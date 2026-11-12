/**
 * Pure microcompact planning — no host imports, no session access.
 *
 * microcompact clears stale tool results *before* a full summarization
 * compaction becomes the only remedy. This module owns every decision a pass
 * makes (which results qualify, which assistant-turn groups are protected, how
 * much a pass would save); lib/microcompact.js only wires it to the session
 * event feed and the surface replacement API. Keeping it pure means the whole
 * policy is unit-testable in a clean Node environment.
 *
 * Grouping note (0.1.1 fix #3): "keep the newest N tool results" was wrong,
 * because one assistant turn can emit several parallel tool results. Dropping
 * only some of them leaves a half-answered step in history. The protected unit
 * is therefore the assistant-turn group: the tool results that share one
 * `tool/result` turn/step pair. keepRecentToolResults survives only as a
 * deprecated alias for keepRecentGroups so old rows keep loading; it never
 * selects a different semantics.
 *
 * @module dsh-workflow-boost/lib/pure/microcompact-plan
 */
import { contentText, estimateTokens, clampNumber, roundInt } from '../shared.js'
import { DEFAULTS, sectionDefaults } from '../defaults.js'

/** A pass that would save fewer than this many estimated tokens commits nothing. */
export const MIN_SAVINGS_TOKENS = 256

/** Windows larger than this keep a flat 20k reserve; smaller windows keep a ratio. */
export const AUTO_WINDOW_TOKENS = 200000
export const AUTO_REMAINING_TOKENS = 20000
export const AUTO_REMAINING_RATIO = 0.2

/** Documented placeholder text; lib/defaults.js is authoritative for the runtime value. */
export const DEFAULT_PLACEHOLDER = DEFAULTS.microcompact.placeholder

const MAX_GROUPS = 50
const MAX_FIRST_EVENTS = 20
const MAX_RESULTS_PER_PASS = 200

/** Integer option clamped into [0, max] with a fallback for junk input. */
function integerOption(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(0, Math.floor(number)))
}

/**
 * Resolve the row config into one normalized settings object.
 *
 * The legacy key is only read when keepRecentGroups is absent: accepting both as
 * independent knobs would give the module two competing meanings for "recent",
 * which is exactly the bug 0.1.1 fix #3 asks us to remove.
 * @param config - plugin row config (a section may be missing).
 * @returns normalized settings plus a legacyKeptToolResults marker for the
 *   wiring layer to log once.
 */
export function resolveMicrocompactConfig(config) {
  const merged = sectionDefaults('microcompact', config)
  const raw = config?.microcompact !== null && typeof config?.microcompact === 'object' ? config.microcompact : {}
  const legacyUsed = raw.keepRecentGroups === undefined && Number.isFinite(Number(raw.keepRecentToolResults))
  const groups = legacyUsed
    ? integerOption(raw.keepRecentToolResults, merged.keepRecentGroups, MAX_GROUPS)
    : integerOption(merged.keepRecentGroups, DEFAULTS.microcompact.keepRecentGroups, MAX_GROUPS)
  const placeholder = typeof merged.placeholder === 'string' && merged.placeholder.length > 0
    ? merged.placeholder
    : DEFAULT_PLACEHOLDER
  return {
    enabled: config?.enabled !== false && merged.enabled !== false,
    triggerRatio: clampNumber(merged.triggerRatio, DEFAULTS.microcompact.triggerRatio, 0.3, 0.95),
    triggerTokens: Math.max(0, integerOption(merged.triggerTokens, 0, Number.MAX_SAFE_INTEGER)),
    minRemainingTokens: Math.max(0, integerOption(merged.minRemainingTokens, 0, Number.MAX_SAFE_INTEGER)),
    keepRecentGroups: groups,
    keepFirstEvents: integerOption(merged.keepFirstEvents, DEFAULTS.microcompact.keepFirstEvents, MAX_FIRST_EVENTS),
    minCharsPerResult: Math.max(1, integerOption(merged.minCharsPerResult, DEFAULTS.microcompact.minCharsPerResult, Number.MAX_SAFE_INTEGER)),
    maxResultsPerPass: Math.max(1, integerOption(merged.maxResultsPerPass, DEFAULTS.microcompact.maxResultsPerPass, MAX_RESULTS_PER_PASS)),
    idleMinutes: Math.max(0, Number.isFinite(Number(merged.idleMinutes)) ? Number(merged.idleMinutes) : DEFAULTS.microcompact.idleMinutes),
    placeholder,
    legacyKeepRecentToolResults: legacyUsed,
  }
}

/**
 * Remaining-context budget below which a pass is allowed to fire.
 *
 * An explicit minRemainingTokens always wins; 0 means "derive it from the
 * window": large windows keep a flat 20k so a 1M-token route is not compacted
 * for most of its life, small windows keep 20% because 20k would be too late.
 * @param contextWindow - routed context window in tokens (unknown when 0).
 * @param configured - explicit minRemainingTokens (0 = automatic).
 * @returns the reserve in tokens, 0 when the window is unknown.
 */
