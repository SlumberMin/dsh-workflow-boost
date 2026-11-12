/**
 * Pure reviewGate core: git command planning, diff/status parsing, deterministic
 * checks, evidence records and report rendering.
 *
 * No host packages, no fs and no clock: the host module feeds captured git
 * output in and calls the checks/renderers, and the unit tests drive exactly the
 * same functions. Everything is plain data and never throws.
 */

/** Canonical config defaults, mirrored from lib/defaults.js. */
export const REVIEW_DEFAULTS = Object.freeze({
  enabled: true,
  maxDiffChars: 12000,
  checks: Object.freeze({ secrets: true, conflictMarkers: true, debugPrints: true, largeDeletion: true }),
})

/** Contract constants shared by the host module and its tests. */
export const REVIEW_CONTRACT = Object.freeze({
  toolName: 'review_diff',
  recordField: 'reviews',
  rules: Object.freeze(['secrets', 'conflictMarkers', 'debugPrints', 'largeDeletion']),
})

/** A deletion larger than this many lines is called out for a human look. */
export const LARGE_DELETION_LINES = 300

/** Upper bound of listed findings; the report must stay affordable. */
export const MAX_FINDINGS = 60

/** Snippets and arguments are bounded so a pathological diff cannot explode context. */
export const MAX_SNIPPET_CHARS = 160
export const MAX_BASE_CHARS = 120
export const MAX_PATH_CHARS = 260
export const MAX_PATHS = 50

/** Git probes are bounded; a hung git must not hang the agent. */
export const GIT_TIMEOUT_MS = 20000

/** Risk ordering used to sort findings (blockers first). */
export const RISK_ORDER = Object.freeze({ blocker: 0, warning: 1, info: 2 })

/** Severity per rule: only blockers fail the review and gate goal completion. */
export const RULE_SEVERITY = Object.freeze({
  secrets: 'blocker',
  conflictMarkers: 'blocker',
  debugPrints: 'warning',
  largeDeletion: 'warning',
})

/** Suggestions shown next to every finding so the report is actionable. */
export const RULE_SUGGESTIONS = Object.freeze({
  secrets: 'Remove the secret, load it from an environment variable or secret store, and rotate it if it was ever committed.',
  conflictMarkers: 'Resolve the merge conflict and remove every marker before committing or completing.',
  debugPrints: 'Remove the debug output, or put it behind an explicit debug flag.',
  largeDeletion: 'Double-check that the deleted code or data is intended; restore anything still required.',
})

