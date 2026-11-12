/**
 * focus chain (Cline) — periodically re-inject the live task list into history.
 *
 * The list already exists as todo/write events (dsh-tool-todo); what the model
 * loses over a long turn is the *active* framing of that list. Every
 * everySteps tool calls this module attaches a user-role context snapshot
 * through the tools/post-execute waterfall (the same mechanism
 * dsh-repeat-tool-reminder uses), carrying n/m progress, an explicit Next line
 * and the original acceptance criteria. Injected context lands in the next
 * step's inbox and is appended as an ordinary user notice, so the system prompt
 * is untouched and the request prefix stays cache-stable.
 *
 * 2.0 additions:
 *   - the todo list is read from the plugin session-state fold
 *     (state.sessionState.stateOf(session).todos), never from the deprecated
 *     session.eventAt() reader;
 *   - when the fold reports a new lastCompactionEndSeq the snapshot is injected
 *     once even though the period has not elapsed, because compaction is
 *     exactly when the model loses the plan;
 *   - an unchanged snapshot (same content hash) is not re-injected, so a stable
 *     list costs nothing. A post-compaction re-anchor overrides the hash check
 *     once, since the history it was deduplicated against no longer exists;
 *   - maxItems/maxItemChars are configurable and the renderer keeps acceptance
 *     clauses verbatim.
 *
 * Only a non-empty list is injected; when no todo list exists the module is a
 * no-op. Failures are logged and swallowed: this module must never break a tool
 * call.
 *
 * @module dsh-workflow-boost/lib/focus-chain
 */
import { loadHost, logInfo, logWarn } from './shared.js'
import { sectionDefaults } from './defaults.js'
import {
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_ITEM_CHARS,
  MARKS,
  focusChainKey,
  nextActionable,
  normalizeTodos,
  renderFocusChain,
  todoCounts,
} from './pure/focus-render.js'

export {
  MARKS,
  focusChainKey,
  nextActionable,
  renderFocusChain,
  todoCounts,
}

/** Message source label for the injected snapshots (a notice, never a user prompt). */
export const SOURCE_KIND = 'dsh-workflow-boost'

