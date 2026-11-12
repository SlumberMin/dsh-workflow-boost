/**
 * Pure cacheAudit core: ledger folding, miss attribution, compression math and
 * report rendering.
 *
 * No host packages, no fs, no clock and no session reads: the running plugin
 * only feeds committed session events into foldLedger() and reads projections;
 * the unit tests drive the same functions directly. Everything returns data and
 * never throws, because a diagnostics tool must not be able to break a session.
 */

/** Session-projection key for the plugin-owned request ledger. */
export const CACHE_LEDGER_KEY = 'workflow-boost:cache-ledger'
/** Bump when fields or fold semantics change; a version conflict falls back to live folding. */
export const CACHE_LEDGER_STATE_VERSION = 1

/** Projection keys this module reads from dsh-token-meter. */
export const TOKEN_USAGE_KEY = 'tokenUsage'
export const CONTEXT_PRESSURE_KEY = 'contextPressure'
export const CONTEXT_BREAKDOWN_KEY = 'contextBreakdown'

/** Contract constants shared by the host module and its tests. */
export const CACHE_LEDGER_CONTRACT = Object.freeze({
  projectionKey: CACHE_LEDGER_KEY,
  stateVersion: CACHE_LEDGER_STATE_VERSION,
  usageKey: TOKEN_USAGE_KEY,
  pressureKey: CONTEXT_PRESSURE_KEY,
  breakdownKey: CONTEXT_BREAKDOWN_KEY,
})

/** Report detail levels, in increasing verbosity. */
export const DETAIL_LEVELS = Object.freeze(['summary', 'attribution', 'ledger', 'all'])

/** Defaults mirror lib/defaults.js so the module also works when applied directly. */
export const CACHE_REPORT_DEFAULTS = Object.freeze({
  enabled: true,
  detail: 'summary',
  healthThreshold: 90,
  inputPricePerMillion: 0.28,
  cacheReadPricePerMillion: 0.028,
  outputPricePerMillion: 0.42,
})

/** A cache-read share drop above this many percentage points is a real miss. */
export const DEFAULT_MISS_THRESHOLD_PP = 30

/** Bounded ledger sizes: projections must not grow with session length. */
export const SAMPLE_LIMIT = 24
export const EXPECTED_LIMIT = 32
export const SIGNAL_LIMIT = 16
export const EPISODE_LIMIT = 12
export const MAX_REPORT_CHARS = 16000

/** Clamp one finite number into [min, max], falling back for junk. */
export function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Coerce to a finite number, else undefined. */
function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** Coerce a non-negative finite number, else 0. */
function nonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/** CJK-aware char-per-token estimate, dependency-free for the pure fold. */
export function estimateTokens(text) {
  const source = String(text ?? '')
  if (source.length === 0) return 0
  let cjk = 0
  let other = 0
  let lines = 0
  for (const ch of source) {
    const code = ch.codePointAt(0)
    if (code === 10) lines += 1
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.6 + other / 4 + lines * 0.25)
}

/** Format an integer with thousands separators (stable across locales). */
export function formatTokens(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  const rounded = Math.round(number)
  const sign = rounded < 0 ? '-' : ''
  const digits = Math.abs(rounded).toString()
  let out = ''
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ','
    out += digits[index]
  }
  return sign + out
}

/** Percentage string with one decimal, guarding division by zero. */
export function percent(part, whole) {
  const ratio = ratioOf(part, whole)
  return ratio === null ? '0.0%' : (ratio * 100).toFixed(1) + '%'
}

/** Ratio in [0, 1], or null when the whole is not a usable positive number. */
export function ratioOf(part, whole) {
  const total = Number(whole)
  const value = Number(part)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(value)) return null
  return value / total
}