/** Base-ref characters accepted from the model (no shell metacharacters). */
const BASE_RE = /^[A-Za-z0-9._/@^~{}:\-]+$/u
/** Path characters rejected because the git command goes through a shell. */
const PATH_FORBIDDEN_RE = /[\u0000-\u001f"'$&|<>^%;]/u

const CONFLICT_RE = /^(?:<{7}|={7}|>{7}|\|{7})(?: .*)?$/u

const SECRET_RULES = Object.freeze([
  { name: 'private-key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u, message: 'private key material added' },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u, message: 'AWS access key id added' },
  { name: 'aws-secret', re: /aws_?secret_?access_?key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{20,}/iu, message: 'AWS secret access key assignment added' },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u, message: 'GitHub token added' },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u, message: 'Slack token added' },
  { name: 'api-key', re: /\bsk-[A-Za-z0-9]{20,}\b/u, message: 'API key (sk-...) added' },
  { name: 'credential-assignment', re: /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*['"][^'"]{12,}['"]/iu, message: 'credential-like assignment added' },
  { name: 'url-credentials', re: /\b[a-z][a-z0-9+.\-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/iu, message: 'URL with embedded credentials added' },
])

const DEBUG_PATTERNS = Object.freeze([
  { name: 'console', re: /(?:^|[^\w$.])console\.(?:log|debug|trace)\s*\(/u, message: 'console debug output added' },
  { name: 'debugger', re: /(?:^|[^\w$])debugger(?:\s*;)?\s*$/u, message: 'debugger statement added' },
  { name: 'print', re: /(?:^|[^\w$])print\s*\(/u, message: 'print() call added' },
  { name: 'java', re: /\bSystem\.out\.print/u, message: 'System.out.print call added' },
])

/** Clamp one finite number into [min, max], falling back for junk. */
export function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Non-negative finite number, else 0. */
function nonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
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

/**
 * Resolve the reviewGate section.
 * @param config - resolved row configuration (or the section itself).
 * @returns { enabled, maxDiffChars, checks }.
 */
export function resolveReviewConfig(config) {
  let section = {}
  let masterEnabled = true
  if (config !== null && typeof config === 'object') {
    if (config.enabled === false) masterEnabled = false
    section = config.reviewGate !== null && config.reviewGate !== undefined && typeof config.reviewGate === 'object'
      ? config.reviewGate
      : config
  }
  const rawChecks = section.checks !== null && section.checks !== undefined && typeof section.checks === 'object'
    ? section.checks
    : {}
  return {
    enabled: masterEnabled && section.enabled !== false,
    maxDiffChars: clampNumber(section.maxDiffChars, REVIEW_DEFAULTS.maxDiffChars, 1000, 60000),
    checks: {
      secrets: rawChecks.secrets !== false,
      conflictMarkers: rawChecks.conflictMarkers !== false,
      debugPrints: rawChecks.debugPrints !== false,
      largeDeletion: rawChecks.largeDeletion !== false,
    },
  }
}

/** Normalize the optional focus filter (case-insensitive substring). */
export function normalizeFocus(focus) {
  if (typeof focus !== 'string') return ''
  return focus.trim().toLowerCase().slice(0, 120)
}

/**
 * Validate a model-supplied git base ref before it reaches a shell command.
 * The ref is a revision name, not arbitrary text: only ref-safe characters are
 * accepted, which also keeps the shell wrapper injection-free.
 * @param ref - raw argument.
 * @returns { ok: true, value } or { ok: false, reason }.
 */
export function validateRef(ref) {
  if (ref === undefined || ref === null) return { ok: true, value: undefined }
  if (typeof ref !== 'string') return { ok: false, reason: 'base must be a git revision string (for example "HEAD~1").' }
  const trimmed = ref.trim()
  if (trimmed.length === 0) return { ok: true, value: undefined }
  if (trimmed.length > MAX_BASE_CHARS) return { ok: false, reason: 'base is longer than ' + MAX_BASE_CHARS + ' characters.' }
  if (!BASE_RE.test(trimmed)) {
    return { ok: false, reason: 'base may only contain ref characters (letters, digits, . _ / @ ^ ~ { } : -); got ' + JSON.stringify(trimmed) + '.' }
  }
  return { ok: true, value: trimmed }
}

/**
 * Validate and normalize model-supplied path filters.
 * @param paths - array of pathspec strings, a single string, or undefined.
 * @returns { ok: true, paths, dropped } or { ok: false, reason }.
 */
export function normalizePaths(paths) {
  let list = []
  if (paths === undefined || paths === null) list = []
  else if (Array.isArray(paths)) list = paths
  else if (typeof paths === 'string') list = paths.split(/[\n,;]+/u)
  else return { ok: false, reason: 'paths must be an array of path strings.' }
  const cleaned = []
  let dropped = 0
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    if (trimmed.length > MAX_PATH_CHARS || PATH_FORBIDDEN_RE.test(trimmed) || trimmed.startsWith('-')) {
      dropped += 1
      continue
    }
    cleaned.push(trimmed)
    if (cleaned.length >= MAX_PATHS) break
  }
  if (cleaned.length === 0 && dropped > 0) {
    return { ok: false, reason: 'no usable path filter: paths must be worktree-relative, must not start with "-", and must not contain shell metacharacters.' }
  }
  return { ok: true, paths: cleaned, dropped }
}

/**
 * Quote one argument for the platform shell wrapper.
 * Arguments are validated first (no quotes, $, %, &, |, <, >, ^, ;), so simple
 * quoting is enough; the model never supplies the command itself.
 * @param arg - one argument.
 * @param platform - process.platform value.
 * @returns quoted argument text.
 */
export function quoteShellArg(arg, platform) {
  const text = String(arg ?? '')
  if (platform === 'win32') {
    if (/^[A-Za-z0-9_./:=@+\-]+$/u.test(text)) return text
    return '"' + text + '"'
  }
  if (/^[A-Za-z0-9_./:=@+~\-]+$/u.test(text)) return text
  return "'" + text + "'"
}

/**
 * Build the shell invocation for one git command.
 * @param args - git arguments.
 * @param platform - process.platform value.
 * @param comspec - Windows command processor path, if any.
 * @returns { file, args } for the command runner.
 */
export function buildGitInvocation(args, platform, comspec) {
  const list = Array.isArray(args) ? args.map((arg) => String(arg)) : []
  const line = list.map((arg) => quoteShellArg(arg, platform)).join(' ')
  if (platform === 'win32') {
    const file = typeof comspec === 'string' && comspec.length > 0 ? comspec : 'cmd.exe'
    return { file, args: ['/d', '/s', '/c', 'git ' + line] }
  }
  return { file: '/bin/sh', args: ['-c', 'git ' + line] }
}

/**
 * Plan the git probes for one review call.
 *
 * With a base (or an existing HEAD) one diff captures worktree and index against
 * that revision; in an unborn repository the unstaged and staged diffs are taken
 * separately so the first review still works.
 * @param input - { base, paths, hasHead }.
 * @returns ordered steps { kind, label, args }.
 */
export function buildGitPlan(input) {
  const base = typeof input?.base === 'string' && input.base.length > 0 ? input.base : undefined
  const paths = Array.isArray(input?.paths) ? input.paths : []
  const pathspec = paths.length > 0 ? ['--', ...paths] : []
  const steps = [{ kind: 'status', label: 'status', args: ['status', '--porcelain=v1', '--untracked-files=normal'] }]
  const rev = base !== undefined ? base : (input?.hasHead === true ? 'HEAD' : undefined)
  if (rev !== undefined) {
    steps.push({ kind: 'stat', label: 'stat', args: ['diff', rev, '--stat', ...pathspec] })
    steps.push({ kind: 'diff', label: 'worktree', args: ['diff', rev, '--no-color', ...pathspec] })
    return steps
  }
  steps.push({ kind: 'stat', label: 'stat-index', args: ['diff', '--cached', '--stat', ...pathspec] })
  steps.push({ kind: 'stat', label: 'stat-worktree', args: ['diff', '--stat', ...pathspec] })
  steps.push({ kind: 'diff', label: 'index', args: ['diff', '--cached', '--no-color', ...pathspec] })
  steps.push({ kind: 'diff', label: 'worktree', args: ['diff', '--no-color', ...pathspec] })
  return steps
}

/**
 * Parse git status --porcelain=v1 output.
 * @param text - porcelain output.
 * @returns { files, untracked, changed }.
 */
export function parseStatusPorcelain(text) {
  const files = []
  for (const raw of String(text ?? '').split(/\r?\n/u)) {
    const line = raw.replace(/\r$/u, '')
    if (line.trim().length === 0) continue
    const code = line.slice(0, 2)
    const path = line.slice(3).trim()
    files.push({ code, path })
  }
  const untracked = files.filter((file) => file.code.startsWith('??')).length
  return { files, untracked, changed: files.length - untracked }
}

/**
 * Parse a unified diff into per-file added/deleted lines with new-file line
 * numbers, and aggregate insertion/deletion stats.
 * @param text - unified diff text (may be several concatenated diffs).
 * @returns { files, stats }.
 */
export function parseUnifiedDiff(text) {
  const files = []
  let current = null
  let newLine = 0
  let oldLine = 0
  const finish = () => {
    if (current !== null) files.push(current)
    current = null
  }
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/u, '')
    if (line.startsWith('diff --git ')) {
      finish()
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line)
      current = {
        path: match === null ? '' : match[2],
        insertions: 0,
        deletions: 0,
        addedLines: [],
        deletedLines: [],
        addedFile: false,
        deletedFile: false,
        binary: false,
      }
      continue
    }
    if (current === null) continue
    if (line.startsWith('deleted file mode')) { current.deletedFile = true; continue }
    if (line.startsWith('new file mode')) { current.addedFile = true; continue }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { current.binary = true; continue }
    if (line.startsWith('--- ')) { if (line.slice(4) === '/dev/null') current.addedFile = true; continue }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4)
      if (target === '/dev/null') current.deletedFile = true
      else if (target.startsWith('b/')) current.path = target.slice(2)
      continue
    }
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line)
      if (match !== null) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      continue
    }
    if (line.startsWith('+')) {
      current.insertions += 1
      current.addedLines.push({ line: newLine, text: line.slice(1) })
      newLine += 1
      continue
    }
    if (line.startsWith('-')) {
      current.deletions += 1
      current.deletedLines.push({ line: oldLine, text: line.slice(1) })
      oldLine += 1
      continue
    }
    if (line.startsWith(' ')) {
      newLine += 1
      oldLine += 1
      continue
    }
  }
  finish()
  const stats = { files: files.length, insertions: 0, deletions: 0 }
  for (const file of files) {
    stats.insertions += file.insertions
    stats.deletions += file.deletions
  }
  return { files, stats }
}

