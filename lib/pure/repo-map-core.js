/**
 * repoMap pure core — symbol extraction, one-pass token index, Aider-style
 * ranking, workspace containment checks and token-budget rendering.
 *
 * Everything here is dependency free: only lib/shared.js (host-free helpers)
 * and lib/defaults.js are imported, so the clean-environment unit tests can
 * exercise the ranking and the path guard without DSH installed.
 *
 * Why this file exists:
 *  - the 0.1.0 ranker rescanned every file's full text once per symbol
 *    (symbol x file x full text) and never yielded to the event loop; the
 *    scanner here builds ONE identifier->count index per file and the ranker
 *    only does Map lookups, with a hard symbol/edge cap and deadline checks;
 *  - repo_map accepted any absolute path (C:\\Windows, /etc, ../ escapes) and
 *    followed symlinks; classifyWorkspacePath is the single pure decision
 *    point for containment now, and the caller realpaths both ends before it
 *    so a symlink escape cannot pass.
 */
import { estimateTokens, truncateToTokenBudget } from '../shared.js'
import { DEFAULTS as PLUGIN_DEFAULTS } from '../defaults.js'

/** On-disk symbol index schema version. Any mismatch discards the cache. */
export const INDEX_VERSION = 1
/** Workspace-relative directory of the persisted map index. */
export const INDEX_DIR = '.dsh/workflow-boost'
/** Persisted map index file name. */
export const INDEX_FILE = 'repomap-index.json'

/** Rendered definitions per file, so one large file cannot own the budget. */
export const MAX_SYMBOLS_PER_FILE = 8
/** Hard cap of extracted definitions per file. */
export const MAX_EXTRACTED_SYMBOLS = 4000
/** Unique identifiers kept per file when building the one-pass token index. */
export const MAX_TOKEN_INDEX_PER_FILE = 3000
/** Total definitions considered by the ranker (beyond this the map is partial). */
export const MAX_RANK_SYMBOLS = 12000
/** Total distinct file-pair edges considered by the ranker. */
export const MAX_RANK_EDGES = 40000
/** Unique tokens inspected per file while building rank edges. */
export const MAX_RANK_TOKENS_PER_FILE = 3000
/** PageRank damping; Aider uses the usual 0.85. */
export const PAGERANK_DAMPING = 0.85
/** PageRank power iterations; small graphs converge well within this. */
export const PAGERANK_ITERATIONS = 12
/** A definition no other file references adds this self-loop weight (Aider 0.1). */
export const UNREFERENCED_SELF_WEIGHT = 0.1
/** Rank bonus for files mentioned in the conversation (Aider personalization). */
export const CHAT_SCORE_BOOST = 1
/** Without conversation files the map needs more breadth, so the budget grows. */
export const NO_CHAT_BUDGET_MULTIPLIER = 1.5
/** Largest personalised budget after amplification. */
export const MAX_EFFECTIVE_BUDGET = 30000
/** Tokens reserved for the header/footer when the body budget is computed. */
export const HEADER_RESERVE_TOKENS = 120
/** Conversation path hints kept per session. */
export const MAX_HINT_HISTORY = 48
/** Conversation files that may be personalised at once. */
export const MAX_CHAT_FILES = 24
/** Hard cap of persisted index records read back from disk. */
export const MAX_INDEX_FILES = 100000
/** Persisted index larger than this is not written (keeps calls responsive). */
export const INDEX_MAX_BYTES = 24 * 1024 * 1024

/** Mirror of the row defaults; lib/defaults.js is the single source of truth. */
export const DEFAULT_SETTINGS = PLUGIN_DEFAULTS.repoMap

