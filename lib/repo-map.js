/**
 * repoMap (Aider) - a whole-repository outline under a token budget.
 *
 * Big repositories are the one place where "read files one by one" loses: the
 * model does not know the shape of the tree before it starts. This module
 * extracts definitions from source files, counts references from a ONE-PASS
 * per-file token index, ranks files Aider-style (personalised PageRank with
 * sqrt-damped edges), and renders the most important files and symbols within
 * a token budget.
 *
 * Hardening added for 1.0.0 (0.1.1 fix #6 plus P1-6):
 *  - every path is resolved inside the session working directory and both the
 *    string form and the realpath form are checked, so ../, foreign drives,
 *    C:\\Windows, /etc and symlink escapes are refused with a clear error;
 *  - one token index per file (never symbol x file x full text), bounded
 *    symbols/edges, sliced work with setImmediate yields and a configurable
 *    timeBudgetMs; when the budget is exceeded the partial map is returned and
 *    explicitly annotated as incomplete;
 *  - incremental disk index at <workspace>/.dsh/workflow-boost/repomap-index.json
 *    keyed by mtime+size, discarded when corrupt or out of bounds;
 *  - conversation files (read/edited/mentioned in this session) personalise
 *    the ranking, and without them the token budget is widened.
 *
 * It is a *tool*, not prompt injection: nothing is added to the system prompt,
 * so the cache prefix never changes, and the model calls repo_map only when it
 * decides the repository is worth mapping.
 */
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sectionDefaults } from './defaults.js'
import { errorText, estimateTokens, loadHost, logInfo, logWarn, shortHash } from './shared.js'
import * as core from './pure/repo-map-core.js'

/** One in-memory map text per root+options, reused within cacheTtlMs. */
const RESULT_CACHE_LIMIT = 16
/** Filesystem candidates examined (stat calls) per scan is capped by maxFiles * this. */
const SCAN_SEEN_MULTIPLIER = 6
/** Files between setImmediate yields inside the scanner. */
const SCAN_YIELD_EVERY = 32
/** Strings inspected per tool/call or user/message event for file hints. */
const HINT_STRINGS_PER_EVENT = 24
/** Longest string inspected for file hints (tool arguments can be huge). */
const HINT_TEXT_LIMIT = 800

const TOOL_DESCRIPTION =
  'Render a compact map of the repository inside the session working directory: the most important source ' +
  'files ranked by cross-file references (personalized by files already read or mentioned), with their top ' +
  'definitions, within a token budget. Use it at the start of work in a large or unfamiliar codebase, before ' +
  'planning changes spanning several files, or to find where a concept is defined. Paths must stay inside the ' +
  'workspace (outside paths, ../ escapes and symlink escapes are refused). Do not use it for a single-file ' +
  'edit or repeatedly in a row; results are cached for cacheTtlMs and reused from an incremental index.'

/** The session that owns one tool execution (Cordis exec schema). */
function getSession(exec) {
  try {
    return exec?.agent?.session ?? exec?.session
  } catch {
    return undefined
  }
}

/** Session working directory via ctx.workingDirectory; never process.cwd(). */
function sessionCwd(ctx, exec) {
  const session = getSession(exec)
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service !== null && typeof service === 'object' && typeof service.get === 'function') {
      const value = service.get(session)
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    /* service unavailable or threw; fall through to the session header */
  }
  try {
    const headerCwd = session?.header?.cwd
    if (typeof headerCwd === 'string' && core.isAbsolutePathLike(headerCwd)) return headerCwd
  } catch {
    /* ignore */
  }
  return undefined
}

/** Human-readable structured refusal; the tool returns text instead of throwing. */
function refusalText(result) {
  const code = typeof result?.code === 'string' ? result.code : 'error'
  const message = typeof result?.message === 'string' ? result.message : 'request rejected'
  return 'repo_map refused: ' + message + ' [code: ' + code + ']. The map is limited to the session working ' +
    'directory; use fs/glob/grep for anything outside it.'
}

/**
 * Resolve the requested directory inside the workspace and realpath both ends.
 * @returns { ok: true, root } or a structured error { ok: false, code, message }.
 */
