/**
 * Pure goalGate policy, planning and rendering.
 *
 * Kept out of lib/goal-gate.js so the complete decision surface — configured
 * verification steps, freshness arbitration, blocker policy, evidence folding
 * and the model-facing report — runs in a clean Node process with no host
 * packages, no subprocess and no wall clock. Callers pass `now` and measured
 * durations in, which keeps every freshness/serialization test deterministic.
 *
 * All failures are data, not exceptions: the host module wraps each stage and
 * only logs, because a gate bug must never change what the agent can do.
 */

/** Schema defaults, mirrored from lib/defaults.js so the module works standalone. */
export const GOAL_GATE_DEFAULTS = Object.freeze({
  mode: 'enforce',
  verifyCommand: '',
  verifyCommands: Object.freeze([]),
  verifyTimeoutMs: 600000,
  requireGitEvidence: true,
  freshWithinMs: 1800000,
  blockAfterFailures: 3,
  useGoalsService: true,
  requireReview: false,
})

/** Lower bound accepted for one configured command timeout. */
export const MIN_COMMAND_TIMEOUT_MS = 1000
/** Upper bound accepted for one configured command timeout. */
export const MAX_COMMAND_TIMEOUT_MS = 1800000
/** Keep one command's output short so a multi-command report stays affordable. */
export const COMMAND_OUTPUT_TAIL_CHARS = 1200
/** Hard cap for the whole rendered report; the model should not pay for 5 test suites. */
export const MAX_REPORT_CHARS = 12000
/** Git status entries listed before collapsing into a count. */
export const MAX_CHANGED_FILES_SHOWN = 12
/** `git diff --stat` tail kept in the report. */
export const MAX_DIFF_STAT_CHARS = 1600

/** First line of every verification report; the evidence fold parses it back. */
export const PASS_LINE = 'goal_verify: PASS'
export const FAIL_LINE = 'goal_verify: FAIL'
export const NOT_CONFIGURED_LINE = 'goal_verify: FAIL (not configured)'

const PASS_RE = /^goal_verify:\s*PASS\b/u
const NOT_CONFIGURED_RE = /not configured/iu
const CHECKED_AT_RE = /^checked at:\s*(.+)$/imu

/** Clamp one finite number into [min, max], falling back for junk. */
export function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** ISO timestamp for a millisecond value, or '' when unusable. */
export function isoTime(at) {
  if (!Number.isFinite(at)) return ''
  try {
    return new Date(at).toISOString()
  } catch {
    return ''
  }
}

/** Keep the end of a long text, marking what was dropped. */
export function tailText(text, limit) {
  const source = String(text ?? '')
  const budget = Math.max(0, Math.floor(Number(limit) || 0))
  if (budget === 0) return ''
  if (source.length <= budget) return source
  return '[... ' + (source.length - budget) + ' chars omitted ...]\n' + source.slice(-budget)
}

