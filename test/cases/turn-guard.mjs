/**
 * turnGuard 测试：纯决策边界 + 用 fake ctx 驱动真实监听器的集成场景。
 *
 * 测试不允许静态依赖 @deepseek-ai/*：install 走 state.loadHost 的 fake，
 * 消息工厂回落到纯对象；这正是干净环境下的实际路径。
 */
import { test, assert, assertEqual } from '../harness.mjs'
import { sectionDefaults } from '../../lib/defaults.js'
import { install } from '../../lib/turn-guard.js'
import {
  describeLimits,
  describeUsage,
  detectFinishIssue,
  freshVerifyInRing,
  inProgressTodos,
  renderBudgetReminder,
  renderBudgetSteer,
  renderFinishSteer,
  resolveTurnOptions,
  turnBudget,
} from '../../lib/pure/turn-guard-core.js'

// ---------- 纯决策层 ----------

test('resolveTurnOptions applies documented defaults', () => {
  const options = resolveTurnOptions(sectionDefaults('turnGuard', {}))
  assertEqual(options.mode, 'advisory')
  assertEqual(options.maxSteps, 150)
  assertEqual(options.maxMinutes, 60)
  assertEqual(options.maxTokens, 0)
  assertEqual(options.warnAt, 0.8)
  assertEqual(options.hardStop, false)
  assertEqual(options.finishChecks, true)
  assertEqual(options.cancelAtLimit, false)
})

test('resolveTurnOptions clamps bad values and derives cancelAtLimit', () => {
  const options = resolveTurnOptions({ maxSteps: -3, maxMinutes: 'nope', warnAt: 9, mode: 'enforce' })
  assertEqual(options.maxSteps, 1)
  assertEqual(options.maxMinutes, 60)
  assertEqual(options.warnAt, 0.95)
  assertEqual(options.cancelAtLimit, true)
  assertEqual(resolveTurnOptions({ hardStop: true }).cancelAtLimit, true)
})

test('turnBudget warns only after the 80% boundary is crossed', () => {
  const options = resolveTurnOptions({ maxSteps: 150, maxMinutes: 60, warnAt: 0.8 })
  assertEqual(turnBudget({ steps: 120 }, options).approaching, false, 'exactly 80% does not warn')
  assertEqual(turnBudget({ steps: 121 }, options).approaching, true, '121/150 warns')
  assertEqual(turnBudget({ steps: 149 }, options).exceeded, false)
  assertEqual(turnBudget({ steps: 150 }, options).exceeded, true)
  assertEqual(turnBudget({ steps: 0, elapsedMs: 48 * 60000 }, options).approaching, false)
  assertEqual(turnBudget({ steps: 0, elapsedMs: 48 * 60000 + 1 }, options).approaching, true)
  assertEqual(turnBudget({ steps: 0, elapsedMs: 60 * 60000 }, options).exceeded, true)
})

test('turnBudget handles the token ceiling when enabled', () => {
  const options = resolveTurnOptions({ maxTokens: 1000 })
  assertEqual(turnBudget({ tokens: 800 }, options).approaching, false)
  assertEqual(turnBudget({ tokens: 801 }, options).approaching, true)
  assertEqual(turnBudget({ tokens: 1000 }, options).exceeded, true)
})

test('budget text names usage and limits', () => {
  const options = resolveTurnOptions({ maxSteps: 150, maxMinutes: 60 })
  const budget = turnBudget({ steps: 121, elapsedMs: 3 * 60000 }, options)
  const usage = describeUsage(budget, options)
  assert(usage.includes('121/150'), 'usage shows steps')
  assert(describeLimits(options).includes('150 steps'), 'limits show max steps')
  const reminder = renderBudgetReminder(budget, options)
  assert(reminder.includes('approaching'), 'reminder is advisory')
  assert(reminder.includes('121/150'), 'reminder repeats the numbers')
  assert(renderBudgetSteer(turnBudget({ steps: 150 }, options), options).includes('exhausted'))
})

