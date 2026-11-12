/**
 * stuckDetector（duplicate-guard 2.0）测试：五模式纯判定 + fake ctx 集成。
 *
 * 覆盖：四类 fixture（同观察重复 / 连续错误 / ABAB 乒乓 / 独白）、
 * context-overflow advisory、恢复类与白名单豁免、resume（fold 折叠的 ring
 * JSON 往返后仍触发）、以及 install 的 fail-open。
 */
import { test, assert, assertEqual } from '../harness.mjs'
import { sectionDefaults } from '../../lib/defaults.js'
import { foldEvent, initialState } from '../../lib/session-state.js'
import { install } from '../../lib/duplicate-guard.js'
import {
  callSignature,
  classifyOverflow,
  detectStuck,
  isExempt,
  isOverflowFailure,
  isRecoveryTool,
  monologueFromMessages,
  observationSignature,
  renderDenial,
  renderMonologueReminder,
  renderOverflowAdvice,
  renderReminder,
  reminderFor,
  resolveStuckOptions,
  normalizeRing,
  trailingAlternation,
} from '../../lib/pure/stuck-core.js'

const options = resolveStuckOptions(sectionDefaults('duplicateGuard', {}))
const entry = (seq, name, args, resultKey, isError = false) => {
  const signature = typeof args === 'string' ? { name, argsKey: args } : callSignature(name, args)
  return { seq, name, argsKey: signature.argsKey, resultKey, isError }
}

// ---------- 配置与豁免 ----------

test('resolveStuckOptions applies defaults and maps legacy maxIdenticalCalls', () => {
  assertEqual(options.remindAt, 3)
  assertEqual(options.blockAt, 5)
  assertEqual(options.identicalObservationAt, 4)
  assertEqual(options.consecutiveErrorsAt, 3)
  assertEqual(options.alternatingAt, 6)
  assertEqual(options.monologueAt, 3)
  assertEqual(options.contextOverflowAt, 2)
  assertEqual(options.whitelist, [])
  // 旧配置 maxIdenticalCalls: 3 映射到 blockAt，且 remindAt 被压到 blockAt 之前。
  const legacy = resolveStuckOptions(sectionDefaults('duplicateGuard', {}), { legacyBlockAt: 3 })
  assertEqual(legacy.blockAt, 3)
  assertEqual(legacy.remindAt, 2)
  // 新配置显式 blockAt 优先于旧键。
  const explicit = resolveStuckOptions(sectionDefaults('duplicateGuard', { duplicateGuard: { blockAt: 7 } }), { legacyBlockAt: 3 })
  assertEqual(explicit.blockAt, 7)
})

test('recovery tools and whitelist are exempt', () => {
  assert(isRecoveryTool('goal_verify'))
  assert(isRecoveryTool('job_output'))
  assert(isRecoveryTool('repo_status'))
  assert(isRecoveryTool('cache_report'))
  assert(!isRecoveryTool('read'))
  const configured = resolveStuckOptions({ whitelist: ['read', 'mcp_*'] })
  assert(isExempt('read', configured))
  assert(isExempt('mcp_call', configured))
  assert(isExempt('', configured), 'missing tool name is fail-open')
  assert(isExempt('get_goal', configured))
  assert(!isExempt('bash', configured))
})

test('call signatures match the session-state fold', () => {
  const readArgs = { b: 2, a: 1 }
  let folded = foldEvent(initialState(), { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'read', arguments: readArgs } })
  folded = foldEvent(folded, {
    type: 'tool/result',
    seq: 2,
    data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'same text' }] } },
  })
  const signature = callSignature('read', { a: 1, b: 2 })
  assertEqual(folded.toolRing[0].argsKey, signature.argsKey, 'ring argsKey must use the same canonical hash')
  assertEqual(folded.toolRing[0].resultKey, observationSignature('same text').resultKey, 'ring resultKey uses the same hash')
})

// ---------- 模式 1：同动作 → 同观察 ----------

