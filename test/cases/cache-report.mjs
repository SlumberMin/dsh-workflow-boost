/**
 * cacheAudit cases — ledger folding, expected-vs-unexpected miss attribution,
 * compression accounting, report degradation and tool/command registration in a
 * clean Node process (fake ctx, fake loadHost, no @deepseek-ai packages).
 */
import { test, assert, assertEqual } from '../harness.mjs'
import {
  CACHE_LEDGER_KEY,
  CACHE_LEDGER_STATE_VERSION,
  DEFAULT_MISS_THRESHOLD_PP,
  attributeCacheMisses,
  estimateCost,
  estimateTokens,
  foldLedger,
  formatTokens,
  initialLedgerState,
  markersToExpected,
  normalizeDetail,
  parseBuckets,
  percent,
  promptTokensOf,
  renderBreakdownLines,
  renderCacheReport,
  renderHealthChecklist,
  renderReport,
  resolveCacheConfig,
  resolveHitRatio,
  summarizeCompression,
} from '../../lib/pure/cache-core.js'
import { gatherReportInput, install, ledgerOf } from '../../lib/cache-report.js'

const PRICES = { inputPricePerMillion: 0.28, cacheReadPricePerMillion: 0.028, outputPricePerMillion: 0.42 }
const USAGE_WIRE = { uncachedInputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 500 }
const PRESSURE = { contextWindow: 100000, pressureTokens: 40000, projectedTokens: 42000 }
const BREAKDOWN = { systemTokens: 2000, toolsTokens: 3000, messageTokens: 5000 }

const usageEvent = (seq, turn, step, usage) => ({ type: 'assistant/message', seq, time: 1000 + seq, data: { turn, step, usage } })

/** Build one attribution sample with a requested cache-read share. */
function sample(seq, share, turn = 1) {
  const promptTokens = 1000
  return {
    seq,
    turn,
    step: seq,
    buckets: {
      uncachedInputTokens: Math.round((1 - share) * promptTokens),
      cacheReadTokens: Math.round(share * promptTokens),
      cacheWriteTokens: 0,
      outputTokens: 10,
    },
    promptTokens,
    cacheReadShare: share,
  }
}

/** Fake plugin state with an injectable sync loadHost and a session event feed. */
function fakeState(extra = {}) {
  const logs = []
  const feed = []
  const sessionState = {
    onEvent(listener) { feed.push(listener); return () => {} },
    emit(session, event) { for (const listener of feed) listener(session, event, undefined) },
  }
  return {
    log(level, message) { logs.push({ level, message }) },
    logs,
    sessionState,
    loadHost: () => ({ defineTool: (definition) => definition }),
    ...extra,
  }
}

/** Fake projections service: fixed snapshot values + a resolvable registration. */
function fakeProjections(values = {}) {
  const registrations = []
  return {
    registrations,
    snapshot: () => ({ asOfSeq: 1, values }),
    register: async (definition) => {
      registrations.push(definition)
      return { stateOf: () => undefined, dispose: async () => {} }
    },
  }
}

