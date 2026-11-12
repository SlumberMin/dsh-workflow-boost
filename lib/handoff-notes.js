/**
 * handoffNotes — durable structured notes that survive compaction.
 *
 * Compaction replaces the history with a summary; the model then loses the
 * goal, the plan and what it just did. This module keeps a per-session note file
 * at <workspace>/.dsh/workflow-boost/handoff/<sessionId>.md whose content is
 * derived from the session-state fold (goal, todos, tool ring, last mutation,
 * timestamps), refreshes it when context pressure gets close to the native
 * compaction threshold, and re-injects it after a compaction checkpoint.
 *
 * Where the note goes: the path is fixed by the plugin (sanitized session id
 * only, never model input) and must stay inside the session workspace. Writes
 * prefer the host fs service (ctx.fs) so they participate in the fs intent
 * pipeline; when that service is absent they fall back to node:fs/promises.
 * Missing workingDirectory, missing permissions, or any internal failure only
 * log at debug/warn level — a handoff note must never change the turn.
 *
 * Injection shape: an ordinary user notice through tools/post-execute
 * additionalContexts, so the system prompt stays static and the request prefix
 * stays cache-stable. The pressure path injects a short notice (goal + Next);
 * the compaction path injects the rendered note itself (bounded).
 *
 * @module dsh-workflow-boost/lib/handoff-notes
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadHost, logInfo, logWarn } from './shared.js'
import {
  COMPACTION_INJECT_MAX_CHARS,
  MODEL_NOTES_HEADING,
  NOTE_DIR,
  NOTICE_MAX_CHARS,
  isInsideWorkspace,
  noteRelativePath,
  pressureRatioOf,
  renderHandoffInjection,
  renderHandoffNote,
  renderHandoffNotice,
  resolveHandoffConfig,
  sanitizeSegment,
  sessionIdOf,
  shouldRefreshHandoff,
  truncateNote,
} from './pure/handoff-core.js'

export {
  NOTE_DIR,
  MODEL_NOTES_HEADING,
  noteRelativePath,
  renderHandoffInjection,
  renderHandoffNote,
  renderHandoffNotice,
  resolveHandoffConfig,
  sanitizeSegment,
  shouldRefreshHandoff,
  truncateNote,
}

/** Source label for injected notices (kept consistent with the other modules). */
export const SOURCE_KIND = 'dsh-workflow-boost'

/** Tool name registered for model-facing note access. */
export const TOOL_NAME = 'handoff_note'

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve settings without throwing. */
export function resolveSettings(config) {
  return resolveHandoffConfig(config)
}

/** Alias used by install(); kept exported so tests can assert the resolved row. */
export function resolveConfig(config) {
  return resolveHandoffConfig(config)
}

/** Resolve the session working directory; no process.cwd fallback. */
function workspaceOf(ctx, session) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service === null || service === undefined || typeof service.get !== 'function') return undefined
    const cwd = service.get(session)
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/** Fold state for one session, or undefined when the plugin state is unavailable. */
function foldedState(state, session) {
  try {
    const service = state?.sessionState
    if (service === null || service === undefined || typeof service.stateOf !== 'function') return undefined
    const folded = service.stateOf(session)
    return folded !== null && typeof folded === 'object' ? folded : undefined
  } catch {
    return undefined
  }
}

/** Current pressure ratio from the token meter, or undefined when it cannot tell. */
function pressureRatioOfSession(ctx, session) {
  try {
    const meter = typeof ctx?.get === 'function' ? ctx.get('tokenMeter') : undefined
    if (meter === null || meter === undefined || typeof meter.contextPressure !== 'function') return undefined
    return pressureRatioOf(meter.contextPressure(session))
  } catch {
    return undefined
  }
}

/** Whether an fs-service rejection means "the file is simply absent". */
function isMissingError(error) {
  const code = error?.code
  return code === 'ENOENT' || code === 'FS_NOT_FOUND'
}