test('pattern 1: four identical observations block the fifth attempt', () => {
  const call = callSignature('read', { path: 'src/a.ts' })
  const ring = [1, 2, 3, 4].map((seq) => entry(seq, 'read', { path: 'src/a.ts' }, 'same-observation'))
  const detection = detectStuck(ring, call, options)
  assert(detection !== undefined, 'must detect the loop')
  assertEqual(detection.mode, 'identical-observation')
  assertEqual(detection.past, 4)
  assertEqual(detection.attempt, 5)
  const reason = renderDenial(detection)
  assert(reason.includes('identical-observation'), 'reason names the mode')
  assert(reason.includes('4 times'), 'reason names the count')
  assert(reason.toLowerCase().includes('vary the arguments'), 'reason gives an alternative')
  assertEqual(detectStuck(ring.slice(0, 3), call, options), undefined, 'three observations are not enough')
})

// ---------- 模式 2：同动作连续错误 ----------

test('pattern 2: three consecutive failures block the fourth attempt', () => {
  const ring = [1, 2, 3].map((seq) => entry(seq, 'bash', { command: 'npm test' }, 'err-' + seq, true))
  const detection = detectStuck(ring, callSignature('bash', { command: 'npm test' }), options)
  assertEqual(detection.mode, 'consecutive-errors')
  assertEqual(detection.past, 3)
  assertEqual(detection.attempt, 4)
  const reason = renderDenial(detection)
  assert(reason.includes('consecutive-errors'))
  assert(reason.includes('failed 3 times'))
  // 不同参数的同名工具不算同动作。
  assertEqual(detectStuck(ring, callSignature('bash', { command: 'npm run build' }), options), undefined)
})

// ---------- 模式 4：A-B-A-B 乒乓 ----------

test('pattern 4: A-B-A-B alternation blocks the continuing action', () => {
  const actionA = callSignature('read', { path: 'a.ts' })
  const actionB = callSignature('read', { path: 'b.ts' })
  const ring = [
    entry(1, 'read', { path: 'a.ts' }, 'a1'),
    entry(2, 'read', { path: 'b.ts' }, 'b1'),
    entry(3, 'read', { path: 'a.ts' }, 'a2'),
    entry(4, 'read', { path: 'b.ts' }, 'b2'),
    entry(5, 'read', { path: 'a.ts' }, 'a3'),
    entry(6, 'read', { path: 'b.ts' }, 'b3'),
  ]
  assertEqual(trailingAlternation(normalizeRing(ring)).count, 6)
  const detection = detectStuck(ring, actionA, options)
  assertEqual(detection.mode, 'alternating-abab')
  assertEqual(detection.past, 6)
  assertEqual(detection.attempt, 7)
  assert(renderDenial(detection).includes('alternated A-B-A-B'))
  // 交替未达阈值 / 不是交替的下一步时放行。
  assertEqual(detectStuck(ring.slice(0, 5), actionA, options), undefined)
  assertEqual(detectStuck(ring, callSignature('read', { path: 'c.ts' }), options), undefined)
})

// ---------- 通用重复调用与提醒 ----------

test('generic identical calls block after blockAt repeats', () => {
  const call = callSignature('read', { path: 'x.ts' })
  const ring = [1, 2, 3, 4, 5].map((seq) => entry(seq, 'read', { path: 'x.ts' }, 'obs-' + seq))
  const detection = detectStuck(ring, call, options)
  assertEqual(detection.mode, 'identical-call')
  assertEqual(detection.past, 5)
  assertEqual(detection.attempt, 6)
  assert(renderDenial(detection).includes('identical-call'))
  assertEqual(detectStuck(ring.slice(0, 4), call, options), undefined)
})

