/**
 * cache report 2.0 / cacheAudit (ZCode / OpenCode / Claude Code) — make the
 * session's prompt-cache economics explainable, not just visible.
 *
 * DSH exposes provider usage and context projections but no tool answers
 * "was this cache miss caused by compaction or by an accidental prefix
 * change?". This module registers:
 *
 *   - `cache_report(detail?)` — summary / attribution / compression-ledger /
 *     all, read-only and add-free (it never touches the prompt or a request);
 *   - a plugin-owned `wfbCacheLedger` session projection that folds
 *     provider usage samples and prefix-invalidating lifecycle events from the
 *     durable event log, so attribution survives resume;
 *   - `/cache` for humans when the host exposes ctx.commands.
 *
 * Degradation is explicit: when a host projection is absent the report says
 * "unavailable" instead of inventing numbers. The ledger is a fold over real
 * session events, so a missing projection still has real (not guessed) data.
 */
import { errorText, loadHost, logWarn } from './shared.js'
import {
  CACHE_LEDGER_KEY,
  CACHE_LEDGER_STATE_VERSION,
  CACHE_REPORT_DEFAULTS,
  CONTEXT_BREAKDOWN_KEY,
  CONTEXT_PRESSURE_KEY,
  TOKEN_USAGE_KEY,
  estimateCost,
  foldLedger,
  formatTokens,
  initialLedgerState,
  normalizeDetail,
  percent,
  renderCacheReport,
  resolveCacheConfig,
} from './pure/cache-core.js'

/** Schema defaults, re-exported for callers that only import this module. */
export const DEFAULTS = CACHE_REPORT_DEFAULTS

/** Historic export name kept for 0.1.x callers. */
export function resolveConfig(config) {
  return resolveCacheConfig(config)
}

export { estimateCost, formatTokens, percent, renderReport } from './pure/cache-core.js'

/** Projection keys this module reads from dsh-token-meter. */
const READ_KEYS = new Set([TOKEN_USAGE_KEY, CONTEXT_PRESSURE_KEY, CONTEXT_BREAKDOWN_KEY])

/** Tool name, also used in the description and tests. */
export const TOOL_NAME = 'cache_report'

/**
 * Register the plugin-owned cache ledger projection.
 * The state is host-only (no wire view): it is diagnostics, not UI copy.
 * @param ctx - plugin context.
 * @param state - shared plugin state (`log`).
 * @returns mutable `{ handle }` ref.
 */
export function registerLedgerProjection(ctx, state) {
  const ref = { handle: null }
  try {
    const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined
    if (projections === null || projections === undefined || typeof projections.register !== 'function') return ref
    void (async () => {
      try {
        ref.handle = await projections.register({
          key: CACHE_LEDGER_KEY,
          stateVersion: CACHE_LEDGER_STATE_VERSION,
          stateSchema: { parse: (value) => value },
          init: () => initialLedgerState(),
          apply: (ledger, event) => foldLedger(ledger, event),
        })
        state?.log?.('debug', 'cacheReport: cache ledger projection registered')
      } catch (error) {
        ref.handle = null
        logWarn(state, 'cacheReport: cache ledger projection unavailable, folding live events only: ' + describe(error))
      }
    })()
  } catch (error) {
    logWarn(state, 'cacheReport: cache ledger projection registration failed open: ' + describe(error))
  }
  return ref
}

/**
 * Read the ledger for one session: the projection (resume-safe) first, then the
 * live fold fed by `session/event`.
 * @param projection - ref from registerLedgerProjection.
 * @param local - WeakMap fed by the session event feed.
 * @param session - target session.
 * @returns ledger state or undefined when nothing has been observed yet.
 */
export function ledgerOf(projection, local, session) {
  const handle = projection?.handle
  if (handle !== null && handle !== undefined && session !== null && session !== undefined && typeof handle.stateOf === 'function') {
    try {
      const state = handle.stateOf(session)
      if (state !== null && state !== undefined && typeof state === 'object') return state
    } catch {
      /* fall through to the live fold */
    }
  }
  return local instanceof WeakMap ? local.get(session) : undefined
}