/** First non-empty, trimmed line of a text. */
export function firstLine(text, max = 160) {
  const line = String(text ?? '').split('\n').find((entry) => entry.trim().length > 0) ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** Join the text parts of one tool result content array. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Normalize the ordered verification steps.
 *
 * `verifyCommands` (1.0.0) wins over the legacy `verifyCommand`; the legacy
 * form becomes one required step named "verify" so the gate has a single code
 * path. An empty command string never becomes a step: that is exactly the
 * 0.1.1 #5 hole this version closes.
 * @param section - raw goalGate config section.
 * @returns ordered steps: `{ name, command, required, timeoutMs }`.
 */
export function normalizeVerifyCommands(section) {
  const source = section !== null && typeof section === 'object' ? section : {}
  const configured = Array.isArray(source.verifyCommands) ? source.verifyCommands : []
  const commands = []
  for (const entry of configured) {
    if (entry === null || typeof entry !== 'object') continue
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (command.length === 0) continue
    const name = typeof entry.name === 'string' && entry.name.trim().length > 0
      ? entry.name.trim()
      : 'check-' + (commands.length + 1)
    commands.push({
      name,
      command,
      required: entry.required !== false,
      timeoutMs: clampNumber(entry.timeoutMs, GOAL_GATE_DEFAULTS.verifyTimeoutMs, MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS),
    })
  }
  if (commands.length > 0) return commands
  const legacy = typeof source.verifyCommand === 'string' ? source.verifyCommand.trim() : ''
  if (legacy.length === 0) return []
  return [{
    name: 'verify',
    command: legacy,
    required: true,
    timeoutMs: clampNumber(source.verifyTimeoutMs, GOAL_GATE_DEFAULTS.verifyTimeoutMs, MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS),
  }]
}

/**
 * Resolve the goalGate section for the runtime gate.
 * @param config - resolved row configuration (or the section itself).
 * @returns normalized settings; `commands` is the authoritative plan.
 */
export function resolveSettings(config) {
  let section = {}
  if (config !== null && typeof config === 'object') {
    section = config.goalGate !== null && typeof config.goalGate === 'object' ? config.goalGate : config
  }
  const commands = normalizeVerifyCommands(section)
  return {
    mode: section.mode === 'advisory' ? 'advisory' : 'enforce',
    commands,
    configured: commands.length > 0,
    verifyTimeoutMs: clampNumber(section.verifyTimeoutMs, GOAL_GATE_DEFAULTS.verifyTimeoutMs, MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS),
    requireGitEvidence: section.requireGitEvidence !== false,
    freshWithinMs: clampNumber(section.freshWithinMs, GOAL_GATE_DEFAULTS.freshWithinMs, 60000, 86400000),
    blockAfterFailures: clampNumber(section.blockAfterFailures, GOAL_GATE_DEFAULTS.blockAfterFailures, 1, 20),
    useGoalsService: section.useGoalsService !== false,
    // 1.1.0: require a fresh blocker-free review_diff pass before completion.
    requireReview: section.requireReview === true,
  }
}

/**
 * Whether one call is a goal-completion attempt.
 *
 * Broad on the tool name (`/goal/i`) and strict on the argument shape so the
 * shipped `update_goal` and a differently named goal tool with the same
 * completion argument are both gated, while read-only goal calls are not.
 * @param name - tool name.
 * @param args - frozen argument object.
 * @returns true when this call would complete a goal.
 */
export function isGoalCompletionCall(name, args) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (!/goal/iu.test(name)) return false
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  const text = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')
  if (text(args.action) === 'complete') return true
  if (text(args.phase) === 'complete') return true
  if (text(args.status) === 'complete') return true
  return args.complete === true
}

/**
 * Whether a recorded pass may satisfy the completion gate.
 *
 * Only a real command run counts (`evidenceOnly === false`) and it must have
 * succeeded (`ok === true`) inside the freshness window. An evidence-only
 * record is exactly the 0.1.1 #5 bypass, so it is rejected here even if an old
 * record shape leaks in.
 * @param record - folded or in-memory evidence record.
 * @param settings - normalized settings.
 * @param now - current milliseconds.
 * @returns true when the gate should allow the completion.
 */
export function hasFreshPass(record, settings, now) {
  if (record === null || typeof record !== 'object') return false
  if (record.ok !== true) return false
  if (record.evidenceOnly !== false) return false
  if (!Number.isFinite(record.at)) return false
  const age = now - record.at
  return age >= 0 && age <= settings.freshWithinMs
}

/** Human list of configured steps for denial/refusal texts. */
export function describeCommands(settings) {
  const commands = Array.isArray(settings?.commands) ? settings.commands : []
  if (commands.length === 0) return 'no verification command is configured'
  return commands.map((entry) => JSON.stringify(entry.name) + (entry.required ? '' : ' (optional)')).join(', ')
}

/**
 * Model-facing refusal when a completion lacks fresh evidence.
 * It must be self-contained: `Error: <reason>` is the whole channel.
 * @param settings - normalized settings.
 * @param record - folded evidence record, if any.
 * @param now - current milliseconds.
 * @returns denial reason.
 */
