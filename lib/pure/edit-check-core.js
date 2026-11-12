/**
 * editCheck pure core — decisions that do not touch the host.
 *
 * Nothing here imports @deepseek-ai/*; only ../shared.js (Node built-ins only).
 */
import { estimateTokens, globMatches, truncateToTokenBudget } from '../shared.js'

/** Tools whose successful result means a file was written, and the argument that names it. */
export const WRITE_TOOLS = Object.freeze({
  write: 'file_path',
  edit: 'file_path',
  replace: 'file_path',
  str_replace_editor: 'path',
  apply_patch: 'input',
})

/** Defaults for one check entry. */
export const CHECK_DEFAULTS = Object.freeze({
  timeoutMs: 120000,
  maxOutputTokens: 1200,
})

/** Lines of stdout/stderr kept from the head and tail of a failed run. */
export const HEAD_LINES = 40
export const TAIL_LINES = 20

/** True when the tool mutates a file (its result is worth validating). */
export function isWriteTool(name) {
  return Object.prototype.hasOwnProperty.call(WRITE_TOOLS, String(name ?? ''))
}

/** Normalize a host path to forward slashes without resolving it. */
export function toPosixPath(value) {
  return String(value ?? '').replace(/\\/gu, '/')
}

/**
 * Strip trailing slashes and lowercase a Windows path for containment
 * comparisons (drive letters and separators are case-insensitive there).
 */
function comparablePath(value) {
  const posix = toPosixPath(value).replace(/\/+$/u, '')
  return /^[A-Za-z]:/u.test(posix) ? posix.toLowerCase() : posix
}

/** Whether an absolute path is the workspace itself or lives below it. */
export function isInsideWorkspace(workspace, filePath) {
  const root = comparablePath(workspace)
  const target = comparablePath(filePath)
  if (root.length === 0 || target.length === 0) return false
  if (root === target) return true
  return target.startsWith(root + '/')
}

/**
 * Map a tool-supplied path to a workspace-relative POSIX path.
 * @returns ok:true with relative/absolute, or ok:false with a reason.
 */
export function relativeToWorkspace(workspace, filePath) {
  if (typeof workspace !== 'string' || workspace.length === 0) return { ok: false, reason: 'no-workspace' }
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return { ok: false, reason: 'no-path' }
  const raw = filePath.trim()
  const absolute = raw.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(raw) || raw.startsWith('\\\\')
  const resolved = absolute ? toPosixPath(raw) : toPosixPath(workspace) + '/' + toPosixPath(raw)
  const normalized = normalizeSegments(resolved)
  if (!isInsideWorkspace(workspace, normalized)) return { ok: false, reason: 'outside-workspace' }
  const root = toPosixPath(workspace).replace(/\/+$/u, '')
  const target = normalized.replace(/\/+$/u, '')
  const relative = target === root ? '' : target.slice(comparableRootLength(workspace))
  return { ok: true, relative: relative.replace(/^\.\//u, ''), absolute: normalized }
}

/** Character offset of the first path segment below the normalized workspace root. */
function comparableRootLength(workspace) {
  return toPosixPath(workspace).replace(/\/+$/u, '').length + 1
}

/** Resolve '.' and '..' segments without touching the filesystem. */
export function normalizeSegments(path) {
  const source = toPosixPath(path)
  const drive = /^([A-Za-z]):/u.exec(source)
  const prefix = drive === null ? (source.startsWith('/') ? '/' : '') : drive[1] + ':'
  const body = drive === null ? source.slice(prefix.length) : source.slice(2)
  const segments = []
  for (const segment of body.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0) segments.pop()
      continue
    }
    segments.push(segment)
  }
  return prefix + '/' + segments.join('/')
}

/** File paths named by one write-class tool call, in argument order. */
export function pathsFromToolCall(toolName, args) {
  const name = String(toolName ?? '')
  const source = args !== null && typeof args === 'object' ? args : {}
  if (name === 'apply_patch') return pathsFromPatch(source.input ?? source.patch)
  const key = WRITE_TOOLS[name]
  const collected = []
  if (typeof key === 'string') {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) collected.push(value.trim())
  }
  for (const fallback of ['file_path', 'path']) {
    const value = source[fallback]
    if (typeof value === 'string' && value.trim().length > 0 && !collected.includes(value.trim())) collected.push(value.trim())
  }
  return collected
}