test('detectFinishIssue gates goal evidence and open todos', () => {
  assertEqual(detectFinishIssue({ goalActive: true, mutatedInTurn: true, freshVerify: false }).kind, 'goal')
  assertEqual(detectFinishIssue({ goalActive: true, mutatedInTurn: true, freshVerify: true }), undefined)
  assertEqual(detectFinishIssue({ goalActive: true, mutatedInTurn: false, freshVerify: false }), undefined)
  assertEqual(detectFinishIssue({ goalActive: false, inProgress: { count: 2, first: 'step' } }).kind, 'todo')
  assertEqual(detectFinishIssue({}), undefined)
  assert(renderFinishSteer({ kind: 'goal' }).includes('goal_verify'))
  assert(renderFinishSteer({ kind: 'todo', count: 2, sample: 'step' }).includes('in_progress'))
  assertEqual(renderFinishSteer(undefined), '')
})

test('freshVerifyInRing compares the verify seq against the last write', () => {
  const ring = [
    { seq: 4, name: 'read' },
    { seq: 5, name: 'edit' },
    { seq: 9, name: 'goal_verify' },
  ]
  assertEqual(freshVerifyInRing(ring, 5), true, 'verify after the last write is fresh')
  assertEqual(freshVerifyInRing(ring, 9), false, 'verify before the last write is stale')
  assertEqual(freshVerifyInRing([{ seq: 3, name: 'goal_verify' }], 5), false)
  assertEqual(freshVerifyInRing([{ seq: 3, name: 'edit' }], 2), false, 'no verify at all')
  assertEqual(freshVerifyInRing([], -1), false)
})

test('inProgressTodos counts open items', () => {
  const counts = inProgressTodos([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'in_progress' },
  ])
  assertEqual(counts.count, 2)
  assertEqual(counts.first, 'b')
  assertEqual(inProgressTodos(null).count, 0)
})

// ---------- install / 监听器集成 ----------

function createCtx(services = {}) {
  const listeners = new Map()
  return {
    listeners,
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
    get(name) {
      return services[name]
    },
  }
}

function createState(fold, options = {}) {
  return {
    log() {},
    sessionState: options.noSessionState
      ? undefined
      : { stateOf: () => (typeof fold === 'function' ? fold() : fold), onEvent() {} },
    loadHost: options.loadHost ?? (async () => undefined),
  }
}

function createAgent() {
  const agent = { session: {}, steers: [], cancels: [] }
  agent.steer = (message) => agent.steers.push(message)
  agent.cancel = (cause) => agent.cancels.push(cause)
  return agent
}

const listenersOf = (ctx, name) => ctx.listeners.get(name) ?? []
const preStep = (ctx, agent, turn, step) =>
  listenersOf(ctx, 'agent/pre-step')[0]({ agent, turn, step, messages: [], signal: { aborted: false } }, () =>
    Promise.resolve({ kind: 'enter', messages: [] }))
const postExecute = (ctx, agent) =>
  listenersOf(ctx, 'tools/post-execute')[0](
    { name: 'read', arguments: { path: 'a' }, agent },
    { content: [{ type: 'text', text: 'ok' }], isError: false },
    () => Promise.resolve({ kind: 'accept' }),
  )
const turnStopping = (ctx, agent) => listenersOf(ctx, 'agent/turn-stopping')[0]({ agent, turn: 1, signal: { aborted: false } })

const asyncFailures = []
async function scenario(name, fn) {
  try {
    await fn()
  } catch (error) {
    asyncFailures.push(name + ': ' + (error instanceof Error ? error.message : String(error)))
  }
}

