/**
 * stylePack — response style and self-presentation, adjustable at runtime.
 *
 * What it does:
 *  1. renders ONE static system-prompt section (identity line + checkable
 *     style rules) so the request prefix stays byte-stable per session;
 *  2. registers /boost-style, /boost-identity, /boost-show and /boost-reset
 *     through the native commands service. Handlers use the real DSH contract
 *     (handler({ agent, rawInput }) -> { kind: 'success' | 'error', text });
 *     a switch lands as a tail notice, so the cached prefix up to that point
 *     survives;
 *  3. reads the volatile stylePack config on every operation, so edits made in
 *     the plugin settings page take effect without remounting the plugin;
 *  4. persists user choices to <workspace>/.dsh/workflow-boost/style.json when
 *     stylePack.persist is true, so the next session starts with them;
 *  5. exposes a read-only boost_settings tool so the model can report the
 *     active selection on request.
 *
 * Host services are optional: without systemPrompt the module still answers
 * commands; without commands it is a no-op. Every failure is logged and
 * swallowed, because style must never break a turn.
 */
import { errorText, loadHost, logInfo, logWarn } from './shared.js'
import { sectionDefaults } from './defaults.js'
import {
  applyChange, describeSelection, identityIsActive, identityLine, renderCatalog, renderStyleSection, renderSwitchNotice, resolveStyleConfig,
} from './pure/style-core.js'

const SETTINGS_DIR = '.dsh/workflow-boost'
const SETTINGS_FILE = 'style.json'
const SECTION_NAME = 'workflow-boost:style'
const SECTION_ORDER = 5

/**
 * Sections the identity override replaces at the system-prompt layer.
 * DSH renders the harness identity at order -1000 and a deployment/preset
 * persona prefix at order 0; both name the model/harness, so a selected
 * self-presentation must shadow them rather than appear beside them.
 */
const OVERRIDDEN_SECTION_NAMES = new Set([
  'harness:identity',
  'deployment:persona-prefix',
  'deployment:persona-suffix',
])
const IDENTITY_SECTION_NAME = 'workflow-boost:identity'

/** Resolve the host loader; tests may inject state.loadHost. */
function hostOf(state) {
  return typeof state?.loadHost === 'function' ? state.loadHost : loadHost
}

/**
 * A volatile Cordis config value is a stable reference, not a plain object.
 * Reading through .get() is what makes settings-page edits visible to a
 * long-running plugin; a plain row config is returned unchanged.
 */
function unwrap(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get !== 'function') return value
  try {
    return value.get()
  } catch {
    return undefined
  }
}

/** Normalized stylePack settings for the current config snapshot. */
function configuredOf(config) {
  const raw = unwrap(config?.stylePack)
  return resolveStyleConfig(sectionDefaults('stylePack', { stylePack: raw, enabled: config?.enabled }))
}

/** WeakMap keys must be objects; command payloads are not guaranteed to carry one. */
function keyOf(agent) {
  return agent !== null && typeof agent === 'object' ? agent : undefined
}

/** Session working directory from workingDirectory; never process.cwd(). */
function workspaceOf(ctx, session) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service === undefined || service === null || typeof service.get !== 'function') return undefined
    const dir = service.get(session)
    return typeof dir === 'string' && dir.length > 0 ? dir : undefined
  } catch {
    return undefined
  }
}

/** Absolute path of the persisted settings file. */
export function settingsPath(workspace) {
  return String(workspace).replace(/\\/g, '/').replace(/\/+$/g, '') + '/' + SETTINGS_DIR + '/' + SETTINGS_FILE
}