/** Resolve the lazily loaded host packages through state.loadHost when provided. */
function hostLoader(state) {
  if (state !== null && typeof state === 'object' && typeof state.loadHost === 'function') return state.loadHost
  return loadHost
}

/** Compute the note target for one session; enforces workspace containment. */
function noteTargetOf(workspace, session) {
  const sessionId = sessionIdOf(session)
  const absolutePath = join(workspace, '.dsh', 'workflow-boost', 'handoff', sanitizeSegment(sessionId, 64) + '.md')
  return {
    sessionId,
    absolutePath,
    relativePath: noteRelativePath(sessionId),
    inside: isInsideWorkspace(workspace, absolutePath),
  }
}

/** Node fallback read; undefined when the note does not exist yet. */
async function readWithNode(absolutePath) {
  try {
    return await readFile(absolutePath, 'utf8')
  } catch (error) {
    if (isMissingError(error)) return undefined
    throw error
  }
}

/** Node fallback write: create parents, then re-check the real parent stays inside the workspace. */
async function writeWithNode(workspace, absolutePath, content) {
  await mkdir(dirname(absolutePath), { recursive: true })
  try {
    const [realRoot, realParent] = await Promise.all([realpath(workspace), realpath(dirname(absolutePath))])
    if (!isInsideWorkspace(realRoot, realParent)) throw new Error('note directory resolves outside the workspace')
  } catch (error) {
    // A missing workspace is a fail-open condition, a real escape is a refusal.
    if (isMissingError(error)) throw error
    throw new Error('cannot verify the note directory stays inside the workspace: ' + describe(error))
  }
  await writeFile(absolutePath, content, 'utf8')
}

/**
 * Note I/O facade: prefer the host fs service (it participates in fs intents and
 * confinement), fall back to node:fs/promises. Every method is bounded and may
 * reject; callers decide whether that is a refresh failure or a tool error.
 */
function createNoteStore(ctx, state) {
  const fsService = () => {
    try {
      const fs = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined
      if (fs !== null && fs !== undefined && typeof fs.resolve === 'function' && typeof fs.readText === 'function' && typeof fs.writeText === 'function') return fs
      return undefined
    } catch {
      return undefined
    }
  }

  return {
    async read(workspace, target) {
      const service = fsService()
      if (service !== undefined) {
        try {
          const resolved = await service.resolve(target.absolutePath, { cwd: workspace })
          const text = await service.readText(resolved)
          return typeof text === 'string' ? text : undefined
        } catch (error) {
          if (isMissingError(error)) return undefined
          throw error
        }
      }
      return readWithNode(target.absolutePath)
    },
    async write(workspace, target, content) {
      const service = fsService()
      if (service !== undefined) {
        try {
          const resolved = await service.resolve(target.absolutePath, { cwd: workspace })
          await service.writeText(resolved, content)
          return true
        } catch (error) {
          state.log?.('debug', 'handoffNotes: fs service write failed (' + describe(error) + '); trying node fallback')
        }
      }
      await writeWithNode(workspace, target.absolutePath, content)
      return true
    },
  }
}

/** Build the state-derived note for one session at the current fold position. */
async function renderFor(ctx, state, settings, exec, previousText) {
  const session = exec?.agent?.session
  const workspace = workspaceOf(ctx, session)
  if (workspace === undefined) return undefined
  const folded = foldedState(state, session) ?? {}
  let goal
  try {
    const goals = typeof ctx?.get === 'function' ? ctx.get('goals') : undefined
    if (goals !== null && goals !== undefined && typeof goals.get === 'function') {
      goal = goals.get(exec.agent)
      if (goal !== null && typeof goal === 'object' && typeof goal.then === 'function') goal = await goal
    }
  } catch {
    goal = undefined
  }
  const noteText = renderHandoffNote({
    sessionId: sessionIdOf(session),
    workspace,
    goal,
    todos: folded.todos,
    toolRing: folded.toolRing,
    toolCount: folded.toolCount,
    errorCount: folded.errorCount,
    lastMutationSeq: folded.lastMutationSeq,
    turn: folded.turn,
    step: folded.step,
    previousText,
    now: Date.now(),
    maxNoteChars: settings.maxNoteChars,
  })
  return { session, workspace, folded, noteText }
}