/**
 * Parse a Codex-style patch for every path it can create, update, move or delete.
 * Header lines are the only reliable source: hunk content may contain arbitrary
 * text that looks like a header.
 */
export function pathsFromPatch(patch) {
  const text = String(patch ?? '')
  if (text.length === 0) return []
  const paths = []
  const push = (value) => {
    const trimmed = String(value ?? '').trim()
    if (trimmed.length > 0 && !paths.includes(trimmed)) paths.push(trimmed)
  }
  for (const line of text.split('\n')) {
    const match = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/u.exec(line.trim())
    if (match !== null) { push(match[1]); continue }
    const move = /^\*\*\*\s+Move\s+to:\s*(.+)$/u.exec(line.trim())
    if (move !== null) push(move[1])
  }
  return paths
}

/**
 * Split a configured command into execFile (command, args).
 * Accepts an argv array as a convenience (and the safe form in tests), or a
 * shell-like string with single/double quotes. Never uses a shell: the model
 * configured the command, but we still do not hand it to /bin/sh.
 * @throws when the command is empty or a quote is unterminated.
 */
export function parseCommandLine(input) {
  if (Array.isArray(input)) {
    const argv = input.map((part) => String(part)).filter((part) => part.length > 0)
    if (argv.length === 0) throw new Error('check command is empty')
    return { command: argv[0], args: argv.slice(1), display: argv.join(' ') }
  }
  const source = String(input ?? '').trim()
  if (source.length === 0) throw new Error('check command is empty')
  const parts = []
  let current = ''
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote === '') {
      if (char === '"' || char === "'") { quote = char; continue }
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
        if (current.length > 0) { parts.push(current); current = '' }
        continue
      }
      if (char === '\\') {
        const next = source[index + 1]
        if (next === '"' || next === "'" || next === '\\' || next === ' ') { current += next; index += 1; continue }
        current += char
        continue
      }
      current += char
      continue
    }
    if (char === quote) { quote = ''; continue }
    if (char === '\\' && quote === '"') {
      const next = source[index + 1]
      if (next === '"' || next === '\\') { current += next; index += 1; continue }
    }
    current += char
  }
  if (quote !== '') throw new Error('unterminated quote in check command')
  if (current.length > 0) parts.push(current)
  if (parts.length === 0) throw new Error('check command is empty')
  return { command: parts[0], args: parts.slice(1), display: source }
}

/** Whether a check applies to one changed file; an omitted 'when' matches every file. */
export function checkMatchesFile(check, relativePath) {
  const when = Array.isArray(check?.when) ? check.when.filter((item) => typeof item === 'string' && item.length > 0) : []
  if (when.length === 0) return true
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  return when.some((pattern) => globMatches(pattern, relativePath))
}

/**
 * Stable identity for debouncing and deduplication.
 * Keyed by the command, not the check name: two entries that run the same
 * expensive command in the same debounce window must not both fire.
 */
export function checkKey(check) {
  const command = Array.isArray(check?.command) ? check.command.join(' ') : String(check?.command ?? '')
  return command.replace(/\s+/gu, ' ').trim()
}

/**
 * Select the checks that should run for the changed files.
 * Deduplicates identical commands (one tsc run is enough even if two checks
 * declare it) and keeps configuration order so the first-failure semantics are
 * stable.
 */
export function selectMatchingChecks(checks, changedFiles) {
  const list = Array.isArray(checks) ? checks : []
  const files = Array.isArray(changedFiles) ? changedFiles : []
  const selected = []
  const seen = new Set()
  for (const check of list) {
    if (check === null || typeof check !== 'object') continue
    if (typeof check.command !== 'string' && !Array.isArray(check.command)) continue
    const matched = files.some((file) => checkMatchesFile(check, file))
    if (!matched) continue
    const key = checkKey(check)
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(check)
  }
  return selected
}

/** First line that looks like a compiler/runtime error, for the one-line pinpoint. */
export function firstErrorLine(text) {
  const source = String(text ?? '')
  const lines = source.split('\n')
  const patterns = [
    /\berror TS\d+/u,
    /\b[A-Z]+\d{3,}\b/u,
    /^\s*(?:Error|error|ERROR|FAIL|failed|Failed|fatal|Fatal)\b/u,
    /\b(?:AssertionError|TypeError|SyntaxError|ReferenceError|RangeError)\b/u,
    /^\s*(?:=>|>)\s*\S/u,
    /\b(?:expected|Expected|mismatch|Mismatch|not found|cannot find|Cannot find)\b/u,
  ]
  for (const pattern of patterns) {
    const hit = lines.find((line) => pattern.test(line))
    if (hit !== undefined) return hit.trim()
  }
  return lines.find((line) => line.trim().length > 0)?.trim() ?? ''
}