/** Fake Row context exposing only the seams cacheReport touches. */
function fakeCtx(options = {}) {
  const tools = []
  const commands = []
  const services = { ...(options.services ?? {}) }
  const ctx = {
    get(name) {
      if (Object.hasOwn(services, name)) return services[name]
      if (name === 'commands') return { register: (definition) => { commands.push(definition); return () => {} } }
      return undefined
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, tools, commands }
}

// ---------------------------------------------------------------------------
// Configuration and numeric helpers (0.1.x compatibility)
// ---------------------------------------------------------------------------

test('resolveCacheConfig applies defaults and validates detail/prices', () => {
  const defaults = resolveCacheConfig({})
  assertEqual(defaults.enabled, true)
  assertEqual(defaults.detail, 'summary')
  assertEqual(defaults.healthThreshold, 90)
  assertEqual(defaults.inputPricePerMillion, 0.28)
  const custom = resolveCacheConfig({ cacheReport: { detail: 'ALL', healthThreshold: 101, inputPricePerMillion: -1, cacheReadPricePerMillion: 0.1 } })
  assertEqual(custom.detail, 'all')
  assertEqual(custom.healthThreshold, 100)
  assertEqual(custom.inputPricePerMillion, 0.28, 'negative price falls back')
  assertEqual(custom.cacheReadPricePerMillion, 0.1)
  assertEqual(resolveCacheConfig({ cacheReport: { enabled: false } }).enabled, false)
  assertEqual(resolveCacheConfig({ enabled: false }).enabled, false)
  assertEqual(normalizeDetail('ledger'), 'ledger')
  assertEqual(normalizeDetail('nope', 'attribution'), 'attribution')
  assertEqual(normalizeDetail(undefined, 'bad'), 'summary')
})

test('estimateCost keeps the 0.1.x numbers and formatTokens/percent stay stable', () => {
  const buckets = { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 }
  const cost = estimateCost(buckets, PRICES)
  assert(Math.abs(cost.promptUsd - 0.28) < 1e-9, 'uncached prompt price')
  assert(Math.abs(cost.cacheReadUsd - 0.028) < 1e-9, 'cache read price')
  assert(Math.abs(cost.outputUsd - 0.42) < 1e-9, 'output price')
  assert(Math.abs(cost.savingsUsd - (0.28 - 0.028)) < 1e-9, 'cache saving versus full input price')
  assertEqual(formatTokens(1234567), '1,234,567')
  assertEqual(formatTokens(0), '0')
  assertEqual(percent(1, 4), '25.0%')
  assertEqual(percent(1, 0), '0.0%')
  assertEqual(estimateTokens('abcd'), 1)
})

test('parseBuckets accepts provider and bucket shapes but returns undefined for no data', () => {
  assertEqual(parseBuckets({ inputTokens: 5, cacheReadTokens: 7, outputTokens: 3 }), {
    uncachedInputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 0, outputTokens: 3,
  })
  assertEqual(parseBuckets({ uncachedInputTokens: 1, outputTokens: 2 }), {
    uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2,
  })
  assertEqual(parseBuckets({}), undefined, 'an empty object is not zero usage')
  assertEqual(parseBuckets(null), undefined)
  assertEqual(promptTokensOf({ uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }), 6)
})

// ---------------------------------------------------------------------------
// Ledger folding
// ---------------------------------------------------------------------------

test('foldLedger accumulates provider usage and replaces a retried request', () => {
  let ledger = initialLedgerState()
  ledger = foldLedger(ledger, usageEvent(1, 1, 1, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 }))
  assertEqual(ledger.totals, { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 50 })
  assertEqual(ledger.samples.length, 1)
  assertEqual(ledger.samples[0].promptTokens, 1000)
  assertEqual(ledger.samples[0].cacheReadShare, 0.9)
  ledger = foldLedger(ledger, usageEvent(2, 1, 1, { inputTokens: 200, cacheReadTokens: 800, outputTokens: 60 }))
  assertEqual(ledger.samples.length, 1, 'same turn/step retry replaces the sample')
  assertEqual(ledger.totals.uncachedInputTokens, 200)
  assertEqual(ledger.totals.cacheReadTokens, 800)
  const unrelated = foldLedger(ledger, { type: 'todo/write', seq: 3, data: { todos: [] } })
  assertEqual(unrelated, ledger, 'unrelated events return the same state reference')
})

