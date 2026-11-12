import { test, assert, assertEqual } from '../harness.mjs'
import { initialState, foldEvent, STATE_KEY, STATE_VERSION } from '../../lib/session-state.js'

const ev = (type, seq, data = {}) => ({ type, seq, data })

test('initialState is inert', () => {
  const state = initialState()
  assertEqual(state.compactionOpen, false)
  assertEqual(state.toolRing.length, 0)
  assertEqual(state.todos, null)
  assert(STATE_KEY.length > 0 && STATE_VERSION >= 1)
})

test('compaction start and end toggle the lock', () => {
  let state = foldEvent(initialState(), ev('compaction/start', 1))
  assert(state.compactionOpen, 'locked after start')
  assertEqual(state.lastCompactionStartSeq, 1)
  state = foldEvent(state, ev('compaction/end', 2))
  assert(!state.compactionOpen, 'unlocked after end')
  assertEqual(state.lastCompactionEndSeq, 2)
})

test('todo writes replace the list', () => {
  let state = foldEvent(initialState(), ev('todo/write', 3, { todos: [{ content: 'a', status: 'pending' }] }))
  assertEqual(state.todos.length, 1)
  state = foldEvent(state, ev('todo/write', 4, { todos: [] }))
  assertEqual(state.todos.length, 0)
  assertEqual(state.todosSeq, 4)
})

test('tool call and result build the tool ring', () => {
  let state = foldEvent(initialState(), ev('tool/call', 5, { callId: 'c1', name: 'read', arguments: { path: 'a' }, turn: 1, step: 1 }))
  state = foldEvent(state, ev('tool/result', 6, { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }))
  assertEqual(state.toolRing.length, 1)
  assertEqual(state.toolRing[0].name, 'read')
  assertEqual(state.errorCount, 0)
  assertEqual(state.monologue, 0)
})

test('error results increment errorCount', () => {
  let state = foldEvent(initialState(), ev('tool/call', 1, { callId: 'c', name: 'bash', arguments: {} }))
  state = foldEvent(state, ev('tool/result', 2, { message: { toolCallId: 'c', content: [{ type: 'text', text: 'boom' }], isError: true } }))
  assertEqual(state.errorCount, 1)
})

test('assistant messages count monologue, tool calls reset it', () => {
  let state = foldEvent(initialState(), ev('assistant/message', 1))
  state = foldEvent(state, ev('assistant/message', 2))
  assertEqual(state.monologue, 2)
  state = foldEvent(state, ev('tool/call', 3, { callId: 'c', name: 'read', arguments: {} }))
  assertEqual(state.monologue, 0)
})

test('turn start resets mutatedInTurn', () => {
  let state = foldEvent(initialState(), ev('turn/start', 1, { turn: 2 }))
  assertEqual(state.turn, 2)
  assertEqual(state.mutatedInTurn, false)
  state = foldEvent(state, ev('tool/call', 2, { callId: 'c', name: 'edit', arguments: {} }))
  state = foldEvent(state, ev('tool/result', 3, { message: { toolCallId: 'c', content: [{ type: 'text', text: 'ok' }] } }))
  assert(state.mutatedInTurn, 'edit marks the turn as mutating')
})

test('unknown events and malformed input never throw', () => {
  const state = initialState()
  assertEqual(foldEvent(state, null), state)
  assertEqual(foldEvent(state, {}), state)
  assertEqual(foldEvent(state, ev('something/else', 9)).seq, 9)
})