/**
 * Cut the analysed diff to the configured character budget.
 * @param text - full diff text.
 * @param maxChars - character budget.
 * @returns { text, truncated, omitted }.
 */
export function truncateDiff(text, maxChars) {
  const source = String(text ?? '')
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0))
  if (budget === 0 || source.length <= budget) return { text: source, truncated: false, omitted: 0 }
  let head = source.slice(0, budget)
  const lastNewline = head.lastIndexOf('\n')
  if (lastNewline > budget * 0.5) head = head.slice(0, lastNewline)
  return { text: head, truncated: true, omitted: source.length - head.length }
}

/** Redact high-entropy runs so a detected secret never lands in model history. */
export function redactSecretSnippet(text) {
  const clipped = String(text ?? '').trim().slice(0, MAX_SNIPPET_CHARS)
  return clipped.replace(/[A-Za-z0-9+/=_\-]{12,}/gu, (match) => (match.length > 16 ? match.slice(0, 4) + '[redacted]' : match))
}

/** Short readable snippet of an added line. */
export function snippetFor(text) {
  const clipped = String(text ?? '').trim().slice(0, MAX_SNIPPET_CHARS)
  return clipped.length === 0 ? '(empty line)' : clipped
}

/** Build one finding record. */
export function makeFinding(rule, file, line, snippet, message, severity) {
  return {
    rule,
    severity: severity ?? RULE_SEVERITY[rule] ?? 'warning',
    file: String(file ?? ''),
    line: Number.isFinite(Number(line)) ? Number(line) : 0,
    snippet: String(snippet ?? '').slice(0, MAX_SNIPPET_CHARS),
    message: String(message ?? rule),
    suggestion: RULE_SUGGESTIONS[rule] ?? 'Review this change manually.',
  }
}