export function resolveRemainingBudget(contextWindow, configured) {
  const explicit = Number(configured)
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  const window = Number(contextWindow)
  if (!Number.isFinite(window) || window <= 0) return 0
  return window > AUTO_WINDOW_TOKENS ? AUTO_REMAINING_TOKENS : Math.floor(window * AUTO_REMAINING_RATIO)
}

/**
 * Decide whether the current pressure should start a pass.
 *
 * The two P1 thresholds are alternatives: pressure ratio OR remaining budget.
 * triggerTokens is the optional absolute override from spec 1.1 for routes
 * whose window is unknown or whose ratio is not comparable to the native
 * compactor's character-based threshold.
 * @param input.pressureTokens - current routed prompt size (undefined when unknown).
 * @param input.contextWindow - routed context window (undefined when unknown).
 * @param input.triggerRatio - pressure ratio threshold.
 * @param input.triggerTokens - absolute token ceiling (0 disables).
 * @param input.minRemainingTokens - remaining-token reserve (0 = automatic).
 * @returns a decision record with the resolved thresholds for the log line.
 */
export function evaluateTrigger(input = {}) {
  const decision = {
    shouldTrigger: false,
    reason: 'none',
    pressureTokens: undefined,
    contextWindow: undefined,
    ratio: undefined,
    remainingTokens: undefined,
    remainingBudget: undefined,
    triggerRatio: clampNumber(input.triggerRatio, DEFAULTS.microcompact.triggerRatio, 0.3, 0.95),
    triggerTokens: Math.max(0, roundInt(input.triggerTokens, 0)),
  }
  const pressure = Number(input.pressureTokens)
  if (!Number.isFinite(pressure) || pressure < 0) {
    decision.reason = 'unknown'
    return decision
  }
  decision.pressureTokens = pressure
  const window = Number(input.contextWindow)
  if (Number.isFinite(window) && window > 0) {
    decision.contextWindow = window
    decision.ratio = pressure / window
    decision.remainingBudget = resolveRemainingBudget(window, input.minRemainingTokens)
    decision.remainingTokens = Math.max(0, window - pressure)
    if (decision.ratio >= decision.triggerRatio) {
      decision.shouldTrigger = true
      decision.reason = 'pressure'
    } else if (decision.remainingTokens <= decision.remainingBudget) {
      decision.shouldTrigger = true
      decision.reason = 'remaining'
    }
  }
  if (!decision.shouldTrigger && decision.triggerTokens > 0 && pressure >= decision.triggerTokens) {
    decision.shouldTrigger = true
    decision.reason = 'absolute'
  }
  return decision
}

/** Render one trigger decision as a short reason suffix for logs. */
export function describeTrigger(decision) {
  if (decision === undefined || decision === null) return 'unknown'
  if (decision.reason === 'pressure') {
    return 'pressure(' + decision.ratio.toFixed(2) + ' >= ' + decision.triggerRatio + ')'
  }
  if (decision.reason === 'remaining') {
    return 'remaining(' + decision.remainingTokens + ' <= ' + decision.remainingBudget + ')'
  }
  if (decision.reason === 'absolute') {
    return 'absolute(' + decision.pressureTokens + ' >= ' + decision.triggerTokens + ')'
  }
  return decision.reason ?? 'unknown'
}

/** Whether one derived tool message can be replaced by a text placeholder. */
export function isReplaceableToolMessage(message) {
  try {
    if (message === undefined || message === null || message.role !== 'tool') return false
    if (message.isError === true) return false
    const content = Array.isArray(message.content) ? message.content : []
    if (content.length === 0) return false
    if (!content.every((block) => block && typeof block === 'object' && block.type === 'text')) return false
    return contentText(message.content).length > 0
  } catch {
    return false
  }
}

/**
 * Partition surface tool results into assistant-turn groups.
 *
 * A group is a run of tool results sharing the same turn/step, i.e. one
 * assistant message and its (possibly parallel) calls. Results without turn
 * metadata fall back to their own single-entry group so an unknown producer
 * never widens the protected window by accident.
 * @param entries - [{ seq, event }] in surface order.
 * @returns ordered groups with the stable grouping key.
 */
export function groupToolResults(entries) {
  const groups = []
  let current
  for (const entry of entries) {
    const turn = Number(entry?.event?.data?.turn)
    const step = Number(entry?.event?.data?.step)
    const known = Number.isFinite(turn) && Number.isFinite(step)
    const key = known ? 'turn:' + turn + '/step:' + step : 'seq:' + entry.seq
    if (current === undefined || current.key !== key) {
      current = { key, turn: known ? turn : undefined, step: known ? step : undefined, entries: [] }
      groups.push(current)
    }
    current.entries.push(entry)
  }
  return groups
}

/** Read one plan option, preferring an explicit override over resolved settings. */
function option(input, key, fallback) {
  const value = input?.[key]
  return value === undefined || value === null ? fallback : value
}

/**
 * Plan one microcompact pass. No session is mutated, so the plan is safe to
 * compute, log, and unit-test before anything is appended.
 * @param input.surfaceNodes - current surface seqs, oldest first.
 * @param input.eventFor - resolves one seq to its observed event (or undefined).
 * @param input.messageFor - resolves one event to its derived model message.
 * @param input.settings - normalized settings from resolveMicrocompactConfig.
 * @param input.estimate - text-to-token estimator (defaults to the shared heuristic).
 * @returns replacements plus a why-skipped tally and the savings verdict.
 */