test('foldLedger records expected rebuilds, compression entries and suspect signals', () => {
  let ledger = initialLedgerState()
  ledger = foldLedger(ledger, { type: 'compaction/start', seq: 10, data: { compactionId: 'c1' } })
  ledger = foldLedger(ledger, { type: 'compaction/prune', seq: 11, data: { shadowedSeqs: [5], shadowedTokenCount: 500, shadowedRange: { start: 5, end: 5 } } })
  ledger = foldLedger(ledger, {
    type: 'compaction/summary',
    seq: 12,
    data: {
      compactionId: 'c1',
      summary: 'S'.repeat(400),
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 3000,
      shadowedRange: { start: 1, end: 3 },
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  })
  ledger = foldLedger(ledger, { type: 'compaction/end', seq: 13, data: { compactionId: 'c1' } })
  ledger = foldLedger(ledger, { type: 'model/selection', seq: 14, data: { provider: 'deepseek', model: 'x' } })
  ledger = foldLedger(ledger, { type: 'session/end-seed', seq: 15, data: { inherited: true } })
  ledger = foldLedger(ledger, { type: 'system/message', seq: 16, data: {} })
  assertEqual(ledger.compactionStarts, 1)
  assertEqual(ledger.prunes.length, 1)
  assertEqual(ledger.prunes[0].releasedTokens, 500)
  assertEqual(ledger.prunes[0].prunedNodes, 1)
  assertEqual(ledger.summaries.length, 1)
  assertEqual(ledger.summaries[0].releasedTokens, 3000)
  assertEqual(ledger.summaries[0].summaryTokens, estimateTokens('S'.repeat(400)))
  assertEqual(ledger.expected.map((entry) => entry.kind), [
    'compaction-start', 'compaction-prune', 'compaction-summary', 'compaction-end', 'model-selection', 'session-resume',
  ])
  assertEqual(ledger.signals.length, 1)
  assertEqual(ledger.signals[0].kind, 'system-prompt')
})

// ---------------------------------------------------------------------------
// Attribution: expected vs unexpected
// ---------------------------------------------------------------------------

test('attributeCacheMisses leaves a stable cache curve alone', () => {
  const attribution = attributeCacheMisses([sample(1, 0.9), sample(2, 0.92), sample(3, 0.91)], [])
  assertEqual(attribution.compared, 2)
  assertEqual(attribution.stableCount, 2)
  assertEqual(attribution.expectedCount, 0)
  assertEqual(attribution.unexpectedCount, 0)
  assertEqual(attribution.lastUnexpected, null)
})

test('attributeCacheMisses marks a drop after compaction as expected', () => {
  const attribution = attributeCacheMisses([sample(1, 0.9), sample(7, 0.3)], [
    { kind: 'compaction-summary', seq: 3 },
    { kind: 'compaction-end', seq: 4 },
  ])
  assertEqual(attribution.expectedCount, 1)
  assertEqual(attribution.unexpectedCount, 0)
  const episode = attribution.episodes[0]
  assertEqual(episode.kind, 'expected')
  assertEqual(episode.dropPp, 60)
  assertEqual(episode.expectedKinds, ['compaction-summary', 'compaction-end'])
})

test('attributeCacheMisses flags a drop with no leading rebuild as unexpected', () => {
  const samples = [sample(1, 0.9), sample(7, 0.3)]
  const attribution = attributeCacheMisses(samples, [], { signals: [{ kind: 'system-prompt', seq: 4 }] })
  assertEqual(attribution.unexpectedCount, 1)
  const episode = attribution.lastUnexpected
  assertEqual(episode.kind, 'unexpected')
  assertEqual(episode.dropPp, 60)
  assertEqual(episode.suspects, ['system-prompt'])
  assertEqual(DEFAULT_MISS_THRESHOLD_PP, 30)
})

test('session-state markers supplement expected-rebuild attribution', () => {
  assertEqual(markersToExpected({ lastCompactionStartSeq: 3, lastPruneSeq: 4, lastEndSeedSeq: -1 }), [
    { kind: 'session-marker:compaction-start', seq: 3 },
    { kind: 'session-marker:prune', seq: 4 },
  ])
  assertEqual(markersToExpected(undefined), [])
  const attribution = attributeCacheMisses([sample(1, 0.9), sample(7, 0.3)], [], {
    markers: { lastPruneSeq: 4 },
  })
  assertEqual(attribution.expectedCount, 1)
  assertEqual(attribution.lastExpected.expectedKinds, ['session-marker:prune'])
})

test('attributeCacheMisses only trips when the drop exceeds the threshold', () => {
  const below = attributeCacheMisses([sample(1, 0.9), sample(2, 0.66)], [])
  assertEqual(below.unexpectedCount, 0, '24pp drop is below the 30pp threshold')
  const above = attributeCacheMisses([sample(1, 0.9), sample(2, 0.59)], [])
  assertEqual(above.unexpectedCount, 1, '31pp drop trips the threshold')
  assertEqual(above.lastUnexpected.dropPp, 31)
})

// ---------------------------------------------------------------------------
// Compression ledger
// ---------------------------------------------------------------------------

test('summarizeCompression reports released tokens and estimated savings', () => {
  let ledger = initialLedgerState()
  ledger = foldLedger(ledger, { type: 'compaction/prune', seq: 11, data: { shadowedSeqs: [5], shadowedTokenCount: 500 } })
  ledger = foldLedger(ledger, {
    type: 'compaction/summary',
    seq: 12,
    data: { summary: 'S'.repeat(400), shadowedSeqs: [1, 2, 3], shadowedTokenCount: 3000, usage: { inputTokens: 100, outputTokens: 20 } },
  })
  const compression = summarizeCompression(ledger, PRICES)
  assertEqual(compression.pruneCount, 1)
  assertEqual(compression.pruneReleasedTokens, 500)
  assertEqual(compression.summaryCount, 1)
  assertEqual(compression.summaryReleasedTokens, 3000)
  assertEqual(compression.summaryReplacementTokens, 100)
  assertEqual(compression.summaryNetReleasedTokens, 2900)
  assertEqual(compression.totalNetReleasedTokens, 3400)
  assert(Math.abs(compression.estimatedSavedUsd - (3400 * 0.28) / 1e6) < 1e-12, 'savings use the configured input price')
  assert(Math.abs(compression.summarizerCostUsd - (100 * 0.28 + 20 * 0.42) / 1e6) < 1e-12, 'summarizer spend from provider usage')
  assert(compression.estimatedSavedUsd > 0)
})

// ---------------------------------------------------------------------------
// Rendering and degradation
// ---------------------------------------------------------------------------

test('summary rendering keeps the historic fields', () => {
  const report = renderCacheReport({
    detail: 'summary',
    usage: USAGE_WIRE,
    pressure: PRESSURE,
    breakdown: BREAKDOWN,
    prices: PRICES,
    healthThreshold: 90,
    sessionMinutes: 30,
  })
  assert(report.startsWith('Cache report (workflow-boost; estimated from provider-reported usage).'), report)
  assert(report.includes('Prompt tokens: 10,000 (uncached 1,000, cache read 9,000, cache write 0).'), report)
  assert(report.includes('Output tokens: 500.'), report)
  assert(report.includes('Prompt-cache hit ratio: 90.0% of prompt tokens were cache reads.'), report)
  assert(report.includes('Estimated cost: $'), report)
  assert(report.includes('Average cost per hour of session so far: $'), report)
  assert(report.includes('Context window: 40,000 / 100,000 tokens (40.0% used).'), report)
  assert(report.includes('Projected after pending surface changes: 42,000.'), report)
  assert(report.includes('Context composition (contextBreakdown): system 2,000 (20.0%), tools 3,000 (30.0%), history/other 5,000 (50.0%).'), report)
  assert(report.includes('Prices are configuration values, not billing data'), report)
})

test('missing projections are reported as unavailable, never guessed', () => {
  const report = renderCacheReport({ detail: 'summary', prices: PRICES, healthThreshold: 90 })
  assert(report.includes('Token usage is not available for this session yet'), report)
  assert(report.includes('Nothing was guessed.'), report)
  assert(report.includes('Context pressure: unavailable'), report)
  assert(report.includes('Context composition: unavailable'), report)
  assert(!report.includes('Prompt-cache hit ratio:'), 'no invented ratio without usage')
  const attribution = renderCacheReport({ detail: 'attribution', prices: PRICES })
  assert(attribution.includes('Cache miss attribution: unavailable'), attribution)
  const ledger = renderCacheReport({ detail: 'ledger', prices: PRICES })
  assert(ledger.includes('Compression ledger: unavailable'), ledger)
})

test('detail levels switch sections on and off', () => {
  const ledger = {
    ...initialLedgerState(),
    samples: [sample(1, 0.9), sample(7, 0.3)],
    expected: [{ kind: 'compaction-summary', seq: 3 }],
    prunes: [{ seq: 4, releasedTokens: 500, prunedNodes: 1 }],
    summaries: [],
  }
  const base = { usage: USAGE_WIRE, pressure: PRESSURE, breakdown: BREAKDOWN, prices: PRICES, healthThreshold: 90, ledger }
  const summary = renderCacheReport({ ...base, detail: 'summary' })
  assert(!summary.includes('Cache miss attribution:'), 'summary has no attribution section')
  assert(!summary.includes('Compression ledger ('), 'summary has no ledger section')
  const attribution = renderCacheReport({ ...base, detail: 'attribution' })
  assert(attribution.includes('Cache miss attribution'), attribution)
  assert(attribution.includes('[EXPECTED]'), attribution)
  assert(!attribution.includes('Compression ledger ('), 'attribution has no ledger section')
  const ledgerOnly = renderCacheReport({ ...base, detail: 'ledger' })
  assert(ledgerOnly.includes('Compression ledger (from durable compaction events):'), ledgerOnly)
  assert(ledgerOnly.includes('prune released: 500 prompt tokens'), ledgerOnly)
  assert(!ledgerOnly.includes('Cache miss attribution:'), 'ledger has no attribution section')
  const all = renderCacheReport({ ...base, detail: 'all' })
  assert(all.includes('Cache miss attribution') && all.includes('Compression ledger ('), all)
})

test('an unhealthy hit ratio renders the checklist and the suspicious miss', () => {
  const unhealthyUsage = { uncachedInputTokens: 1500, cacheReadTokens: 8500, cacheWriteTokens: 0, outputTokens: 200 }
  const ledger = {
    ...initialLedgerState(),
    samples: [sample(1, 0.95), sample(7, 0.3)],
    expected: [],
    signals: [],
  }
  const report = renderCacheReport({
    detail: 'summary',
    usage: unhealthyUsage,
    pressure: PRESSURE,
    breakdown: BREAKDOWN,
    prices: PRICES,
    healthThreshold: 90,
    ledger,
  })
  assert(report.includes('Cache health: prompt-cache hit ratio 85.0% is below the configured 90% threshold'), report)
  assert(report.includes('Most recent suspicious miss: cache-read share 95% -> 30% (65pp)'), report)
  assert(report.includes('Cache health checklist'), 'the standalone summary carries the checklist')
  assert(report.includes('Confirm the system prompt did not change'), report)
  for (const line of renderHealthChecklist()) assert(typeof line === 'string' && line.length > 0)
  const healthy = renderCacheReport({ detail: 'summary', usage: USAGE_WIRE, prices: PRICES, healthThreshold: 90 })
  assert(healthy.includes('Cache health: prompt-cache hit ratio 90.0% meets the configured 90% threshold.'), healthy)
})

test('context breakdown and hit-ratio helpers degrade explicitly', () => {
  const lines = renderBreakdownLines(BREAKDOWN)
  assert(lines[0].includes('system 2,000 (20.0%)'), lines[0])
  assert(lines[1].includes('does not report them separately'), 'images are not invented')
  assert(renderBreakdownLines(undefined)[0].includes('unavailable'), 'missing projection is explicit')
  assertEqual(resolveHitRatio(USAGE_WIRE, undefined), 0.9)
  assertEqual(resolveHitRatio(undefined, { totals: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }), null)
})

test('renderReport stays as the summary compatibility alias', () => {
  const report = renderReport({ usage: USAGE_WIRE, prices: PRICES })
  assert(report.startsWith('Cache report'))
  assert(report.includes('Prompt tokens: 10,000'), report)
  assert(!report.includes('Cache miss attribution:'), report)
})

// ---------------------------------------------------------------------------
// Host module: projection wiring, tool and command registration
// ---------------------------------------------------------------------------

const asyncTests = []
function testAsync(name, fn) {
  asyncTests.push({ name, fn })
}

testAsync('install registers cache_report and /cache with an injectable loader', async () => {
  const session = {}
  const projections = fakeProjections({
    tokenUsage: USAGE_WIRE,
    contextPressure: PRESSURE,
    contextBreakdown: BREAKDOWN,
  })
  const { ctx, tools, commands } = fakeCtx({ services: { sessionProjections: projections } })
  const state = fakeState()
  const dispose = install(ctx, { cacheReport: { enabled: true, detail: 'summary' } }, state)
  assertEqual(typeof dispose, 'function')
  assertEqual(tools.length, 1)
  assertEqual(tools[0].name, 'cache_report')
  assertEqual(commands.length, 1)
  assertEqual(commands[0].name, 'cache')
  assert(projections.registrations.length === 1, 'ledger projection registered')
  assertEqual(projections.registrations[0].key, CACHE_LEDGER_KEY)
  assertEqual(projections.registrations[0].stateVersion, CACHE_LEDGER_STATE_VERSION)

  state.sessionState.emit(session, usageEvent(1, 1, 1, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 }))
  state.sessionState.emit(session, { type: 'compaction/prune', seq: 2, data: { shadowedSeqs: [1], shadowedTokenCount: 400 } })
  const report = await tools[0].execute({ detail: 'all' }, { agent: { session } })
  assert(report.includes('Prompt tokens: 10,000'), report)
  assert(report.includes('Cache miss attribution'), report)
  assert(report.includes('Compression ledger (from durable compaction events):'), report)

  const commandResult = commands[0].handler({ agent: { session } })
  assertEqual(commandResult.kind, 'success')
  assert(commandResult.text.includes('Prune events: 1') || commandResult.text.includes('prune events: 1'), commandResult.text)
  dispose()
})

