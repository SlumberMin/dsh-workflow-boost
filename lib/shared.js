/** Shared helpers for every workflow-boost module. No third-party imports. */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

export const MODULE_PREFIX = 'dsh-workflow-boost'

/** Log through the plugin state so every line carries the same prefix. */
export function logWarn(state, message) {
  try { state?.log?.('warn', message) } catch { /* ignore */ }
}

export function logInfo(state, message) {
  try { state?.log?.('info', message) } catch { /* ignore */ }
}

/** Stable JSON: objects with sorted keys, so the same call always yields the same key. */
export function stableStringify(value) {
  const seen = new WeakSet()
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk)
    const out = {}
    for (const key of Object.keys(v).sort()) out[key] = walk(v[key])
    return out
  }
  try {
    return JSON.stringify(walk(value))
  } catch {
    return String(value)
  }
}

export function shortHash(text, length = 16) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, length)
}

/**
 * Char-per-token heuristic that also knows CJK. DSH's own meter assumes four
 * characters per token, which under-counts Chinese and JSON by a wide margin;
 * this estimate is deliberately conservative for trigger decisions only.
 */
export function estimateTokens(text) {
  const source = String(text ?? '')
  if (source.length === 0) return 0
  let cjk = 0
  let other = 0
  let lines = 0
  for (const ch of source) {
    const code = ch.codePointAt(0)
    if (code === 10) lines += 1
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) cjk += 1
    else other += 1
  }
  // CJK: ~1.6 chars/token; code/prose: ~4 chars/token; line structure adds a little.
  return Math.ceil(cjk / 1.6 + other / 4 + lines * 0.25)
}

export function truncateToTokenBudget(text, budget) {
  const source = String(text ?? '')
  if (budget <= 0) return ''
  if (estimateTokens(source) <= budget) return source
  // Binary search on characters by estimated tokens.
  let low = 0
  let high = source.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(source.slice(0, mid)) <= budget) low = mid
    else high = mid - 1
  }
  return source.slice(0, low)
}

/** Keep head and tail of a long text, marking the removed middle. */
export function shortenMiddle(text, headChars = 240, tailChars = 160) {
  const source = String(text ?? '')
  if (source.length <= headChars + tailChars + 32) return source
  return source.slice(0, headChars) + '\n\n[... truncated ' + (source.length - headChars - tailChars) + ' chars ...]\n\n' + source.slice(-tailChars)
}

/** Concatenate text blocks of a content array; non-text blocks are ignored. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** True when the content array is text-only (no images or structured payloads). */
export function isTextOnlyContent(content) {
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return content.every((block) => block && typeof block === 'object' && block.type === 'text')
}

/** DSH renders a thrown tool failure as `Error: ...`; keep those results. */
export function looksLikeErrorText(text) {
  return /^\s*(?:Error:|error:|Traceback \(most recent call last\))/.test(String(text ?? ''))
}

/** Promise wrapper around execFile with timeout and no shell. */
export function runProcess(command, args, options = {}) {
  const { cwd, timeoutMs = 120000, env } = options
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: env ?? process.env,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: Boolean(error && (error.killed || error.signal)),
          error: error ? String(error.message ?? error) : undefined,
        })
      },
    )
  })
}

/** Best-effort git evidence for the goal gate. Never throws. */
export async function gitEvidence(cwd, timeoutMs = 15000) {
  if (!cwd) return undefined
  try {
    const status = await runProcess('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=normal'], { cwd, timeoutMs })
    if (status.code !== 0) return undefined
    const changed = status.stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean)
    const diffStat = await runProcess('git', ['-C', cwd, 'diff', '--stat', 'HEAD'], { cwd, timeoutMs })
    return {
      changedFiles: changed.length,
      changed: changed.slice(0, 40),
      diffStat: shortText(diffStat.stdout, 4000),
    }
  } catch {
    return undefined
  }
}

export function shortText(text, max = 2000) {
  const source = String(text ?? '')
  return source.length <= max ? source : source.slice(0, max) + '\n[... ' + (source.length - max) + ' chars truncated ...]'
}

