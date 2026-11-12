/**
 * microcompact 2.0 cases: config contract, assistant-turn grouping, dual
 * thresholds, protected leading results, savings floor, and the fail-open
 * wiring over a faked host.
 */
import { test, assert, assertEqual } from '../harness.mjs'
import { createFakeContext, createFakeSession, fakeLoadHost } from '../fakes.mjs'
import {
  DEFAULT_PLACEHOLDER,
  MIN_SAVINGS_TOKENS,
  evaluateTrigger,
  groupToolResults,
  isReplaceableToolMessage,
  planMicrocompact,
  resolveMicrocompactConfig,
  resolveRemainingBudget,
} from '../../lib/pure/microcompact-plan.js'
import { install, resolveConfig } from '../../lib/microcompact.js'

const ESTIMATE = (text) => Math.ceil(String(text ?? '').length / 4)
const PAD = (n) => 'x'.repeat(n)

/** A tiny in-memory world: events by seq plus the surface node order. */
function makeWorld() {
  const events = new Map()
  const surfaceNodes = []
  let seq = 0
  function push(type, data) {
    const event = { type, seq: seq++, data }
    events.set(event.seq, event)
    if (type === 'tool/result' || type === 'user/message' || type === 'assistant/message') surfaceNodes.push(event.seq)
    return event
  }
  return { events, surfaceNodes, push, eventFor: (target) => events.get(target) }
}

/** Append one assistant turn group of parallel tool results. */
function addTurn(world, turn, step, count, chars = 2000) {
  for (let index = 0; index < count; index += 1) {
    const callId = 'call-' + turn + '-' + step + '-' + index
    world.push('tool/result', {
      turn,
      step,
      message: {
        id: 'msg-' + callId,
        role: 'tool',
        toolCallId: callId,
        source: { kind: 'tool', callId },
        isError: false,
        content: [{ type: 'text', text: 'result ' + callId + ' ' + PAD(chars) }],
      },
    })
  }
}

function plan(world, overrides = {}) {
  return planMicrocompact({
    surfaceNodes: world.surfaceNodes,
    eventFor: world.eventFor,
    estimate: ESTIMATE,
    settings: resolveMicrocompactConfig({}),
    ...overrides,
  })
}

// --- configuration contract ------------------------------------------------

test('defaults match the 1.0.0 contract', () => {
  const settings = resolveMicrocompactConfig({})
  assertEqual(settings.triggerRatio, 0.72)
  assertEqual(settings.keepRecentGroups, 5)
  assertEqual(settings.keepFirstEvents, 2)
  assertEqual(settings.placeholder, '[Old tool result content cleared]')
  assertEqual(settings.placeholder, DEFAULT_PLACEHOLDER)
  assertEqual(settings.minCharsPerResult, 1600)
  assertEqual(settings.maxResultsPerPass, 24)
  assertEqual(MIN_SAVINGS_TOKENS, 256)
  assertEqual(settings.enabled, true)
  assertEqual(resolveConfig({ microcompact: { enabled: false } }).enabled, false)
  assertEqual(resolveConfig({ enabled: false }).enabled, false)
})

test('keepRecentToolResults is only a deprecated alias for keepRecentGroups', () => {
  const legacy = resolveMicrocompactConfig({ microcompact: { keepRecentToolResults: 2 } })
  assertEqual(legacy.keepRecentGroups, 2, 'legacy key still decides the group count')
  assertEqual(legacy.legacyKeepRecentToolResults, true)
  const explicit = resolveMicrocompactConfig({ microcompact: { keepRecentGroups: 4, keepRecentToolResults: 2 } })
  assertEqual(explicit.keepRecentGroups, 4, 'documented key wins')
  assertEqual(explicit.legacyKeepRecentToolResults, false)
  const plain = resolveMicrocompactConfig({ microcompact: {} })
  assertEqual(plain.legacyKeepRecentToolResults, false)
})

test('settings are clamped to usable values', () => {
  const settings = resolveMicrocompactConfig({
    microcompact: { triggerRatio: 0.1, keepRecentGroups: 999, keepFirstEvents: -3, placeholder: '' },
  })
  assertEqual(settings.triggerRatio, 0.3)
  assertEqual(settings.keepRecentGroups, 50)
  assertEqual(settings.keepFirstEvents, 0)
  assertEqual(settings.placeholder, DEFAULT_PLACEHOLDER)
})

// --- assistant-turn grouping ----------------------------------------------