/** Directories that never carry useful shape for planning. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.venv', 'venv', 'env', '__pycache__', 'target', 'vendor', 'bin', 'obj',
  '.next', '.nuxt', '.cache', '.turbo', '.idea', '.vscode', '.gradle',
  '.pytest_cache', '.mypy_cache', '.dsh', '.obsidian', '.svelte-kit',
  '.parcel-cache', '.yarn', '.pnpm-store',
])

/** Extensions mapped to a language id; anything else is ignored by the mapper. */
export const LANGUAGES = new Map([
  ['.js', 'js'], ['.mjs', 'js'], ['.cjs', 'js'], ['.jsx', 'js'],
  ['.ts', 'ts'], ['.mts', 'ts'], ['.cts', 'ts'], ['.tsx', 'ts'],
  ['.py', 'py'], ['.go', 'go'], ['.rs', 'rs'],
  ['.java', 'java'], ['.kt', 'kt'], ['.cs', 'cs'],
  ['.c', 'c'], ['.h', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.hpp', 'cpp'],
  ['.rb', 'rb'], ['.php', 'php'], ['.swift', 'swift'], ['.lua', 'lua'],
  ['.sh', 'sh'], ['.bash', 'sh'], ['.ps1', 'ps1'], ['.sql', 'sql'],
])

/** Language id for one file name, or undefined when the mapper ignores it. */
export function languageFor(fileName) {
  const name = String(fileName ?? '')
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return undefined
  return LANGUAGES.get(name.slice(dot).toLowerCase())
}

/** Jump table: per-language definition extractors (global, lastIndex reset per use). */
const EXTRACTORS = {
  js: [
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  ],
  ts: [
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum|type|namespace)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  ],
  py: [/(?:^|\n)\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/g],
  go: [/(?:^|\n)\s*(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g],
  rs: [
    /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|union|type|const|static|mod)\s+([A-Za-z_]\w*)/g,
    /(?:^|\n)\s*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/g,
  ],
  java: [/(?:^|\n|\s)(?:public|private|protected|abstract|final|sealed|static|\s)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g],
  kt: [/(?:^|\n)\s*(?:(?:public|private|internal|protected|open|abstract|sealed|data|inline|suspend)\s+)*(?:class|interface|object|fun)\s+([A-Za-z_]\w*)/g],
  cs: [/(?:^|\n)\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly)\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/g],
  c: [/(?:^|\n)\s*(?:static\s+|inline\s+|const\s+|unsigned\s+|struct\s+|enum\s+|typedef\s+)*[A-Za-z_][\w\s*]*\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/g],
  cpp: [/(?:^|\n)\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|enum|namespace)\s+([A-Za-z_]\w*)/g],
  rb: [/(?:^|\n)\s*(?:def|class|module)\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/g],
  php: [/(?:^|\n)\s*(?:(?:abstract|final|public|private|protected|static)\s+)*(?:class|interface|trait|function)\s+([A-Za-z_]\w*)/g],
  swift: [/(?:^|\n)\s*(?:(?:public|private|internal|open|final|static|class)\s+)*(?:class|struct|enum|protocol|func|extension)\s+([A-Za-z_]\w*)/g],
  lua: [/(?:^|\n)\s*(?:local\s+)?function\s+([A-Za-z_]\w*)/g],
  sh: [/(?:^|\n)\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/g],
  ps1: [/(?:^|\n)\s*function\s+([A-Za-z0-9_-]+)/g],
  sql: [/(?:^|\n)\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure)\s+([A-Za-z_]\w*)/gi],
}

/**
 * Extract unique definition names from one source file.
 * Bounded by MAX_EXTRACTED_SYMBOLS so a generated file cannot stall a call.
 * @param text - file text.
 * @param language - language id from LANGUAGES.
 * @returns definition names in first-seen order.
 */
export function extractSymbols(text, language) {
  const languageExtractors = EXTRACTORS[language]
  if (languageExtractors === undefined) return []
  const source = String(text ?? '')
  if (source.length === 0) return []
  const names = new Set()
  for (const pattern of languageExtractors) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1]
      if (typeof name === 'string' && name.length > 0 && name.length <= 80) names.add(name)
      if (names.size >= MAX_EXTRACTED_SYMBOLS) break
    }
    if (names.size >= MAX_EXTRACTED_SYMBOLS) break
  }
  return Array.from(names)
}

/** Identifier token pattern; also used for the one-pass reference index. */
const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g

/**
 * Build the per-file token index ONCE: identifier -> occurrence count.
 * The ranker only does Map lookups against this, never full-text scans.
 * @param text - file text.
 * @returns Map of identifier to count (bounded by MAX_TOKEN_INDEX_PER_FILE).
 */
export function tokenizeIdentifiers(text) {
  const source = String(text ?? '')
  const counts = new Map()
  if (source.length === 0) return counts
  IDENTIFIER_PATTERN.lastIndex = 0
  let match
  while ((match = IDENTIFIER_PATTERN.exec(source)) !== null) {
    const token = match[0]
    if (token.length < 2 || token.length > 64) continue
    const previous = counts.get(token)
    if (previous === undefined) {
      if (counts.size >= MAX_TOKEN_INDEX_PER_FILE) continue
      counts.set(token, 1)
    } else {
      counts.set(token, previous + 1)
    }
  }
  return counts
}

/** Normalise a Map or a JSON object of identifier counts into entries. */
export function tokenEntries(tokens) {
  if (tokens instanceof Map) return tokens.entries()
  if (tokens !== null && typeof tokens === 'object') return Object.entries(tokens)
  return []
}

