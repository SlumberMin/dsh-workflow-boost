/**
 * goal gate 2.0 (ZCode Goal Mode) — completion requires fresh, real evidence.
 *
 * Four pieces, all independently useful and all fail-open:
 *  1. `goal_verify` tool — runs the configured verification steps
 *     (`goalGate.verifyCommands`, or the legacy single `verifyCommand`) in the
 *     session working directory and reports every step's exit code and output
 *     tail plus git evidence.
 *  2. `tools/pre-execute` gate — in `enforce` mode a goal-completion call is
 *     denied unless a fresh PASS from a real command run exists. Evidence-only
 *     runs never count (0.1.1 #5).
 *  3. A static system-prompt section stating the completion discipline (static
 *     so it never disturbs the KV-cache prefix).
 *  4. Repeated failures try to record a native `ctx.goals.block` blocker so the
 *     failure is visible in the goal state machine; a missing/broken goal
 *     service is ignored.
 *  5. With `goalGate.requireReview` (1.1.0) a completion also needs a fresh,
 *     blocker-free review_diff record written by the reviewGate module.
 *
 * enforce + no command is a configuration error, so install throws and index.js
 * logs a warning and disables the module instead of shipping a gate that can
 * never pass. Every other failure path only logs.
 */
import { errorText, gitEvidence, loadHost, logWarn, runProcess } from './shared.js'
import {
  GOAL_POLICY_CONTRACT,
  blockReasonFor,
  buildPassRecord,
  foldEvidence,
  gateReason,
  goalRefFromView,
  hasFreshPass,
  initialEvidenceState,
  isGoalCompletionCall,
  overallOk,
  renderVerifyReport,
  resolveSettings,
  reviewGateReason,
  shouldRecordBlocker,
  summarizeCommandRun,
  verifyInvocation,
} from './pure/goal-policy.js'
import { readReview } from './review-gate.js'

/** Prompt section name; must stay unique per prompt layer (`tool:goal` is dsh-tool-goal's). */
const SECTION_NAME = GOAL_POLICY_CONTRACT.sectionName

/** Fallback placement: SECTION_ORDERS.TOOL_GOAL (2400) + 1 when the host exposes none. */
const SECTION_ORDER_FALLBACK = 2401

/** Registered tool name. */
const VERIFY_TOOL = GOAL_POLICY_CONTRACT.toolName

/** Projection key + version for durable goal evidence (survives session resume). */
const EVIDENCE_KEY = 'workflow-boost:goal-evidence'
const EVIDENCE_STATE_VERSION = 1

/** Git probes are cheap; keep them well below the verification timeout. */
const GIT_TIMEOUT_MS = 15000

/** Cache-stable policy text: static by design, never reads live state. */
const SECTION_TEXT = [
  'Goal completion requires evidence. Before calling a goal-completion tool (for example',
  'update_goal with action "complete"), run the goal_verify tool and report each check name, its exit',
  'code and the output tail to the user.',
  'Never mark a goal complete because the work looks finished: complete it only after goal_verify',
  'reports PASS for every required check. If goal_verify fails, fix the failure or tell the user exactly',
  'what is still broken; do not complete the goal.',
].join(' ')

const VERIFY_DESCRIPTION = 'Verify that the current work actually satisfies the goal before it is '
  + 'claimed complete: runs the configured verification command(s) in the session working directory '
  + 'and reports each command name, exit code, an output tail, and the current git changes. Use it '
  + 'immediately before marking a goal complete, after finishing a set of edits, or whenever you are '
  + 'about to tell the user the work is done. Do not use it for exploratory checks or while the work '
  + 'is still in progress: it can be slow (it may run a full test suite) and its passing result is '
  + 'what the completion gate accepts.'

/** Canonical output: one text report. */
const VERIFY_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { report: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.report }],
}

/**
 * In-memory evidence store used immediately (before the projection catches up
 * to the committed tool result) and as the fallback when the projection service
 * is unavailable. Agents and sessions are separate keys so a subagent's run
 * never satisfies its parent's gate.
 * @returns `{ read, write, readSession, writeSession, foldSession }`.
 */