async function resolveWorkspace(ctx, exec, requestedPath) {
  const cwd = sessionCwd(ctx, exec)
  if (cwd === undefined) {
    return {
      ok: false,
      code: 'no-workspace',
      message: 'cannot resolve the session working directory (the workingDirectory service is unavailable)',
    }
  }
  let realRoot
  try {
    realRoot = await realpath(cwd)
  } catch (error) {
    return { ok: false, code: 'workspace-unavailable', message: 'workspace "' + cwd + '" is not accessible: ' + errorText(error) }
  }
  const target = core.resolveRequestedPath(realRoot, requestedPath)
  const preliminary = core.classifyWorkspacePath({ root: realRoot, target })
  if (preliminary.ok !== true) return preliminary
  let realTarget
  try {
    realTarget = await realpath(target)
  } catch (error) {
    return { ok: false, code: 'not-found', message: 'path "' + target + '" is not accessible: ' + errorText(error) }
  }
  const verdict = core.classifyWorkspacePath({ root: realRoot, target, realRoot, realTarget })
  if (verdict.ok !== true) return verdict
  let info
  try {
    info = await stat(realTarget)
  } catch (error) {
    return { ok: false, code: 'not-found', message: 'path "' + realTarget + '" is not accessible: ' + errorText(error) }
  }
  if (info.isDirectory() !== true) {
    return { ok: false, code: 'not-a-directory', message: '"' + target + '" is a file; repo_map maps directories' }
  }
  return { ok: true, root: realTarget }
}

/** Absolute path of the persisted incremental index. */
function indexPathFor(root) {
  return join(root, core.INDEX_DIR, core.INDEX_FILE)
}

/** Load the disk index; corrupt or out-of-bounds caches are discarded. */
async function loadCachedIndex(root, settings, state) {
  if (!settings.incremental) return new Map()
  let text
  try {
    text = await readFile(indexPathFor(root), 'utf8')
  } catch {
    return new Map()
  }
  const parsed = core.parseIndex(text, root)
  if (parsed === undefined) {
    logWarn(state, 'repoMap: discarding corrupt or out-of-bounds repomap index under ' + root)
    return new Map()
  }
  const cached = new Map()
  for (const record of parsed.files) cached.set(record.path, record)
  return cached
}

/** Persist the disk index atomically; failure only warns (fail-open). */
async function saveCachedIndex(root, records, settings, state) {
  if (!settings.incremental) return false
  let temp
  try {
    const text = core.serializeIndex(root, records)
    if (text.length > core.INDEX_MAX_BYTES) {
      logWarn(state, 'repoMap: repomap index would be ' + text.length + ' bytes; skipping persistence')
      return false
    }
    const target = indexPathFor(root)
    await mkdir(dirname(target), { recursive: true })
    temp = target + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp'
    await writeFile(temp, text, 'utf8')
    await rename(temp, target)
    return true
  } catch (error) {
    if (temp !== undefined) {
      try {
        await unlink(temp)
      } catch {
        /* ignore */
      }
    }
    logWarn(state, 'repoMap: could not persist repomap index: ' + errorText(error))
    return false
  }
}

/** Union used when a timed-out scan stores partial progress without losing old entries. */
function mergeRecords(cached, records) {
  const merged = new Map(cached)
  for (const record of records) merged.set(record.path, record)
  return Array.from(merged.values()).sort((left, right) => left.path.localeCompare(right.path))
}

function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Walk the workspace once, reusing unchanged files from the disk index.
 * Bounded by maxFiles, maxFileBytes and the wall-clock deadline; symbolic
 * links are never followed (the realpath guard runs before the scan too).
 */