/** One identifier's count inside a Map or plain object token index. */
export function tokenCount(tokens, name) {
  if (tokens instanceof Map) return tokens.get(name) ?? 0
  if (tokens !== null && typeof tokens === 'object' && Object.prototype.hasOwnProperty.call(tokens, name)) {
    const value = tokens[name]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  return 0
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return Math.floor(Number(fallback) || 0)
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * Merge one config row section with the defaults and clamp every limit.
 * Callers pass lib/defaults.js sectionDefaults() output; resolveConfig never
 * touches the host so tests can exercise it in a clean environment.
 * @param section - config?.repoMap (may be undefined).
 * @returns fully populated settings object.
 */
export function resolveConfig(section) {
  const raw = section !== null && typeof section === 'object' ? section : {}
  const defaults = DEFAULT_SETTINGS
  return {
    enabled: raw.enabled === undefined ? defaults.enabled !== false : raw.enabled !== false,
    maxFiles: clampInteger(raw.maxFiles, defaults.maxFiles, 10, 20000),
    maxFileBytes: clampInteger(raw.maxFileBytes, defaults.maxFileBytes, 1024, 2000000),
    tokenBudget: clampInteger(raw.tokenBudget, defaults.tokenBudget, 200, 20000),
    cacheTtlMs: clampInteger(raw.cacheTtlMs, defaults.cacheTtlMs, 0, 3600000),
    timeBudgetMs: clampInteger(raw.timeBudgetMs, defaults.timeBudgetMs, 1000, 120000),
    incremental: raw.incremental === undefined ? defaults.incremental !== false : raw.incremental !== false,
    personalize: raw.personalize === undefined ? defaults.personalize !== false : raw.personalize !== false,
  }
}

// ---------------------------------------------------------------------------
// Workspace containment (pure string logic; the caller supplies realpaths)
// ---------------------------------------------------------------------------

/** Replace backslashes so one comparison works for Windows and POSIX paths. */
export function normalizeSlashes(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** True for drive-rooted, UNC or POSIX-rooted absolute paths. */
export function isAbsolutePathLike(value) {
  const path = normalizeSlashes(value)
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path)
}

/** True when the path uses Windows/UNC syntax (case-insensitive comparisons). */
export function isWindowsStylePath(value) {
  const path = normalizeSlashes(value)
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//')
}

/**
 * Collapse '.', '..' and duplicate separators WITHOUT touching the disk.
 * @param value - any path string.
 * @returns { path, escaped } where escaped says a '..' walked above the root.
 */
export function normalizePath(value) {
  const raw = normalizeSlashes(value)
  if (raw.length === 0) return { path: '', escaped: false }
  let prefix = ''
  let rest = raw
  const drive = /^([A-Za-z]:)(?:\/|$)/.exec(raw)
  if (drive !== null) {
    prefix = drive[1] + '/'
    rest = raw.slice(drive[0].length)
  } else if (raw.startsWith('//')) {
    prefix = '//'
    rest = raw.slice(2)
  } else if (raw.startsWith('/')) {
    prefix = '/'
    rest = raw.slice(1)
  }
  const segments = []
  let escaped = false
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) escaped = true
      else segments.pop()
      continue
    }
    segments.push(segment)
  }
  let path
  if (prefix === '') path = segments.join('/')
  else if (prefix === '/') path = '/' + segments.join('/')
  else if (prefix === '//') path = '//' + segments.join('/')
  else path = prefix + segments.join('/')
  return { path, escaped }
}

/** Case-fold Windows-style paths so containment matches the filesystem. */
function comparablePath(value) {
  const normalized = normalizePath(value).path
  return isWindowsStylePath(normalized) ? normalized.toLowerCase() : normalized
}

/** True when target is the root or lives below it (string containment only). */
export function isPathInside(root, target) {
  const rootPath = comparablePath(root)
  const targetPath = comparablePath(target)
  if (rootPath.length === 0) return false
  if (targetPath === rootPath) return true
  const prefix = rootPath.endsWith('/') ? rootPath : rootPath + '/'
  return targetPath.startsWith(prefix)
}

/** Workspace-relative POSIX path, or undefined when outside the root. */
export function relativeWorkspacePath(root, target) {
  const rootNormalized = normalizePath(root).path
  const targetNormalized = normalizePath(target).path
  const rootPath = rootNormalized.replace(/\/+$/, '')
  if (!isPathInside(rootPath, targetNormalized)) return undefined
  const rootComparable = comparablePath(rootPath)
  const targetComparable = comparablePath(targetNormalized)
  if (targetComparable === rootComparable) return ''
  return targetNormalized.slice(rootPath.length + 1)
}

/** Absolute candidate for a model-supplied repo_map path (string only). */
export function resolveRequestedPath(root, requested) {
  const rootInfo = normalizePath(root)
  if (requested === undefined || requested === null || String(requested).trim() === '') return rootInfo.path
  const raw = String(requested).trim()
  if (isAbsolutePathLike(raw)) return normalizePath(raw).path
  const base = rootInfo.path.replace(/\/+$/, '')
  return normalizePath(base + '/' + raw).path
}

/** System locations that are never mapped, even if a workspace contains them. */
const WINDOWS_SYSTEM_PREFIXES = [
  'c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata',
  'c:/system volume information', 'c:/recovery', 'c:/$recycle.bin', 'c:/bootmgr',
]
const POSIX_SYSTEM_PREFIXES = [
  '/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/usr', '/bin', '/sbin',
  '/lib', '/lib64', '/opt', '/srv', '/var', '/run',
]

/** True for protected system locations (defence in depth on top of containment). */
export function isDeniedSystemPath(value) {
  const normalized = normalizePath(value).path
  if (normalized.length === 0) return false
  if (isWindowsStylePath(normalized)) {
    const lower = normalized.toLowerCase()
    return WINDOWS_SYSTEM_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix + '/'))
  }
  const lower = normalized.toLowerCase()
  return POSIX_SYSTEM_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix + '/'))
}

