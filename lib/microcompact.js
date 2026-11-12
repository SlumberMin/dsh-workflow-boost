/**
 * microcompact (ZCode) — clear stale tool results under context pressure so a
 * full summarization compaction is not the first (and most expensive) remedy.
 *
 * Mechanics, all replay-safe:
 *   - Trigger on agent/pre-step from the routed context pressure (pressure
 *     ratio, remaining-budget reserve, or absolute token ceiling) or after
 *     idleMinutes without a step. Never while a compaction transaction owns the
 *     surface: the durable lock is read from the plugin session-state fold,
 *     never from the deprecated session.eventAt() reader.
 *   - Protect the newest keepRecentGroups assistant-turn groups (all parallel
 *     results of one turn together, not the newest N flat results), the first
 *     keepFirstEvents observed results, error results, non-text results, and
 *     short results.
 *   - Replace older results through a logged surface replacement (surfaceOp
 *     replace + sourceEventSeqs) so the original content stays in the
 *     append-only log and replay can recover it. Each replacement is preceded
 *     by a compaction/prune shadow-price claim, exactly like the shipped
 *     tool-result pruner, so pressure folds stay truthful.
 *   - A pass that cannot save MIN_SAVINGS_TOKENS commits nothing (the ZCode
 *     "not worth it" rollback).
 *   - Any failure is logged and swallowed: this module must never break a turn.
 *
 * Event access: the event log is observed through session/event; the deprecated
 * synchronous readers (eventAt/snapshotEvents/ownEvents) are not used. Seed
 * events from a resumed session are never replayed as session/event, so their
 * results are not eligible for rewriting — native compaction owns that history,
 * and this module simply skips it (fail-open) instead of guessing.
 *
 * Why this keeps the cache cheap: clearing starts from the OLDEST results, so
 * the reusable prefix only breaks at the first cleared position, far behind the
 * current tail, instead of the whole prompt being rewritten.
 *
 * @module dsh-workflow-boost/lib/microcompact
 */
import { estimateTokens, loadHost, logInfo, logWarn } from './shared.js'
import {
  MIN_SAVINGS_TOKENS,
  describeTrigger,
  evaluateTrigger,
  isReplaceableToolMessage,
  planMicrocompact,
  resolveMicrocompactConfig,
} from './pure/microcompact-plan.js'

export {
  MIN_SAVINGS_TOKENS,
  describeTrigger,
  evaluateTrigger,
  isReplaceableToolMessage,
  planMicrocompact,
  resolveMicrocompactConfig,
}

/** How many observed tool-result events one session keeps for rewriting. */
export const OBSERVED_EVENT_LIMIT = 4096