async function scanWorkspace(input) {
  const { root, settings, deadline, cached, signal } = input
  const records = []
  const stack = [root]
  let seen = 0
  let skipped = 0
  let cachedHits = 0
  let reread = 0
  let timedOut = false
  let truncated = false
  let cancelled = false
  while (stack.length > 0) {
    if (signal !== undefined && signal.aborted === true) {
      cancelled = true
      break
    }
    if (Date.now() > deadline) {
      timedOut = true
      break
    }
    const directory = stack.pop()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    const subdirectories = []
    for (const entry of entries) {
      if (signal !== undefined && signal.aborted === true) {
        cancelled = true
        break
      }
      if (Date.now() > deadline) {
        timedOut = true
        break
      }
      if (records.length >= settings.maxFiles || seen >= settings.maxFiles * SCAN_SEEN_MULTIPLIER) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink()) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !core.SKIP_DIRS.has(entry.name)) subdirectories.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const language = core.languageFor(entry.name)
      if (language === undefined) continue
      seen += 1
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (info.size <= 0 || info.size > settings.maxFileBytes) {
        skipped += 1
        continue
      }
      const relativePath = core.relativeWorkspacePath(root, full)
      if (relativePath === undefined || relativePath.length === 0) continue
      const cachedRecord = cached.get(relativePath)
      if (cachedRecord !== undefined && cachedRecord.mtimeMs === info.mtimeMs && cachedRecord.size === info.size) {
        records.push(cachedRecord)
        cachedHits += 1
      } else {
        let text
        try {
          text = await readFile(full, 'utf8')
        } catch {
          continue
        }
        if (text.length === 0 || text.slice(0, 1000).includes('\u0000')) continue
        records.push({
          path: relativePath,
          language,
          mtimeMs: info.mtimeMs,
          size: info.size,
          symbols: core.extractSymbols(text, language),
          tokens: core.tokenizeIdentifiers(text),
        })
        reread += 1
      }
      if (seen % SCAN_YIELD_EVERY === 0) {
        await yieldToLoop()
        if (Date.now() > deadline) {
          timedOut = true
          break
        }
      }
    }
    if (timedOut || truncated || cancelled) break
    for (let index = subdirectories.length - 1; index >= 0; index -= 1) stack.push(subdirectories[index])
    await yieldToLoop()
  }
  records.sort((left, right) => left.path.localeCompare(right.path))
  return { records, seen, skipped, cachedHits, reread, timedOut, truncated, cancelled }
}

/** Collect bounded strings from one committed session event. */
function collectHintStrings(value, out, depth) {
  if (out.length >= HINT_STRINGS_PER_EVENT || depth > 4) return
  if (typeof value === 'string') {
    if (value.length > 0 && value.length <= HINT_TEXT_LIMIT) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, HINT_STRINGS_PER_EVENT)) collectHintStrings(item, out, depth + 1)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value).slice(0, HINT_STRINGS_PER_EVENT)) collectHintStrings(value[key], out, depth + 1)
  }
}

/** Per-session conversation-file hints (used for Aider-style personalization). */
function createStores() {
  return { hints: new WeakMap(), resultCache: new Map() }
}

function rememberHints(stores, session, texts) {
  if (session === null || typeof session !== 'object') return
  let hints = stores.hints.get(session)
  if (hints === undefined) {
    hints = []
    stores.hints.set(session, hints)
  }
  for (const text of texts) {
    for (const hint of core.extractPathHints(text)) {
      const existing = hints.indexOf(hint)
      if (existing >= 0) hints.splice(existing, 1)
      hints.push(hint)
      while (hints.length > core.MAX_HINT_HISTORY) hints.shift()
    }
  }
}

function collectEventHints(stores, session, event) {
  const type = event?.type
  if (type !== 'tool/call' && type !== 'user/message') return
  const strings = []
  collectHintStrings(event?.data, strings, 0)
  if (strings.length === 0) return
  rememberHints(stores, session, strings)
}

function hintsFor(stores, exec) {
  const session = getSession(exec)
  if (session === null || typeof session !== 'object') return []
  const hints = stores.hints.get(session)
  return hints === undefined ? [] : hints.slice()
}

/** Map conversation hints onto scanned files, keeping only in-workspace files. */
function chatFilesFor(records, hints, root, enabled) {
  if (!enabled || hints.length === 0) return new Set()
  const relativeHints = []
  for (const hint of hints) {
    const target = core.resolveRequestedPath(root, hint)
    const verdict = core.classifyWorkspacePath({ root, target })
    if (verdict.ok === true && typeof verdict.relative === 'string' && verdict.relative.length > 0) relativeHints.push(verdict.relative)
    if (relativeHints.length >= core.MAX_CHAT_FILES) break
  }
  if (relativeHints.length === 0) return new Set()
  return core.matchChatFiles(records, relativeHints, { limit: core.MAX_CHAT_FILES })
}