export function gateReason(settings, record, now) {
  const minutes = Math.max(1, Math.round(settings.freshWithinMs / 60000))
  const configured = ' Configured verification steps: ' + describeCommands(settings) + '.'
  const head = 'goal-gate blocked this completion: marking a goal complete requires fresh evidence from a real verification run, but '
  if (record === null || typeof record !== 'object' || !Number.isFinite(record.at)) {
    return head + 'goal_verify has not run in this session. Run the goal_verify tool now, report its'
      + ' exit code and output to the user, and retry this completion only after it passes. If it fails,'
      + ' fix the failure or tell the user what is still broken.' + configured
  }
  if (record.evidenceOnly === true) {
    return head + 'the last goal_verify was evidence-only because no verification command is configured,'
      + ' and evidence-only runs never count as a pass. Configure goalGate.verifyCommand or'
      + ' goalGate.verifyCommands, then run goal_verify again.' + configured
  }
  if (record.ok !== true) {
    const code = Number.isFinite(record.exitCode) ? 'exit code ' + record.exitCode : 'no exit code'
    return head + 'the most recent goal_verify failed (' + code + ' at ' + isoTime(record.at) + ').'
      + ' Do not complete the goal: fix the failure, run goal_verify again, and retry only after it'
      + ' passes.' + configured
  }
  const ageMinutes = Math.max(1, Math.round((now - record.at) / 60000))
  return head + 'the last passing goal_verify is ' + ageMinutes + ' minutes old, which is outside the '
    + minutes + '-minute freshness window. Run goal_verify again, report its result to the user, and'
    + ' then retry this completion.' + configured
}

/**
 * Model-facing refusal when goalGate.requireReview is enabled and the review
 * evidence is missing, stale or has blockers.
 *
 * The review record is produced by the reviewGate module; this function takes
 * its read-view ({ status, record, ageMs }) so the policy stays pure and the
 * two modules share one contract.
 * @param settings - normalized goal settings.
 * @param review - result of reviewGate readReview(), or undefined.
 * @param now - current milliseconds (reserved for custom messages).
 * @returns denial reason, or undefined when the review requirement is satisfied.
 */
export function reviewGateReason(settings, review, now) {
  if (settings?.requireReview !== true) return undefined
  const minutes = Math.max(1, Math.round(settings.freshWithinMs / 60000))
  const head = 'goal-gate blocked this completion: goalGate.requireReview is enabled, but '
  const record = review?.record
  if (review === null || review === undefined || review.status === 'missing') {
    return head + 'review_diff has not reviewed this session\'s changes. Run the review_diff tool now, report its'
      + ' findings (especially blockers) to the user, and retry this completion only after it reports no blocker.'
  }
  if (review.status === 'blocked') {
    const blockers = Number.isFinite(Number(record?.findings)) ? Number(record.findings) : 'some'
    const files = Number.isFinite(Number(record?.files)) ? ' across ' + Number(record.files) + ' changed file(s)' : ''
    return head + 'the most recent review_diff reported ' + blockers + ' blocker finding(s)' + files + '.'
      + ' Fix or justify them, run review_diff again, and retry this completion only when it reports no blocker.'
  }
  if (review.status === 'stale') {
    const age = Number.isFinite(review.ageMs) ? Math.max(1, Math.round(review.ageMs / 60000)) : minutes
    return head + 'the last clean review_diff is ' + age + ' minutes old, which is outside the ' + minutes
      + '-minute freshness window. Run review_diff again and retry this completion only after it reports no blocker.'
  }
  if (review.status === 'ok') return undefined
  // Unknown status must not invent a block reason; the verify-evidence check and
  // the tool's own fail-open behavior still protect the completion path.
  return undefined
}

/**
 * Resolve the process invocation for one configured command.
 * The command is trusted profile configuration, never model input.
 * @param command - configured verification command.
 * @param platform - `process.platform` value.
 * @param comspec - Windows command processor path, if any.
 * @returns `{ file, args }` for execFile; no untrusted shell interpolation.
 */