await scenario('a normal 10-step turn injects nothing and steers nothing', async () => {
  const ctx = createCtx()
  const state = createState({ turn: 1, step: 0, toolRing: [], todos: null, mutatedInTurn: false, lastMutationSeq: -1 })
  install(ctx, { turnGuard: { finishChecks: false } }, state)
  const agent = createAgent()
  for (let step = 1; step <= 10; step += 1) await preStep(ctx, agent, 1, step)
  for (let index = 0; index < 10; index += 1) {
    const result = await postExecute(ctx, agent)
    assertEqual(result.additionalContexts, undefined, 'no reminder in a normal turn')
  }
  await turnStopping(ctx, agent)
  assertEqual(agent.steers.length, 0)
  assertEqual(agent.cancels.length, 0)
})

await scenario('step 121 injects exactly one budget reminder', async () => {
  const ctx = createCtx()
  const state = createState({ turn: 1, step: 0, toolRing: [], todos: null, mutatedInTurn: false, lastMutationSeq: -1 })
  install(ctx, { turnGuard: { maxSteps: 150, finishChecks: false } }, state)
  const agent = createAgent()
  for (let step = 1; step <= 120; step += 1) await preStep(ctx, agent, 1, step)
  assertEqual((await postExecute(ctx, agent)).additionalContexts, undefined, 'step 120 is still below the warning')
  const decision = await preStep(ctx, agent, 1, 121)
  assertEqual(decision.kind, 'enter', 'the pre-step listener must pass the decision through')
  const warned = await postExecute(ctx, agent)
  assert(Array.isArray(warned.additionalContexts) && warned.additionalContexts.length === 1, 'one context attached')
  const message = warned.additionalContexts[0]
  assertEqual(message.role, 'user')
  assertEqual(message.source.form, 'notice')
  assert(message.content[0].text.includes('Turn budget'), 'budget notice text')
  assert(message.content[0].text.includes('121/150'), 'notice names the usage')
  const again = await postExecute(ctx, agent)
  assertEqual(again.additionalContexts, undefined, 'the reminder is one-shot')
})

await scenario('budget exhaustion steers once and keeps the turn open (advisory)', async () => {
  const ctx = createCtx()
  const state = createState({ turn: 1, step: 0, toolRing: [], todos: null, mutatedInTurn: false, lastMutationSeq: -1 })
  install(ctx, { turnGuard: { maxSteps: 150, finishChecks: false } }, state)
  const agent = createAgent()
  for (let step = 1; step <= 150; step += 1) await preStep(ctx, agent, 1, step)
  await turnStopping(ctx, agent)
  assertEqual(agent.steers.length, 1, 'steered exactly once')
  assert(agent.steers[0].content[0].text.includes('Turn budget exhausted'))
  assertEqual(agent.cancels.length, 0, 'advisory mode never cancels')
  await turnStopping(ctx, agent)
  assertEqual(agent.steers.length, 1, 'per-turn steer cap')
})

await scenario('hardStop cancels after the final steer', async () => {
  const ctx = createCtx()
  const state = createState({ turn: 1, step: 0, toolRing: [], todos: null, mutatedInTurn: false, lastMutationSeq: -1 })
  install(ctx, { turnGuard: { maxSteps: 2, hardStop: true, finishChecks: false } }, state)
  const agent = createAgent()
  await preStep(ctx, agent, 1, 1)
  await preStep(ctx, agent, 1, 2)
  await turnStopping(ctx, agent)
  assertEqual(agent.steers.length, 1)
  assertEqual(agent.cancels.length, 1)
  assertEqual(agent.cancels[0].kind, 'hook')
})

await scenario('finishChecks steers for an active goal without fresh verification', async () => {
  const fold = {
    turn: 1,
    step: 3,
    mutatedInTurn: true,
    lastMutationSeq: 11,
    toolRing: [{ seq: 11, name: 'edit', argsKey: 'x', resultKey: 'r', isError: false }],
    todos: null,
  }
  const ctx = createCtx({ goals: { get: () => ({ phase: 'active', id: 'goal-1' }) } })
  install(ctx, {}, createState(fold))
  const agent = createAgent()
  await preStep(ctx, agent, 1, 3)
  await turnStopping(ctx, agent)
  assertEqual(agent.steers.length, 1)
  assert(agent.steers[0].content[0].text.includes('goal_verify'))
  assertEqual(agent.cancels.length, 0)
})