/** Whether a line looks like a secret of any supported kind. */
export function matchSecret(text) {
  const line = String(text ?? '')
  for (const rule of SECRET_RULES) {
    if (rule.re.test(line)) return rule
  }
  return undefined
}

/** Whether a line looks like a debug print. */
export function matchDebugPrint(text) {
  const line = String(text ?? '')
  for (const pattern of DEBUG_PATTERNS) {
    if (pattern.re.test(line)) return pattern
  }
  return undefined
}

/** Whether a line is a merge-conflict marker. */
export function isConflictMarker(text) {
  return CONFLICT_RE.test(String(text ?? '').trimStart())
}

/**
 * Keep only findings matching the focus substring (file, rule, message, snippet).
 * @param findings - findings list.
 * @param focus - raw focus argument.
 * @returns filtered findings.
 */
export function applyFocus(findings, focus) {
  const needle = normalizeFocus(focus)
  const list = Array.isArray(findings) ? findings : []
  if (needle.length === 0) return list.slice()
  return list.filter((finding) => {
    const haystack = [finding?.file, finding?.rule, finding?.message, finding?.snippet]
      .map((value) => String(value ?? '').toLowerCase())
      .join('\n')
    return haystack.includes(needle)
  })
}

/** Sort findings risk-first, then by file and line. */
export function sortFindings(findings) {
  const list = Array.isArray(findings) ? findings.slice() : []
  list.sort((left, right) => {
    const risk = (RISK_ORDER[left?.severity] ?? 9) - (RISK_ORDER[right?.severity] ?? 9)
    if (risk !== 0) return risk
    const file = String(left?.file ?? '').localeCompare(String(right?.file ?? ''))
    if (file !== 0) return file
    return Number(left?.line ?? 0) - Number(right?.line ?? 0)
  })
  return list
}

/**
 * Run the deterministic checks over parsed added lines plus per-file deletion
 * stats. Checks are independent switches from config; a disabled check is never
 * evaluated (and therefore never reported).
 * @param input - { parsed, checks, focus, truncated }.
 * @returns { findings, blockerCount, warningCount, truncatedInput }.
 */