/** Read persisted choices; a missing or broken file yields undefined. */
export async function loadPersisted(workspace, readFile) {
  if (typeof workspace !== 'string' || workspace.length === 0) return undefined
  if (typeof readFile !== 'function') return undefined
  try {
    const text = await readFile(settingsPath(workspace), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist user choices. Failures are logged and swallowed: a read-only
 * workspace must not disable style switching for the running session.
 */
export async function savePersisted(workspace, settings, writeFile, state) {
  if (typeof workspace !== 'string' || workspace.length === 0) return false
  if (typeof writeFile !== 'function') return false
  try {
    const payload = JSON.stringify({
      style: settings.style,
      identity: settings.identity,
      customStyle: settings.customStyle,
      customIdentity: settings.customIdentity,
      savedAt: new Date().toISOString(),
    }, null, 2)
    await writeFile(settingsPath(workspace), payload)
    logInfo(state, 'stylePack: saved style/identity to ' + settingsPath(workspace))
    return true
  } catch (error) {
    logWarn(state, 'stylePack: could not persist style settings: ' + errorText(error))
    return false
  }
}

/**
 * Install the module.
 * @param ctx - plugin context.
 * @param config - row configuration (a stylePack section may be missing or volatile).
 * @param state - shared plugin state ({ log, loadHost, sessionState }).
 * @returns disposer.
 */
export function install(ctx, config, state) {
  let configured = configuredOf(config)
  if (!configured.enabled) return undefined
  const host = hostOf(state)
  const perAgent = new WeakMap()
  const pendingNotices = new WeakMap()
  const disposers = []
  let active = true
  let fsApi
  let fallbackSettings

  /** A disposer registered after install() returned must still be honoured. */
  const track = (disposer) => {
    if (typeof disposer !== 'function') return
    if (!active) {
      try { disposer() } catch { /* disposal must not throw */ }
      return
    }
    disposers.push(disposer)
  }

  if (configured.warnOnIdentity && identityIsActive(configured.identity)) {
    logWarn(state, 'stylePack: identity ' + JSON.stringify(configured.identity) + ' is active. It changes what the model claims about itself; do not use it to misrepresent the product to end users.')
  }

  const settingsFor = (agent) => {
    const key = keyOf(agent)
    const stored = key === undefined ? fallbackSettings : perAgent.get(key)
    return stored ?? configured
  }
  const storeSettings = (agent, next) => {
    const key = keyOf(agent)
    if (key === undefined) fallbackSettings = next
    else perAgent.set(key, next)
  }
  const queueNotice = (agent, notice) => {
    if (notice.length === 0) return
    const key = keyOf(agent)
    if (key === undefined) return
    pendingNotices.set(key, notice)
  }
  const takeNotice = (agent) => {
    const key = keyOf(agent)
    if (key === undefined) return ''
    const queued = pendingNotices.get(key)
    if (typeof queued !== 'string' || queued.length === 0) return ''
    pendingNotices.delete(key)
    return queued
  }

  // ---- 1) static system-prompt section ---------------------------------
  // Volatile config edits re-register this section. That costs one cache
  // rebuild for the next request, which is the intended price of a settings
  // change; ordinary turns never rewrite the prefix.
  let sectionDisposer
  const promptOf = () => {
    try {
      const viaService = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined
      return viaService !== undefined && viaService !== null ? viaService : ctx?.systemPrompt
    } catch {
      return ctx?.systemPrompt
    }
  }
  const refreshSection = () => {
    const settings = configuredOf(config)
    const prompt = promptOf()
    if (settings.applyToSystemPrompt === false || typeof prompt?.section !== 'function') return
    try {
      if (typeof sectionDisposer === 'function') {
        const previous = sectionDisposer
        sectionDisposer = undefined
        const index = disposers.indexOf(previous)
        if (index >= 0) disposers.splice(index, 1)
        previous()
      }
      // Identity is applied in the assembly waterfall (it must SHADOW the
      // host identity/persona sections, not append another line), so the
      // static section carries only the checkable style rules.
      const text = renderStyleSection({ ...settings, identity: 'off' })
      if (text.length === 0) return
      sectionDisposer = prompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text })
      if (typeof sectionDisposer === 'function') track(sectionDisposer)
      else sectionDisposer = undefined
      logInfo(state, 'stylePack: static section registered (style=' + settings.style + ', identity=' + settings.identity + ')')
    } catch (error) {
      logWarn(state, 'stylePack: could not register the style section: ' + errorText(error))
    }
  }
  refreshSection()

  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('loader/volatile-update', () => {
        if (!active) return
        configured = configuredOf(config)
        refreshSection()
      })
    }
  } catch (error) {
    logWarn(state, 'stylePack: could not listen for volatile config updates: ' + errorText(error))
  }

  // ---- 1b) identity override at the system-prompt layer -----------------
  // The host assembles ordered sections and then runs a waterfall where the
  // returned assembly is authoritative. Replacing the harness identity and
  // persona sections there is the only way to make "self-presentation" actually
  // replace DSH's model/harness naming instead of adding a conflicting line.
  const applyIdentityOverride = (assembly, agent) => {
    if (!active) return assembly
    const settings = settingsFor(agent)
    if (settings.applyToSystemPrompt === false) return assembly
    const line = identityLine(settings.identity, settings.customIdentity)
    if (line.length === 0) return assembly
    const source = assembly !== null && typeof assembly === 'object' && Array.isArray(assembly.sections) ? assembly.sections : []
    const kept = source.filter((section) => section === null || typeof section !== 'object' || !OVERRIDDEN_SECTION_NAMES.has(section.name))
    const caveat = settings.identityScope === 'presentation'
      ? ' Keep this identity as self-presentation only: never claim a capability you do not have, and treat the tools in this session as the only source of truth about what you can do.'
      : ''
    return {
      ...assembly,
      sections: [{ name: IDENTITY_SECTION_NAME, text: line + caveat }, ...kept],
    }
  }

  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const downstream = await next()
        try {
          return applyIdentityOverride(downstream, context !== null && typeof context === 'object' ? context.scope : undefined)
        } catch (error) {
          logWarn(state, 'stylePack: identity override failed: ' + errorText(error))
          return downstream
        }
      })
    }
  } catch (error) {
    logWarn(state, 'stylePack: could not listen for system-prompt/assemble: ' + errorText(error))
  }

  // ---- 2) lazy fs helper ------------------------------------------------
  const fileApi = async () => {
    if (fsApi !== undefined) return fsApi
    try {
      const nodeFs = await host('node:fs/promises')
      if (nodeFs === undefined) return undefined
      fsApi = {
        readFile: nodeFs.readFile,
        async writeFile(path, text) {
          const dir = path.slice(0, path.lastIndexOf('/'))
          await nodeFs.mkdir(dir, { recursive: true })
          await nodeFs.writeFile(path, text, 'utf8')
        },
      }
    } catch {
      fsApi = undefined
    }
    return fsApi
  }

  /** Apply one switch, queue a tail notice, persist when enabled. */
  const switchTo = async (agent, change) => {
    const next = applyChange(settingsFor(agent), change)
    storeSettings(agent, next)
    queueNotice(agent, renderSwitchNotice(next))
    if (next.persist) {
      const workspace = workspaceOf(ctx, agent?.session)
      const api = await fileApi()
      if (api !== undefined) await savePersisted(workspace, next, api.writeFile, state)
    }
    return next
  }

  // ---- 3) tool: boost_settings (read-only) ------------------------------
  void (async () => {
    try {
      const tools = await host('@deepseek-ai/dsh-tools')
      if (!active || tools === undefined || typeof tools.defineTool !== 'function') return
      if (typeof ctx?.tools?.register !== 'function') return
      const definition = tools.defineTool({
        name: 'boost_settings',
        description:
          'Report the response style and self-presentation active for this session and list the available presets. ' +
          'Read-only: switch styles with the /boost-style and /boost-identity commands.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(_args, exec) {
          const settings = settingsFor(exec?.agent)
          const selection = describeSelection(settings)
          return [
            'Active style: ' + selection.style.name + ' — ' + selection.style.label,
            'Active identity: ' + selection.identity.name + (selection.identity.active ? ' — ' + selection.identity.label : ''),
            '',
            renderCatalog(settings),
          ].join('\n')
        },
      })
      track(ctx.tools.register(definition))
    } catch (error) {
      logWarn(state, 'stylePack: could not register boost_settings: ' + errorText(error))
    }
  })()

  // ---- 4) commands ------------------------------------------------------
  // DSH contract: ctx.commands.register({ name, description, input: { hint },
  // handler: ({ agent, rawInput }) -> { kind: 'success' | 'error', text } }).
  // Commands never become model messages; the tail notice in step 5 is what
  // makes a switch visible to the model from the next step onward.
  const success = (text) => ({ kind: 'success', text })
  const failure = (text) => ({ kind: 'error', text })
  const guard = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      logWarn(state, 'stylePack: command failed open: ' + errorText(error))
      return failure('stylePack could not apply that change: ' + errorText(error))
    }
  }
  const parseInput = (rawInput) => {
    const parts = (typeof rawInput === 'string' ? rawInput.trim() : '').split(/\s+/).filter(Boolean)
    return { name: (parts[0] ?? '').toLowerCase(), extra: parts.slice(1).join(' ').trim() }
  }

  try {
    const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : undefined
    const registry = commands !== undefined && commands !== null ? commands : ctx?.commands
    if (registry === undefined || registry === null || typeof registry.register !== 'function') {
      logInfo(state, 'stylePack: commands service unavailable; /boost-* is not registered')
    } else {
      const specs = [
        {
          name: 'boost-style',
          description: 'Switch the response style for this session (default, concise, proactive, explanatory, learning, custom).',
          input: { hint: '<style> [custom rule text]' },
          handler: async ({ agent, rawInput }) => guard(async () => {
            const { name, extra } = parseInput(rawInput)
            const settings = settingsFor(agent)
            if (name.length === 0) return success('Current style: ' + settings.style + '\n' + renderCatalog(settings))
            const change = { style: name }
            if (name === 'custom' && extra.length > 0) change.customStyle = extra
            const next = await switchTo(agent, change)
            if (next.style !== name) return failure('Unknown style "' + name + '".\n' + renderCatalog(settings))
            return success('Style set to ' + name + '. It applies from the next step; earlier history keeps its cached prefix.')
          }),
        },
        {
          name: 'boost-identity',
          description: 'Set the self-presentation line for this session (off, deepseek-v4.1, claude-opus-5.5, claude-fable-5.2, claude-sonnet-5.5, gpt-6.1-sol, grok-4.7, kimi-k3, glm-5.3, minimax-m3.1, custom).',
          input: { hint: '<identity> [custom identity text]' },
          handler: async ({ agent, rawInput }) => guard(async () => {
            const { name, extra } = parseInput(rawInput)
            const settings = settingsFor(agent)
            if (name.length === 0) return success('Current identity: ' + settings.identity + '\n' + renderCatalog(settings))
            const change = { identity: name }
            if (name === 'custom' && extra.length > 0) change.customIdentity = extra
            const next = await switchTo(agent, change)
            if (next.identity !== name) return failure('Unknown identity "' + name + '".\n' + renderCatalog(settings))
            return success('Identity set to ' + name + '. Presentation only: capabilities still come from the tools.')
          }),
        },
        {
          name: 'boost-show',
          description: 'Show the active style/identity selection and the available presets.',
          handler: async ({ agent }) => guard(async () => success(renderCatalog(settingsFor(agent)))),
        },
        {
          name: 'boost-reset',
          description: 'Restore the configured default style and identity for this session.',
          handler: async ({ agent }) => guard(async () => {
            const key = keyOf(agent)
            if (key !== undefined) perAgent.delete(key)
            fallbackSettings = undefined
            queueNotice(agent, renderSwitchNotice(configuredOf(config)))
            return success('Style and identity restored to the configured defaults.')
          }),
        },
      ]
      for (const spec of specs) {
        try {
          track(registry.register(spec))
        } catch (error) {
          logWarn(state, 'stylePack: could not register /' + spec.name + ': ' + errorText(error))
        }
      }
      logInfo(state, 'stylePack: registered /boost-style, /boost-identity, /boost-show, /boost-reset')
    }
  } catch (error) {
    logWarn(state, 'stylePack: command registration failed: ' + errorText(error))
  }

  // ---- 5) tail notice: a mid-session switch takes effect ----------------
  // DSH contract (packages/core/tools/src/events.ts:41): this event is a
  // waterfall whose listener signature is (exec, result, next) and whose
  // return value is a PostToolDecision. Using two arguments here makes `next`
  // receive the tool result object, so `await next()` throws and breaks every
  // tool call instead of only skipping the notice.
  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('tools/post-execute', async (exec, _result, next) => {
        let notice = ''
        try {
          if (active) notice = takeNotice(exec?.agent)
        } catch (error) {
          logWarn(state, 'stylePack: notice lookup failed: ' + errorText(error))
        }
        const downstream = await next()
        if (notice.length === 0) return downstream
        try {
          const llm = await host('@deepseek-ai/dsh-llm')
          const message = llm?.createUserMessage !== undefined
            ? llm.createUserMessage({
                content: [{ type: 'text', text: notice }],
                source: { kind: 'dsh-workflow-boost', form: 'notice', summary: 'style switch' },
              })
            : { role: 'user', content: [{ type: 'text', text: notice }], source: { kind: 'dsh-workflow-boost', form: 'notice' } }
          const base = downstream !== null && typeof downstream === 'object' ? downstream : { kind: 'accept' }
          const existing = Array.isArray(base.additionalContexts) ? base.additionalContexts : []
          return { ...base, additionalContexts: [message, ...existing] }
        } catch (error) {
          logWarn(state, 'stylePack: notice injection failed: ' + errorText(error))
          return downstream
        }
      })
    }
  } catch (error) {
    logWarn(state, 'stylePack: could not listen for tools/post-execute: ' + errorText(error))
  }

  // ---- 6) restore persisted choices before the first step ---------------
  try {
    if (typeof ctx?.on === 'function' && configured.persist) {
      let restored = false
      ctx.on('agent/pre-step', async (payload, next) => {
        if (!restored && active) {
          restored = true
          try {
            const agent = payload?.agent
            const workspace = workspaceOf(ctx, agent?.session)
            const api = await fileApi()
            if (api !== undefined) {
              const persisted = await loadPersisted(workspace, api.readFile)
              if (persisted !== undefined) {
                const merged = applyChange(configuredOf(config), persisted)
                storeSettings(agent, merged)
                logInfo(state, 'stylePack: restored persisted selection (style=' + merged.style + ', identity=' + merged.identity + ')')
              }
            }
          } catch (error) {
            logWarn(state, 'stylePack: restore failed: ' + errorText(error))
          }
        }
        return next()
      })
    }
  } catch (error) {
    logWarn(state, 'stylePack: could not restore persisted settings: ' + errorText(error))
  }

  return () => {
    active = false
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* disposal must not throw */ }
    }
  }
}