/** Round to one decimal without producing "-0.0". */
function round1(value) {
  const rounded = Math.round(Number(value) * 10) / 10
  return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * Resolve the cacheReport section.
 * @param config - resolved row configuration (or the section itself).
 * @returns normalized settings.
 */
export function resolveCacheConfig(config) {
  let section = {}
  let masterEnabled = true
  if (config !== null && typeof config === 'object') {
    if (config.enabled === false) masterEnabled = false
    section = config.cacheReport !== null && typeof config.cacheReport === 'object' && config.cacheReport !== undefined
      ? config.cacheReport
      : config
  }
  const detailCandidate = typeof section.detail === 'string' ? section.detail.trim().toLowerCase() : ''
  const detail = DETAIL_LEVELS.includes(detailCandidate) ? detailCandidate : CACHE_REPORT_DEFAULTS.detail
  const enabled = masterEnabled && section.enabled !== false
  const pick = (key) => {
    const value = Number(section[key])
    return Number.isFinite(value) && value >= 0 ? value : CACHE_REPORT_DEFAULTS[key]
  }
  return {
    enabled,
    detail,
    healthThreshold: clampNumber(section.healthThreshold, CACHE_REPORT_DEFAULTS.healthThreshold, 0, 100),
    inputPricePerMillion: pick('inputPricePerMillion'),
    cacheReadPricePerMillion: pick('cacheReadPricePerMillion'),
    outputPricePerMillion: pick('outputPricePerMillion'),
  }
}

/**
 * Normalize the detail argument of one cache_report call.
 * @param value - raw model argument.
 * @param fallback - configured default.
 * @returns one of DETAIL_LEVELS.
 */
export function normalizeDetail(value, fallback = 'summary') {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (DETAIL_LEVELS.includes(candidate)) return candidate
  return DETAIL_LEVELS.includes(fallback) ? fallback : 'summary'
}

/**
 * Read one provider-usage object or tokenUsage bucket view into four buckets.
 * Accepts both the provider shape (inputTokens) and the bucket shape
 * (uncachedInputTokens); returns undefined when no bucket field is present so
 * "no data" is never confused with "zero usage".
 * @param value - usage object of unknown shape.
 * @returns `{ uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }`.
 */
export function parseBuckets(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const present = ['uncachedInputTokens', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
    .some((key) => Object.hasOwn(value, key))
  if (!present) return undefined
  return {
    uncachedInputTokens: nonNegative(value.uncachedInputTokens !== undefined ? value.uncachedInputTokens : value.inputTokens),
    cacheReadTokens: nonNegative(value.cacheReadTokens),
    cacheWriteTokens: nonNegative(value.cacheWriteTokens),
    outputTokens: nonNegative(value.outputTokens),
  }
}

/** Prompt-side tokens of one bucket set (input plus cache traffic, no output). */
export function promptTokensOf(buckets) {
  if (buckets === null || typeof buckets !== 'object') return 0
  return nonNegative(buckets.uncachedInputTokens) + nonNegative(buckets.cacheReadTokens) + nonNegative(buckets.cacheWriteTokens)
}

/** Add one bucket set onto another without mutating either. */
function addBuckets(left, right) {
  return {
    uncachedInputTokens: nonNegative(left?.uncachedInputTokens) + nonNegative(right?.uncachedInputTokens),
    cacheReadTokens: nonNegative(left?.cacheReadTokens) + nonNegative(right?.cacheReadTokens),
    cacheWriteTokens: nonNegative(left?.cacheWriteTokens) + nonNegative(right?.cacheWriteTokens),
    outputTokens: nonNegative(left?.outputTokens) + nonNegative(right?.outputTokens),
  }
}

/** Subtract one bucket set from another, clamping at zero. */
function subtractBuckets(left, right) {
  return {
    uncachedInputTokens: Math.max(0, nonNegative(left?.uncachedInputTokens) - nonNegative(right?.uncachedInputTokens)),
    cacheReadTokens: Math.max(0, nonNegative(left?.cacheReadTokens) - nonNegative(right?.cacheReadTokens)),
    cacheWriteTokens: Math.max(0, nonNegative(left?.cacheWriteTokens) - nonNegative(right?.cacheWriteTokens)),
    outputTokens: Math.max(0, nonNegative(left?.outputTokens) - nonNegative(right?.outputTokens)),
  }
}

/** Fill missing bucket fields with zero so arithmetic stays total. */
function zeroBuckets() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

/**
 * Estimate cost in USD from the four provider buckets.
 * @param buckets - bucket set.
 * @param prices - per-million USD prices.
 * @returns `{ totalUsd, promptUsd, outputUsd, cacheReadUsd, savingsUsd, promptTokens }`.
 */
export function estimateCost(buckets, prices) {
  const safePrices = prices !== null && typeof prices === 'object' ? prices : {}
  const inputPrice = nonNegative(safePrices.inputPricePerMillion)
  const cacheReadPrice = nonNegative(safePrices.cacheReadPricePerMillion)
  const outputPrice = nonNegative(safePrices.outputPricePerMillion)
  const uncached = nonNegative(buckets?.uncachedInputTokens)
  const cacheRead = nonNegative(buckets?.cacheReadTokens)
  const cacheWrite = nonNegative(buckets?.cacheWriteTokens)
  const output = nonNegative(buckets?.outputTokens)
  const promptUsd = ((uncached + cacheWrite) * inputPrice) / 1e6
  const cacheReadUsd = (cacheRead * cacheReadPrice) / 1e6
  const outputUsd = (output * outputPrice) / 1e6
  const fullPrice = ((uncached + cacheWrite + cacheRead) * inputPrice) / 1e6
  return {
    totalUsd: promptUsd + cacheReadUsd + outputUsd,
    promptUsd,
    cacheReadUsd,
    outputUsd,
    savingsUsd: Math.max(0, fullPrice - (promptUsd + cacheReadUsd)),
    promptTokens: uncached + cacheWrite + cacheRead,
  }
}

/** Fresh ledger state for the projection and the in-memory fallback. */
export function initialLedgerState() {
  return {
    seq: -1,
    totals: zeroBuckets(),
    lastKey: null,
    samples: [],
    expected: [],
    signals: [],
    prunes: [],
    summaries: [],
    compactionStarts: 0,
    requestCount: 0,
  }
}

/** Append one entry to a bounded array, dropping the oldest overflow. */
function pushBounded(list, entry, limit) {
  const next = Array.isArray(list) ? list.slice() : []
  next.push(entry)
  while (next.length > limit) next.shift()
  return next
}

/**
 * Replace the newest sample when it belongs to the same turn/step (retry or a
 * second settlement) so one logical request does not look like two calls.
 */
function pushSample(list, sample, limit) {
  const next = Array.isArray(list) ? list.slice() : []
  const last = next[next.length - 1]
  if (last !== undefined && last.turn === sample.turn && last.step === sample.step) next[next.length - 1] = sample
  else next.push(sample)
  while (next.length > limit) next.shift()
  return next
}

/** Build one attribution sample from an `assistant/message` usage field. */
export function sampleFromEvent(event) {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return undefined
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  if (data.usage === undefined) return undefined
  const buckets = parseBuckets(data.usage)
  if (buckets === undefined) return undefined
  const promptTokens = promptTokensOf(buckets)
  if (promptTokens <= 0) return undefined
  return {
    seq: Number.isFinite(Number(event.seq)) ? Number(event.seq) : -1,
    turn: finiteNumber(data.turn),
    step: finiteNumber(data.step),
    buckets,
    promptTokens,
    cacheReadShare: buckets.cacheReadTokens / promptTokens,
  }
}

/** Sample cache-read share in [0, 1], or null when unavailable. */
export function shareOf(sample) {
  if (sample === null || typeof sample !== 'object') return null
  if (Number.isFinite(sample.cacheReadShare)) {
    return Math.min(1, Math.max(0, sample.cacheReadShare))
  }
  const share = ratioOf(sample?.buckets?.cacheReadTokens, promptTokensOf(sample?.buckets))
  return share === null ? null : Math.min(1, Math.max(0, share))
}

/** Whether one expected-rebuild kind list contains a kind. */
function expectedKindsBetween(expectedEvents, fromSeq, toSeq) {
  const kinds = []
  for (const entry of Array.isArray(expectedEvents) ? expectedEvents : []) {
    if (entry === null || typeof entry !== 'object') continue
    const seq = Number(entry.seq)
    if (!Number.isFinite(seq) || seq <= fromSeq || seq >= toSeq) continue
    const kind = typeof entry.kind === 'string' ? entry.kind : 'unknown'
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/** Signal kinds observed between two samples (diagnostics for unexpected misses). */
function signalKindsBetween(signals, fromSeq, toSeq) {
  const kinds = []
  for (const entry of Array.isArray(signals) ? signals : []) {
    if (entry === null || typeof entry !== 'object') continue
    const seq = Number(entry.seq)
    if (!Number.isFinite(seq) || seq < fromSeq || seq >= toSeq) continue
    const kind = typeof entry.kind === 'string' ? entry.kind : 'unknown'
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/**
 * Fold one committed session event into the cache ledger.
 *
 * Only durable events are used: provider usage from `assistant/message`, and
 * rebuild-leading lifecycle events. The state is O(1)-ish (bounded arrays) and
 * returns the same reference for unrelated events.
 * @param state - previous ledger state.
 * @param event - committed session event.
 * @returns next ledger state (never mutates the input).
 */
export function foldLedger(state, event) {
  const base = state !== null && typeof state === 'object' ? state : initialLedgerState()
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return base
  const seq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : base.seq
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  switch (event.type) {
    case 'assistant/message':
    case 'assistant/attempt': {
      const sample = sampleFromEvent(event)
      if (sample === undefined) return base
      const previous = base.lastKey !== null
        && base.lastKey.turn === sample.turn
        && base.lastKey.step === sample.step
        ? base.lastKey.buckets
        : undefined
      let totals = addBuckets(base.totals, sample.buckets)
      if (previous !== undefined) totals = subtractBuckets(totals, previous)
      return {
        ...base,
        seq,
        totals,
        lastKey: { turn: sample.turn, step: sample.step, buckets: sample.buckets },
        samples: pushSample(base.samples, sample, SAMPLE_LIMIT),
        requestCount: base.requestCount + 1,
      }
    }
    case 'compaction/start':
      return {
        ...base,
        seq,
        compactionStarts: base.compactionStarts + 1,
        expected: pushBounded(base.expected, { kind: 'compaction-start', seq }, EXPECTED_LIMIT),
      }
    case 'compaction/end':
      return { ...base, seq, expected: pushBounded(base.expected, { kind: 'compaction-end', seq }, EXPECTED_LIMIT) }
    case 'compaction/prune': {
      const prunedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0
      return {
        ...base,
        seq,
        prunes: pushBounded(base.prunes, {
          seq,
          releasedTokens: nonNegative(data.shadowedTokenCount),
          prunedNodes: prunedSeqs,
        }, SAMPLE_LIMIT),
        expected: pushBounded(base.expected, { kind: 'compaction-prune', seq }, EXPECTED_LIMIT),
      }
    }
    case 'compaction/summary': {
      const summary = typeof data.summary === 'string' ? data.summary : ''
      const usage = parseBuckets(data.usage)
      return {
        ...base,
        seq,
        summaries: pushBounded(base.summaries, {
          seq,
          releasedTokens: nonNegative(data.shadowedTokenCount),
          summaryTokens: estimateTokens(summary),
          usage,
        }, SAMPLE_LIMIT),
        expected: pushBounded(base.expected, { kind: 'compaction-summary', seq }, EXPECTED_LIMIT),
      }
    }
    case 'model/selection':
      return { ...base, seq, expected: pushBounded(base.expected, { kind: 'model-selection', seq }, EXPECTED_LIMIT) }
    case 'session/end-seed':
      return { ...base, seq, expected: pushBounded(base.expected, { kind: 'session-resume', seq }, EXPECTED_LIMIT) }
    case 'system/message':
      return { ...base, seq, signals: pushBounded(base.signals, { kind: 'system-prompt', seq }, SIGNAL_LIMIT) }
    default:
      return base
  }
}

/**
 * Convert the session-state seq markers (lastCompactionStartSeq/lastPruneSeq/
 * lastModelSelectionSeq/lastEndSeedSeq) into expected-rebuild entries.
 * The markers only remember the newest event of each kind, which is why they
 * are a supplement to the ledger fold rather than its replacement.
 * @param markers - folded session state (or a compatible subset).
 * @returns expected entries `{ kind, seq }`.
 */
export function markersToExpected(markers) {
  if (markers === null || typeof markers !== 'object') return []
  const fields = [
    ['lastCompactionStartSeq', 'session-marker:compaction-start'],
    ['lastCompactionEndSeq', 'session-marker:compaction-end'],
    ['lastPruneSeq', 'session-marker:prune'],
    ['lastSummarySeq', 'session-marker:summary'],
    ['lastModelSelectionSeq', 'session-marker:model-selection'],
    ['lastEndSeedSeq', 'session-marker:resume'],
  ]
  const entries = []
  for (const [field, kind] of fields) {
    const seq = Number(markers[field])
    if (Number.isFinite(seq) && seq >= 0) entries.push({ kind, seq })
  }
  return entries
}

/**
 * Attribute cache-read share drops between consecutive settled requests.
 *
 * "Expected rebuild" means a known prefix-invalidating event sits between the
 * two samples: compaction start/summary, a microcompact prune, a model switch,
 * or a resume end-seed. A significant drop with none of those is unexpected.
 * @param samples - ledger samples in commit order.
 * @param expectedEvents - ledger expected-rebuild entries (`{ kind, seq }`).
 * @param options - `{ thresholdPp, signals }`.
 * @returns comparison summary plus the episodes themselves.
 */
export function attributeCacheMisses(samples, expectedEvents, options = {}) {
  const list = Array.isArray(samples) ? samples.filter((sample) => sample !== null && typeof sample === 'object') : []
  const thresholdPp = clampNumber(options.thresholdPp, DEFAULT_MISS_THRESHOLD_PP, 1, 100)
  const signals = Array.isArray(options.signals) ? options.signals : []
  // Ledger events are authoritative; session-state markers only cover hosts
  // where the ledger fold was not available, so merge them without overriding.
  const expectedEntries = [
    ...(Array.isArray(expectedEvents) ? expectedEvents : []),
    ...markersToExpected(options.markers),
  ]
  const episodes = []
  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1]
    const current = list[index]
    const fromSeq = Number(previous.seq)
    const toSeq = Number(current.seq)
    if (!Number.isFinite(fromSeq) || !Number.isFinite(toSeq) || toSeq <= fromSeq) continue
    const fromShare = shareOf(previous)
    const toShare = shareOf(current)
    if (fromShare === null || toShare === null) continue
    const dropPp = (fromShare - toShare) * 100
    const leading = expectedKindsBetween(expectedEntries, fromSeq, toSeq)
    let kind = 'stable'
    if (dropPp > thresholdPp) kind = leading.length > 0 ? 'expected' : 'unexpected'
    const episode = {
      kind,
      fromSeq,
      toSeq,
      turn: current.turn,
      step: current.step,
      fromSharePct: round1(fromShare * 100),
      toSharePct: round1(toShare * 100),
      dropPp: round1(dropPp),
      promptTokens: current.promptTokens,
      expectedKinds: leading,
      suspects: kind === 'unexpected' ? signalKindsBetween(signals, fromSeq, toSeq) : [],
    }
    episodes.push(episode)
  }
  const unexpected = episodes.filter((episode) => episode.kind === 'unexpected')
  const expected = episodes.filter((episode) => episode.kind === 'expected')
  return {
    thresholdPp,
    compared: episodes.length,
    stableCount: episodes.length - unexpected.length - expected.length,
    expectedCount: expected.length,
    unexpectedCount: unexpected.length,
    episodes: episodes.slice(-EPISODE_LIMIT),
    lastUnexpected: unexpected.length > 0 ? unexpected[unexpected.length - 1] : null,
    lastExpected: expected.length > 0 ? expected[expected.length - 1] : null,
  }
}

/** Sum one numeric field of a ledger list. */
function sumField(list, field) {
  let total = 0
  for (const entry of Array.isArray(list) ? list : []) {
    const value = Number(entry?.[field])
    if (Number.isFinite(value) && value > 0) total += value
  }
  return total
}

/**
 * Aggregate the compression ledger: prune and summary releases, estimator cost
 * and the estimated money saved from not re-sending released prompt tokens.
 * Savings are priced at the configured uncached-input rate for one subsequent
 * request; they are estimates, not billing data.
 * @param ledger - ledger state.
 * @param prices - resolved per-million prices.
 * @returns compression summary.
 */
export function summarizeCompression(ledger, prices) {
  const prunes = Array.isArray(ledger?.prunes) ? ledger.prunes : []
  const summaries = Array.isArray(ledger?.summaries) ? ledger.summaries : []
  const rate = nonNegative(prices?.inputPricePerMillion) / 1e6
  const pruneReleasedTokens = sumField(prunes, 'releasedTokens')
  const prunedNodes = sumField(prunes, 'prunedNodes')
  const summaryReleasedTokens = sumField(summaries, 'releasedTokens')
  const summaryReplacementTokens = sumField(summaries, 'summaryTokens')
  const summaryNetReleasedTokens = Math.max(0, summaryReleasedTokens - summaryReplacementTokens)
  let summarizerCostUsd = 0
  for (const summary of summaries) {
    if (summary?.usage !== undefined) summarizerCostUsd += estimateCost(summary.usage, prices).totalUsd
  }
  const totalReleasedTokens = pruneReleasedTokens + summaryReleasedTokens
  const totalNetReleasedTokens = Math.max(0, totalReleasedTokens - summaryReplacementTokens)
  const estimatedSavedUsd = totalNetReleasedTokens * rate
  return {
    pruneCount: prunes.length,
    prunedNodes,
    pruneReleasedTokens,
    summaryCount: summaries.length,
    summaryReleasedTokens,
    summaryReplacementTokens,
    summaryNetReleasedTokens,
    summarizerCostUsd,
    totalReleasedTokens,
    totalNetReleasedTokens,
    estimatedSavedUsd,
    estimatedNetSavedUsd: Math.max(0, estimatedSavedUsd - summarizerCostUsd),
    compactionTransactions: nonNegative(ledger?.compactionStarts),
    requestCount: nonNegative(ledger?.requestCount),
    ratePerMillion: nonNegative(prices?.inputPricePerMillion),
  }
}

/** Resolve the effective totals from the tokenUsage projection or the ledger. */
export function resolveUsageTotals(usage, ledger) {
  const source = usage !== null && typeof usage === 'object' && usage.totals !== null && typeof usage.totals === 'object'
    ? usage.totals
    : usage
  const buckets = parseBuckets(source)
  if (buckets !== undefined) return { buckets, source: 'projection' }
  const folded = parseBuckets(ledger?.totals)
  if (folded !== undefined && promptTokensOf(folded) + nonNegative(folded.outputTokens) > 0) {
    return { buckets: folded, source: 'ledger' }
  }
  return { buckets: undefined, source: undefined }
}

/** Last settled call view, from the projection host state when present. */
export function resolveLastCall(usage, ledger) {
  const last = usage !== null && typeof usage === 'object' ? usage.last : undefined
  if (last !== null && last !== undefined && typeof last === 'object') {
    const buckets = parseBuckets(last.buckets)
    if (buckets !== undefined) return { turn: last.turn, step: last.step, buckets }
  }
  const samples = Array.isArray(ledger?.samples) ? ledger.samples : []
  const sample = samples[samples.length - 1]
  if (sample === undefined) return undefined
  return { turn: sample.turn, step: sample.step, buckets: sample.buckets }
}

/** Prompt-cache hit ratio in [0, 1] from the resolved totals, or null. */
export function resolveHitRatio(usage, ledger) {
  const resolved = resolveUsageTotals(usage, ledger)
  if (resolved.buckets === undefined) return null
  const prompt = promptTokensOf(resolved.buckets)
  return ratioOf(nonNegative(resolved.buckets.cacheReadTokens), prompt)
}

/**
 * Human health checklist for an unhealthy hit ratio. Mirrors the Claude Code
 * cache-invalidation checklist adapted to DSH seams.
 * @returns checklist lines.
 */
export function renderHealthChecklist() {
  return [
    'Cache health checklist (hit ratio below the configured threshold):',
    '  1. Confirm the system prompt did not change: plugin hot reload, dynamic section text or a',
    '     variable that embeds the clock/directory are the most common prefix breakers.',
    '  2. Confirm the tool schema set did not change: tools added/removed/reordered, MCP server',
    '     restart, or an executor switch invalidates the cached tool prefix.',
    '  3. Check for expected rebuilds first: compaction/summary, compaction/prune, model selection',
    '     switches and session resume (session/end-seed) legitimately reset the prefix.',
    '  4. Confirm no plugin rewrote early history without emitting compaction/prune metering.',
    '  5. Keep volatile text (timestamps, random ids, file listings) out of early messages;',
    '     append-only notices and reminders are cache-safe, replaced early nodes are not.',
  ]
}

/**
 * Render the contextBreakdown composition block.
 * @param breakdown - contextBreakdown wire view.
 * @returns report lines.
 */
export function renderBreakdownLines(breakdown) {
  if (breakdown === null || typeof breakdown !== 'object') {
    return ['Context composition: unavailable (contextBreakdown projection is not mounted); nothing was guessed.']
  }
  const system = nonNegative(breakdown.systemTokens)
  const tools = nonNegative(breakdown.toolsTokens)
  const history = nonNegative(breakdown.messageTokens)
  const total = system + tools + history
  if (total <= 0) {
    return ['Context composition: the contextBreakdown projection has no priced surface yet.']
  }
  return [
    'Context composition (contextBreakdown): system ' + formatTokens(system) + ' (' + percent(system, total) + '), tools '
      + formatTokens(tools) + ' (' + percent(tools, total) + '), history/other ' + formatTokens(history) + ' ('
      + percent(history, total) + ').',
    'Note: the projection prices images inside history/other and does not report them separately; no split was invented.',
  ]
}

/**
 * Render the summary section (also the historic cacheReport fields, kept for
 * compatibility with the 0.1.0 output).
 * @param input - resolved report input.
 * @returns lines.
 */
export function renderSummaryLines(input) {
  const prices = input?.prices ?? {}
  const resolved = resolveUsageTotals(input?.usage, input?.ledger)
  const lines = []
  if (resolved.buckets === undefined) {
    lines.push(
      'Token usage is not available for this session yet: the dsh-token-meter projections are not mounted, ' +
        'or no model call has completed. Nothing was guessed. Enable @deepseek-ai/dsh-token-meter and retry after one turn.',
    )
  } else {
    const buckets = resolved.buckets
    const promptTokens = promptTokensOf(buckets)
    const cacheRead = nonNegative(buckets.cacheReadTokens)
    const cost = estimateCost(buckets, prices)
    lines.push('Prompt tokens: ' + formatTokens(promptTokens) + ' (uncached ' + formatTokens(buckets.uncachedInputTokens) +
      ', cache read ' + formatTokens(cacheRead) + ', cache write ' + formatTokens(buckets.cacheWriteTokens) + ').')
    lines.push('Output tokens: ' + formatTokens(buckets.outputTokens) + '.')
    lines.push('Prompt-cache hit ratio: ' + percent(cacheRead, promptTokens) + ' of prompt tokens were cache reads.')
    lines.push(
      'Estimated cost: $' + cost.totalUsd.toFixed(4) + ' (prompt $' + cost.promptUsd.toFixed(4) +
        ', cache read $' + cost.cacheReadUsd.toFixed(4) + ', output $' + cost.outputUsd.toFixed(4) +
        '); about $' + cost.savingsUsd.toFixed(4) + ' saved versus paying full input price for every prompt token.',
    )
    if (resolved.source === 'ledger') {
      lines.push('Usage source: the tokenUsage projection is unavailable; totals are folded by workflow-boost'
        + ' from this session\'s assistant-message events (provider-reported numbers, not an estimate).')
    }
    const last = resolveLastCall(input?.usage, input?.ledger)
    if (last !== undefined) {
      const lastPrompt = promptTokensOf(last.buckets)
      lines.push('Last settled call (turn ' + last.turn + ', step ' + last.step + '): '
        + formatTokens(last.buckets.uncachedInputTokens) + ' uncached / '
        + formatTokens(last.buckets.cacheReadTokens) + ' cache-read / '
        + formatTokens(last.buckets.outputTokens) + ' output ('
        + percent(last.buckets.cacheReadTokens, lastPrompt) + ' cache).')
    }
    const minutes = Number(input?.sessionMinutes)
    if (Number.isFinite(minutes) && minutes > 5) {
      lines.push('Average cost per hour of session so far: $' + ((cost.totalUsd / minutes) * 60).toFixed(4) + '.')
    }
  }
  const pressure = input?.pressure
  if (pressure !== null && pressure !== undefined && Number(pressure.contextWindow) > 0) {
    const used = nonNegative(pressure.pressureTokens !== undefined ? pressure.pressureTokens : pressure.projectedTokens)
    const projected = nonNegative(pressure.projectedTokens)
    lines.push(
      'Context window: ' + formatTokens(used) + ' / ' + formatTokens(pressure.contextWindow) + ' tokens (' +
        percent(used, pressure.contextWindow) + ' used).' +
        (projected > 0 && Math.abs(projected - used) > 0
          ? ' Projected after pending surface changes: ' + formatTokens(projected) + '.'
          : '') +
        (ratioOf(used, pressure.contextWindow) !== null && ratioOf(used, pressure.contextWindow) > 0.7
          ? ' Pressure is high: prefer a summary checkpoint or clear stale tool output before the next large step.'
          : ''),
    )
  } else if (pressure !== null && pressure !== undefined) {
    lines.push('Context pressure is known, but no context window is recorded for the active model route yet.')
  } else {
    lines.push('Context pressure: unavailable (contextPressure projection is not mounted); nothing was guessed.')
  }
  for (const line of renderBreakdownLines(input?.breakdown)) lines.push(line)
  const hitRatio = resolveHitRatio(input?.usage, input?.ledger)
  const threshold = clampNumber(input?.healthThreshold, CACHE_REPORT_DEFAULTS.healthThreshold, 0, 100)
  if (hitRatio !== null) {
    const hitPct = hitRatio * 100
    if (hitPct < threshold) {
      lines.push('Cache health: prompt-cache hit ratio ' + hitPct.toFixed(1) + '% is below the configured '
        + threshold + '% threshold; a miss may have broken the prefix.')
      const attribution = input?.attribution
      const suspicious = attribution !== null && attribution !== undefined
        ? attribution.lastUnexpected
        : null
      if (suspicious !== null && suspicious !== undefined) {
        lines.push('Most recent suspicious miss: cache-read share ' + suspicious.fromSharePct + '% -> '
          + suspicious.toSharePct + '% (' + suspicious.dropPp + 'pp) between seq '
          + suspicious.fromSeq + ' and seq ' + suspicious.toSeq + ' with no expected-rebuild event in between.')
      }
      // The summary detail must stand alone, so it carries the full checklist;
      // attribution/all render it once in the attribution section instead.
      if (input?.detail === 'summary' || input?.detail === undefined) {
        for (const line of renderHealthChecklist()) lines.push('  ' + line)
      }
    } else {
      lines.push('Cache health: prompt-cache hit ratio ' + hitPct.toFixed(1) + '% meets the configured '
        + threshold + '% threshold.')
    }
  }
  return lines
}

/**
 * Render the miss-attribution section.
 * @param input - resolved report input.
 * @returns lines.
 */
export function renderAttributionLines(input) {
  const attribution = input?.attribution
  const lines = []
  if (input?.ledger === null || input?.ledger === undefined) {
    lines.push('Cache miss attribution: unavailable (the workflow-boost cache ledger projection is not mounted and no'
      + ' assistant-message usage was folded); nothing was guessed.')
    return lines
  }
  if (attribution === null || attribution === undefined || attribution.compared === 0) {
    lines.push('Cache miss attribution: not enough settled calls with provider usage to compare consecutive requests yet.')
    return lines
  }
  lines.push('Cache miss attribution (a cache-read share drop greater than ' + attribution.thresholdPp
    + 'pp between consecutive settled calls is a miss):')
  lines.push('  Compared ' + attribution.compared + ' consecutive calls: ' + attribution.expectedCount
    + ' expected rebuild(s), ' + attribution.unexpectedCount + ' unexpected miss(es), '
    + attribution.stableCount + ' stable.')
  for (const episode of attribution.episodes) {
    if (episode.kind === 'stable') continue
    lines.push('  [' + (episode.kind === 'expected' ? 'EXPECTED' : 'UNEXPECTED') + '] turn ' + episode.turn
      + ' step ' + episode.step + ', seq ' + episode.fromSeq + ' -> ' + episode.toSeq + ': cache-read share '
      + episode.fromSharePct + '% -> ' + episode.toSharePct + '% (-' + episode.dropPp + 'pp)')
    if (episode.kind === 'expected') {
      lines.push('    leading rebuild events: ' + episode.expectedKinds.join(', '))
    } else {
      lines.push('    no expected-rebuild event between the two samples; the prefix was broken by something else')
      if (episode.suspects.length > 0) lines.push('    observed signals: ' + episode.suspects.join(', '))
    }
  }
  if (attribution.unexpectedCount === 0) {
    lines.push('  No unexpected miss detected: every significant drop had a compaction/prune/model-switch/resume'
      + ' cause, or the cache-read share stayed flat.')
  }
  const hitRatio = resolveHitRatio(input?.usage, input?.ledger)
  const threshold = clampNumber(input?.healthThreshold, CACHE_REPORT_DEFAULTS.healthThreshold, 0, 100)
  const unhealthy = hitRatio !== null && hitRatio * 100 < threshold
  if (attribution.unexpectedCount > 0 || unhealthy) {
    for (const line of renderHealthChecklist()) lines.push('  ' + line)
  }
  return lines
}

/**
 * Render the compression ledger section.
 * @param input - resolved report input.
 * @returns lines.
 */
export function renderLedgerLines(input) {
  const ledger = input?.ledger
  const lines = []
  if (ledger === null || ledger === undefined) {
    lines.push('Compression ledger: unavailable (the workflow-boost cache ledger projection is not mounted);',
      ' nothing was guessed. Compaction events are folded from the durable session log, not from provider data.')
    return lines
  }
  const compression = input?.compression ?? summarizeCompression(ledger, input?.prices)
  const saves = 'at the configured uncached-input rate (' + compression.ratePerMillion + ' USD/1M tokens, for one subsequent request)'
  lines.push('Compression ledger (from durable compaction events):')
  lines.push('  compaction transactions started: ' + compression.compactionTransactions + '; prune events: '
    + compression.pruneCount + ' removing ' + formatTokens(compression.prunedNodes) + ' tool result node(s).')
  lines.push('  prune released: ' + formatTokens(compression.pruneReleasedTokens) + ' prompt tokens (~$'
    + (compression.pruneReleasedTokens * compression.ratePerMillion / 1e6).toFixed(4) + ' ' + saves + ').')
  lines.push('  summaries: ' + compression.summaryCount + ' covering ' + formatTokens(compression.summaryReleasedTokens)
    + ' tokens; replacement summaries cost ~' + formatTokens(compression.summaryReplacementTokens)
    + ' tokens, net released ~' + formatTokens(compression.summaryNetReleasedTokens) + '.')
  lines.push('  summarizer spend recorded on compaction/summary: ~$' + compression.summarizerCostUsd.toFixed(4)
    + ' (provider usage buckets, when the host records them).')
  lines.push('  total released: ' + formatTokens(compression.totalReleasedTokens) + ' prompt tokens; net after'
    + ' replacement summaries: ' + formatTokens(compression.totalNetReleasedTokens) + '.')
  lines.push('  estimated saving: ~$' + compression.estimatedSavedUsd.toFixed(4) + ' gross, ~$'
    + compression.estimatedNetSavedUsd.toFixed(4) + ' net of summarizer spend. These are estimates, not billing data.')
  if (compression.pruneCount === 0 && compression.summaryCount === 0) {
    lines.push('  No compaction/prune has settled in this session yet; the ledger is empty rather than unavailable.')
  }
  return lines
}

/**
 * Render the complete cache report at one detail level.
 * @param input - `{ detail, usage, pressure, breakdown, ledger, prices, healthThreshold, sessionMinutes, missThresholdPp }`.
 * @returns report text.
 */
export function renderCacheReport(input) {
  const detail = normalizeDetail(input?.detail, 'summary')
  const lines = ['Cache report (workflow-boost; estimated from provider-reported usage).']
  const ledger = input?.ledger
  const attribution = input?.attribution ?? (
    ledger !== null && ledger !== undefined
      ? attributeCacheMisses(ledger?.samples, ledger?.expected, {
        thresholdPp: input?.missThresholdPp,
        signals: ledger?.signals,
        markers: input?.markers,
      })
      : undefined
  )
  const resolvedInput = { ...input, detail, attribution }
  for (const line of renderSummaryLines(resolvedInput)) lines.push(line)
  if (detail === 'attribution' || detail === 'all') {
    for (const line of renderAttributionLines({ ...resolvedInput, ledger })) lines.push(line)
  }
  if (detail === 'ledger' || detail === 'all') {
    for (const line of renderLedgerLines(resolvedInput)) lines.push(line)
  }
  lines.push('Prices are configuration values, not billing data; see cacheReport.* in the plugin row.')
  const report = lines.join('\n')
  return report.length <= MAX_REPORT_CHARS
    ? report
    : report.slice(0, MAX_REPORT_CHARS) + '\n[... report truncated at ' + MAX_REPORT_CHARS + ' chars ...]'
}

/**
 * Historic renderer alias kept for 0.1.x callers: summary-only report.
 * @param input - `{ usage, pressure, prices, sessionMinutes, breakdown, ledger }`.
 * @returns report text.
 */
export function renderReport(input) {
  return renderCacheReport({ ...input, detail: 'summary' })
}