function deny(code, message) {
  return { ok: false, code, message }
}

/**
 * Decide whether a resolved path may be mapped. The caller must pass REAL
 * paths (after fs.realpath) as realRoot/realTarget so symlink escapes are
 * caught here; string-only containment still rejects ../ and foreign drives.
 * @param input - { root, target, realRoot?, realTarget? }.
 * @returns { ok: true, relative, root, target } or { ok: false, code, message }.
 */
export function classifyWorkspacePath(input) {
  const root = String(input?.root ?? '')
  const target = String(input?.target ?? '')
  if (root.length === 0 || target.length === 0) return deny('invalid-path', 'repo_map needs a non-empty workspace root and target path')
  if (root.includes('\u0000') || target.includes('\u0000')) return deny('invalid-path', 'repo_map path contains a NUL byte')
  const rootInfo = normalizePath(root)
  const targetInfo = normalizePath(target)
  if (rootInfo.escaped) return deny('invalid-path', 'repo_map workspace root "' + root + '" escapes its own root')
  if (targetInfo.escaped) return deny('outside-workspace', 'path "' + target + '" escapes the workspace "' + root + '"')
  if (!isAbsolutePathLike(targetInfo.path)) return deny('invalid-path', 'path "' + target + '" is not an absolute path (resolve it against the workspace first)')
  // An explicit workspace inside a system prefix (e.g. /usr/local/src/app) is
  // honoured; otherwise the system denylist would make the tool unusable there.
  if (isDeniedSystemPath(rootInfo.path) !== true && isDeniedSystemPath(targetInfo.path)) {
    return deny('system-path', 'path "' + targetInfo.path + '" points at a protected system location and is never mapped')
  }
  if (!isPathInside(rootInfo.path, targetInfo.path)) {
    return deny('outside-workspace', 'path "' + targetInfo.path + '" is outside the workspace "' + rootInfo.path + '" (relative paths are resolved against the workspace; absolute paths must stay inside it)')
  }
  const realRoot = typeof input?.realRoot === 'string' ? input.realRoot : undefined
  const realTarget = typeof input?.realTarget === 'string' ? input.realTarget : undefined
  if (realRoot !== undefined && realTarget !== undefined && realRoot.length > 0 && realTarget.length > 0) {
    const realRootInfo = normalizePath(realRoot)
    const realTargetInfo = normalizePath(realTarget)
    if (realTargetInfo.escaped || !isPathInside(realRootInfo.path, realTargetInfo.path)) {
      return deny('symlink-escape', 'path "' + targetInfo.path + '" resolves through a symbolic link to "' + realTargetInfo.path + '", which is outside the workspace "' + realRootInfo.path + '"')
    }
  }
  const relative = relativeWorkspacePath(rootInfo.path, targetInfo.path)
  return { ok: true, relative: relative === undefined ? '' : relative, root: rootInfo.path, target: targetInfo.path }
}

// ---------------------------------------------------------------------------
// Conversation file hints (Aider personalization input)
// ---------------------------------------------------------------------------

const HINT_EXTENSIONS = new Set([
  ...Array.from(LANGUAGES.keys()).map((extension) => extension.slice(1)),
  'md', 'mdx', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'html', 'htm',
  'css', 'scss', 'less', 'txt', 'cfg', 'conf', 'xml', 'csv', 'sql', 'proto',
])

