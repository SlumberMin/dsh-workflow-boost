/**
 * editCheck — run the configured lint/typecheck/test after a successful edit and
 * feed a bounded failure summary back to the model (Aider reflexion).
 *
 * Why post-execute: the result is the only place that tells us the write
 * actually succeeded. tools/pre-execute cannot know, and denied or failed
 * writes must not trigger checks. The listener runs the configured commands
 * with execFile (never a shell) in the Session working directory, then appends
 * one bounded context message through PostToolDecision.additionalContexts — an
 * append-only injection that does not invalidate the KV-cache prefix.
 *
 * Fail-open by design: a missing working-directory service, a bad command, a
 * spawn error, a timeout, or an aborted tool call all log and skip the
 * injection. This module must never make an edit fail. It is disabled by
 * default so a large repository pays zero cost until the user opts in.
 *
 * @module dsh-workflow-boost/lib/edit-check
 */
import { randomUUID } from 'node:crypto'
import { sectionDefaults } from './defaults.js'
import { logInfo, logWarn, runProcess } from './shared.js'
import {
  buildCheckFailureText,
  buildReflectionMessage,
  buildSuccessMessage,
  checkKey,
  isWriteTool,
  normalizeBudget,
  parseCommandLine,
  pathsFromToolCall,
  relativeToWorkspace,
  selectMatchingChecks,
} from './pure/edit-check-core.js'

/** Source label stamped on injected notices; keeps them out of the user prompt. */
export const SOURCE_KIND = 'dsh-workflow-boost'

/** Bound for the one-line source summary recorded with a notice. */
const SUMMARY_MAX_CHARS = 120

/** Resolve the module config, merging lib/defaults.js with the row section. */
export function resolveSettings(config) {
  const merged = sectionDefaults('editCheck', config)
  const clamp = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.floor(number)))
  }
  const timeoutMs = clamp(merged.timeoutMs, 120000, 1000, 600000)
  const defaultOutputTokens = normalizeBudget(merged.maxOutputTokens)
  const rawChecks = Array.isArray(merged.checks) ? merged.checks : []
  const checks = []
  for (const [index, raw] of rawChecks.entries()) {
    if (raw === null || typeof raw !== 'object') continue
    if (typeof raw.command !== 'string' && !Array.isArray(raw.command)) continue
    const command = Array.isArray(raw.command) ? raw.command.map((part) => String(part)) : raw.command
    const when = Array.isArray(raw.when) ? raw.when.filter((item) => typeof item === 'string' && item.length > 0) : []
    checks.push({
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'check' + (index + 1),
      when,
      command,
      timeoutMs: clamp(raw.timeoutMs, timeoutMs, 1000, 600000),
      maxOutputTokens: normalizeBudget(raw.maxOutputTokens ?? defaultOutputTokens),
    })
  }
  return {
    enabled: merged.enabled !== false,
    checks,
    timeoutMs,
    debounceMs: clamp(merged.debounceMs, 15000, 0, 600000),
    maxPerTurn: clamp(merged.maxPerTurn, 3, 1, 100),
    maxReflections: clamp(merged.maxReflections, 3, 1, 20),
    maxOutputTokens: defaultOutputTokens,
    reportSuccess: merged.reportSuccess === true,
  }
}

/** One-line source summary, bounded like every other notice producer. */
function boundSummary(text) {
  const source = String(text ?? '')
  return source.length <= SUMMARY_MAX_CHARS ? source : source.slice(0, SUMMARY_MAX_CHARS - 1) + '…'
}

/**
 * Build the user-role notice carried through additionalContexts.
 * A notice (source.form) is rendered as injected context, not as a user prompt.
 */
export function makeNoticeMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: SOURCE_KIND, form: 'notice', summary: boundSummary(summary) },
  }
}

/** Append one context to a post-execute decision without losing its kind. */
export function withContext(decision, message) {
  const base = decision !== null && typeof decision === 'object' ? decision : { kind: 'accept' }
  const existing = Array.isArray(base.additionalContexts) ? base.additionalContexts : []
  return { ...base, additionalContexts: [...existing, message] }
}

/** Read the folded turn number, defaulting to 0 when session state is unavailable. */
function currentTurn(state, session) {
  try {
    const folded = state?.sessionState?.stateOf?.(session)
    const turn = Number(folded?.turn)
    return Number.isFinite(turn) && turn >= 0 ? turn : 0
  } catch {
    return 0
  }
}

