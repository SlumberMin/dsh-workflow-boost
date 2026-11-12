/**
 * skillPack - register the plugin built-in skills through the native skills
 * service (@deepseek-ai/dsh-skill).
 *
 * Why a dedicated module instead of stuffing module documentation into the
 * system prompt: the host catalog exposes only name + description and loads the
 * markdown body on demand, so the plugin pays zero prompt tokens until a skill
 * is actually loaded, and its cache prefix is untouched.
 *
 * Capability probing (the skills service is a Cordis service, not a package, so
 * no host import is needed):
 *  - registerProvider(create) -> synchronous factory returning { name, list, get };
 *    the catalog lives in the provider and is merged into the native catalog;
 *  - fallback register(skill) -> one runtime skill per entry for older/partial
 *    services;
 *  - neither -> log debug and fail open (never throw into the host).
 * If the service is mounted after this plugin, a bounded session/event probe
 * retries registration once the service appears, then unsubscribes.
 *
 * Nothing here ever writes AGENTS.md/CLAUDE.md: skills are read-only data.
 */
import { sectionDefaults } from './defaults.js'
import { errorText, logInfo, logWarn } from './shared.js'
import * as core from './pure/skill-core.js'

/** Give up probing for a late-mounted skills service after this many events. */
const MAX_SERVICE_PROBE_EVENTS = 20

/** Skills service object -> Set of skill names this process already provided. */
const registeredNames = new WeakMap()

function logDebug(state, message) {
  try {
    state?.log?.('debug', message)
  } catch {
    /* logging must never break a module */
  }
}

/** Look up the native skills service without importing any host package. */
function skillsServiceOf(ctx) {
  try {
    if (typeof ctx?.get === 'function') {
      const service = ctx.get('skills')
      if (service !== null && typeof service === 'object') return service
    }
  } catch {
    /* service lookup can throw on a partial/broken context; fail open */
  }
  return undefined
}

/** True when the service looks like the native SkillRegistry. */
function supportsProviderRegistration(skills) {
  return skills !== null && typeof skills === 'object' && typeof skills.registerProvider === 'function'
}

/**
 * Mount the module.
 * @param ctx - Cordis plugin context.
 * @param config - validated row configuration.
 * @param state - { ctx, log(level, message) }.
 * @returns disposer that unregisters the provider/skills and stops probing.
 */
export function install(ctx, config, state) {
  let settings
  try {
    settings = core.resolveConfig(sectionDefaults('skillPack', config))
  } catch (error) {
    logWarn(state, 'skillPack: invalid configuration: ' + errorText(error))
    return undefined
  }
  if (settings.enabled !== true) return undefined

  const problems = core.validateCatalog(core.SKILL_CATALOG)
  if (problems.length > 0) logWarn(state, 'skillPack: built-in catalog is invalid: ' + problems.join('; '))

  let disposed = false
  let disposers = []
  let addedNames = []
  let service
  let feedDisposer
  let probeCount = 0

  const cleanupFeed = () => {
    const current = feedDisposer
    feedDisposer = undefined
    try {
      if (typeof current === 'function') current()
    } catch {
      /* ignore */
    }
  }

  const disposeRegistrations = () => {
    const list = disposers
    disposers = []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      try {
        list[index]?.()
      } catch {
        /* one failed disposal must not skip the others */
      }
    }
  }

  const registerOn = (skills) => {
    service = skills
    const existing = registeredNames.get(skills)
    const tracked = existing === undefined ? new Set() : existing
    const missing = core.SKILL_CATALOG.filter((entry) => !tracked.has(entry.name))
    if (missing.length === 0) {
      logDebug(state, 'skillPack: built-in skills are already registered on this skills service')
      return
    }
    let providerHandled = false
    if (supportsProviderRegistration(skills)) {
      try {
        const cleanup = skills.registerProvider((control) => core.createSkillProvider(missing, {
          providerName: core.SKILL_PROVIDER_NAME,
          exposeCatalog: settings.exposeCatalog,
          control,
        }))
        if (typeof cleanup === 'function') disposers.push(cleanup)
        providerHandled = true
        logInfo(state, 'skillPack: registered ' + missing.length + ' built-in skills through skills.registerProvider' +
          (settings.exposeCatalog ? '' : ' (catalog hidden by exposeCatalog=false)'))
      } catch (error) {
        logWarn(state, 'skillPack: skills.registerProvider failed, falling back to skills.register: ' + errorText(error))
      }
    }
    if (providerHandled) {
      for (const entry of missing) {
        tracked.add(entry.name)
        addedNames.push(entry.name)
      }
    } else if (typeof skills.register === 'function') {
      for (const entry of missing) {
        try {
          const cleanup = skills.register(core.buildRuntimeSkill(entry))
          if (typeof cleanup === 'function') disposers.push(cleanup)
          tracked.add(entry.name)
          addedNames.push(entry.name)
        } catch (error) {
          logWarn(state, 'skillPack: skills.register failed for ' + entry.name + ': ' + errorText(error))
        }
      }
      if (addedNames.length > 0) logInfo(state, 'skillPack: registered ' + addedNames.length + ' built-in skills through skills.register')
      if (settings.exposeCatalog === false) {
        logDebug(state, 'skillPack: skills.register has no catalog switch; exposeCatalog=false keeps the entries registered')
      }
    } else {
      logDebug(state, 'skillPack: skills service exposes neither registerProvider nor register; built-in skills not registered')
      return
    }
    registeredNames.set(skills, tracked)
  }

  const discover = () => {
    if (disposed) return true
    const found = skillsServiceOf(ctx)
    if (found === undefined) return false
    cleanupFeed()
    try {
      registerOn(found)
    } catch (error) {
      logWarn(state, 'skillPack: registration failed: ' + errorText(error))
    }
    return true
  }

  if (discover() !== true) {
    logDebug(state, 'skillPack: skills service unavailable at install; probing on session events (fail-open)')
    try {
      if (typeof ctx?.on === 'function') {
        feedDisposer = ctx.on('session/event', () => {
          if (disposed || service !== undefined) {
            cleanupFeed()
            return
          }
          probeCount += 1
          if (probeCount > MAX_SERVICE_PROBE_EVENTS) {
            cleanupFeed()
            logDebug(state, 'skillPack: skills service never appeared; giving up (fail-open)')
            return
          }
          discover()
        })
      }
    } catch {
      feedDisposer = undefined
      logDebug(state, 'skillPack: could not subscribe to the session event feed; built-in skills not registered')
    }
  }

  return () => {
    if (disposed) return
    disposed = true
    cleanupFeed()
    disposeRegistrations()
    if (service !== undefined) {
      const tracked = registeredNames.get(service)
      if (tracked !== undefined) {
        for (const name of addedNames) tracked.delete(name)
        if (tracked.size === 0) registeredNames.delete(service)
      }
    }
    addedNames = []
  }
}