export function createEvidenceStore() {
  const perAgent = new WeakMap()
  const perSession = new WeakMap()
  let fallbackAgent = initialEvidenceState()
  let fallbackSession = initialEvidenceState()
  const usable = (value) => value !== null && value !== undefined && typeof value === 'object'
  return {
    read(agent) {
      return usable(agent) ? (perAgent.get(agent) ?? initialEvidenceState()) : fallbackAgent
    },
    write(agent, next) {
      if (usable(agent)) perAgent.set(agent, next)
      else fallbackAgent = next
    },
    readSession(session) {
      return usable(session) ? (perSession.get(session) ?? initialEvidenceState()) : fallbackSession
    },
    writeSession(session, next) {
      if (usable(session)) perSession.set(session, next)
      else fallbackSession = next
    },
    foldSession(session, event) {
      const next = foldEvidence(this.readSession(session), event)
      this.writeSession(session, next)
      return next
    },
  }
}

/**
 * Register the goal-evidence projection so a passing `goal_verify` survives
 * session resume. Registration is asynchronous on the host, so the handle is
 * filled in later; every read falls back to the in-memory store until then.
 * @param ctx - plugin context.
 * @param state - shared plugin state (`log`).
 * @returns mutable `{ handle }` ref (handle is null while unavailable).
 */
export function registerEvidenceProjection(ctx, state) {
  const ref = { handle: null }
  try {
    const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined
    if (projections === null || projections === undefined || typeof projections.register !== 'function') return ref
    void (async () => {
      try {
        ref.handle = await projections.register({
          key: EVIDENCE_KEY,
          stateVersion: EVIDENCE_STATE_VERSION,
          stateSchema: { parse: (value) => value },
          init: () => initialEvidenceState(),
          apply: (evidence, event) => foldEvidence(evidence, event),
        })
        state?.log?.('debug', 'goalGate: goal-evidence projection registered')
      } catch (error) {
        ref.handle = null
        logWarn(state, 'goalGate: goal-evidence projection unavailable, using in-memory evidence: ' + describe(error))
      }
    })()
  } catch (error) {
    logWarn(state, 'goalGate: goal-evidence projection registration failed open: ' + describe(error))
  }
  return ref
}

/**
 * Read the current evidence for one execution: the projection (resume-safe)
 * first, then the session fold fed by `session/event`, then the agent store.
 * @param projection - projection ref from registerEvidenceProjection.
 * @param store - evidence store.
 * @param session - agent session, if any.
 * @param agent - live agent, if any.
 * @returns evidence state.
 */
export function evidenceOf(projection, store, session, agent) {
  const handle = projection?.handle
  if (handle !== null && handle !== undefined && session !== null && session !== undefined && typeof handle.stateOf === 'function') {
    try {
      const state = handle.stateOf(session)
      if (state !== null && state !== undefined && typeof state === 'object') return state
    } catch {
      /* fall through to the local fold */
    }
  }
  if (session !== null && session !== undefined) {
    const folded = store.readSession(session)
    if (folded.lastPass !== null || folded.failureStreak > 0) return folded
  }
  return store.read(agent)
}

/**
 * Resolve the session working directory through the host service only.
 * There is deliberately no `process.cwd()` fallback: with no reliable cwd the
 * verification is reported as not run instead of silently checking another
 * workspace.
 * @param ctx - plugin context.
 * @param exec - execution metadata carrying the agent.
 * @returns absolute directory, or undefined when the host cannot provide one.
 */