/** Resolve the module config with defaults, guarded so install never throws. */
export function resolveConfig(config) {
  return resolveMicrocompactConfig(config)
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the injected host loader; state.loadHost lets tests fake the host. */
function hostLoader(state) {
  if (state !== null && typeof state === 'object' && typeof state.loadHost === 'function') return state.loadHost
  return loadHost
}

/**
 * Install the module.
 * @param ctx - plugin context (Cordis).
 * @param config - resolved plugin config.
 * @param state - shared plugin state with sessionState, log and optional loadHost.
 * @returns a disposer that stops further passes.
 */
export function install(ctx, config, state) {
  let settings
  try {
    settings = resolveMicrocompactConfig(config)
  } catch (error) {
    logWarn(state, 'microcompact: config resolution failed: ' + describe(error))
    return undefined
  }
  if (!settings.enabled) return undefined
  if (settings.legacyKeepRecentToolResults) {
    logWarn(
      state,
      'microcompact: keepRecentToolResults is deprecated; it is read as keepRecentGroups so only one "recent" semantics exists',
    )
  }

  const observed = new WeakMap()
  const windows = new WeakMap()
  const lastStepAt = new WeakMap()
  const disposers = []
  let active = true
  let llmPromise

  /** Lazily resolve freezeMessage; absent in a clean environment, hence optional. */
  function llmModule() {
    if (llmPromise === undefined) {
      llmPromise = Promise.resolve()
        .then(() => hostLoader(state)('@deepseek-ai/dsh-llm'))
        .catch(() => undefined)
    }
    return llmPromise
  }

  /** Remember one observed tool result so it can be rewritten later. */
  function observe(session, event) {
    try {
      if (session === undefined || session === null || event === null || typeof event !== 'object') return
      if (event.type !== 'tool/result') return
      let cache = observed.get(session)
      if (cache === undefined) {
        cache = new Map()
        observed.set(session, cache)
      }
      cache.set(event.seq, event)
      while (cache.size > OBSERVED_EVENT_LIMIT) {
        const oldest = cache.keys().next().value
        cache.delete(oldest)
      }
    } catch {
      /* observation must never break the event feed */
    }
  }

  /** Fold state for one session, or undefined when the plugin state is unavailable. */
  function foldedState(session) {
    try {
      const service = state?.sessionState
      if (service === null || service === undefined || typeof service.stateOf !== 'function') return undefined
      const folded = service.stateOf(session)
      return folded !== null && typeof folded === 'object' ? folded : undefined
    } catch {
      return undefined
    }
  }

  /** Current prompt size and routed window, or undefined when the meter cannot tell. */
  function readPressure(session) {
    try {
      const meter = ctx.get?.('tokenMeter')
      if (meter === null || meter === undefined) return undefined
      let contextWindow
      let pressureTokens
      if (typeof meter.contextPressure === 'function') {
        const pressure = meter.contextPressure(session)
        if (pressure !== null && pressure !== undefined && typeof pressure === 'object') {
          if (Number.isFinite(Number(pressure.contextWindow))) contextWindow = Number(pressure.contextWindow)
          if (Number.isFinite(Number(pressure.pressureTokens))) pressureTokens = Number(pressure.pressureTokens)
        }
      }
      if (contextWindow !== undefined && contextWindow > 0) windows.set(session, contextWindow)
      else contextWindow = windows.get(session)
      if (pressureTokens === undefined && typeof meter.measure === 'function') {
        const measured = meter.measure(session)
        if (measured !== null && measured !== undefined && Number.isFinite(Number(measured.totalTokens))) {
          pressureTokens = Number(measured.totalTokens)
        }
      }
      if (pressureTokens === undefined) return undefined
      return { pressureTokens, contextWindow }
    } catch {
      return undefined
    }
  }

  /** Text estimator: prefer the host meter so the savings floor uses real numbers. */
  function createEstimator() {
    let meter
    try {
      meter = ctx.get?.('tokenMeter')
    } catch {
      meter = undefined
    }
    if (meter === null || meter === undefined || typeof meter.estimateMessage !== 'function') return estimateTokens
    return (text) => {
      try {
        return meter.estimateMessage({
          role: 'tool',
          source: { kind: 'tool', callId: 'microcompact-estimate' },
          toolCallId: 'microcompact-estimate',
          content: [{ type: 'text', text: String(text ?? '') }],
        })
      } catch {
        return estimateTokens(text)
      }
    }
  }

  /** Derive the model message for one observed tool-result event. */
  function deriveMessage(session, event) {
    try {
      if (typeof session.deriveEventMessage === 'function') {
        const derived = session.deriveEventMessage(event)
        if (derived !== null && derived !== undefined) return derived
      }
    } catch {
      /* fall through to the logged message */
    }
    return event?.data?.message
  }

  /** Build the placeholder message; freezeMessage is optional in a clean env. */
  function placeholderMessage(original, placeholderText, freeze) {
    const message = { ...original, content: [{ type: 'text', text: placeholderText }] }
    if (typeof freeze === 'function') {
      const frozen = freeze(message)
      if (frozen !== null && frozen !== undefined) return frozen
    }
    return message
  }

  /** Commit a plan against the session; every replacement is individually contained. */
  async function applyPlan(session, plan) {
    const llm = await llmModule()
    const freeze = llm !== null && typeof llm === 'object' && typeof llm.freezeMessage === 'function' ? llm.freezeMessage : undefined
    const meter = ctx.get?.('tokenMeter')
    const cache = observed.get(session)
    let applied = 0
    let savedChars = 0
    let savedTokens = 0
    for (const replacement of plan.replacements) {
      try {
        const original = cache?.get(replacement.seq)
        if (original === undefined || original === null || original.type !== 'tool/result') continue
        const originalMessage = deriveMessage(session, original)
        if (!isReplaceableToolMessage(originalMessage)) continue
        const message = placeholderMessage(originalMessage, plan.placeholderText, freeze)
        // Price the shadowed node like the shipped pruner: the claim is written
        // immediately before the replacement that consumes it.
        let shadowedTokenCount = 0
        try {
          if (typeof meter?.estimateMessage === 'function') shadowedTokenCount = meter.estimateMessage(originalMessage) ?? 0
        } catch {
          shadowedTokenCount = 0
        }
        try {
          session.append('compaction/prune', {
            shadowedRange: { start: replacement.seq, end: replacement.seq },
            shadowedSeqs: [replacement.seq],
            shadowedTokenCount,
          })
        } catch {
          // Without a price claim the replacement still folds correctly; only
          // the shadow-price accounting event is lost.
        }
        session.append(
          'tool/result',
          { ...original.data, message },
          {
            surfaceOp: { op: 'replace', startSeq: replacement.seq, endSeq: replacement.seq },
            sourceEventSeqs: [replacement.seq],
          },
        )
        applied += 1
        savedChars += replacement.charsBefore
        savedTokens += Math.max(0, replacement.tokensBefore - replacement.tokensAfter)
      } catch (error) {
        logWarn(state, 'microcompact: replacement at seq ' + replacement.seq + ' failed: ' + describe(error))
      }
    }
    return { applied, savedChars, savedTokens }
  }

  /** Run one pass for one agent, swallowing every internal failure. */
  async function maybeCompact(agent) {
    const session = agent?.session
    if (session === undefined || session === null) return
    if (session.surface === undefined || !Array.isArray(session.surface.nodes) || typeof session.append !== 'function') return
    const now = Date.now()
    const previous = lastStepAt.get(session)
    lastStepAt.set(session, now)

    const folded = foldedState(session)
    if (folded === undefined) {
      state.log?.('debug', 'microcompact: session state unavailable; skipping rather than risking a compaction overlap')
      return
    }
    if (folded.compactionOpen === true) {
      state.log?.('debug', 'microcompact: skipped, a compaction transaction owns the surface')
      return
    }

    const pressure = readPressure(session)
    const decision = evaluateTrigger({
      pressureTokens: pressure?.pressureTokens,
      contextWindow: pressure?.contextWindow,
      triggerRatio: settings.triggerRatio,
      triggerTokens: settings.triggerTokens,
      minRemainingTokens: settings.minRemainingTokens,
    })
    let trigger = decision.shouldTrigger ? describeTrigger(decision) : ''
    if (trigger.length === 0 && settings.idleMinutes > 0 && previous !== undefined && now - previous >= settings.idleMinutes * 60000) {
      trigger = 'idle(' + Math.round((now - previous) / 60000) + 'm)'
    }
    if (trigger.length === 0) return

    const nodes = [...session.surface.nodes]
    const plan = planMicrocompact({
      surfaceNodes: nodes,
      eventFor: (seq) => observed.get(session)?.get(seq),
      messageFor: (event) => deriveMessage(session, event),
      estimate: createEstimator(),
      keepRecentGroups: settings.keepRecentGroups,
      keepFirstEvents: settings.keepFirstEvents,
      minCharsPerResult: settings.minCharsPerResult,
      maxResultsPerPass: settings.maxResultsPerPass,
      placeholderText: settings.placeholder,
    })
    if (plan.replacements.length === 0) {
      state.log?.('debug', 'microcompact: ' + trigger + ' but no stale tool result qualifies')
      return
    }
    if (plan.estimatedTokensSaved < MIN_SAVINGS_TOKENS) {
      state.log?.(
        'debug',
        'microcompact: ' + trigger + ' would save ~' + plan.estimatedTokensSaved + ' tokens; below the ' +
          MIN_SAVINGS_TOKENS + ' token floor, keeping history intact',
      )
      return
    }
    const result = await applyPlan(session, plan)
    if (result.applied === 0) return
    logInfo(
      state,
      'microcompact (' + trigger + '): cleared ' + result.applied + ' stale tool result(s), ~' +
        result.savedTokens + ' tokens / ' + result.savedChars + ' chars; kept the newest ' +
        plan.keptGroups + ' group(s) and protected ' + plan.keepFirstEvents + ' leading result(s)',
    )
  }

  try {
    const dispose = ctx.on(
      'agent/pre-step',
      async (payload, next) => {
        try {
          if (active) await maybeCompact(payload?.agent)
        } catch (error) {
          logWarn(state, 'microcompact: pass failed: ' + describe(error))
        }
        return next()
      },
      { prepend: true },
    )
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    logWarn(state, 'microcompact: could not listen for agent/pre-step: ' + describe(error))
    return undefined
  }

  try {
    const dispose = ctx.on('session/event', (session, event) => {
      if (active) observe(session, event)
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    logWarn(state, 'microcompact: could not observe session/event: ' + describe(error))
  }

  return () => {
    active = false
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* disposal must not throw */
      }
    }
    disposers.length = 0
  }
}
