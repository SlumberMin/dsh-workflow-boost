/**
 * Per-session plugin state derived only from committed session events.
 *
 * Two paths, same fold function:
 *  - Preferred: register a session projection (ctx.sessionProjections.register)
 *    so the state survives resume and is folded from the durable log without
 *    the deprecated session.eventAt() read API.
 *  - Fallback: an in-memory fold fed by the session/event feed (used when the
 *    projection service is unavailable).
 *
 * The fold is deliberately pure and dependency-free so tests can exercise it.
 */
import { contentText, shortDigest, stableStringify } from './shared.js'

export const STATE_KEY = 'workflow-boost:state'
export const STATE_VERSION = 1
export const TOOL_RING_SIZE = 24

/** Fresh fold state for one session. */
export function initialState() {
  return {
    seq: -1,
    compactionOpen: false,
    lastCompactionStartSeq: -1,
    lastCompactionEndSeq: -1,
    lastPruneSeq: -1,
    lastSummarySeq: -1,
    lastModelSelectionSeq: -1,
    lastEndSeedSeq: -1,
    todos: null,
    todosSeq: -1,
    pending: {},
    toolRing: [],
    toolCount: 0,
    errorCount: 0,
    lastUserMessageSeq: -1,
    lastAssistantSeq: -1,
    monologue: 0,
    turn: 0,
    step: 0,
    mutatedInTurn: false,
    lastMutationSeq: -1,
  }
}

function cloneRing(ring) {
  return Array.isArray(ring) ? ring.slice() : []
}

/**
 * Fold one committed session event into a new state object.
 * Unknown event types return the previous state unchanged.
 * @param state - previous fold state.
 * @param event - committed session event ({ type, seq, data }).
 * @returns next state (never mutates the input).
 */
export function foldEvent(state, event) {
  const base = state === null || typeof state !== 'object' ? initialState() : state
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return base
  const seq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : base.seq
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  const next = { ...base, seq }
  switch (event.type) {
    case 'compaction/start':
      next.compactionOpen = true
      next.lastCompactionStartSeq = seq
      return next
    case 'compaction/end':
      next.compactionOpen = false
      next.lastCompactionEndSeq = seq
      return next
    case 'compaction/prune':
      next.lastPruneSeq = seq
      return next
    case 'compaction/summary':
      next.lastSummarySeq = seq
      return next
    case 'model/selection':
      next.lastModelSelectionSeq = seq
      return next
    case 'session/end-seed':
      next.lastEndSeedSeq = seq
      return next
    case 'todo/write':
      next.todos = Array.isArray(data.todos) ? data.todos.map((todo) => ({ ...todo })) : []
      next.todosSeq = seq
      return next
    case 'turn/start':
      next.turn = Number.isFinite(Number(data.turn)) ? Number(data.turn) : base.turn + 1
      next.step = 0
      next.mutatedInTurn = false
      next.monologue = 0
      return next
    case 'turn/end':
      next.compactionOpen = false
      return next
    case 'step/start':
      next.step = Number.isFinite(Number(data.step)) ? Number(data.step) : base.step
      return next
    case 'user/message':
      next.lastUserMessageSeq = seq
      next.monologue = 0
      return next
    case 'assistant/message':
      next.lastAssistantSeq = seq
      next.monologue = base.monologue + 1
      return next
    case 'tool/call': {
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      if (callId === undefined) return next
      const name = typeof data.name === 'string' ? data.name : ''
      const argsKey = shortDigest(stableStringify(data.arguments ?? {}))
      next.pending = { ...base.pending, [callId]: { name, argsKey, seq } }
      next.toolCount = base.toolCount
      next.monologue = 0
      return next
    }
    case 'tool/result': {
      const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
      const pending = callId !== undefined ? base.pending[callId] : undefined
      const isError = message.isError === true || data.error !== undefined
      const text = contentText(message.content)
      const resultKey = shortDigest(text.slice(0, 2000))
      const name = pending?.name ?? ''
      const ring = cloneRing(base.toolRing)
      ring.push({ seq, name, argsKey: pending?.argsKey ?? '', resultKey, isError, turn: base.turn, step: base.step })
      while (ring.length > TOOL_RING_SIZE) ring.shift()
      const pendingNext = { ...base.pending }
      if (callId !== undefined) delete pendingNext[callId]
      next.pending = pendingNext
      next.toolRing = ring
      next.toolCount = base.toolCount + 1
      next.errorCount = base.errorCount + (isError ? 1 : 0)
      if (name !== '' && base.compactionOpen === false) {
        next.mutatedInTurn = next.mutatedInTurn || /^(?:write|edit|replace|apply_patch|str_replace_editor)$/u.test(name)
        next.lastMutationSeq = seq
      }
      return next
    }
    default:
      return next
  }
}

/**
 * Build the plugin's session-state service.
 * @param ctx - plugin context (Cordis).
 * @param pluginState - shared plugin state with log().
 */
export function createSessionState(ctx, pluginState) {
  const local = new WeakMap()
  const listeners = new Set()
  let handle = null
  let disposed = false

  const notify = (session, event, next) => {
    for (const listener of listeners) {
      try { listener(session, event, next) } catch { /* observers must not break the feed */ }
    }
  }

  let disposeFeed
  try {
    if (typeof ctx?.on === 'function') {
      disposeFeed = ctx.on('session/event', (session, event) => {
        if (handle === null) {
          const previous = local.get(session) ?? initialState()
          const next = foldEvent(previous, event)
          local.set(session, next)
          notify(session, event, next)
          return
        }
        try { notify(session, event, handle.stateOf(session)) } catch { /* ignore */ }
      })
    }
  } catch (error) {
    pluginState?.log?.('debug', 'session-state: session/event feed unavailable: ' + String(error))
  }

  const ready = (async () => {
    try {
      const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined
      if (projections === null || projections === undefined || typeof projections.register !== 'function') return
      handle = await projections.register({
        key: STATE_KEY,
        stateVersion: STATE_VERSION,
        stateSchema: { parse: (value) => value },
        init: () => initialState(),
        apply: (state, event) => foldEvent(state, event),
      })
      pluginState?.log?.('debug', 'session-state: projection registered')
    } catch (error) {
      pluginState?.log?.('debug', 'session-state: projection unavailable, using in-memory fold: ' + String(error))
      handle = null
    }
  })()

  return {
    ready,
    /** Current fold state for one session. */
    stateOf(session) {
      if (handle !== null) {
        try { return handle.stateOf(session) } catch { /* fall through */ }
      }
      return local.get(session) ?? initialState()
    },
    /** Observe every committed event after the fold (plugin-internal). */
    onEvent(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Tool ring entries for one session, newest last. */
    toolRing(session) {
      return this.stateOf(session).toolRing
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      try { disposeFeed?.() } catch { /* ignore */ }
      const disposing = handle
      handle = null
      if (disposing && typeof disposing.dispose === 'function') {
        Promise.resolve(disposing.dispose()).catch(() => {})
      }
    },
  }
}