/** Resolve the session working directory through the documented service; no process.cwd fallback. */
function workspaceOf(ctx, session) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service === null || service === undefined || typeof service.get !== 'function') return undefined
    const cwd = service.get(session)
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/** Run one configured check; returns undefined when the run itself is not reportable. */
async function runCheck(check, workspace, exec, state) {
  let parsed
  try {
    parsed = parseCommandLine(check.command)
  } catch (error) {
    logWarn(state, 'editCheck: invalid command for ' + check.name + ': ' + describe(error))
    return undefined
  }
  let outcome
  try {
    outcome = await runProcess(parsed.command, parsed.args, { cwd: workspace, timeoutMs: check.timeoutMs })
  } catch (error) {
    logWarn(state, 'editCheck: ' + check.name + ' could not start: ' + describe(error))
    return undefined
  }
  if (exec?.signal?.aborted === true) return undefined
  if (outcome.timedOut) {
    logWarn(state, 'editCheck: ' + check.name + ' timed out after ' + check.timeoutMs + 'ms; skipping feedback')
    return undefined
  }
  if (outcome.code === -1 && outcome.error !== undefined && outcome.stdout.length === 0 && outcome.stderr.length === 0) {
    logWarn(state, 'editCheck: ' + check.name + ' could not run: ' + outcome.error)
    return undefined
  }
  return outcome
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Install the module.
 * @param ctx - Cordis plugin context.
 * @param config - resolved plugin row config.
 * @param state - shared plugin state with log and sessionState.
 * @returns a disposer, or undefined when disabled / not enough config.
 */
export function install(ctx, config, state) {
  const settings = resolveSettings(config)
  if (!settings.enabled) return undefined
  if (settings.checks.length === 0) {
    logInfo(state, 'editCheck: enabled but no checks configured; nothing to run')
    return undefined
  }
  if (typeof ctx?.on !== 'function') {
    logWarn(state, 'editCheck: ctx.on is unavailable; module inactive')
    return undefined
  }
  let active = true
  const sessions = new WeakMap()
  const sessionRuntime = (session, turn) => {
    let entry = sessions.get(session)
    if (entry === undefined || entry.turn !== turn) {
      entry = { turn, runs: 0, reflections: 0, exhausted: false, lastRun: new Map(), warned: false }
      sessions.set(session, entry)
    }
    return entry
  }
  let disposeFeed
  try {
    if (typeof state?.sessionState?.onEvent === 'function') {
      disposeFeed = state.sessionState.onEvent((session, event) => {
        try {
          if (event?.type === 'turn/start' || event?.type === 'user/message') sessions.delete(session)
        } catch { /* observer must not break the feed */ }
      })
    }
  } catch (error) {
    logWarn(state, 'editCheck: session feed unavailable: ' + describe(error))
  }

  const maybeCheck = async (exec, result) => {
    if (exec === null || typeof exec !== 'object') return null
    if (!isWriteTool(exec.name)) return null
    if (result?.isError === true) return null
    const session = exec.agent?.session
    if (session === undefined || session === null) return null
    const workspace = workspaceOf(ctx, session)
    if (workspace === undefined) {
      let entry
      try { entry = sessionRuntime(session, 0) } catch { entry = undefined }
      if (entry !== undefined && !entry.warned) {
        entry.warned = true
        logWarn(state, 'editCheck: workingDirectory service unavailable; checks skipped for this session')
      }
      return null
    }
    const rawPaths = pathsFromToolCall(exec.name, exec.arguments)
    if (rawPaths.length === 0) return null
    const files = []
    for (const rawPath of rawPaths) {
      const mapped = relativeToWorkspace(workspace, rawPath)
      if (!mapped.ok) {
        if (mapped.reason === 'outside-workspace') logInfo(state, 'editCheck: ignoring ' + rawPath + ' (outside the workspace)')
        continue
      }
      if (mapped.relative.length > 0 && !files.includes(mapped.relative)) files.push(mapped.relative)
    }
    if (files.length === 0) return null
    const checks = selectMatchingChecks(settings.checks, files)
    if (checks.length === 0) return null
    const turn = currentTurn(state, session)
    const entry = sessionRuntime(session, turn)
    if (entry.exhausted) return null
    if (entry.runs >= settings.maxPerTurn) {
      logInfo(state, 'editCheck: per-turn limit (' + settings.maxPerTurn + ') reached; checks skipped')
      return null
    }
    if (exec.signal?.aborted === true) return null
    const now = Date.now()
    const due = []
    for (const check of checks) {
      const last = entry.lastRun.get(checkKey(check))
      if (last !== undefined && now - last < settings.debounceMs) continue
      due.push(check)
    }
    if (due.length === 0) {
      logInfo(state, 'editCheck: all matching checks are debounced')
      return null
    }
    const failures = []
    const failedNames = []
    const passed = []
    for (const check of due) {
      if (exec.signal?.aborted === true) break
      if (entry.runs >= settings.maxPerTurn) break
      entry.runs += 1
      entry.lastRun.set(checkKey(check), Date.now())
      const run = await runCheck(check, workspace, exec, state)
      if (run === undefined) continue
      if (run.code === 0) { passed.push(check.name); continue }
      failures.push(buildCheckFailureText({ check, run }))
      failedNames.push(check.name)
    }
    if (failures.length === 0) {
      entry.reflections = 0
      if (settings.reportSuccess && passed.length > 0) {
        const text = buildSuccessMessage(passed, files)
        logInfo(state, 'editCheck: passed (' + passed.join(', ') + ')')
        return makeNoticeMessage(text, 'editCheck passed: ' + passed.join(', '))
      }
      return null
    }
    entry.reflections += 1
    const exhausted = entry.reflections > settings.maxReflections
    if (exhausted) entry.exhausted = true
    const text = buildReflectionMessage({
      failures,
      attempt: entry.reflections,
      maxReflections: settings.maxReflections,
      exhausted,
      budget: settings.maxOutputTokens,
      files,
    })
    logInfo(
      state,
      'editCheck: ' + failedNames.join(', ') + ' failed after ' + exec.name +
        (exhausted ? ' (reflection limit reached; handing back to the model to report)' : ' (fix attempt ' + entry.reflections + '/' + settings.maxReflections + ')'),
    )
    return makeNoticeMessage(text, 'editCheck failed: ' + failedNames.join(', '))
  }

  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      let message = null
      try {
        if (active) message = await maybeCheck(exec, result)
      } catch (error) {
        logWarn(state, 'editCheck: check dispatch failed: ' + describe(error))
        message = null
      }
      const decision = await next()
      if (message === null) return decision
      return withContext(decision, message)
    })
  } catch (error) {
    logWarn(state, 'editCheck: could not register post-execute listener: ' + describe(error))
    return undefined
  }
  logInfo(state, 'editCheck active (' + settings.checks.length + ' check(s), debounce ' + settings.debounceMs + 'ms)')
  return () => {
    active = false
    try { disposeFeed?.() } catch { /* disposal must not throw */ }
  }
}