/**
 * Install the module.
 * @param ctx - plugin context (Cordis).
 * @param config - plugin row config.
 * @param state - shared plugin state with log, sessionState and optional loadHost.
 * @returns a disposer with a .ready promise for the async tool registration.
 */
export function install(ctx, config, state) {
  let settings
  try {
    settings = resolveConfig(config)
  } catch (error) {
    logWarn(state, 'handoffNotes: config resolution failed: ' + describe(error))
    return undefined
  }
  if (!settings.enabled) return undefined

  const perSession = new WeakMap()
  const store = createNoteStore(ctx, state)
  let active = true
  let disposed = false
  let messageFactoryPromise
  const cleanups = []
  const warned = new Set()

  /** Lazily resolve createUserMessage; without it no host notice can be built. */
  function messageFactory() {
    if (messageFactoryPromise === undefined) {
      messageFactoryPromise = Promise.resolve()
        .then(() => hostLoader(state)('@deepseek-ai/dsh-llm'))
        .then((llm) => (typeof llm?.createUserMessage === 'function' ? llm.createUserMessage : undefined))
        .catch(() => undefined)
    }
    return messageFactoryPromise
  }

  /** Per-session bookkeeping (counters and once-per-turn/compaction flags). */
  function bookkeeping(session) {
    let entry = perSession.get(session)
    if (entry === undefined) {
      entry = {
        toolsSinceNote: 0,
        notedTurn: undefined,
        pendingCompaction: false,
        seenCompactionEnd: -1,
      }
      perSession.set(session, entry)
    }
    return entry
  }

  /** Debug-log once per session about a missing capability instead of every step. */
  function debugOnce(session, message) {
    try {
      if (warned.has(session)) return
      warned.add(session)
    } catch {
      return
    }
    state.log?.('debug', message)
  }

  /** Build the user-role notice for one rendered text. */
  async function buildNotice(text, reason) {
    const factory = await messageFactory()
    if (typeof factory !== 'function') return undefined
    const summary = ('handoff note ' + (reason === 'compaction' ? 're-injected after compaction' : 'refreshed under pressure')).slice(0, 120)
    return factory({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'notice', summary },
    })
  }

  /**
   * Decide whether this post-execute call should refresh and inject.
   * @returns the additional context message, or undefined to stay silent.
   */
  async function maybeDeliver(exec) {
    const session = exec?.agent?.session
    if (session === undefined || session === null) return undefined
    const entry = bookkeeping(session)
    entry.toolsSinceNote += 1
    const folded = foldedState(state, session)
    if (folded !== undefined) {
      const endSeq = Number(folded.lastCompactionEndSeq)
      // Belt and braces: the session/event feed normally sets this, but a fold
      // that already knows about the compaction must not be missed.
      if (Number.isFinite(endSeq) && endSeq > entry.seenCompactionEnd) {
        entry.seenCompactionEnd = endSeq
        if (settings.injectAfterCompaction) entry.pendingCompaction = true
      }
    }
    const turn = Number(folded?.turn)
    const decision = shouldRefreshHandoff({
      pressureRatio: pressureRatioOfSession(ctx, session),
      toolsSinceNote: entry.toolsSinceNote,
      minPressureRatio: settings.minPressureRatio,
      refreshEveryTools: settings.refreshEveryTools,
      compactionPending: entry.pendingCompaction,
      notedThisTurn: Number.isFinite(turn) && entry.notedTurn === turn,
    })
    if (decision.action === 'none') return undefined
    const workspace = workspaceOf(ctx, session)
    if (workspace === undefined) {
      debugOnce(session, 'handoffNotes: workingDirectory service unavailable; notes are skipped for this session (fail-open)')
      entry.pendingCompaction = false
      return undefined
    }
    const target = noteTargetOf(workspace, session)
    if (!target.inside) {
      logWarn(state, 'handoffNotes: refusing to write outside the session workspace: ' + target.absolutePath)
      entry.pendingCompaction = false
      return undefined
    }
    let previousText
    try {
      previousText = await store.read(workspace, target)
    } catch (error) {
      logWarn(state, 'handoffNotes: could not read the existing note: ' + describe(error))
      previousText = undefined
    }
    const rendered = await renderFor(ctx, state, settings, exec, previousText)
    if (rendered === undefined) {
      entry.pendingCompaction = false
      return undefined
    }
    let written = false
    try {
      written = await store.write(workspace, target, rendered.noteText)
    } catch (error) {
      debugOnce(session, 'handoffNotes: note write failed (fail-open): ' + describe(error))
    }
    // One attempt per turn / compaction even when the write failed, so a
    // read-only workspace cannot turn every tool call into a retry storm.
    entry.toolsSinceNote = 0
    entry.pendingCompaction = false
    if (Number.isFinite(turn)) entry.notedTurn = turn
    if (!written) return undefined
    const reason = decision.action === 'inject-compaction' ? 'compaction' : 'pressure'
    const text = reason === 'compaction'
      ? renderHandoffInjection({
        noteText: rendered.noteText,
        notePath: target.relativePath,
        maxChars: Math.min(settings.maxNoteChars, COMPACTION_INJECT_MAX_CHARS),
      })
      : renderHandoffNotice({
        noteText: rendered.noteText,
        notePath: target.relativePath,
        reason,
        maxChars: NOTICE_MAX_CHARS,
      })
    logInfo(
      state,
      'handoffNotes: ' + (reason === 'compaction' ? 're-injected note after compaction' : 'refreshed note under pressure') +
        ' (' + target.relativePath + ', ' + rendered.noteText.length + ' chars)',
    )
    return buildNotice(text, reason)
  }

  /** Model-facing tool implementation; always returns text, never throws. */
  async function runTool(args, exec) {
    try {
      const action = typeof args?.action === 'string' ? args.action : 'read'
      const session = exec?.agent?.session
      if (session === undefined || session === null) {
        return 'handoff_note: this tool must be called from an agent turn (no session is attached).'
      }
      const workspace = workspaceOf(ctx, session)
      if (workspace === undefined) {
        return 'handoff_note: the workingDirectory service is not mounted in this profile, so the note cannot be read or written.'
      }
      const target = noteTargetOf(workspace, session)
      if (!target.inside) return 'handoff_note: refusing to touch a path outside the session workspace.'
      const text = typeof args?.text === 'string' ? args.text : ''
      if (action === 'read') {
        let current
        try {
          current = await store.read(workspace, target)
        } catch (error) {
          return 'handoff_note: cannot read ' + target.relativePath + ': ' + describe(error)
        }
        if (current !== undefined) {
          return 'Handoff note (' + target.relativePath + '):\n' + truncateNote(current, settings.maxNoteChars)
        }
        const rendered = await renderFor(ctx, state, settings, exec, '')
        const fallback = rendered === undefined ? '(no state is available to render a note)' : rendered.noteText
        return 'No handoff note file exists yet for this session (' + target.relativePath + '). ' +
          'Current state-derived note, not saved until the next refresh:\n' + fallback
      }
      if (action !== 'write' && action !== 'append') {
        return 'handoff_note: unknown action "' + action + '"; use read, write or append.'
      }
      if (text.trim().length === 0) {
        return 'handoff_note: ' + action + ' requires a non-empty text argument.'
      }
      let content = text
      if (action === 'append') {
        let current
        try {
          current = await store.read(workspace, target)
        } catch (error) {
          return 'handoff_note: cannot read ' + target.relativePath + ' before appending: ' + describe(error)
        }
        const base = current === undefined ? '' : current.replace(/\s+$/u, '')
        content = base.length === 0 ? text : base + '\n\n' + text
      }
      const bounded = truncateNote(content, settings.maxNoteChars)
      try {
        await store.write(workspace, target, bounded)
      } catch (error) {
        return 'handoff_note: could not write ' + target.relativePath + ' (' + describe(error) + '); the context is unchanged.'
      }
      return 'handoff_note: ' + action + ' succeeded (' + target.relativePath + ', ' + bounded.length + ' chars).'
    } catch (error) {
      logWarn(state, 'handoffNotes: tool failed: ' + describe(error))
      return 'handoff_note: ' + describe(error)
    }
  }

  // 1. Compaction observation: a note is due on the next tool call.
  let listeners = 0
  try {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        if (!active || event?.type !== 'compaction/end') return
        const entry = bookkeeping(session)
        const seq = Number(event.seq)
        if (Number.isFinite(seq)) entry.seenCompactionEnd = Math.max(entry.seenCompactionEnd, seq)
        if (settings.injectAfterCompaction) entry.pendingCompaction = true
      } catch {
        /* observers must never break the event feed */
      }
    })
    if (typeof dispose === 'function') cleanups.push(dispose)
    listeners += 1
  } catch (error) {
    logWarn(state, 'handoffNotes: could not observe session/event: ' + describe(error))
  }

  // 2. Delivery point: tools/post-execute additionalContexts (history tail append).
  try {
    const dispose = ctx.on('tools/post-execute', async (exec, result, next) => {
      let message
      try {
        if (active) message = await maybeDeliver(exec)
      } catch (error) {
        logWarn(state, 'handoffNotes: refresh failed: ' + describe(error))
        message = undefined
      }
      const downstream = await next()
      if (message === undefined) return downstream
      const base = downstream !== null && typeof downstream === 'object' ? downstream : { kind: 'accept' }
      const existing = Array.isArray(base.additionalContexts) ? base.additionalContexts : []
      return { ...base, additionalContexts: [message, ...existing] }
    })
    if (typeof dispose === 'function') cleanups.push(dispose)
    listeners += 1
  } catch (error) {
    logWarn(state, 'handoffNotes: could not listen for tools/post-execute: ' + describe(error))
  }

  if (listeners === 0) return undefined

  // 3. Model-facing tool: defineTool comes from the host package, loaded lazily
  // so the plugin stays importable in a clean Node environment.
  const ready = (async () => {
    try {
      if (disposed) return
      if (typeof ctx?.tools?.register !== 'function') {
        logWarn(state, 'handoffNotes: ctx.tools.register is unavailable; ' + TOOL_NAME + ' not registered')
        return
      }
      const host = hostLoader(state)
      let toolsModule
      try {
        toolsModule = await host('@deepseek-ai/dsh-tools')
      } catch {
        toolsModule = undefined
      }
      if (disposed) return
      const define = typeof toolsModule?.defineTool === 'function' ? toolsModule.defineTool : (definition) => definition
      const definition = {
        name: TOOL_NAME,
        description: 'Read or write the durable handoff note for this session. The note lives at .dsh/workflow-boost/handoff/<sessionId>.md, survives compaction, and records the active goal, the task list with statuses, the next actionable item, recent tool activity and recent edits. Use action "read" before resuming long work after a compaction or a restart; use "write" to replace note text and "append" to add a note without losing generated sections. The file path is fixed by the plugin: text is content, never a path.',
        parameters: {
          action: { type: 'string', enum: ['read', 'write', 'append'], description: 'read the note, replace it with text, or append text.' },
          text: { type: 'string', description: 'Content for write/append. Required for those actions.' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async (args, exec) => runTool(args ?? {}, exec),
      }
      try {
        const cleanup = ctx.tools.register(define(definition))
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      } catch (error) {
        logWarn(state, 'handoffNotes: could not register ' + TOOL_NAME + ': ' + describe(error))
      }
    } catch (error) {
      logWarn(state, 'handoffNotes: tool registration failed: ' + describe(error))
    }
  })()

  const disposer = () => {
    disposed = true
    active = false
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        /* disposal must not throw */
      }
    }
  }
  disposer.ready = ready
  return disposer
}