export function runChecks(input) {
  const enabled = {
    secrets: input?.checks?.secrets !== false,
    conflictMarkers: input?.checks?.conflictMarkers !== false,
    debugPrints: input?.checks?.debugPrints !== false,
    largeDeletion: input?.checks?.largeDeletion !== false,
  }
  const parsed = input?.parsed !== null && input?.parsed !== undefined && typeof input.parsed === 'object'
    ? input.parsed
    : { files: [] }
  const findings = []
  const push = (finding) => {
    if (findings.length < MAX_FINDINGS) findings.push(finding)
  }
  for (const file of Array.isArray(parsed.files) ? parsed.files : []) {
    const filePath = String(file?.path ?? '')
    if (enabled.largeDeletion) {
      if (file?.deletedFile === true) {
        push(makeFinding('largeDeletion', filePath, 0, '(whole file deleted)', 'entire file deleted (' + nonNegative(file?.deletions) + ' lines removed)'))
      } else if (nonNegative(file?.deletions) > LARGE_DELETION_LINES) {
        push(makeFinding('largeDeletion', filePath, 0, '(large deletion)', nonNegative(file.deletions) + ' deleted lines (threshold ' + LARGE_DELETION_LINES + ')'))
      }
    }
    for (const added of Array.isArray(file?.addedLines) ? file.addedLines : []) {
      const text = String(added?.text ?? '')
      const line = Number(added?.line)
      if (enabled.conflictMarkers && isConflictMarker(text)) {
        push(makeFinding('conflictMarkers', filePath, line, snippetFor(text), 'unresolved merge conflict marker added'))
      }
      if (enabled.secrets) {
        const secret = matchSecret(text)
        if (secret !== undefined) {
          push(makeFinding('secrets', filePath, line, redactSecretSnippet(text), secret.message + ' (' + secret.name + ')'))
        }
      }
      if (enabled.debugPrints) {
        const debug = matchDebugPrint(text)
        if (debug !== undefined) {
          push(makeFinding('debugPrints', filePath, line, snippetFor(text), debug.message + ' (' + debug.name + ')'))
        }
      }
    }
  }
  const focused = sortFindings(applyFocus(findings, input?.focus))
  const blockerCount = focused.filter((finding) => finding.severity === 'blocker').length
  return {
    findings: focused,
    blockerCount,
    warningCount: focused.length - blockerCount,
    truncatedInput: input?.truncated === true,
  }
}

/** Age in whole minutes for denial texts. */
export function ageMinutes(ageMs, fallback = 1) {
  const number = Number(ageMs)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.max(1, Math.round(number / 60000))
}

/**
 * Build the evidence record goalGate consumes.
 * ok is true only when the review ran and found no blocker.
 * @param input - { at, findings, stats, truncated, base }.
 * @returns the review record.
 */
export function buildReviewRecord(input) {
  const findings = Array.isArray(input?.findings) ? input.findings : []
  const blockerCount = findings.filter((finding) => finding?.severity === 'blocker').length
  return {
    at: Number.isFinite(input?.at) ? input.at : 0,
    ok: blockerCount === 0,
    findings: blockerCount,
    warnings: findings.length - blockerCount,
    files: nonNegative(input?.stats?.files),
    insertions: nonNegative(input?.stats?.insertions),
    deletions: nonNegative(input?.stats?.deletions),
    untracked: nonNegative(input?.stats?.untracked),
    truncated: input?.truncated === true,
    base: typeof input?.base === 'string' ? input.base : undefined,
  }
}

/** Tail of a long text, marking what was dropped. */
export function tailText(text, limit) {
  const source = String(text ?? '')
  const budget = Math.max(0, Math.floor(Number(limit) || 0))
  if (budget === 0 || source.length <= budget) return source
  return '[... ' + (source.length - budget) + ' chars omitted ...]\n' + source.slice(-budget)
}

/**
 * Render the model-facing review report: risk-first findings, a fix suggestion
 * per finding, the deterministic-check disclaimer and a closing human checklist.
 * @param input - findings/stats/git context collected by the host module.
 * @returns report text, capped at maxChars.
 */