testAsync('install degrades when the host tools package is missing', async () => {
  const { ctx, tools } = fakeCtx({ services: { sessionProjections: fakeProjections() } })
  const state = fakeState({ loadHost: () => undefined })
  let threw = false
  let dispose
  try {
    dispose = install(ctx, { cacheReport: { enabled: true } }, state)
  } catch {
    threw = true
  }
  assertEqual(threw, false, 'a missing host package must not throw')
  assertEqual(tools.length, 0)
  assertEqual(typeof dispose, 'function')
  dispose()
  const disabled = fakeCtx()
  const disposeDisabled = install(disabled.ctx, { cacheReport: { enabled: false } }, fakeState())
  assertEqual(typeof disposeDisabled, 'function')
  assertEqual(disabled.tools.length, 0)
})

testAsync('gatherReportInput reads projection wire views and the live ledger', async () => {
  const session = {}
  const projections = fakeProjections({
    tokenUsage: USAGE_WIRE,
    contextPressure: PRESSURE,
    contextBreakdown: BREAKDOWN,
  })
  const local = new WeakMap()
  local.set(session, { ...initialLedgerState(), samples: [sample(1, 0.9)] })
  const { ctx } = fakeCtx({ services: { sessionProjections: projections } })
  const state = fakeState()
  state.sessionState.stateOf = () => ({ lastCompactionStartSeq: 3, lastPruneSeq: 4 })
  const input = gatherReportInput(ctx, state, session, {
    detail: 'attribution',
    settings: { detail: 'summary', healthThreshold: 90, ...PRICES },
    projection: { handle: null },
    local,
  })
  assertEqual(input.detail, 'attribution')
  assertEqual(input.usage, USAGE_WIRE)
  assertEqual(input.pressure, PRESSURE)
  assertEqual(input.breakdown, BREAKDOWN)
  assertEqual(input.ledger.samples.length, 1)
  assertEqual(input.markers.lastPruneSeq, 4, 'session-state seq markers are forwarded to attribution')
  assert(Number.isFinite(input.sessionMinutes) || input.sessionMinutes === undefined)
  assertEqual(ledgerOf({ handle: null }, local, session), input.ledger)
  assertEqual(ledgerOf({ handle: null }, new WeakMap(), {}), undefined)
})

testAsync('install fails open when host seams throw and accepts an async loader', async () => {
  const ctx = {
    get() { throw new Error('get down') },
    tools: { register() { throw new Error('register down') } },
  }
  const state = fakeState({ loadHost: async () => ({ defineTool: (definition) => definition }) })
  let dispose
  try {
    dispose = install(ctx, { cacheReport: { enabled: true } }, state)
  } catch (error) {
    throw new Error('install must not throw when host seams fail: ' + (error instanceof Error ? error.message : String(error)))
  }
  assertEqual(typeof dispose, 'function')
  await new Promise((resolve) => setTimeout(resolve, 0))
  dispose()
})

for (const entry of asyncTests) {
  try {
    await entry.fn()
    test(entry.name, () => {})
  } catch (error) {
    test(entry.name, () => {
      throw error
    })
  }
}