export function verifyInvocation(command, platform, comspec) {
  if (platform === 'win32') {
    const file = typeof comspec === 'string' && comspec.length > 0 ? comspec : 'cmd.exe'
    return { file, args: ['/d', '/s', '/c', command] }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

/** Merge stdout and stderr of one finished command. */
export function commandOutput(run) {
  if (run === null || typeof run !== 'object') return ''
  const stdout = typeof run.stdout === 'string' ? run.stdout : ''
  const stderr = typeof run.stderr === 'string' ? run.stderr : ''
  if (stdout.length === 0) return stderr
  if (stderr.length === 0) return stdout
  return stdout + '\n[stderr]\n' + stderr
}

/**
 * Turn one finished process into the report/evidence view of a step.
 * @param entry - configured step.
 * @param run - `runProcess` result (or undefined when the run never started).
 * @param elapsedMs - measured duration.
 * @returns normalized step result.
 */
export function summarizeCommandRun(entry, run, elapsedMs) {
  const code = run !== null && typeof run === 'object' && Number.isFinite(run.code) ? run.code : undefined
  const timedOut = run !== null && typeof run === 'object' && run.timedOut === true
  const failedToStart = run === undefined || run === null
  return {
    name: entry.name,
    command: entry.command,
    required: entry.required !== false,
    ok: !failedToStart && !timedOut && code === 0,
    exitCode: code,
    timedOut,
    failedToStart,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : undefined,
    outputTail: tailText(commandOutput(run), COMMAND_OUTPUT_TAIL_CHARS),
  }
}

/**
 * Overall verdict: at least one configured step, and every REQUIRED step passed.
 * Optional failures are reported but do not block completion.
 * @param results - normalized step results.
 * @returns true when the run counts as a pass.
 */
export function overallOk(results) {
  const list = Array.isArray(results) ? results : []
  if (list.length === 0) return false
  return list.every((result) => result.required !== true || result.ok === true)
}

/**
 * Build the durable/in-memory evidence record consumed by hasFreshPass.
 * `evidenceOnly` is always false for a real run (even a failing one).
 * @param input - `{ at, results, evidenceOnly }`.
 * @returns evidence record.
 */
export function buildPassRecord(input) {
  const results = Array.isArray(input?.results) ? input.results : []
  // An empty plan is an evidence-only run by construction: it can never pass,
  // even if a caller forgets to set the flag (0.1.1 #5 defense in depth).
  const evidenceOnly = input?.evidenceOnly === true || results.length === 0
  const ok = evidenceOnly ? false : overallOk(results)
  const exitCode = results.find((result) => result.required !== false && !result.ok)?.exitCode
  return {
    at: Number.isFinite(input?.at) ? input.at : 0,
    ok,
    evidenceOnly,
    exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
    commands: results.map((result) => ({
      name: result.name,
      required: result.required !== false,
      ok: result.ok === true,
      exitCode: Number.isFinite(result.exitCode) ? result.exitCode : undefined,
    })),
  }
}

/** Attach corner for git evidence; only nonempty changes are worth showing. */
export function hasGitChanges(git) {
  if (git === null || typeof git !== 'object') return false
  const changed = Array.isArray(git.changed) ? git.changed : []
  const count = Number.isFinite(git.changedFiles) ? git.changedFiles : changed.length
  if (count > 0 || changed.length > 0) return true
  return typeof git.diffStat === 'string' && git.diffStat.trim().length > 0
}

/**
 * Render the git evidence block. `requireGitEvidence` only attaches real
 * changes: an empty working tree gets one honest line instead of a large block.
 * @param git - `gitEvidence` result, or undefined when unavailable.
 * @returns report lines.
 */
export function renderGitEvidence(git) {
  if (git === null || typeof git !== 'object') {
    return ['git: unavailable (not a git work tree, or git is not installed)']
  }
  if (!hasGitChanges(git)) {
    return ['git: no working-tree changes detected (no git evidence attached)']
  }
  const changed = Array.isArray(git.changed) ? git.changed : []
  const count = Number.isFinite(git.changedFiles) ? git.changedFiles : changed.length
  const lines = ['git: ' + count + ' changed file' + (count === 1 ? '' : 's') + ' (working tree vs HEAD)']
  for (const entry of changed.slice(0, MAX_CHANGED_FILES_SHOWN)) lines.push('  ' + String(entry))
  if (changed.length > MAX_CHANGED_FILES_SHOWN) lines.push('  ... ' + (changed.length - MAX_CHANGED_FILES_SHOWN) + ' more')
  const stat = typeof git.diffStat === 'string' ? git.diffStat.trim() : ''
  if (stat.length > 0) {
    lines.push('diff stat:')
    for (const line of tailText(stat, MAX_DIFF_STAT_CHARS).split('\n')) lines.push('  ' + line)
  }
  return lines
}

/**
 * Render the model-facing verification report.
 *
 * The first line is machine-readable (`goal_verify: PASS|FAIL...`) because the
 * evidence projection folds it back across resume; the rest is for the model.
 * @param input - `{ ok, evidenceOnly, results, git, cwd, elapsedMs, checkedAt }`.
 * @returns report text, capped at MAX_REPORT_CHARS.
 */
export function renderVerifyReport(input) {
  const evidenceOnly = input?.evidenceOnly === true
  const results = Array.isArray(input?.results) ? input.results : []
  const ok = evidenceOnly ? false : overallOk(results)
  const lines = []
  lines.push(evidenceOnly ? NOT_CONFIGURED_LINE : (ok ? PASS_LINE : FAIL_LINE))
  if (evidenceOnly) {
    lines.push('No verification command is configured (goalGate.verifyCommand and goalGate.verifyCommands are'
      + ' empty), so this run collected no evidence and is NOT a pass. Configure at least one command in the'
      + ' plugin row before claiming the goal complete.')
  } else {
    const required = results.filter((result) => result.required !== false).length
    lines.push('commands: ' + results.length + ' configured, ' + required + ' required')
    for (const result of results) {
      lines.push('[' + (result.ok ? 'PASS' : 'FAIL') + '] ' + result.name + (result.required === false ? ' (optional)' : ' (required)'))
      lines.push('  command: ' + String(result.command ?? ''))
      if (result.failedToStart === true) lines.push('  exit code: not started')
      else if (result.timedOut === true) lines.push('  exit code: timed out')
      else lines.push('  exit code: ' + (Number.isFinite(result.exitCode) ? result.exitCode : 'unknown'))
      if (Number.isFinite(result.elapsedMs)) lines.push('  elapsed: ' + (Math.round(result.elapsedMs / 100) / 10) + 's')
      const tail = typeof result.outputTail === 'string' ? result.outputTail.trim() : ''
      lines.push('  output tail:')
      if (tail.length === 0) lines.push('    (no output)')
      else for (const line of tail.split('\n')) lines.push('    ' + line)
    }
    if (!ok) {
      lines.push('Do not mark the goal complete: at least one required verification command failed.'
        + ' Fix the failure, or report to the user exactly what is still broken.')
    }
  }
  lines.push('cwd: ' + String(input?.cwd ?? '(unknown)'))
  if (Number.isFinite(input?.elapsedMs)) lines.push('elapsed: ' + (Math.round(input.elapsedMs / 100) / 10) + 's')
  if (Number.isFinite(input?.checkedAt)) lines.push('checked at: ' + isoTime(input.checkedAt))
  if (input?.git !== undefined) {
    for (const line of renderGitEvidence(input.git)) lines.push(line)
  }
  const report = lines.join('\n')
  return report.length <= MAX_REPORT_CHARS
    ? report
    : report.slice(0, MAX_REPORT_CHARS) + '\n[... report truncated at ' + MAX_REPORT_CHARS + ' chars ...]'
}

/**
 * Parse a `goal_verify` report back into an evidence record.
 * Used by the projection fold so a pass survives resume without the plugin
 * writing any custom session event.
 * @param text - rendered report (tool result content).
 * @param fallbackAt - event time used when the report has no `checked at` line.
 * @returns `{ at, ok, evidenceOnly, exitCode }`.
 */
export function parseVerifyReport(text, fallbackAt) {
  const source = String(text ?? '')
  const first = firstLine(source, 200)
  const evidenceOnly = NOT_CONFIGURED_RE.test(first)
  const passed = !evidenceOnly && PASS_RE.test(first)
  const match = CHECKED_AT_RE.exec(source)
  const parsedAt = match === null ? NaN : Date.parse(match[1].trim())
  const at = Number.isFinite(parsedAt) ? parsedAt : (Number.isFinite(fallbackAt) ? fallbackAt : undefined)
  return { at, ok: passed, evidenceOnly }
}

/** Fresh fold state for the goal-evidence projection / in-memory fallback. */
export function initialEvidenceState() {
  return { lastPass: null, failureStreak: 0, pending: {} }
}

/**
 * Fold one committed session event into goal-evidence state.
 *
 * `goal_verify` is our own tool, so its rendered report is a stable contract:
 * a completed call is read back from `tool/result` instead of asking the
 * deprecated session read APIs. Unrelated events return the same reference so
 * the projection registry suppresses needless downstream work.
 * @param state - previous evidence state.
 * @param event - committed session event.
 * @returns next state (never mutates the input).
 */
export function foldEvidence(state, event) {
  const base = state !== null && typeof state === 'object' ? state : initialEvidenceState()
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return base
  const seq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : base.lastPass?.seq ?? -1
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  if (event.type === 'tool/call') {
    const callId = typeof data.callId === 'string' ? data.callId : undefined
    if (callId === undefined || typeof data.name !== 'string') return base
    return { ...base, pending: { ...base.pending, [callId]: data.name } }
  }
  if (event.type === 'tool/result') {
    const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
    if (callId === undefined || !Object.hasOwn(base.pending, callId)) return base
    const name = base.pending[callId]
    const pending = { ...base.pending }
    delete pending[callId]
    if (name !== 'goal_verify') return { ...base, pending }
    const record = parseVerifyReport(contentText(message.content), Number.isFinite(Number(event.time)) ? Number(event.time) : undefined)
    const lastPass = { ...record, seq }
    const failureStreak = lastPass.ok ? 0 : base.failureStreak + 1
    return { ...base, lastPass, failureStreak, pending }
  }
  return base
}

/** Extract the compare-and-set ref a goal view needs for `ctx.goals.block`. */
export function goalRefFromView(view) {
  if (view === null || typeof view !== 'object') return undefined
  if (typeof view.id !== 'string' || view.id.length === 0) return undefined
  if (!Number.isSafeInteger(view.revision) || view.revision < 0) return undefined
  return { id: view.id, revision: view.revision }
}

/** Stable lower-kebab-case blocker code the goal service accepts. */
export const BLOCKER_CODE = 'verification-failed'

/**
 * Build the blocker reason recorded through the native goal service.
 * @param record - failing verification record.
 * @returns `{ code, message }` accepted by `ctx.goals.block`.
 */
export function blockReasonFor(record) {
  const failed = Array.isArray(record?.commands)
    ? record.commands.filter((command) => command.required !== false && command.ok !== true)
    : []
  const detail = failed.length === 0
    ? 'the verification command failed'
    : failed.map((command) => command.name + (Number.isFinite(command.exitCode) ? ' (exit ' + command.exitCode + ')' : '')).join(', ')
  return {
    code: BLOCKER_CODE,
    message: 'goal verification failed: ' + detail + '; fix the failure and rerun goal_verify before completing.',
  }
}

/**
 * Whether a failure streak has reached the configured blocker threshold.
 * @param failureStreak - consecutive failed verification runs.
 * @param settings - normalized settings.
 * @returns true when the host module should try to record a native blocker.
 */
export function shouldRecordBlocker(failureStreak, settings) {
  if (settings?.useGoalsService === false) return false
  const threshold = Math.max(1, Number(settings?.blockAfterFailures) || 1)
  return Number(failureStreak) >= threshold
}

/**
 * Contract constant set used by the host module and its tests.
 */
export const GOAL_POLICY_CONTRACT = Object.freeze({
  toolName: 'goal_verify',
  sectionName: 'tool:goal-evidence',
  blockerCode: BLOCKER_CODE,
})