export function renderReviewReport(input) {
  const findings = sortFindings(Array.isArray(input?.findings) ? input.findings : [])
  const stats = input?.stats !== null && input?.stats !== undefined && typeof input.stats === 'object' ? input.stats : {}
  const blockers = findings.filter((finding) => finding.severity === 'blocker').length
  const warnings = findings.length - blockers
  const maxChars = Math.max(1000, Math.floor(Number(input?.maxChars) || REVIEW_DEFAULTS.maxDiffChars))
  const lines = []
  if (blockers > 0) lines.push('review_diff: BLOCKED — ' + blockers + ' blocker(s), ' + warnings + ' warning(s)')
  else if (findings.length > 0) lines.push('review_diff: PASS with ' + warnings + ' warning(s) (0 blockers)')
  else lines.push('review_diff: CLEAN (no findings)')
  lines.push(
    'scope: ' + nonNegative(stats.files) + ' changed tracked file(s), ' + nonNegative(stats.insertions)
    + ' insertion(s), ' + nonNegative(stats.deletions) + ' deletion(s), ' + nonNegative(stats.untracked)
    + ' untracked file(s); base=' + String(input?.base ?? 'HEAD')
  )
  if (input?.diffTruncated === true) {
    lines.push('truncated: the diff exceeded maxDiffChars=' + maxChars + ' and was cut after '
      + nonNegative(input?.diffOmittedChars) + ' omitted chars; checks beyond the cut were not run.')
  }
  const untrackedFiles = Array.isArray(input?.untrackedFiles) ? input.untrackedFiles : []
  if (untrackedFiles.length > 0) {
    lines.push('untracked (not content-reviewed; git diff does not show them): '
      + untrackedFiles.slice(0, 20).map((entry) => String(entry)).join(', ')
      + (untrackedFiles.length > 20 ? ' …' : ''))
  }
  lines.push('Note: 这是确定性检查，不是完整代码审查 (this is a deterministic diff check, not a complete code review).')
  if (findings.length === 0) {
    lines.push('No secret-looking additions, conflict markers, debug prints or large deletions were detected in the reviewed diff.')
  } else {
    lines.push('Findings (risk-first, each with a suggested fix):')
    for (const finding of findings) {
      const location = String(finding.file ?? '') + (Number(finding.line) > 0 ? ':' + finding.line : '')
      lines.push('[' + String(finding.severity ?? 'warning').toUpperCase() + '] ' + finding.rule + ' '
        + (location.length > 0 ? location + ' — ' : '') + finding.message)
      if (typeof finding.snippet === 'string' && finding.snippet.length > 0) lines.push('  ' + finding.snippet)
      if (typeof finding.suggestion === 'string' && finding.suggestion.length > 0) lines.push('  fix: ' + finding.suggestion)
    }
  }
  const statText = typeof input?.statText === 'string' ? input.statText.trim() : ''
  if (statText.length > 0) {
    lines.push('diffstat:')
    for (const line of tailText(statText, 1200).split('\n')) lines.push('  ' + line)
  }
  lines.push('cwd: ' + String(input?.cwd ?? '(unknown)'))
  if (Number.isFinite(input?.elapsedMs)) lines.push('elapsed: ' + (Math.round(input.elapsedMs / 100) / 10) + 's')
  if (Number.isFinite(input?.checkedAt)) lines.push('checked at: ' + isoTime(input.checkedAt))
  lines.push('Human review checklist:')
  if (blockers > 0) {
    lines.push('  1. Inspect every blocker finding above; remove the secret or resolve the conflict, and rotate any credential that may have been exposed.')
  } else {
    lines.push('  1. Spot-check the diff for what deterministic rules cannot see: logic, security, data loss, API compatibility.')
  }
  lines.push('  2. Review the untracked files manually; git diff does not show their content.')
  if (findings.some((finding) => finding.rule === 'debugPrints')) {
    lines.push('  3. Remove or gate the debug prints before merging.')
  }
  if (findings.some((finding) => finding.rule === 'largeDeletion')) {
    lines.push('  4. Explain every large deletion; restore anything that is still required.')
  }
  lines.push('  5. Run the test suite (or goal_verify) again after fixing the findings.')
  const report = lines.join('\n')
  return report.length <= maxChars
    ? report
    : report.slice(0, maxChars) + '\n[... report truncated at ' + maxChars + ' chars (reviewGate.maxDiffChars) ...]'
}

/**
 * Render the explicit "git unavailable, nothing guessed" report.
 * @param reason - concrete failure detail.
 * @returns report text.
 */
export function renderUnavailableReview(reason) {
  return [
    'review_diff: unavailable — nothing was reviewed and nothing was guessed.',
    'reason: ' + String(reason ?? 'unknown reason'),
    'No review record was written. Fix the environment (git availability or the session working directory) and retry.',
  ].join('\n')
}