/** Resolve the module config with defaults. */
export function resolveConfig(config) {
  const merged = sectionDefaults('focusChain', config)
  const integer = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.floor(number)))
  }
  return {
    enabled: config?.enabled !== false && merged.enabled !== false,
    everySteps: integer(merged.everySteps, 6, 2, 100),
    minItems: integer(merged.minItems, 1, 1, 200),
    includeProgress: merged.includeProgress !== false,
    includeNextAction: merged.includeNextAction !== false,
    injectAfterCompaction: merged.injectAfterCompaction !== false,
    maxItems: integer(merged.maxItems, DEFAULT_MAX_ITEMS, 1, 200),
    maxItemChars: integer(merged.maxItemChars, DEFAULT_MAX_ITEM_CHARS, 40, 1000),
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the injected host loader; state.loadHost lets tests fake the host. */
function hostLoader(state) {
  if (state !== null && typeof state === 'object' && typeof state.loadHost === 'function') return state.loadHost
  return loadHost
}

/** Attach one additional context to a post-execute decision without losing the decision kind. */
function withContext(decision, message) {
  const base = decision !== null && typeof decision === 'object' ? decision : { kind: 'accept' }
  const existing = Array.isArray(base.additionalContexts) ? base.additionalContexts : []
  return { ...base, additionalContexts: [message, ...existing] }
}

/**
 * Install the module.
 * @param ctx - plugin context (Cordis).
 * @param config - resolved plugin config.
 * @param state - shared plugin state with sessionState, log and optional loadHost.
 * @returns a disposer that stops further injection.
 */
export function install(ctx, config, state) {
  let settings
  try {
    settings = resolveConfig(config)
  } catch (error) {
    logWarn(state, 'focusChain: config resolution failed: ' + describe(error))
    return undefined
  }
  if (!settings.enabled) return undefined

  const counters = new WeakMap()
  const lastHash = new WeakMap()
  const lastCompactionSeen = new WeakMap()
  let active = true
  let messageFactoryPromise

  /** Lazily resolve createUserMessage; without it no valid host notice can be built. */
  function messageFactory() {
    if (messageFactoryPromise === undefined) {
      messageFactoryPromise = Promise.resolve()
        .then(() => hostLoader(state)('@deepseek-ai/dsh-llm'))
        .then((llm) => (typeof llm?.createUserMessage === 'function' ? llm.createUserMessage : undefined))
        .catch(() => undefined)
    }
    return messageFactoryPromise
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

  /** The current todo list from the plugin fold (null when the session never wrote one). */
  function todosOf(session) {
    const folded = foldedState(session)
    if (folded === undefined) return null
    return Array.isArray(folded.todos) ? normalizeTodos(folded.todos) : null
  }

  /**
   * The newest compaction-end seq when it differs from the last one this module
   * acted on. The marker is only consumed after a snapshot is actually built, so
   * a compaction that lands while the todo list is empty is not silently lost.
   */
  function newCompactionEnd(session) {
    if (!settings.injectAfterCompaction) return undefined
    const folded = foldedState(session)
    if (folded === undefined) return undefined
    const endSeq = Number(folded.lastCompactionEndSeq)
    if (!Number.isFinite(endSeq) || endSeq < 0) return undefined
    if (endSeq <= (lastCompactionSeen.get(session) ?? -1)) return undefined
    return endSeq
  }

  /**
   * Decide whether this post-execute call owes a snapshot.
   * @returns a candidate { agent, key, text, counts, step, forced } or undefined.
   */
  function snapshotFor(exec) {
    const agent = exec?.agent
    if (agent === undefined || agent === null) return undefined
    const session = agent.session
    if (session === undefined || session === null) return undefined
    const previous = counters.get(agent) ?? 0
    const count = previous + 1
    counters.set(agent, count)
    const forcedEndSeq = newCompactionEnd(session)
    const forced = forcedEndSeq !== undefined
    const due = count % settings.everySteps === 0
    if (!forced && !due) return undefined
    const todos = todosOf(session)
    if (todos === null || todos.length < settings.minItems) return undefined
    const text = renderFocusChain(todos, {
      includeProgress: settings.includeProgress,
      includeNextAction: settings.includeNextAction,
      maxItems: settings.maxItems,
      maxItemChars: settings.maxItemChars,
      step: count,
      everySteps: settings.everySteps,
      afterCompaction: forced,
    })
    if (text.length === 0) return undefined
    // The dedupe key covers list content only: the header carries a volatile
    // "after N tool calls" ordinal, which would defeat the hash on every period.
    const stableText = renderFocusChain(todos, {
      includeProgress: settings.includeProgress,
      includeNextAction: settings.includeNextAction,
      maxItems: settings.maxItems,
      maxItemChars: settings.maxItemChars,
    })
    const key = focusChainKey(stableText)
    // An unchanged snapshot is noise; but a post-compaction re-anchor must be
    // re-injected once even when the list itself is byte-identical.
    if (!forced && lastHash.get(agent) === key) return undefined
    if (forced) lastCompactionSeen.set(session, forcedEndSeq)
    const counts = todoCounts(todos)
    const summary = ('task list ' + counts.completed + '/' + counts.total + ' complete' +
      (forced ? ', re-anchored after compaction' : '')).slice(0, 120)
    return { agent, key, text, counts, summary, step: count, forced }
  }

  /** Build the host user-message notice for one snapshot. */
  async function buildMessage(snapshot) {
    const factory = await messageFactory()
    if (typeof factory !== 'function') return undefined
    return factory({
      content: [{ type: 'text', text: snapshot.text }],
      source: { kind: SOURCE_KIND, form: 'notice', summary: snapshot.summary },
    })
  }

  let dispose
  try {
    dispose = ctx.on('tools/post-execute', async (exec, result, next) => {
      let snapshot
      try {
        if (active) snapshot = snapshotFor(exec)
      } catch (error) {
        logWarn(state, 'focusChain: snapshot failed: ' + describe(error))
        snapshot = undefined
      }
      const downstream = await next()
      if (snapshot === undefined) return downstream
      try {
        const message = await buildMessage(snapshot)
        if (message === undefined) {
          state.log?.('debug', 'focusChain: host message factory unavailable; skipping injection')
          return downstream
        }
        // Only remember the hash once the message actually landed in the inbox.
        lastHash.set(snapshot.agent, snapshot.key)
        logInfo(
          state,
          'focusChain: injected task list snapshot (' + snapshot.summary + ') after tool call ' + snapshot.step +
            (snapshot.forced ? ' (forced after compaction)' : ''),
        )
        return withContext(downstream, message)
      } catch (error) {
        logWarn(state, 'focusChain: injection failed: ' + describe(error))
        return downstream
      }
    })
  } catch (error) {
    logWarn(state, 'focusChain: could not listen for tools/post-execute: ' + describe(error))
    return undefined
  }

  return () => {
    active = false
    try {
      dispose?.()
    } catch {
      /* disposal must not throw */
    }
  }
}