test('reminder fires once at remindAt and names the block threshold', () => {
  const call = callSignature('read', { path: 'x.ts' })
  const ring = [1, 2].map((seq) => entry(seq, 'read', { path: 'x.ts' }, 'obs-' + seq))
  const detection = reminderFor(ring, call, options)
  assert(detection !== undefined, 'third identical call reminds')
  assertEqual(detection.past, 3)
  assertEqual(detection.nextBlockAt, 6)
  const text = renderReminder(detection)
  assert(text.includes('identical-call'), 'reminder names the pattern')
  assert(text.includes('blocked on attempt 6'), 'reminder names the block threshold')
  assertEqual(reminderFor(ring.concat([entry(3, 'read', { path: 'x.ts' }, 'obs-3')]), call, options), undefined, 'reminder is one-shot')
  assertEqual(reminderFor(ring, callSignature('get_goal'), options), undefined, 'recovery tools never remind')
})

test('normal polling and distinct reads are never flagged (regression set >= 20)', () => {
  const ring = []
  const calls = []
  for (let index = 0; index < 10; index += 1) {
    const call = callSignature('read', { path: 'file-' + index + '.ts' })
    calls.push(call)
    ring.push(entry(index * 2 + 1, 'read', { path: 'file-' + index + '.ts' }, 'r-' + index))
    ring.push(entry(index * 2 + 2, 'job_output', { jobId: 'job-' + index }, 'j-' + index))
  }
  for (const call of calls) assertEqual(detectStuck(ring, call, options), undefined, 're-reading a file twice is fine')
  assertEqual(detectStuck(ring, callSignature('read', { path: 'new.ts' }), options), undefined)
  assertEqual(detectStuck(ring, callSignature('bash', { command: 'ls' }), options), undefined)
})

// ---------- resume（持久化 ring） ----------

test('stuck counts survive resume because they come from the persisted ring', () => {
  let folded = initialState()
  let seq = 0
  for (let index = 0; index < 4; index += 1) {
    seq += 1
    folded = foldEvent(folded, {
      type: 'tool/call',
      seq,
      data: { callId: 'c' + index, name: 'read', arguments: { path: 'same.ts' } },
    })
    seq += 1
    folded = foldEvent(folded, {
      type: 'tool/result',
      seq,
      data: { message: { toolCallId: 'c' + index, content: [{ type: 'text', text: 'same body' }] } },
    })
  }
  assertEqual(folded.toolRing.length, 4)
  // resume: 折叠状态经过 JSON 序列化/反序列化后仍然是同一批计数。
  const resumedRing = JSON.parse(JSON.stringify(folded.toolRing))
  const detection = detectStuck(resumedRing, callSignature('read', { path: 'same.ts' }), options)
  assert(detection !== undefined, 'resumed counters still detect the loop')
  assertEqual(detection.mode, 'identical-observation')
})

// ---------- 模式 3：独白 ----------

test('pattern 3: consecutive monologue advice renders and approximates', () => {
  assertEqual(monologueFromMessages([{ role: 'user' }, { role: 'assistant' }, { role: 'assistant' }]), 2)
  assertEqual(monologueFromMessages([{ role: 'assistant' }, { role: 'tool' }]), 0)
  const text = renderMonologueReminder(3, options)
  assert(text.includes('3 assistant messages'))
  assert(text.includes('call a tool'))
})

// ---------- 模式 5：context overflow ----------

test('pattern 5: overflow failures are classified and advised', () => {
  assert(classifyOverflow('Error: maximum context length exceeded'))
  assert(classifyOverflow('prompt is too long: 300000 tokens'))
  assert(!classifyOverflow('normal tool output'))
  assert(!classifyOverflow(''))
  assert(isOverflowFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }))
  assert(isOverflowFailure({ code: 'LLM_ERROR', message: 'input is too long for this model' }))
  assert(!isOverflowFailure({ code: 'RATE_LIMIT', message: 'slow down' }))
  const advice = renderOverflowAdvice(2, options)
  assert(advice.includes('/compact'))
  assert(advice.includes('2 times'))
})

// ---------- install / 监听器集成 ----------

function createCtx() {
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
    get() {
      return undefined
    },
  }
}

