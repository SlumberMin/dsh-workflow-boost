/**
 * focusChain 2.0 cases: Next line, verbatim acceptance criteria, configurable
 * render limits, content-hash dedupe, post-compaction forced re-anchor, and the
 * fail-open wiring that reads todos only from the plugin session-state fold.
 */
import { test, assert, assertEqual } from '../harness.mjs'
import { createFakeContext, createFakeSession, fakeLoadHost } from '../fakes.mjs'
import {
  MARKS,
  focusChainKey,
  nextActionable,
  normalizeTodos,
  renderFocusChain,
  splitAcceptance,
  todoCounts,
} from '../../lib/pure/focus-render.js'
import { install, resolveConfig } from '../../lib/focus-chain.js'

const TODOS = [
  { content: '读契约', status: 'completed' },
  { content: '写纯模块（验收：node test/run-case.mjs 全绿）', status: 'in_progress' },
  { content: '写测试', status: 'pending' },
]

// --- pure rendering --------------------------------------------------------

test('renderFocusChain renders progress, Next and item lines', () => {
  const text = renderFocusChain(TODOS, { step: 6, everySteps: 6 })
  assert(text.startsWith('[Focus chain'), 'labeled notice header')
  assert(text.includes('Progress: 1/3 complete, 1 in progress.'), 'progress line')
  assert(text.includes('Next: 2. 写纯模块 （验收：node test/run-case.mjs 全绿）'), 'Next points at the in-progress item')
  assert(text.includes('[x] 1. 读契约'))
  assert(text.includes('[>] 2. 写纯模块'))
  assert(text.includes('[ ] 3. 写测试'))
  assert(text.includes('refreshed after 6 tool calls'), 'period context')
})

test('Next falls back to the first pending item and never suggests a blocked or completed one', () => {
  const pendingFirst = [
    { content: 'done', status: 'completed' },
    { content: 'blocked one', status: 'blocked' },
    { content: 'pending one', status: 'pending' },
  ]
  const text = renderFocusChain(pendingFirst)
  assert(text.includes('Next: 3. pending one'), 'first pending wins')
  const none = [{ content: 'done', status: 'completed' }]
  assert(!renderFocusChain(none).includes('Next:'), 'nothing actionable means no Next line')
})

test('acceptance criteria survive verbatim even when the task text is clipped', () => {
  const longTask = '非常长的任务描述'.repeat(20)
  const content = longTask + '（验收：npm test 全绿且无 TODO）'
  const text = renderFocusChain([{ content, status: 'pending' }], { maxItemChars: 24 })
  assert(text.includes('（验收：npm test 全绿且无 TODO）'), 'acceptance clause is kept byte-for-byte')
  assert(text.includes('…'), 'task text itself is clipped')
  const split = splitAcceptance(content)
  assertEqual(split.acceptance, '（验收：npm test 全绿且无 TODO）')
  assertEqual(split.text, longTask)
})

test('maxItems, maxItemChars, progress and Next are configurable', () => {
  const many = []
  for (let index = 0; index < 10; index += 1) many.push({ content: 'item-' + index + '-' + 'x'.repeat(60), status: 'pending' })
  const text = renderFocusChain(many, {
    includeProgress: false,
    includeNextAction: false,
    maxItems: 3,
    maxItemChars: 20,
  })
  assert(!text.includes('Progress:'), 'progress disabled')
  assert(!text.includes('Next:'), 'Next disabled')
  assert(text.includes('... (7 more items not shown)'))
  assert(!text.includes('item-4-'), 'items beyond maxItems are not rendered')
  const clipped = text.split('\n').find((line) => line.startsWith('[ ] 1. '))
  assert(clipped.length <= '[ ] 1. '.length + 20, 'maxItemChars bounds the task text')
})

test('blocked items get their own marker and progress bucket', () => {
  const text = renderFocusChain([
    { content: 'waiting on review', status: 'blocked' },
    { content: 'normal', status: 'pending' },
  ])
  assert(text.includes(MARKS.blocked + ' 1. waiting on review'))
  assert(text.includes('Progress: 0/2 complete, 1 blocked.'))
})

test('empty, missing and malformed lists render nothing', () => {
  assertEqual(renderFocusChain([]), '')
  assertEqual(renderFocusChain(null), '')
  assertEqual(renderFocusChain([null, 42, { status: 'pending' }]), '')
  assertEqual(normalizeTodos(undefined).length, 0)
  assertEqual(renderFocusChain([{ content: 'unknown status item', status: 'waiting' }]).includes('[ ] 1.'), true)
})

test('counts and nextActionable follow todo semantics', () => {
  const counts = todoCounts(TODOS)
  assertEqual(counts, { total: 3, pending: 1, inProgress: 1, completed: 1, blocked: 0 })
  const next = nextActionable(TODOS)
  assertEqual(next.index, 2)
  assertEqual(next.todo.status, 'in_progress')
  assertEqual(nextActionable([{ content: 'a', status: 'completed' }]), undefined)
})