/**
 * Keep the head and tail of a long output, replacing the middle with a marker.
 * Line-based (what compilers report) rather than character-based.
 */
export function headTailLines(text, head = HEAD_LINES, tail = TAIL_LINES) {
  const lines = String(text ?? '').replace(/\r\n/gu, '\n').split('\n')
  if (lines.length <= head + tail) return lines.join('\n')
  const omitted = lines.length - head - tail
  return lines.slice(0, head).join('\n') + '\n[... ' + omitted + ' lines omitted ...]\n' + lines.slice(-tail).join('\n')
}

/**
 * Render one failed check into a bounded model-facing section.
 * @returns the section text, already inside the check token budget.
 */
export function buildCheckFailureText(input) {
  const { check, run } = input ?? {}
  const name = String(check?.name ?? 'check')
  const command = Array.isArray(check?.command) ? check.command.join(' ') : String(check?.command ?? '')
  const budget = normalizeBudget(check?.maxOutputTokens ?? CHECK_DEFAULTS.maxOutputTokens)
  const output = [String(run?.stdout ?? ''), String(run?.stderr ?? '')].filter((part) => part.trim().length > 0).join('\n')
  const status = run?.timedOut === true ? 'timed out' : 'exit code ' + String(run?.code ?? '?')
  const header = 'Check "' + name + '" failed (' + status + '): ' + command
  const first = firstErrorLine(output)
  const body = headTailLines(output)
  const lines = [header]
  if (first.length > 0) lines.push('First error: ' + first)
  lines.push('Output (' + HEAD_LINES + ' head / ' + TAIL_LINES + ' tail lines):')
  lines.push(body.length > 0 ? body : '(no output)')
  return truncateToTokenBudget(lines.join('\n'), budget)
}

/** Clamp a configured token budget to something a post-execute context can afford. */
export function normalizeBudget(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return CHECK_DEFAULTS.maxOutputTokens
  return Math.max(120, Math.min(8000, Math.floor(number)))
}

/**
 * Compose the injected reflection message.
 * @param input.failures - sections produced by buildCheckFailureText.
 * @param input.attempt - 1-based fix attempt number.
 * @param input.maxReflections - configured cap.
 * @param input.exhausted - true when the cap is reached and we ask the model to stop.
 * @param input.budget - total token budget for this message.
 * @param input.files - workspace-relative files that triggered the checks.
 */
export function buildReflectionMessage(input) {
  const failures = Array.isArray(input?.failures) ? input.failures : []
  const attempt = Math.max(1, Math.floor(Number(input?.attempt ?? 1)))
  const maxReflections = Math.max(1, Math.floor(Number(input?.maxReflections ?? 3)))
  const budget = normalizeBudget(input?.budget ?? CHECK_DEFAULTS.maxOutputTokens)
  const files = Array.isArray(input?.files) ? input.files.slice(0, 8) : []
  const header = input?.exhausted === true
    ? '[editCheck - automatically injected; not a new user request.] ' +
      'The configured edit check failed ' + (attempt - 1) + ' time(s) in a row (limit ' + maxReflections + '). ' +
      'Stop automatic fix attempts: summarize the failing check and the remaining error for the user, and say what you would try next.'
    : '[editCheck - automatically injected; not a new user request.] ' +
      'Your edit broke a configured check. Fix it before continuing (fix attempt ' + attempt + '/' + maxReflections + ').'
  const footer = files.length > 0 ? 'Files checked: ' + files.join(', ') : ''
  const room = Math.max(120, budget - estimateTokens(header) - estimateTokens(footer) - 8)
  const body = truncateToTokenBudget(failures.join('\n\n'), room)
  return [header, body, footer].filter((part) => part.length > 0).join('\n')
}

/** Render a passing-run note only when reportSuccess is enabled. */
export function buildSuccessMessage(names, files) {
  const checks = Array.isArray(names) && names.length > 0 ? names.join(', ') : 'configured checks'
  const suffix = Array.isArray(files) && files.length > 0 ? ' (' + files.join(', ') + ')' : ''
  return '[editCheck - automatically injected; not a new user request.] ' + checks + ' passed after the edit' + suffix + '.'
}