export function nowIso() {
  return new Date().toISOString()
}

/** Tools that can mutate the workspace; used by evidence/checkpoint helpers. */
export const MUTATING_TOOLS = new Set([
  'write', 'edit', 'replace', 'apply_patch', 'str_replace_editor',
  'bash', 'pwsh', 'run_code', 'terminal_send', 'shell', 'exec',
])

export function isMutatingTool(name) {
  return MUTATING_TOOLS.has(String(name ?? ''))
}

/** Accept either a module-level modern config or a plain object. */
export function sectionEnabled(config, key) {
  if (config?.enabled === false) return false
  const section = config?.[key]
  if (section === undefined) return true
  return section?.enabled !== false
}

/** FNV-1a 32-bit hash, dependency-free so pure modules and projections can use it. */
export function fnv1a(text) {
  const source = String(text ?? '')
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/** Short hex digest for signatures embedded in logs and reasons. */
export function shortDigest(text) {
  return fnv1a(text).toString(16).padStart(8, '0')
}

/** Clamp a numeric value into [min, max] with a fallback for non-numbers. */
export function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Round a non-negative finite number, falling back when unusable. */
export function roundInt(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.floor(number)
}

/**
 * Minimal glob matcher for workspace-relative POSIX paths.
 * Supports ** (any depth), * (no slash), ? (one non-slash), and exact text.
 * Dependency-free so runtime and clean-environment tests share one implementation.
 */
export function globMatches(pattern, filePath) {
  const path = String(filePath ?? '').replaceAll('\\\\', '/')
  const source = String(pattern ?? '').trim().replaceAll('\\\\', '/')
  if (source.length === 0) return true
  const escape = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  let regex = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        const afterSlash = source[index + 2] === '/'
        regex += afterSlash ? '(?:.*/)?' : '.*'
        index += afterSlash ? 2 : 1
      } else {
        regex += '[^/]*'
      }
      continue
    }
    if (char === '?') { regex += '[^/]'; continue }
    regex += escape(char)
  }
  try {
    return new RegExp('^' + regex + '$', 'i').test(path)
  } catch {
    return false
  }
}

/** True when any of the patterns matches the path (empty list matches nothing). */
export function matchesAny(patterns, filePath) {
  const list = Array.isArray(patterns) ? patterns : []
  for (const pattern of list) if (globMatches(pattern, filePath)) return true
  return false
}

/** Human-readable byte count. */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return Math.round(value) + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** Safe error message. */
export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** First non-empty line of a potentially multi-line text, clipped. */
export function firstLine(text, max = 160) {
  const line = String(text ?? '').split('\n').find((entry) => entry.trim().length > 0) ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}


/**
 * Load a host package lazily. Modules must not import host packages statically:
 * the plugin has to stay importable (and unit-testable) in a clean Node
 * environment that has no @deepseek-ai packages installed.
 * @param specifier - package specifier.
 * @returns the module namespace, or undefined when the host package is absent.
 */
export async function loadHost(specifier) {
  try {
    return await import(specifier)
  } catch {
    return undefined
  }
}

/**
 * Run a command with optional stdin and a hard timeout, collecting both
 * streams. Used by the hook bus (JSON on stdin) and review gate (git diff).
 * @param command - executable or shell command string.
 * @param args - argument array.
 * @param options - { cwd, timeoutMs, stdin, env, shell }
 * @returns { code, stdout, stderr, timedOut }
 */
export function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        shell: options.shell === true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve(result)
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: stderr + String(error?.message ?? error), timedOut: false }))
    child.on('close', (code) => finish({ code: code === null ? -1 : code, stdout, stderr, timedOut: false }))
    timer = setTimeout(() => finish({ code: -1, stdout, stderr, timedOut: true }), Math.max(100, Number(options.timeoutMs) || 10000))
    try {
      if (typeof options.stdin === 'string' && options.stdin.length > 0) child.stdin.write(options.stdin)
      child.stdin.end()
    } catch { /* stdin may be unavailable */ }
  })
}