test('focusChainKey is stable per content and changes when the list changes', () => {
  const one = renderFocusChain(TODOS)
  const two = renderFocusChain(TODOS.map((todo) => ({ ...todo })))
  assertEqual(focusChainKey(one), focusChainKey(two), 'same content, same key')
  assert(focusChainKey(one) !== focusChainKey(renderFocusChain(TODOS.slice(0, 2))))
  assertEqual(focusChainKey('x').length, 8)
})

test('post-compaction snapshots carry the re-anchor marker', () => {
  const text = renderFocusChain(TODOS, { afterCompaction: true })
  assert(text.includes('re-anchored after context compaction'))
})

test('resolveConfig clamps render limits', () => {
  const settings = resolveConfig({ focusChain: { everySteps: 1, maxItems: 0, maxItemChars: 10, minItems: 0 } })
  assertEqual(settings.everySteps, 2)
  assertEqual(settings.maxItems, 1)
  assertEqual(settings.maxItemChars, 40)
  assertEqual(settings.minItems, 1)
  assertEqual(resolveConfig({ focusChain: { enabled: false } }).enabled, false)
})

// --- wiring over fakes -----------------------------------------------------

/** Drive the tools/post-execute waterfall chain the way the host does. */
async function postExecute(context, exec) {
  const chain = context.listeners.get('tools/post-execute') ?? []
  let index = 0
  const next = async () => (index < chain.length ? chain[index++](exec, undefined, next) : { kind: 'accept' })
  return next()
}

function contextsOf(decision) {
  return Array.isArray(decision?.additionalContexts) ? decision.additionalContexts : []
}

const wiring = await (async () => {
  const context = createFakeContext({})
  const session = createFakeSession()
  // The deprecated reader must never be touched; make it loud.
  session.eventAt = () => { throw new Error('eventAt() is prohibited') }
  const folded = { todos: TODOS.map((todo) => ({ ...todo })), lastCompactionEndSeq: -1, compactionOpen: false }
  const state = {
    log() {},
    sessionState: { stateOf: () => folded },
    loadHost: fakeLoadHost,
  }
  const disposer = install(context.ctx, { focusChain: { everySteps: 2 } }, state)
  const exec = { agent: { session } }
  const first = await postExecute(context, exec)
  const second = await postExecute(context, exec)
  const third = await postExecute(context, exec)
  const fourth = await postExecute(context, exec)
  folded.lastCompactionEndSeq = 7
  const forced = await postExecute(context, exec)
  folded.lastCompactionEndSeq = 8
  const forcedAgain = await postExecute(context, exec)
  folded.todos = []
  folded.lastCompactionEndSeq = 9
  const empty = await postExecute(context, exec)
  return { disposer, first, second, third, fourth, forced, forcedAgain, empty, folded }
})()

test('wiring injects the list once per everySteps period', () => {
  assertEqual(contextsOf(wiring.first).length, 0, 'not due yet')
  assertEqual(contextsOf(wiring.second).length, 1, 'due at step 2')
  const message = contextsOf(wiring.second)[0]
  assertEqual(message.source.kind, 'dsh-workflow-boost')
  assertEqual(message.source.form, 'notice')
  assert(message.content[0].text.includes('Next: 2.'))
})

test('wiring does not re-inject an unchanged list', () => {
  assertEqual(contextsOf(wiring.third).length, 0)
  assertEqual(contextsOf(wiring.fourth).length, 0, 'same content hash is suppressed on the next period')
})

test('wiring force-injects once after each compaction checkpoint', () => {
  assertEqual(contextsOf(wiring.forced).length, 1, 'compaction end forces a snapshot outside the period')
  assert(contextsOf(wiring.forced)[0].content[0].text.includes('re-anchored after context compaction'))
  assertEqual(contextsOf(wiring.forcedAgain).length, 1, 'a new compaction end overrides the duplicate hash once more')
  assertEqual(contextsOf(wiring.empty).length, 0, 'no todos means nothing to inject')
})

test('wiring fails open without session state and never throws from install', async () => {
  const context = createFakeContext({})
  const session = createFakeSession()
  const state = { log() {}, sessionState: undefined, loadHost: fakeLoadHost }
  const disposer = install(context.ctx, { focusChain: { everySteps: 2 } }, state)
  assertEqual(typeof disposer, 'function')
  const exec = { agent: { session } }
  for (let index = 0; index < 4; index += 1) {
    const decision = await postExecute(context, exec)
    assertEqual(contextsOf(decision).length, 0)
  }
  disposer()
  const broken = createFakeContext({})
  broken.ctx.on = () => { throw new Error('no listeners') }
  let result
  try {
    result = install(broken.ctx, { focusChain: {} }, { log() {} })
  } catch (error) {
    throw new Error('install must fail open: ' + error.message)
  }
  assert(result === undefined || typeof result === 'function')
})