test('newest turn with 4 results plus 3 earlier turns: 5 groups all kept by default', () => {
  const world = makeWorld()
  addTurn(world, 1, 1, 2)
  addTurn(world, 2, 1, 2)
  addTurn(world, 3, 1, 2)
  addTurn(world, 4, 1, 4)
  const result = plan(world)
  assertEqual(result.totalToolResults, 10)
  assertEqual(result.totalGroups, 4)
  assertEqual(result.keptGroups, 4, 'four groups fit inside keepRecentGroups=5')
  assertEqual(result.staleGroups, 0)
  assertEqual(result.replacements.length, 0)
})

test('keepRecentGroups drops whole groups, never half of the newest turn', () => {
  const world = makeWorld()
  addTurn(world, 1, 1, 2)
  addTurn(world, 2, 1, 2)
  addTurn(world, 3, 1, 2)
  addTurn(world, 4, 1, 4)
  const one = plan(world, { keepRecentGroups: 1, keepFirstEvents: 0 })
  assertEqual(one.staleGroups, 3)
  assertEqual(one.replacements.length, 6, 'flat keep-5 would have cleared 5 results and split the newest turn')
  assertEqual(one.replacements.map((item) => item.turn), [1, 1, 2, 2, 3, 3])
  const three = plan(world, { keepRecentGroups: 3, keepFirstEvents: 0 })
  assertEqual(three.replacements.length, 2, 'only the oldest group is stale')
  assertEqual(three.replacements.map((item) => item.turn), [1, 1])
})

test('groupToolResults partitions by turn/step and isolates unknown producers', () => {
  const groups = groupToolResults([
    { seq: 1, event: { data: { turn: 1, step: 1 } } },
    { seq: 2, event: { data: { turn: 1, step: 1 } } },
    { seq: 3, event: { data: { turn: 1, step: 2 } } },
    { seq: 4, event: { data: {} } },
  ])
  assertEqual(groups.length, 3)
  assertEqual(groups[0].entries.length, 2)
  assertEqual(groups[1].entries.length, 1)
  assertEqual(groups[2].entries.length, 1)
  assertEqual(groups[2].key, 'seq:4')
})

test('keepFirstEvents protects the leading tool results even when stale', () => {
  const world = makeWorld()
  for (let turn = 1; turn <= 5; turn += 1) addTurn(world, turn, 1, 1)
  const result = plan(world, { keepRecentGroups: 0, keepFirstEvents: 2 })
  assertEqual(result.replacements.length, 3)
  assertEqual(result.skipped.firstEvents, 2)
  assertEqual(result.replacements.map((item) => item.turn), [3, 4, 5])
  const none = plan(world, { keepRecentGroups: 0, keepFirstEvents: 0 })
  assertEqual(none.replacements.length, 5)
})

// --- dual thresholds -------------------------------------------------------

test('remaining budget derives from the window size', () => {
  assertEqual(resolveRemainingBudget(1000000, 0), 20000, 'large window keeps a flat 20k')
  assertEqual(resolveRemainingBudget(200000, 0), 40000, '200k window keeps 20%')
  assertEqual(resolveRemainingBudget(100000, 0), 20000)
  assertEqual(resolveRemainingBudget(1000000, 5000), 5000, 'explicit reserve wins')
  assertEqual(resolveRemainingBudget(0, 0), 0, 'unknown window has no reserve')
})

test('evaluateTrigger fires on pressure ratio, remaining budget or absolute tokens', () => {
  const ratio = evaluateTrigger({ pressureTokens: 730, contextWindow: 1000, triggerRatio: 0.72 })
  assert(ratio.shouldTrigger)
  assertEqual(ratio.reason, 'pressure')
  const remaining = evaluateTrigger({
    pressureTokens: 85000,
    contextWindow: 100000,
    triggerRatio: 0.95,
    minRemainingTokens: 0,
  })
  assert(remaining.shouldTrigger, 'remaining reserve still fires when the ratio does not')
  assertEqual(remaining.reason, 'remaining')
  assertEqual(remaining.remainingBudget, 20000)
  const absolute = evaluateTrigger({ pressureTokens: 6000, triggerTokens: 5000 })
  assert(absolute.shouldTrigger)
  assertEqual(absolute.reason, 'absolute')
  const idle = evaluateTrigger({ pressureTokens: 1000, contextWindow: 1000000, triggerRatio: 0.72 })
  assertEqual(idle.shouldTrigger, false)
  assertEqual(idle.reason, 'none')
  const unknown = evaluateTrigger({})
  assertEqual(unknown.shouldTrigger, false)
  assertEqual(unknown.reason, 'unknown')
})

// --- plan filtering --------------------------------------------------------