/** Read the three host projections in one consistent snapshot. */
function readProjections(ctx, state, session) {
  const values = {}
  try {
    const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined
    if (projections !== null && projections !== undefined && typeof projections.snapshot === 'function') {
      const snapshot = projections.snapshot(session, READ_KEYS)
      const read = snapshot !== null && snapshot !== undefined && snapshot.values !== null && typeof snapshot.values === 'object'
        ? snapshot.values
        : {}
      values.usage = read[TOKEN_USAGE_KEY]
      values.pressure = read[CONTEXT_PRESSURE_KEY]
      values.breakdown = read[CONTEXT_BREAKDOWN_KEY]
    }
  } catch (error) {
    logWarn(state, 'cacheReport: projection read failed open: ' + describe(error))
  }
  return values
}

/** Session age in minutes when the header records a start time. */
function sessionAgeMinutes(session) {
  try {
    const startedAt = Number(session?.header?.createdAt ?? session?.header?.time ?? 0)
    if (!Number.isFinite(startedAt) || startedAt <= 0) return undefined
    return (Date.now() - startedAt) / 60000
  } catch {
    return undefined
  }
}

/**
 * Collect every input the pure renderer needs for one session.
 * @param ctx - plugin context.
 * @param state - shared plugin state.
 * @param session - target session.
 * @param options - `{ detail, settings, projection, local }`.
 * @returns renderer input.
 */
export function gatherReportInput(ctx, state, session, options) {
  const settings = options?.settings ?? {}
  const values = readProjections(ctx, state, session)
  const ledger = ledgerOf(options?.projection, options?.local, session)
  // The folded session state contributes its last-seen seq markers as a
  // supplement for hosts where the ledger projection is unavailable.
  let markers
  try {
    const living = typeof state?.sessionState?.stateOf === 'function' ? state.sessionState.stateOf(session) : undefined
    if (living !== null && living !== undefined && typeof living === 'object') markers = living
  } catch (error) {
    logWarn(state, 'cacheReport: session-state marker read failed open: ' + describe(error))
  }
  return {
    detail: normalizeDetail(options?.detail, settings.detail),
    markers,
    usage: values.usage,
    pressure: values.pressure,
    breakdown: values.breakdown,
    ledger,
    prices: {
      inputPricePerMillion: settings.inputPricePerMillion,
      cacheReadPricePerMillion: settings.cacheReadPricePerMillion,
      outputPricePerMillion: settings.outputPricePerMillion,
    },
    healthThreshold: settings.healthThreshold,
    sessionMinutes: sessionAgeMinutes(session),
  }
}

/**
 * Load the host tools package through an injectable loader so tests can install
 * the module in a clean environment with no @deepseek-ai packages.
 * @param state - shared plugin state; `loadHost` may be injected by a harness.
 * @param onModule - called with the loaded module (sync or async delivery).
 * @param onError - called with the load error.
 */
function whenHostTools(state, onModule, onError) {
  const host = typeof state?.loadHost === 'function' ? state.loadHost : loadHost
  try {
    const loaded = host('@deepseek-ai/dsh-tools')
    if (loaded !== null && typeof loaded === 'object' && typeof loaded.then === 'function') {
      void loaded.then((module) => onModule(module)).catch((error) => onError(error))
      return
    }
    onModule(loaded)
  } catch (error) {
    onError(error)
  }
}