function createState(fold, options = {}) {
  return {
    log() {},
    sessionState: options.noSessionState
      ? undefined
      : {
          stateOf: () => (typeof fold === 'function' ? fold() : fold),
          onEvent: (listener) => {
            if (typeof options.onEvent === 'function') options.onEvent(listener)
            return () => {}
          },
        },
    loadHost: options.loadHost ?? (async () => undefined),
  }
}

const listenersOf = (ctx, name) => ctx.listeners.get(name) ?? []
const nextAllow = () => Promise.resolve({ kind: 'allow' })
const preExecute = (ctx, exec) => listenersOf(ctx, 'tools/pre-execute')[0](exec, nextAllow)
const postExecute = (ctx, exec, result) =>
  listenersOf(ctx, 'tools/post-execute')[0](exec, result, () => Promise.resolve({ kind: 'accept' }))
const preStep = (ctx, payload) =>
  listenersOf(ctx, 'agent/pre-step')[0](payload, () => Promise.resolve({ kind: 'enter', messages: [] }))

const asyncFailures = []
async function scenario(name, fn) {
  try {
    await fn()
  } catch (error) {
    asyncFailures.push(name + ': ' + (error instanceof Error ? error.message : String(error)))
  }
}

await scenario('pre-execute denies a pattern-1 loop with a self-contained reason', async () => {
  const ctx = createCtx()
  const agent = { session: {} }
  const fold = {
    turn: 1,
    step: 4,
    monologue: 0,
    lastUserMessageSeq: -1,
    toolRing: [1, 2, 3, 4].map((seq) => entry(seq, 'read', { path: 'a.ts' }, 'same')),
  }
  install(ctx, {}, createState(fold))
  const decision = await preExecute(ctx, { name: 'read', arguments: { path: 'a.ts' }, agent })
  assertEqual(decision.kind, 'deny')
  assert(decision.reason.includes('identical-observation'))
  assert(decision.reason.includes('[identical-observation]'))
})

await scenario('pre-execute allows whitelisted and recovery tools', async () => {
  const ctx = createCtx()
  const fold = {
    turn: 1,
    step: 6,
    monologue: 0,
    lastUserMessageSeq: -1,
    toolRing: [1, 2, 3, 4, 5, 6].map((seq) => entry(seq, 'goal_verify', {}, 'same')),
  }
  const agent = { session: {} }
  install(ctx, { duplicateGuard: { whitelist: ['read_stub'] } }, createState(fold))
  assertEqual((await preExecute(ctx, { name: 'goal_verify', arguments: {}, agent })).kind, 'allow')
  const repeat = { name: 'read_stub', arguments: { path: 'x' }, agent }
  const allowed = await preExecute(ctx, repeat)
  assertEqual(allowed.kind, 'allow')
})

await scenario('pre-execute fails open when the session state is missing', async () => {
  const ctx = createCtx()
  install(ctx, {}, createState(undefined, { noSessionState: true }))
  const decision = await preExecute(ctx, { name: 'read', arguments: {}, agent: {} })
  assertEqual(decision.kind, 'allow')
  const result = await postExecute(ctx, { name: 'read', arguments: {}, agent: {} }, { content: [], isError: false })
  assertEqual(result.kind, 'accept')
})

await scenario('post-execute injects one reminder at remindAt only', async () => {
  const ctx = createCtx()
  const fold = {
    turn: 1,
    step: 2,
    monologue: 0,
    lastUserMessageSeq: -1,
    toolRing: [entry(1, 'read', { path: 'a.ts' }, 'same-1'), entry(2, 'read', { path: 'a.ts' }, 'same-2')],
  }
  const agent = { session: {} }
  install(ctx, {}, createState(() => fold))
  const exec = { name: 'read', arguments: { path: 'a.ts' }, agent }
  const result = await postExecute(ctx, exec, { content: [{ type: 'text', text: 'same-3' }], isError: false })
  assert(Array.isArray(result.additionalContexts) && result.additionalContexts.length === 1)
  assert(result.additionalContexts[0].content[0].text.includes('Stuck detector'))
  assertEqual(result.additionalContexts[0].source.kind, 'dsh-workflow-boost-stuck-detector')
  // 真实宿主里 tool/result 已提交进 ring：第四次不再是 remindAt 边界，不重复提醒。
  fold.toolRing.push(entry(3, 'read', { path: 'a.ts' }, 'same-3'))
  const again = await postExecute(ctx, exec, { content: [{ type: 'text', text: 'same-4' }], isError: false })
  assertEqual(again.additionalContexts, undefined)
})