test('plan skips error, non-text, short and already-cleared results', () => {
  const world = makeWorld()
  const group = { turn: 1, step: 1 }
  world.push('tool/result', {
    ...group,
    error: { name: 'ToolError' },
    message: { id: 'e', role: 'tool', toolCallId: 'e', source: { kind: 'tool', callId: 'e' }, isError: true, content: [{ type: 'text', text: PAD(3000) }] },
  })
  world.push('tool/result', {
    ...group,
    message: { id: 'i', role: 'tool', toolCallId: 'i', source: { kind: 'tool', callId: 'i' }, isError: false, content: [{ type: 'image', data: 'x' }] },
  })
  world.push('tool/result', {
    ...group,
    message: { id: 's', role: 'tool', toolCallId: 's', source: { kind: 'tool', callId: 's' }, isError: false, content: [{ type: 'text', text: PAD(100) }] },
  })
  world.push('tool/result', {
    ...group,
    message: { id: 'c', role: 'tool', toolCallId: 'c', source: { kind: 'tool', callId: 'c' }, isError: false, content: [{ type: 'text', text: DEFAULT_PLACEHOLDER }] },
  })
  addTurn(world, 1, 1, 1, 3000)
  world.push('user/message', { role: 'user', content: [{ type: 'text', text: 'keep me' }] })
  const result = plan(world, { keepRecentGroups: 0, keepFirstEvents: 0 })
  assertEqual(result.replacements.length, 1)
  assertEqual(result.skipped.error, 1)
  assertEqual(result.skipped.nonText, 1)
  assertEqual(result.skipped.tooSmall, 1)
  assertEqual(result.skipped.alreadyCleared, 1)
})

test('maxResultsPerPass caps one pass', () => {
  const world = makeWorld()
  addTurn(world, 1, 1, 10)
  const result = plan(world, { keepRecentGroups: 0, keepFirstEvents: 0, maxResultsPerPass: 3 })
  assertEqual(result.replacements.length, 3)
  assertEqual(result.skipped.overCap, 7)
})

test('a pass below MIN_SAVINGS_TOKENS is flagged as not worth committing', () => {
  const world = makeWorld()
  addTurn(world, 1, 1, 1, 600)
  const small = plan(world, { keepRecentGroups: 0, keepFirstEvents: 0, minCharsPerResult: 64 })
  assertEqual(small.replacements.length, 1)
  assert(small.estimatedTokensSaved < MIN_SAVINGS_TOKENS)
  assertEqual(small.belowSavingsFloor, true)

  const bigWorld = makeWorld()
  addTurn(bigWorld, 1, 1, 3, 4000)
  const big = plan(bigWorld, { keepRecentGroups: 0, keepFirstEvents: 0 })
  assert(big.estimatedTokensSaved >= MIN_SAVINGS_TOKENS)
  assertEqual(big.belowSavingsFloor, false)
})

test('placeholder text is configurable and drives cleared detection', () => {
  const world = makeWorld()
  world.push('tool/result', {
    turn: 1,
    step: 1,
    message: { id: 'a', role: 'tool', toolCallId: 'a', source: { kind: 'tool', callId: 'a' }, isError: false, content: [{ type: 'text', text: 'CLEARED' }] },
  })
  addTurn(world, 1, 1, 1, 3000)
  const result = plan(world, { keepRecentGroups: 0, keepFirstEvents: 0, placeholderText: 'CLEARED' })
  assertEqual(result.replacements.length, 1, 'custom placeholder counts as already cleared')
  assertEqual(result.skipped.alreadyCleared, 1)
  assertEqual(result.placeholderText, 'CLEARED')
  assertEqual(result.replacements[0].tokensAfter, ESTIMATE('CLEARED'))
})

test('isReplaceableToolMessage refuses errors, images and empty text', () => {
  assert(isReplaceableToolMessage({ role: 'tool', content: [{ type: 'text', text: 'x' }] }))
  assert(!isReplaceableToolMessage({ role: 'tool', isError: true, content: [{ type: 'text', text: 'x' }] }))
  assert(!isReplaceableToolMessage({ role: 'tool', content: [{ type: 'image', data: 'x' }] }))
  assert(!isReplaceableToolMessage({ role: 'tool', content: [] }))
  assert(!isReplaceableToolMessage({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }))
  assert(!isReplaceableToolMessage(undefined))
})

// --- wiring over fakes -----------------------------------------------------

function makeState(overrides = {}) {
  const logs = []
  const folded = { compactionOpen: false, todos: null, lastCompactionEndSeq: -1 }
  const state = {
    logs,
    folded,
    log(level, message) { logs.push(level + ': ' + message) },
    sessionState: { stateOf: () => folded },
    loadHost: fakeLoadHost,
    ...overrides,
  }
  return state
}