/** Build the `cache_report` definition from an injected defineTool. */
export function buildReportDefinition(defineTool, ctx, state, settings, projection, local) {
  return defineTool({
    name: TOOL_NAME,
    description:
      'Report this session prompt-cache economics and explain cache misses: uncached vs cache-read prompt tokens, '
      + 'hit ratio, estimated cost at the configured prices, context-window pressure and composition, expected-vs-unexpected '
      + 'miss attribution (compaction/prune/model switch/resume are expected rebuilds), and a compression ledger of '
      + 'released tokens and estimated savings. detail=summary (default) is a quick health check; attribution lists each '
      + 'significant cache-read drop; ledger shows compaction/prune releases; all renders everything. Read-only: it never '
      + 'changes the conversation and adds no prompt tokens.',
    parameters: {
      detail: {
        type: 'string',
        description: 'summary (default) | attribution | ledger | all',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      try {
        const session = exec?.agent?.session
        if (session === null || session === undefined) {
          return TOOL_NAME + ' has no session to report on: it must be called by the model from an agent turn.'
        }
        const detail = normalizeDetail(args?.detail, settings.detail)
        const input = gatherReportInput(ctx, state, session, { detail, settings, projection, local })
        return renderCacheReport(input)
      } catch (error) {
        logWarn(state, 'cacheReport: report failed open: ' + errorText(error))
        return TOOL_NAME + ' failed internally: ' + errorText(error) + '. No numbers were invented.'
      }
    },
  })
}

/** Register `/cache` for humans when the host exposes a command registry. */
function registerCacheCommand(ctx, state, settings, projection, local, track) {
  try {
    const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : undefined
    if (commands === null || commands === undefined || typeof commands.register !== 'function') return
    track(commands.register({
      name: 'cache',
      description: 'Show prompt-cache health, miss attribution and compression ledger for this session.',
      handler: (invocation) => {
        try {
          const agent = invocation?.agent
          const session = agent?.session
          if (session === null || session === undefined) {
            return { kind: 'error', text: 'cache: no session is attached to this agent.' }
          }
          const detail = settings.detail === 'summary' ? 'all' : settings.detail
          const input = gatherReportInput(ctx, state, session, { detail, settings, projection, local })
          return { kind: 'success', text: renderCacheReport(input) }
        } catch (error) {
          return { kind: 'error', text: 'cache: report failed: ' + errorText(error) }
        }
      },
    }))
  } catch (error) {
    logWarn(state, 'cacheReport: /cache command registration failed open: ' + describe(error))
  }
}

/**
 * Install the cache audit module.
 * @param ctx - plugin context (already inside a `ctx.effect` scope).
 * @param config - resolved row configuration.
 * @param state - shared plugin state (`log`, optional `loadHost`, `sessionState`).
 * @returns disposer.
 */
export function install(ctx, config, state) {
  const settings = resolveCacheConfig(config)
  const local = new WeakMap()
  const disposers = []
  let disposed = false
  const track = (disposer) => {
    if (typeof disposer !== 'function') return
    if (disposed) {
      try {
        disposer()
      } catch {
        /* disposal must not throw */
      }
      return
    }
    disposers.push(disposer)
  }
  const dispose = () => {
    disposed = true
    for (const entry of disposers.splice(0)) {
      try {
        entry()
      } catch {
        /* disposal must not throw */
      }
    }
  }
  if (!settings.enabled) return dispose

  const projection = registerLedgerProjection(ctx, state)

  // Keep the live fold warm for same-turn reads and for hosts without the
  // projection registry; the projection stays the authoritative path.
  try {
    const feed = state?.sessionState?.onEvent
    if (typeof feed === 'function') {
      track(feed((session, event) => {
        try {
          const next = foldLedger(local.get(session) ?? initialLedgerState(), event)
          local.set(session, next)
        } catch {
          /* observer failures must not break the session feed */
        }
      }))
    }
  } catch (error) {
    logWarn(state, 'cacheReport: session event feed unavailable: ' + describe(error))
  }

  if (typeof ctx?.tools?.register !== 'function') {
    logWarn(state, 'cacheReport: ctx.tools.register is unavailable; cache_report not registered')
  } else {
    whenHostTools(state, (module) => {
      const defineTool = module?.defineTool
      if (typeof defineTool !== 'function') {
        logWarn(state, 'cacheReport: @deepseek-ai/dsh-tools is unavailable; cache_report not registered')
        return
      }
      try {
        track(ctx.tools.register(buildReportDefinition(defineTool, ctx, state, settings, projection, local)))
      } catch (error) {
        logWarn(state, 'cacheReport: could not register cache_report: ' + describe(error))
      }
    }, (error) => {
      logWarn(state, 'cacheReport: host tools package load failed open: ' + describe(error))
    })
  }

  registerCacheCommand(ctx, state, settings, projection, local, track)

  try {
    state?.log?.('info', 'cacheReport active (cache_report tool registered, detail=' + settings.detail + ')')
  } catch {
    /* logging is best-effort */
  }

  return () => {
    dispose()
    const handle = projection.handle
    projection.handle = null
    if (handle !== null && handle !== undefined) {
      try {
        const disposing = typeof handle.dispose === 'function' ? handle.dispose() : undefined
        if (disposing !== undefined && disposing !== null && typeof disposing.then === 'function') {
          Promise.resolve(disposing).catch(() => {})
        }
      } catch {
        /* disposal must not throw */
      }
    }
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