/** Build and render one repository map. */
async function runRepoMap(ctx, settings, stores, args, exec, state) {
  const started = Date.now()
  const deadline = started + settings.timeBudgetMs
  const signal = exec?.signal
  try {
    const requestedPath = typeof args?.path === 'string' ? args.path : undefined
    const resolved = await resolveWorkspace(ctx, exec, requestedPath)
    if (resolved.ok !== true) return refusalText(resolved)
    const root = resolved.root
    const focus = typeof args?.focus === 'string' && args.focus.trim().length > 0 ? args.focus.trim() : undefined
    const requestedTokens = Number(args?.maxTokens)
    const baseBudget = Number.isFinite(requestedTokens) && requestedTokens >= 200
      ? Math.min(20000, Math.floor(requestedTokens))
      : settings.tokenBudget
    const hints = hintsFor(stores, exec)
    const cacheKey = root + '|' + baseBudget + '|' + (focus ?? '') + '|' + settings.maxFiles + '|' +
      settings.maxFileBytes + '|' + (settings.personalize ? '1' : '0') + '|' + shortHash(hints.slice(-16).join('|'))
    if (settings.cacheTtlMs > 0) {
      const cachedResult = stores.resultCache.get(cacheKey)
      if (cachedResult !== undefined && Date.now() - cachedResult.at <= settings.cacheTtlMs) return cachedResult.text
    }
    const cachedRecords = await loadCachedIndex(root, settings, state)
    const scan = await scanWorkspace({ root, settings, deadline, cached: cachedRecords, signal })
    const rankable = scan.records.filter((record) => Array.isArray(record.symbols) && record.symbols.length > 0)
    if (rankable.length === 0) {
      const notes = []
      if (scan.timedOut) notes.push('time budget ' + settings.timeBudgetMs + 'ms exceeded while scanning')
      if (scan.truncated) notes.push('scan limits reached (maxFiles=' + settings.maxFiles + ')')
      if (scan.cancelled) notes.push('call was cancelled')
      return core.renderMapText({
        root,
        ranked: [],
        totalFiles: 0,
        totalSymbols: 0,
        budget: core.effectiveBudget(baseBudget, { hasChatFiles: false, personalize: settings.personalize }),
        focus,
        incomplete: notes,
      }).text
    }
    const chatFiles = chatFilesFor(rankable, hints, root, settings.personalize)
    const budget = core.effectiveBudget(baseBudget, { hasChatFiles: chatFiles.size > 0, personalize: settings.personalize })
    const ranking = await core.rankFilesAsync(rankable, {
      chatFiles,
      personalize: settings.personalize,
      deadline,
    })
    let totalSymbols = 0
    for (const record of rankable) totalSymbols += record.symbols.length
    const notes = []
    if (scan.timedOut) notes.push('time budget ' + settings.timeBudgetMs + 'ms exceeded while scanning')
    if (scan.truncated) notes.push('scan limits reached (maxFiles=' + settings.maxFiles + ')')
    if (ranking.incomplete) notes.push('ranking stopped early (time budget or symbol/edge caps); ordering is partial')
    if (scan.cancelled) notes.push('call was cancelled')
    const rendered = core.renderMapText({
      root,
      ranked: ranking.ranked,
      totalFiles: rankable.length,
      totalSymbols,
      budget,
      focus,
      incomplete: notes,
      personalized: settings.personalize && chatFiles.size > 0,
    })
    if (settings.incremental) {
      const recordsToSave = scan.timedOut ? mergeRecords(cachedRecords, scan.records) : scan.records
      const changed = scan.timedOut || scan.cancelled || scan.reread > 0 || scan.records.length !== cachedRecords.size
      if (changed) await saveCachedIndex(root, recordsToSave, settings, state)
    }
    if (notes.length === 0 && settings.cacheTtlMs > 0) {
      stores.resultCache.set(cacheKey, { at: Date.now(), text: rendered.text })
      while (stores.resultCache.size > RESULT_CACHE_LIMIT) {
        const oldest = stores.resultCache.keys().next().value
        stores.resultCache.delete(oldest)
      }
    }
    logInfo(state, 'repo_map: ' + scan.records.length + ' files (' + scan.cachedHits + ' reused, ' + scan.skipped +
      ' skipped), ' + rendered.shown + ' shown, ~' + estimateTokens(rendered.text) + ' tokens, ' +
      (Date.now() - started) + 'ms, root=' + root)
    return rendered.text
  } catch (error) {
    logWarn(state, 'repoMap: map build failed: ' + errorText(error))
    return 'repo_map failed: ' + errorText(error) + '. Use fs/glob/grep tools to inspect the tree directly.'
  }
}