function makeMeter(pressureTokens, contextWindow) {
  return {
    contextPressure: () => ({ contextWindow, pressureTokens }),
    measure: () => ({ totalTokens: pressureTokens }),
    estimateMessage: (message) => Math.ceil(JSON.stringify(message?.content ?? []).length / 4),
  }
}

async function driveWiring() {
  const context = createFakeContext({ services: { tokenMeter: makeMeter(900, 1000) } })
  const session = createFakeSession()
  const state = makeState()
  const disposer = install(context.ctx, {
    microcompact: { triggerRatio: 0.5, minCharsPerResult: 64, keepRecentGroups: 0, keepFirstEvents: 0, maxResultsPerPass: 4 },
  }, state)
  const appended = []
  for (let index = 0; index < 3; index += 1) {
    const callId = 'wire-' + index
    const event = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'msg-' + callId,
        role: 'tool',
        toolCallId: callId,
        source: { kind: 'tool', callId },
        isError: false,
        content: [{ type: 'text', text: 'wired result ' + PAD(2000) }],
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    session.surface.nodes.push(event.seq)
    appended.push(event)
    await context.emit('session/event', session, event)
  }
  await context.waterfall('agent/pre-step', { agent: { session } })
  const beforeLock = session.appended.length
  state.folded.compactionOpen = true
  await context.waterfall('agent/pre-step', { agent: { session } })
  const afterLocked = session.appended.length
  state.folded.compactionOpen = false
  return { session, state, disposer, beforeLock, afterLocked }
}

const wiring = await driveWiring()

test('wiring writes a prune claim and a replacement surfaceOp', () => {
  const prunes = wiring.session.appended.filter((event) => event.type === 'compaction/prune')
  const replacements = wiring.session.appended.filter((event) => event.type === 'tool/result' && event.surfaceOp !== 'append')
  assertEqual(prunes.length, 3)
  assertEqual(replacements.length, 3)
  assertEqual(replacements[0].surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 })
  assertEqual(replacements[0].sourceEventSeqs, [0])
  assertEqual(replacements[0].data.message.content[0].text, '[Old tool result content cleared]')
  assertEqual(replacements[0].data.turn, 1, 'the rest of the tool-result payload survives the rewrite')
  assertEqual(prunes[0].data.shadowedSeqs, [0])
})

test('wiring respects the compaction lock from session state', () => {
  assert(wiring.beforeLock > 0)
  assertEqual(wiring.afterLocked, wiring.beforeLock, 'no append while compactionOpen is true')
})

test('wiring fails open without session state or a session surface', async () => {
  const context = createFakeContext({ services: {} })
  const session = createFakeSession()
  const state = makeState({ sessionState: undefined })
  const disposer = install(context.ctx, { microcompact: {} }, state)
  assertEqual(typeof disposer, 'function')
  await context.waterfall('agent/pre-step', { agent: { session } })
  await context.waterfall('agent/pre-step', { agent: {} })
  await context.waterfall('agent/pre-step', {})
  assertEqual(session.appended.length, 0)
  disposer()
})

test('install never throws when the context rejects listeners', () => {
  const context = createFakeContext({})
  context.ctx.on = () => { throw new Error('no listeners') }
  let result
  try {
    result = install(context.ctx, { microcompact: {} }, makeState())
  } catch (error) {
    throw new Error('install must fail open: ' + error.message)
  }
  assert(result === undefined || typeof result === 'function')
})

test('wiring still works when the state has no loadHost (clean environment)', async () => {
  const context = createFakeContext({ services: { tokenMeter: makeMeter(950, 1000) } })
  const session = createFakeSession()
  const state = makeState()
  delete state.loadHost
  const disposer = install(context.ctx, {
    microcompact: { triggerRatio: 0.5, minCharsPerResult: 64, keepRecentGroups: 0, keepFirstEvents: 0 },
  }, state)
  const event = session.append('tool/result', {
    turn: 2,
    step: 1,
    message: {
      id: 'msg-clean',
      role: 'tool',
      toolCallId: 'clean',
      source: { kind: 'tool', callId: 'clean' },
      isError: false,
      content: [{ type: 'text', text: 'clean env ' + PAD(2000) }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.surface.nodes.push(event.seq)
  await context.emit('session/event', session, event)
  await context.waterfall('agent/pre-step', { agent: { session } })
  const replacements = session.appended.filter((entry) => entry.type === 'tool/result' && entry.surfaceOp !== 'append')
  assertEqual(replacements.length, 1, 'freezeMessage fallback keeps the pass working')
  assertEqual(replacements[0].data.message.content[0].text, '[Old tool result content cleared]')
  disposer()
})