await scenario('monologue advisory is injected once per streak', async () => {
  const fold = { turn: 1, step: 2, monologue: 3, lastUserMessageSeq: -1, toolRing: [] }
  const ctx = createCtx()
  install(ctx, {}, createState(() => fold))
  const agent = { session: {} }
  const payload = { agent, turn: 1, step: 2, messages: [], signal: { aborted: false } }
  const first = await preStep(ctx, payload)
  assert(Array.isArray(first.messages) && first.messages.length === 1, 'one monologue notice')
  assert(first.messages[0].content[0].text.includes('assistant messages without a tool call'))
  const second = await preStep(ctx, payload)
  assertEqual(second.messages.length, 0, 'same streak is not re-notified')
  fold.monologue = 0
  await preStep(ctx, payload)
  fold.monologue = 3
  const third = await preStep(ctx, payload)
  assertEqual(third.messages.length, 1, 'a new streak reminds again')
})

await scenario('consecutive context-overflow tool errors produce one advisory', async () => {
  const ctx = createCtx()
  const fold = { turn: 1, step: 3, monologue: 0, lastUserMessageSeq: -1, toolRing: [] }
  const agent = { session: {} }
  install(ctx, {}, createState(fold))
  const exec = { name: 'bash', arguments: { command: 'x' }, agent }
  const overflow = { content: [{ type: 'text', text: 'Error: context window exceeded' }], isError: true }
  const first = await postExecute(ctx, exec, overflow)
  assertEqual(first.additionalContexts, undefined, 'one overflow is not enough')
  const second = await postExecute(ctx, exec, overflow)
  assert(Array.isArray(second.additionalContexts) && second.additionalContexts.length === 1)
  assert(second.additionalContexts[0].content[0].text.includes('/compact'))
})

await scenario('request-level overflow errors are collected and advised on next pre-step', async () => {
  const ctx = createCtx()
  const fold = { turn: 1, step: 1, monologue: 0, lastUserMessageSeq: -1, toolRing: [] }
  const agent = { session: {} }
  install(ctx, {}, createState(fold))
  const handler = listenersOf(ctx, 'agent/request-error')[0]
  const nextError = () => Promise.resolve(undefined)
  await handler({ agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too big' } }, nextError)
  await handler({ agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too big' } }, nextError)
  const decision = await preStep(ctx, { agent, turn: 1, step: 1, messages: [], signal: { aborted: false } })
  assertEqual(decision.messages.length, 1)
  assert(decision.messages[0].content[0].text.toLowerCase().includes('context overflow'))
  assert(decision.messages[0].content[0].text.includes('/compact'))
})

await scenario('state.loadHost is preferred for createUserMessage', async () => {
  const ctx = createCtx()
  const fold = {
    turn: 1,
    step: 2,
    monologue: 0,
    lastUserMessageSeq: -1,
    toolRing: [entry(1, 'read', { path: 'a.ts' }, 'r1'), entry(2, 'read', { path: 'a.ts' }, 'r2')],
  }
  const state = createState(fold, {
    loadHost: async () => ({ createUserMessage: (input) => ({ ...input, role: 'user', id: 'host-id' }) }),
  })
  install(ctx, {}, state)
  const result = await postExecute(ctx, { name: 'read', arguments: { path: 'a.ts' }, agent: { session: {} } }, { content: [], isError: false })
  assertEqual(result.additionalContexts[0].id, 'host-id')
})

test('integration scenarios above all passed', () => {
  assertEqual(asyncFailures, [])
})

test('install survives a hostile ctx and disposes cleanly', () => {
  const throwing = {
    on() {
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