export function planMicrocompact(input = {}) {
  const settings = input.settings !== undefined && input.settings !== null
    ? input.settings
    : resolveMicrocompactConfig(input.config)
  const surfaceNodes = Array.isArray(input.surfaceNodes) ? input.surfaceNodes : []
  const eventFor = typeof input.eventFor === 'function' ? input.eventFor : () => undefined
  const messageFor = typeof input.messageFor === 'function'
    ? input.messageFor
    : (event) => event?.data?.message
  const estimate = typeof input.estimate === 'function' ? input.estimate : estimateTokens
  const keepRecentGroups = integerOption(option(input, 'keepRecentGroups', settings.keepRecentGroups), 0, MAX_GROUPS)
  const keepFirstEvents = integerOption(option(input, 'keepFirstEvents', settings.keepFirstEvents), 0, MAX_FIRST_EVENTS)
  const minCharsPerResult = Math.max(1, integerOption(option(input, 'minCharsPerResult', settings.minCharsPerResult), 1, Number.MAX_SAFE_INTEGER))
  const maxResultsPerPass = Math.max(1, integerOption(option(input, 'maxResultsPerPass', settings.maxResultsPerPass), 1, MAX_RESULTS_PER_PASS))
  const placeholderText = typeof option(input, 'placeholderText', settings.placeholder) === 'string' &&
    String(option(input, 'placeholderText', settings.placeholder)).length > 0
    ? String(option(input, 'placeholderText', settings.placeholder))
    : DEFAULT_PLACEHOLDER

  const skipped = {
    unobserved: 0,
    error: 0,
    nonText: 0,
    alreadyCleared: 0,
    tooSmall: 0,
    firstEvents: 0,
    protectedGroup: 0,
    overCap: 0,
  }

  // Only events observed since this process started can be rewritten: the
  // deprecated eventAt() reader is off-limits, and a seed on resume never
  // replays through session/event. Unknown nodes are simply not candidates.
  const toolResults = []
  for (const seq of surfaceNodes) {
    let event
    try {
      event = eventFor(seq)
    } catch {
      event = undefined
    }
    if (event === undefined || event === null) {
      skipped.unobserved += 1
      continue
    }
    if (event.type !== 'tool/result') continue
    toolResults.push({ seq, event })
  }

  const groups = groupToolResults(toolResults)
  const keptGroupCount = Math.min(keepRecentGroups, groups.length)
  const staleGroupCount = Math.max(0, groups.length - keepRecentGroups)
  // Stale groups are the OLDEST ones; anything at/after this index is kept.
  const firstStaleGroup = staleGroupCount
  const placeholderTokens = Math.max(0, Number(estimate(placeholderText)) || 0)
  const placeholderTrimmed = placeholderText.trim()

  const replacements = []
  let firstSeen = 0
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]
    const protectedGroup = groupIndex >= firstStaleGroup
    for (const entry of group.entries) {
      firstSeen += 1
      if (firstSeen <= keepFirstEvents) {
        skipped.firstEvents += 1
        continue
      }
      if (protectedGroup) {
        skipped.protectedGroup += 1
        continue
      }
      if (replacements.length >= maxResultsPerPass) {
        skipped.overCap += 1
        continue
      }
      let message
      try {
        message = messageFor(entry.event)
      } catch {
        message = undefined
      }
      if (entry.event?.data?.error !== undefined || message?.isError === true) {
        skipped.error += 1
        continue
      }
      if (!isReplaceableToolMessage(message)) {
        skipped.nonText += 1
        continue
      }
      const text = contentText(message.content)
      if (text.trim() === placeholderTrimmed) {
        skipped.alreadyCleared += 1
        continue
      }
      if (text.length < minCharsPerResult) {
        skipped.tooSmall += 1
        continue
      }
      const tokensBefore = Math.max(0, Number(estimate(text)) || 0)
      if (tokensBefore - placeholderTokens <= 0) {
        skipped.tooSmall += 1
        continue
      }
      replacements.push({
        seq: entry.seq,
        callId: message.toolCallId ?? message.source?.callId,
        turn: group.turn,
        step: group.step,
        charsBefore: text.length,
        tokensBefore,
        tokensAfter: placeholderTokens,
      })
    }
  }

  let estimatedTokensSaved = 0
  for (const replacement of replacements) {
    estimatedTokensSaved += Math.max(0, replacement.tokensBefore - replacement.tokensAfter)
  }

  return {
    totalToolResults: toolResults.length,
    totalGroups: groups.length,
    keptGroups: keptGroupCount,
    staleGroups: staleGroupCount,
    keepRecentGroups,
    keepFirstEvents,
    replacements,
    skipped,
    estimatedTokensSaved,
    minSavingsTokens: MIN_SAVINGS_TOKENS,
    belowSavingsFloor: estimatedTokensSaved < MIN_SAVINGS_TOKENS,
    placeholderText,
  }
}