export function resolveCwd(ctx, exec) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined
    const session = exec?.agent?.session
    if (service === null || service === undefined || typeof service.get !== 'function') return undefined
    if (session === null || session === undefined) return undefined
    const cwd = service.get(session)
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/** Best-effort git evidence; a git failure must never fail verification. */
async function safeGitEvidence(cwd) {
  if (cwd === undefined) return undefined
  try {
    return await gitEvidence(cwd, GIT_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

/**
 * Run one configured verification step through execFile (no untrusted shell
 * input: the command is trusted profile configuration).
 * @param entry - `{ name, command, required, timeoutMs }`.
 * @param cwd - session working directory.
 * @returns normalized step result.
 */
async function runOneCommand(entry, cwd) {
  const startedAt = Date.now()
  if (cwd === undefined) return summarizeCommandRun(entry, undefined, 0)
  try {
    const invocation = verifyInvocation(entry.command, process.platform, process.env.ComSpec)
    const run = await runProcess(invocation.file, invocation.args, { cwd, timeoutMs: entry.timeoutMs })
    return summarizeCommandRun(entry, run, Date.now() - startedAt)
  } catch (error) {
    return summarizeCommandRun(entry, { code: -1, stdout: '', stderr: describe(error) }, Date.now() - startedAt)
  }
}

/**
 * Try to record a durable native goal blocker after repeated failures.
 * Missing service, non-live agent, no active goal or a rejected mutation all
 * fail open: the gate must never change agent behavior beyond its deny path.
 * @returns true when a blocker was recorded.
 */
export function maybeBlockGoal(ctx, state, store, exec, settings, record) {
  try {
    const agent = exec?.agent
    const evidence = store.read(agent)
    if (!shouldRecordBlocker(evidence.failureStreak, settings)) return false
    if (Number(evidence.lastBlockAtStreak) >= Number(evidence.failureStreak)) return false
    const goals = typeof ctx?.get === 'function' ? ctx.get('goals') : undefined
    if (goals === null || goals === undefined) return false
    if (typeof goals.get !== 'function' || typeof goals.block !== 'function') return false
    const view = goals.get(agent)
    if (view === null || view === undefined || view.phase !== 'active') return false
    const ref = goalRefFromView(view)
    if (ref === undefined) return false
    goals.block(agent, ref, blockReasonFor(record))
    store.write(agent, { ...store.read(agent), lastBlockAtStreak: evidence.failureStreak })
    state?.log?.('info', 'goalGate: recorded a native goal blocker after ' + evidence.failureStreak + ' failed verification runs')
    return true
  } catch (error) {
    logWarn(state, 'goalGate: goal blocker attempt failed open: ' + describe(error))
    return false
  }
}

/**
 * Execute one `goal_verify` call and record its outcome.
 * Never throws: an internal error becomes a FAIL report plus a failed record.
 * @param ctx - plugin context.
 * @param settings - normalized settings.
 * @param projection - projection ref.
 * @param store - evidence store.
 * @param exec - execution metadata.
 * @returns `{ ok, report }`.
 */
export async function runVerify(ctx, settings, projection, store, exec, state) {
  const startedAt = Date.now()
  try {
    const cwd = resolveCwd(ctx, exec)
    if (settings.commands.length === 0) {
      // 0.1.1 #5: an empty configuration must never PASS and never write a pass record.
      const record = buildPassRecord({ at: Date.now(), results: [], evidenceOnly: true })
      const previous = evidenceOf(projection, store, exec?.agent?.session, exec?.agent)
      store.write(exec?.agent, { ...previous, lastPass: { ...record, seq: -1 } })
      return {
        ok: false,
        report: renderVerifyReport({
          ok: false,
          evidenceOnly: true,
          results: [],
          cwd,
          elapsedMs: Date.now() - startedAt,
          checkedAt: Date.now(),
        }),
      }
    }
    const results = []
    for (const entry of settings.commands) results.push(await runOneCommand(entry, cwd))
    const git = settings.requireGitEvidence ? await safeGitEvidence(cwd) : undefined
    const ok = overallOk(results)
    const record = buildPassRecord({ at: Date.now(), results, evidenceOnly: false })
    const previous = evidenceOf(projection, store, exec?.agent?.session, exec?.agent)
    store.write(exec?.agent, {
      ...previous,
      lastPass: { ...record, seq: -1 },
      failureStreak: ok ? 0 : previous.failureStreak + 1,
      // A passing run re-arms the blocker policy: the next threshold is a new event.
      ...(ok ? { lastBlockAtStreak: 0 } : {}),
    })
    if (!ok) maybeBlockGoal(ctx, state, store, exec, settings, record)
    return {
      ok,
      report: renderVerifyReport({
        ok,
        evidenceOnly: false,
        results,
        git,
        cwd,
        elapsedMs: Date.now() - startedAt,
        checkedAt: Date.now(),
      }),
    }
  } catch (error) {
    const message = errorText(error)
    try {
      const record = buildPassRecord({ at: Date.now(), results: [], evidenceOnly: true })
      store.write(exec?.agent, { ...store.read(exec?.agent), lastPass: { ...record, seq: -1, ok: false, evidenceOnly: false } })
    } catch {
      /* recording is best-effort */
    }
    return {
      ok: false,
      report: 'goal_verify: FAIL (internal error)\n' + message
        + '\nDo not mark the goal complete; report this failure to the user.',
    }
  }
}

/** Mount the static completion-policy prompt section. */
function mountPromptSection(ctx, state, track) {
  let prompt
  try {
    const viaService = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined
    // Prefer the service lookup; fall back to the context property because some
    // compositions (and the test fakes) expose the same service there.
    prompt = viaService !== null && viaService !== undefined ? viaService : ctx?.systemPrompt
  } catch {
    prompt = undefined
  }
  if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') {
    logWarn(state, 'goalGate: systemPrompt is unavailable; the completion policy text was not added')
    return
  }
  let order = SECTION_ORDER_FALLBACK
  try {
    const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_GOAL') : undefined
    if (Number.isFinite(base)) order = base + 1
  } catch {
    /* keep the numeric fallback */
  }
  try {
    track(prompt.section({ name: SECTION_NAME, order, text: SECTION_TEXT }))
  } catch (error) {
    logWarn(state, 'goalGate: could not register the prompt section: ' + describe(error))
  }
}

/**
 * Build the `goal_verify` definition from an injected `defineTool`.
 * Exported so the harness can assert the registered shape without a host.
 * @param defineTool - `@deepseek-ai/dsh-tools` `defineTool`.
 * @param ctx - plugin context.
 * @param settings - normalized settings.
 * @param projection - projection ref.
 * @param store - evidence store.
 * @returns tool definition.
 */
export function buildVerifyDefinition(defineTool, ctx, settings, projection, store, state) {
  return defineTool({
    name: VERIFY_TOOL,
    description: VERIFY_DESCRIPTION,
    parameters: {},
    output: VERIFY_OUTPUT,
    execute: async (_args, exec) => runVerify(ctx, settings, projection, store, exec, state),
  })
}

/**
 * Load the host tools package through an injectable loader so tests can install
 * the module in a clean environment with no @deepseek-ai packages. A fake may
 * return the module synchronously or as a promise; both are accepted.
 * @param state - shared plugin state; `loadHost` may be injected by a harness.
 * @param onModule - called with the loaded module.
 * @param onError - called with the load error.
 */
function whenHostTools(state, onModule, onError) {
  const host = typeof state?.loadHost === 'function' ? state.loadHost : loadHost
  try {
    const loaded = host('@deepseek-ai/dsh-tools')
    if (loaded !== null && typeof loaded === 'object' && typeof loaded.then === 'function') {
      void loaded.then((module) => onModule(module)).catch((error) => onError(error))
      return
    }
    onModule(loaded)
  } catch (error) {
    onError(error)
  }
}

/**
 * Register `goal_verify` through `state.loadHost` (fake-injectable in tests) and
 * the shared `loadHost` fallback. The host package is imported lazily so this
 * module stays loadable in a clean Node environment.
 */
function registerVerifyTool(ctx, state, settings, projection, store, track) {
  if (typeof ctx?.tools?.register !== 'function') {
    logWarn(state, 'goalGate: tools.register is unavailable; goal_verify was not registered')
    return
  }
  whenHostTools(state, (module) => {
    const defineTool = module?.defineTool
    if (typeof defineTool !== 'function') {
      logWarn(state, 'goalGate: @deepseek-ai/dsh-tools is unavailable; goal_verify was not registered')
      return
    }
    try {
      track(ctx.tools.register(buildVerifyDefinition(defineTool, ctx, settings, projection, store, state)))
    } catch (error) {
      logWarn(state, 'goalGate: could not register goal_verify: ' + describe(error))
    }
  }, (error) => {
    logWarn(state, 'goalGate: goal_verify registration failed open: ' + describe(error))
  })
}

/** Mount the completion gate (enforce mode only). */
function mountGate(ctx, state, settings, projection, store, track) {
  if (settings.mode !== 'enforce') {
    state?.log?.('debug', 'goalGate: advisory mode, completion calls are never denied')
    return
  }
  if (typeof ctx?.on !== 'function') {
    logWarn(state, 'goalGate: ctx.on is unavailable; the completion gate is disabled')
    return
  }
  try {
    track(ctx.on('tools/pre-execute', async (exec, next) => {
      let denial
      try {
        if (isGoalCompletionCall(exec?.name, exec?.arguments)) {
          const now = Date.now()
          const evidence = evidenceOf(projection, store, exec?.agent?.session, exec?.agent)
          const record = evidence?.lastPass ?? null
          if (!hasFreshPass(record, settings, now)) {
            denial = { kind: 'deny', reason: gateReason(settings, record, now) }
          } else if (settings.requireReview === true && state?.reviewGateReady !== false) {
            // 1.1.0: verify evidence alone is not enough when a review is required.
            // A reviewer that failed to register must not trap completion forever.
            const review = readReview(state, exec?.agent, settings.freshWithinMs, now)
            const reviewReason = reviewGateReason(settings, review, now)
            if (reviewReason !== undefined) denial = { kind: 'deny', reason: reviewReason }
          }
        }
      } catch (error) {
        logWarn(state, 'goalGate: completion check failed open: ' + describe(error))
        denial = undefined
      }
      if (denial === undefined) return next()
      try {
        state?.log?.('debug', 'goalGate: denied a goal completion without fresh goal_verify evidence')
      } catch {
        /* logging is best-effort */
      }
      return denial
    }))
  } catch (error) {
    logWarn(state, 'goalGate: could not listen for tools/pre-execute: ' + describe(error))
  }
}

/**
 * Install the goal gate.
 * @param ctx - plugin context (already inside a `ctx.effect` scope).
 * @param config - resolved row configuration.
 * @param state - shared plugin state (`log`, optional `loadHost`, `sessionState`).
 * @returns disposer.
 */
export function install(ctx, config, state) {
  const settings = resolveSettings(config)
  // A contradictory configuration (require a review while the reviewer module
  // is disabled) would block every completion forever; fail open with a loud log
  // instead of trapping the agent.
  if (settings.requireReview && (config?.reviewGate?.enabled === false || config?.enabled === false)) {
    logWarn(state, 'goalGate: requireReview is enabled but the reviewGate module is disabled; ignoring the review requirement (fail-open)')
    settings.requireReview = false
  }
  if (settings.mode === 'enforce' && settings.commands.length === 0) {
    // 0.1.1 #5 (b): a gate that can never pass is a configuration error, not a
    // quiet no-op. index.js catches this, logs a warning and disables the module.
    throw new Error('goalGate is in enforce mode but no verification command is configured'
      + ' (set goalGate.verifyCommand or goalGate.verifyCommands, or switch goalGate.mode to advisory)')
  }
  const store = createEvidenceStore()
  const projection = registerEvidenceProjection(ctx, state)
  const disposers = []
  let disposed = false

  const track = (disposer) => {
    if (typeof disposer !== 'function') return
    if (disposed) {
      try {
        disposer()
      } catch {
        /* disposal must not throw */
      }
      return
    }
    disposers.push(disposer)
  }

  // Feed the in-memory fallback from the committed session events; the
  // projection is preferred for resume, this keeps evidence live in the same
  // turn and when the projection registry is absent.
  try {
    const feed = state?.sessionState?.onEvent
    if (typeof feed === 'function') {
      track(feed((session, event) => {
        try {
          store.foldSession(session, event)
        } catch {
          /* observer failures must not break the session feed */
        }
      }))
    }
  } catch (error) {
    logWarn(state, 'goalGate: session event feed unavailable: ' + describe(error))
  }

  try {
    mountPromptSection(ctx, state, track)
  } catch (error) {
    logWarn(state, 'goalGate: prompt section mount failed: ' + describe(error))
  }

  mountGate(ctx, state, settings, projection, store, track)
  registerVerifyTool(ctx, state, settings, projection, store, track)

  try {
    state?.log?.('info', 'goalGate active (mode=' + settings.mode + ', commands='
      + settings.commands.map((entry) => entry.name).join(',') + ')')
  } catch {
    /* logging is best-effort */
  }

  return () => {
    disposed = true
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* disposal must not throw */
      }
    }
    const handle = projection.handle
    projection.handle = null
    if (handle !== null && handle !== undefined) {
      try {
        const disposing = typeof handle.dispose === 'function' ? handle.dispose() : undefined
        if (disposing !== undefined && disposing !== null && typeof disposing.then === 'function') {
          Promise.resolve(disposing).catch(() => {})
        }
      } catch {
        /* disposal must not throw */
      }
    }
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