await scenario('finishChecks passes once a fresh goal_verify exists', async () => {
  const fold = {
    turn: 1,
    step: 3,
    mutatedInTurn: true,
    lastMutationSeq: 11,
    toolRing: [
      { seq: 11, name: 'edit', argsKey: 'x', resultKey: 'r', isError: false },
      { seq: 12, name: 'goal_verify', argsKey: 'y', resultKey: 'ok', isError: false },
    ],
    todos: null,
  }
  const ctx = createCtx({ goals: { get: () => ({ phase: 'active', id: 'goal-1' }) } })
  install(ctx, {}, createState(fold))
  const agent = createAgent()
  await preStep(ctx, agent, 1, 3)
  await turnStopping(ctx, agent)
  assertEqual(agent.steers.length, 0)
})

await scenario('finishChecks steers when a todo is still in_progress', async () => {
  const fold = {
    turn: 1,
    step: 2,
    mutatedInTurn: false,
    lastMutationSeq: -1,
    toolRing: [],
    todos: [{ content: 'implement X', status: 'in_progress' }],
  }
  const ctx = createCtx()
  install(ctx, {}, createState(fold))
  const agent = createAgent()
  await preStep(ctx, agent, 1, 2)
  await turnStopping(ctx, agent)
  assertEqual(agent.steers.length, 1)
  assert(agent.steers[0].content[0].text.includes('in_progress'))
})

await scenario('state.loadHost is preferred for createUserMessage', async () => {
  const ctx = createCtx()
  const state = createState({ turn: 1, step: 0, toolRing: [], todos: null, mutatedInTurn: false, lastMutationSeq: -1 }, {
    loadHost: async () => ({
      createUserMessage: (input) => ({ ...input, role: 'user', id: 'host-message-id' }),
    }),
  })
  install(ctx, { turnGuard: { maxSteps: 2, finishChecks: false } }, state)
  const agent = createAgent()
  await preStep(ctx, agent, 1, 1)
  await preStep(ctx, agent, 1, 2)
  await turnStopping(ctx, agent)
  assertEqual(agent.steers.length, 1)
  assertEqual(agent.steers[0].id, 'host-message-id')
  assertEqual(agent.steers[0].source.kind, 'dsh-workflow-boost-turn-guard')
})

test('integration scenarios above all passed', () => {
  assertEqual(asyncFailures, [])
})

// ---------- fail-open ----------

test('install survives a hostile ctx and a missing session state', () => {
  const throwing = {
    on() {
      throw new Error('boom')
    },
    get() {
      throw new Error('boom')
    },
  }
  const dispose = install(throwing, {}, { log() {} })
  assert(typeof dispose === 'function')
  dispose()
  const empty = install({}, {}, { log() {} })
  assert(typeof empty === 'function')
  empty()
})

await scenario('listener failures are contained, not thrown into the host', async () => {
  const ctx = createCtx()
  const state = createState(undefined, { noSessionState: true })
  install(ctx, {}, state)
  const agent = createAgent()
  const payload = { agent, turn: 1, step: 1, messages: [], signal: { aborted: false } }
  const next = () => Promise.resolve({ kind: 'enter', messages: [] })
  const stepHandler = listenersOf(ctx, 'agent/pre-step')[0]
  assertEqual((await stepHandler(payload, next)).kind, 'enter')
  const stoppingHandler = listenersOf(ctx, 'agent/turn-stopping')[0]
  assertEqual(await stoppingHandler({ agent, turn: 1, signal: { aborted: false } }), undefined)
})