/** Load defineTool dynamically and register repo_map; missing host packages fail open. */
async function registerTool(ctx, settings, stores, state) {
  try {
    const host = state?.loadHost ?? loadHost
    let hostTools
    try {
      hostTools = await host('@deepseek-ai/dsh-tools')
    } catch (error) {
      logWarn(state, 'repoMap: cannot load @deepseek-ai/dsh-tools: ' + errorText(error))
      return undefined
    }
    const defineTool = hostTools?.defineTool
    if (typeof defineTool !== 'function') {
      logWarn(state, 'repoMap: @deepseek-ai/dsh-tools did not provide defineTool; repo_map tool not registered')
      return undefined
    }
    let toolsService
    try {
      if (typeof ctx?.get === 'function') toolsService = ctx.get('tools')
    } catch {
      toolsService = undefined
    }
    if (toolsService === undefined) {
      try {
        toolsService = ctx?.tools
      } catch {
        toolsService = undefined
      }
    }
    const register = toolsService !== null && typeof toolsService === 'object' && typeof toolsService.register === 'function'
      ? toolsService.register.bind(toolsService)
      : undefined
    if (register === undefined) {
      logWarn(state, 'repoMap: the tools service has no register(); repo_map tool not registered')
      return undefined
    }
    const definition = defineTool({
      name: 'repo_map',
      description: TOOL_DESCRIPTION,
      parameters: {
        path: {
          type: 'string',
          description: 'Absolute or relative directory to map. Resolved against the session working directory and refused when it lands outside the workspace. Defaults to the workspace root.',
        },
        maxTokens: {
          type: 'number',
          description: 'Approximate token budget for the rendered map (clamped to 200..20000). Defaults to the plugin configuration.',
        },
        focus: {
          type: 'string',
          description: 'Optional case-insensitive filter: only files or symbols containing this text are shown.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        try {
          return await runRepoMap(ctx, settings, stores, args ?? {}, exec, state)
        } catch (error) {
          logWarn(state, 'repoMap: repo_map execution failed: ' + errorText(error))
          return 'repo_map failed: ' + errorText(error) + '. Use fs/glob/grep tools to inspect the tree directly.'
        }
      },
    })
    const cleanup = register(definition)
    logInfo(state, 'repoMap active (repo_map tool registered): ' + settings.maxFiles + ' files max, ' +
      settings.tokenBudget + ' token budget, timeBudgetMs=' + settings.timeBudgetMs +
      (settings.incremental ? ', incremental index' : ''))
    return cleanup
  } catch (error) {
    logWarn(state, 'repoMap: could not register repo_map: ' + errorText(error))
    return undefined
  }
}

/**
 * Mount the module.
 * @param ctx - Cordis plugin context.
 * @param config - validated row configuration.
 * @param state - { ctx, log(level, message), sessionState }.
 * @returns disposer; registration is async so the returned function waits for it.
 */
export function install(ctx, config, state) {
  let settings
  try {
    settings = core.resolveConfig(sectionDefaults('repoMap', config))
  } catch (error) {
    logWarn(state, 'repoMap: invalid configuration: ' + errorText(error))
    return undefined
  }
  if (settings.enabled !== true) return undefined
  const stores = createStores()
  const onSessionEvent = (session, event) => {
    try {
      collectEventHints(stores, session, event)
    } catch {
      /* hint collection is best effort and must never break the event feed */
    }
  }
  // Register the hint feed synchronously: the module has to be observably wired
  // the moment install() returns (the plugin wiring harness checks that), while
  // the tool definition itself needs an async host import.
  let disposeHints
  try {
    if (typeof ctx?.on === 'function') disposeHints = ctx.on('session/event', onSessionEvent)
  } catch {
    disposeHints = undefined
  }
  if (typeof disposeHints !== 'function') {
    try {
      const sessionState = state?.sessionState
      if (sessionState !== null && typeof sessionState === 'object' && typeof sessionState.onEvent === 'function') {
        disposeHints = sessionState.onEvent(onSessionEvent)
      }
    } catch {
      disposeHints = undefined
    }
  }
  let disposed = false
  let toolDisposer
  const registration = registerTool(ctx, settings, stores, state).then((registered) => {
    toolDisposer = registered
    if (disposed && typeof registered === 'function') {
      try {
        registered()
      } catch {
        /* dispose must not throw */
      }
    }
  }).catch((error) => {
    logWarn(state, 'repoMap: registration failed: ' + errorText(error))
  })
  void registration
  return () => {
    disposed = true
    try {
      if (typeof disposeHints === 'function') disposeHints()
    } catch {
      /* ignore */
    }
    try {
      if (typeof toolDisposer === 'function') toolDisposer()
    } catch {
      /* ignore */
    }
    stores.resultCache.clear()
  }
}