const PATH_HINT_PATTERN = /(?:[A-Za-z]:[\\/][^\s"'\x60<>|*?]+|(?:\.{1,2}[\\/])?[A-Za-z0-9_.@+-]+(?:[\\/][A-Za-z0-9_.@+-]+)*\.[A-Za-z0-9]{1,8})/g

function trimHintPunctuation(value) {
  return String(value ?? '').replace(/^[\s"'(\[]+/u, '').replace(/[\s"')\]},;:]+$/u, '')
}

/**
 * Extract path-like hints from one message or tool-argument string.
 * Bounded so a pasted log cannot explode the personalization store.
 * @param text - free text.
 * @returns candidate path strings (not yet workspace-verified).
 */
export function extractPathHints(text) {
  const source = String(text ?? '')
  if (source.length === 0) return []
  const hints = []
  const seen = new Set()
  PATH_HINT_PATTERN.lastIndex = 0
  let match
  while ((match = PATH_HINT_PATTERN.exec(source)) !== null) {
    const before = source[match.index - 1]
    if (before === ':' || before === '/') continue
    const hint = trimHintPunctuation(match[0])
    if (hint.length === 0 || hint.length > 300) continue
    if (hint.includes('://')) continue
    if (seen.has(hint)) continue
    const dot = hint.lastIndexOf('.')
    if (dot < 0) continue
    const extension = hint.slice(dot + 1).toLowerCase()
    if (!HINT_EXTENSIONS.has(extension)) continue
    seen.add(hint)
    hints.push(hint)
    if (hints.length >= 16) break
  }
  return hints
}

/** Strip decorators from a hint and reject traversal; returns a relative path. */
export function normalizeChatHint(hint) {
  let value = trimHintPunctuation(hint)
  if (value.length === 0) return undefined
  value = normalizeSlashes(value)
  if (value.includes('\u0000')) return undefined
  const info = normalizePath(value)
  if (info.escaped) return undefined
  if (isAbsolutePathLike(info.path)) return info.path
  return info.path.replace(/^\.\//, '')
}

/**
 * Map conversation hints onto scanned files. Exact workspace-relative paths
 * win; a bare file name matches by basename (models often mention just the
 * file name). Never matches outside the scanned set.
 * @param files - scanned records with .path.
 * @param hints - relative hint strings.
 * @param options - { limit }.
 * @returns Set of matched record paths.
 */
export function matchChatFiles(files, hints, options = {}) {
  const records = Array.isArray(files) ? files : []
  const limit = clampInteger(options.limit, MAX_CHAT_FILES, 1, 200)
  const exact = new Set(records.map((file) => file.path))
  const byBaseName = new Map()
  for (const file of records) {
    const slash = file.path.lastIndexOf('/')
    const base = slash < 0 ? file.path : file.path.slice(slash + 1)
    const list = byBaseName.get(base)
    if (list === undefined) byBaseName.set(base, [file.path])
    else list.push(file.path)
  }
  const matched = new Set()
  for (const rawHint of Array.isArray(hints) ? hints : []) {
    const hint = normalizeChatHint(rawHint)
    if (hint === undefined || hint.length === 0) continue
    if (exact.has(hint)) {
      matched.add(hint)
    } else if (!hint.includes('/')) {
      const list = byBaseName.get(hint)
      if (list !== undefined) for (const path of list) matched.add(path)
    }
    if (matched.size >= limit) break
  }
  return new Set(Array.from(matched).slice(0, limit))
}

// ---------------------------------------------------------------------------
// Persisted index (pure serialise/parse; the caller owns fs)
// ---------------------------------------------------------------------------

function tokenObject(tokens) {
  const out = Object.create(null)
  for (const [name, count] of tokenEntries(tokens)) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) continue
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue
    out[name] = count
  }
  return out
}

function isSafeIndexPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return false
  if (value.includes('\u0000')) return false
  const normalized = normalizeSlashes(value)
  if (isAbsolutePathLike(normalized)) return false
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

function indexRootMatches(left, right) {
  const leftPath = normalizePath(left).path
  const rightPath = normalizePath(right).path
  if (isWindowsStylePath(leftPath) || isWindowsStylePath(rightPath)) return leftPath.toLowerCase() === rightPath.toLowerCase()
  return leftPath === rightPath
}

/**
 * Serialise one symbol index for .dsh/workflow-boost/repomap-index.json.
 * Per-file records keep mtimeMs+size so the next call can reuse unchanged
 * files without reading them, and the token index so ranking stays one-pass.
 * @param root - real workspace root.
 * @param files - scanned records ({ path, language, mtimeMs, size, symbols, tokens }).
 * @returns JSON text.
 */
export function serializeIndex(root, files) {
  const records = Array.isArray(files) ? files : []
  return JSON.stringify({
    version: INDEX_VERSION,
    root: normalizePath(root).path,
    savedAt: Date.now(),
    files: records.map((file) => ({
      path: file.path,
      language: typeof file.language === 'string' ? file.language : '',
      mtimeMs: typeof file.mtimeMs === 'number' && Number.isFinite(file.mtimeMs) ? file.mtimeMs : 0,
      size: typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0 ? file.size : 0,
      symbols: Array.isArray(file.symbols) ? file.symbols.slice(0, MAX_EXTRACTED_SYMBOLS) : [],
      tokens: tokenObject(file.tokens),
    })),
  })
}

/**
 * Parse a persisted index, discarding it on ANY corruption or boundary
 * violation (wrong schema version, wrong root, unsafe path, bad record).
 * @param text - file text.
 * @param expectedRoot - real workspace root the index must belong to.
 * @returns { root, savedAt, files } or undefined when the cache must be dropped.
 */
export function parseIndex(text, expectedRoot) {
  let data
  try {
    data = JSON.parse(String(text ?? ''))
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object') return undefined
  if (data.version !== INDEX_VERSION) return undefined
  if (typeof data.root !== 'string' || !indexRootMatches(data.root, expectedRoot)) return undefined
  if (!Array.isArray(data.files) || data.files.length > MAX_INDEX_FILES) return undefined
  const files = []
  for (const entry of data.files) {
    if (entry === null || typeof entry !== 'object') return undefined
    if (!isSafeIndexPath(entry.path)) return undefined
    const symbols = Array.isArray(entry.symbols) ? entry.symbols : []
    if (symbols.length > MAX_EXTRACTED_SYMBOLS) return undefined
    for (const symbol of symbols) {
      if (typeof symbol !== 'string' || symbol.length === 0 || symbol.length > 80) return undefined
    }
    const mtimeMs = Number(entry.mtimeMs)
    const size = Number(entry.size)
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return undefined
    if (!Number.isFinite(size) || size < 0) return undefined
    const tokens = Object.create(null)
    if (entry.tokens !== null && typeof entry.tokens === 'object' && !Array.isArray(entry.tokens)) {
      for (const name of Object.keys(entry.tokens)) {
        const count = entry.tokens[name]
        if (typeof name !== 'string' || name.length === 0 || name.length > 64) return undefined
        if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return undefined
        tokens[name] = count
      }
    }
    files.push({
      path: normalizeSlashes(entry.path),
      language: typeof entry.language === 'string' ? entry.language : '',
      mtimeMs,
      size,
      symbols: symbols.slice(),
      tokens,
    })
  }
  return { root: normalizePath(data.root).path, savedAt: Number(data.savedAt) || 0, files }
}

// ---------------------------------------------------------------------------
// Ranking: references are counted from the one-pass per-file token index
// ---------------------------------------------------------------------------

function pastDeadline(deadline) {
  return typeof deadline === 'number' && Number.isFinite(deadline) && Date.now() > deadline
}

function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

function createGraph(files, options) {
  return {
    files,
    nodes: files.map((file) => file.path),
    definitions: new Map(),
    edges: new Map(),
    refs: new Map(),
    selfLoops: new Map(),
    weights: new Map(),
    truncated: false,
    symbolsAdded: 0,
    edgePairs: 0,
    maxSymbols: clampInteger(options.maxSymbols, MAX_RANK_SYMBOLS, 1, MAX_RANK_SYMBOLS),
    maxEdges: clampInteger(options.maxEdges, MAX_RANK_EDGES, 1, MAX_RANK_EDGES),
    maxTokensPerFile: clampInteger(options.maxTokensPerFile, MAX_RANK_TOKENS_PER_FILE, 1, MAX_TOKEN_INDEX_PER_FILE),
  }
}

function addDefinitions(graph, start, end) {
  for (let index = start; index < end; index += 1) {
    const file = graph.files[index]
    const symbols = Array.isArray(file.symbols) ? file.symbols : []
    for (const symbol of symbols) {
      if (graph.symbolsAdded >= graph.maxSymbols) {
        graph.truncated = true
        return
      }
      graph.symbolsAdded += 1
      const existing = graph.definitions.get(symbol)
      if (existing === undefined) graph.definitions.set(symbol, [index])
      else existing.push(index)
    }
  }
}

function addEdges(graph, start, end) {
  for (let index = start; index < end; index += 1) {
    const file = graph.files[index]
    let considered = 0
    for (const [name, count] of tokenEntries(file.tokens)) {
      considered += 1
      if (considered > graph.maxTokensPerFile) break
      if (typeof name !== 'string' || typeof count !== 'number' || count <= 0) continue
      const definers = graph.definitions.get(name)
      if (definers === undefined) continue
      for (const targetIndex of definers) {
        if (targetIndex === index) continue
        if (graph.edgePairs >= graph.maxEdges) {
          graph.truncated = true
          return
        }
        let row = graph.edges.get(index)
        if (row === undefined) {
          row = new Map()
          graph.edges.set(index, row)
        }
        const previous = row.get(targetIndex)
        if (previous === undefined) {
          graph.edgePairs += 1
          row.set(targetIndex, count)
        } else {
          row.set(targetIndex, previous + count)
        }
        graph.refs.set(name, (graph.refs.get(name) ?? 0) + count)
      }
    }
  }
}

function finishGraph(graph) {
  // Self loops stay metadata only: feeding a 0.1 self-loop into PageRank makes a
  // node non-dangling, and after dangling redistribution it then outranks files
  // that are genuinely referenced. The ranker applies a small multiplicative
  // visibility bump instead (Aider's intent: unreferenced definitions stay
  // visible, not dominant).
  const weights = new Map()
  for (const [from, row] of graph.edges) {
    const damped = new Map()
    for (const [to, count] of row) damped.set(to, Math.sqrt(count))
    weights.set(from, damped)
  }
  for (const [name, definers] of graph.definitions) {
    if ((graph.refs.get(name) ?? 0) > 0) continue
    for (const index of definers) {
      const path = graph.nodes[index]
      graph.selfLoops.set(path, (graph.selfLoops.get(path) ?? 0) + UNREFERENCED_SELF_WEIGHT)
    }
  }
  graph.weights = weights
  return graph
}

/**
 * Build the file graph the ranker scores. Pure and synchronous.
 * Edge weight is sqrt(reference count) so repeated mentions are damped
 * (Aider-style); a definition no other file references gets a 0.1 self loop.
 * @param files - records with symbols and token index.
 * @param options - { maxSymbols, maxEdges, maxTokensPerFile }.
 * @returns graph with nodes/definitions/refs/weights/selfLoops.
 */
export function buildRankGraph(files, options = {}) {
  const list = Array.isArray(files) ? files : []
  const graph = createGraph(list, options)
  addDefinitions(graph, 0, list.length)
  addEdges(graph, 0, list.length)
  return finishGraph(graph)
}

/**
 * Async graph build used by the tool: definitions and edges are processed in
 * slices and yield with setImmediate so one repo_map call cannot monopolise the
 * event loop; a wall-clock deadline stops early and marks the result partial.
 * @returns { graph, incomplete }.
 */
async function buildRankGraphAsync(files, options = {}) {
  const list = Array.isArray(files) ? files : []
  const graph = createGraph(list, options)
  const deadline = typeof options.deadline === 'number' && Number.isFinite(options.deadline) ? options.deadline : undefined
  const slice = clampInteger(options.slice, 150, 10, 1000)
  let incomplete = false
  for (let start = 0; start < list.length; start += slice) {
    if (pastDeadline(deadline)) {
      incomplete = true
      break
    }
    addDefinitions(graph, start, Math.min(list.length, start + slice))
    await yieldToLoop()
  }
  if (!incomplete) {
    for (let start = 0; start < list.length; start += slice) {
      if (pastDeadline(deadline)) {
        incomplete = true
        break
      }
      addEdges(graph, start, Math.min(list.length, start + slice))
      await yieldToLoop()
    }
  }
  return { graph: finishGraph(graph), incomplete: incomplete || graph.truncated }
}

function pageRank(graph, options = {}) {
  const size = graph.nodes.length
  if (size === 0) return []
  const chatFiles = options.chatFiles instanceof Set ? options.chatFiles : new Set()
  const personalize = options.personalize !== false
  const damping = PAGERANK_DAMPING
  const iterations = PAGERANK_ITERATIONS
  let scores = new Float64Array(size)
  scores.fill(1 / size)
  const outWeight = new Float64Array(size)
  for (let index = 0; index < size; index += 1) {
    const row = graph.weights.get(index)
    if (row === undefined) continue
    let sum = 0
    for (const weight of row.values()) sum += weight
    outWeight[index] = sum
  }
  const personalization = new Float64Array(size)
  let chatCount = 0
  if (personalize) {
    for (let index = 0; index < size; index += 1) {
      if (chatFiles.has(graph.nodes[index])) {
        personalization[index] = 1
        chatCount += 1
      }
    }
  }
  if (chatCount === 0) personalization.fill(1 / size)
  else for (let index = 0; index < size; index += 1) personalization[index] /= chatCount
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Float64Array(size)
    let dangling = 0
    for (let index = 0; index < size; index += 1) {
      if (outWeight[index] === 0) {
        dangling += scores[index]
        continue
      }
      const row = graph.weights.get(index)
      const share = scores[index] / outWeight[index]
      for (const [target, weight] of row) next[target] += share * weight
    }
    for (let index = 0; index < size; index += 1) {
      next[index] = (1 - damping) * personalization[index] + damping * (next[index] + dangling * personalization[index])
    }
    scores = next
  }
  return scores
}

function rankGraph(graph, files, options = {}) {
  const scores = pageRank(graph, options)
  const chatFiles = options.chatFiles instanceof Set ? options.chatFiles : new Set()
  const personalize = options.personalize !== false
  const boost = personalize ? CHAT_SCORE_BOOST : 0
  const ranked = files.map((file, index) => {
    let refs = 0
    for (const symbol of Array.isArray(file.symbols) ? file.symbols : []) refs += graph.refs.get(symbol) ?? 0
    const isChat = chatFiles.has(file.path)
    return {
      path: file.path,
      language: file.language,
      symbols: Array.isArray(file.symbols) ? file.symbols.slice() : [],
      // Multiplicative so 0.1 stays a visibility bump at any repo size; an
      // additive bonus would let unreferenced files outrank referenced hubs.
      score: (scores[index] ?? 0) * (1 + Math.min(graph.selfLoops.get(file.path) ?? 0, UNREFERENCED_SELF_WEIGHT)) + (isChat ? boost : 0),
      refs,
      chat: isChat,
    }
  })
  ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  return ranked
}

/**
 * Rank scanned files by personalised PageRank over definition references.
 * @param files - records with symbols + token index.
 * @param options - { chatFiles, personalize }.
 * @returns ranked array [{ path, symbols, score, refs, chat }].
 */
export function rankFiles(files, options = {}) {
  const list = Array.isArray(files) ? files : []
  const graph = buildRankGraph(list, options)
  return rankGraph(graph, list, options)
}

/**
 * Async ranking used by the tool: same ordering as rankFiles but chunked with
 * setImmediate yields and a deadline; on timeout the partial ranking is returned
 * with incomplete=true so the renderer can annotate it.
 * @returns { ranked, incomplete }.
 */
export async function rankFilesAsync(files, options = {}) {
  const list = Array.isArray(files) ? files : []
  const built = await buildRankGraphAsync(list, options)
  return { ranked: rankGraph(built.graph, list, options), incomplete: built.incomplete }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the map body (no header/footer) under a token budget.
 * @param ranked - rankFiles output.
 * @param options - { budget, focus, maxSymbolsPerFile }.
 * @returns { lines, shown, omitted, usedTokens }.
 */
export function renderMap(ranked, options = {}) {
  const list = Array.isArray(ranked) ? ranked : []
  const budget = Number.isFinite(Number(options.budget)) ? Math.max(0, Math.floor(Number(options.budget))) : undefined
  const focus = typeof options.focus === 'string' && options.focus.trim().length > 0 ? options.focus.trim().toLowerCase() : undefined
  const maxSymbols = clampInteger(options.maxSymbolsPerFile, MAX_SYMBOLS_PER_FILE, 1, 50)
  const lines = []
  let usedTokens = 0
  let shown = 0
  let omitted = 0
  for (const file of list) {
    if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue
    const allSymbols = Array.isArray(file.symbols) ? file.symbols : []
    const pathMatchesFocus = focus !== undefined && file.path.toLowerCase().includes(focus)
    let symbols = allSymbols
    if (focus !== undefined && !pathMatchesFocus) symbols = allSymbols.filter((symbol) => String(symbol).toLowerCase().includes(focus))
    if (symbols.length === 0) {
      omitted += 1
      continue
    }
    const displayed = symbols.slice(0, maxSymbols)
    const line = file.path + ' \u2014 ' + displayed.join(', ') + (symbols.length > displayed.length ? ' \u2026' : '')
    const cost = estimateTokens(line) + 1
    if (budget !== undefined && usedTokens + cost > budget) {
      omitted += 1
      continue
    }
    usedTokens += cost
    lines.push(line)
    shown += 1
  }
  return { lines, shown, omitted, usedTokens }
}

/**
 * Effective token budget. With no conversation files the map has no focus, so
 * Aider-style personalization widens the budget instead of narrowing the map.
 * @param tokenBudget - configured budget.
 * @param options - { hasChatFiles, personalize }.
 * @returns clamped budget.
 */
export function effectiveBudget(tokenBudget, options = {}) {
  const base = clampInteger(tokenBudget, DEFAULT_SETTINGS.tokenBudget, 50, 20000)
  const personalize = options.personalize !== false
  if (personalize && options.hasChatFiles !== true) return Math.min(MAX_EFFECTIVE_BUDGET, Math.round(base * NO_CHAT_BUDGET_MULTIPLIER))
  return base
}

/**
 * Compose the final tool text: header, ranked body, omission and incomplete
 * footers, then truncate to the token budget.
 * @param input - { root, ranked, totalFiles, totalSymbols, budget, focus, incomplete, personalized }.
 * @returns { text, shown, omitted, usedTokens, truncated }.
 */
export function renderMapText(input = {}) {
  const requestedBudget = Number(input.budget)
  const budget = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.floor(requestedBudget) : DEFAULT_SETTINGS.tokenBudget
  const bodyBudget = Math.max(40, budget - HEADER_RESERVE_TOKENS)
  const ranked = Array.isArray(input.ranked) ? input.ranked : []
  const body = renderMap(ranked, { budget: bodyBudget, focus: input.focus })
  const totalFiles = Number.isFinite(Number(input.totalFiles)) ? Number(input.totalFiles) : ranked.length
  const totalSymbols = Number.isFinite(Number(input.totalSymbols))
    ? Number(input.totalSymbols)
    : ranked.reduce((sum, file) => sum + (Array.isArray(file.symbols) ? file.symbols.length : 0), 0)
  const header = ['Repository map: ' + totalFiles + ' source files scanned, ' + body.shown + ' shown (' + totalSymbols +
    ' definitions, ranked by cross-file references' + (input.personalized === true ? ', personalized by conversation files' : '') + ').']
  if (typeof input.root === 'string' && input.root.length > 0) header.push('Workspace: ' + input.root)
  if (typeof input.focus === 'string' && input.focus.trim().length > 0) header.push('Focus filter: ' + JSON.stringify(input.focus.trim()) + '.')
  const parts = [header.join('\n')]
  if (body.lines.length > 0) parts.push(body.lines.join('\n'))
  else parts.push('(no source files with recognisable definitions were mapped; use fs/glob/grep to inspect the tree directly.)')
  if (body.omitted > 0) {
    parts.push('(' + body.omitted + ' lower-importance file(s) omitted; pass focus or raise the token budget to narrow the map.)')
  }
  const incomplete = Array.isArray(input.incomplete) ? input.incomplete.filter((note) => typeof note === 'string' && note.length > 0) : []
  if (incomplete.length > 0) {
    parts.push('(incomplete: ' + incomplete.join('; ') + '. Partial results - narrow with focus or raise repoMap.timeBudgetMs.)')
  }
  const fullText = parts.join('\n')
  const text = truncateToTokenBudget(fullText, budget)
  return { text, shown: body.shown, omitted: body.omitted, usedTokens: body.usedTokens, truncated: text.length !== fullText.length }
}
