/**
 * checkpoint pure core — path policy, retention planning, diff rendering, and
 * restore selection for lib/checkpoint.js.
 *
 * Everything here is filesystem-free: callers pass already-read manifests and
 * byte counts, so a clean Node process can test the dangerous policy parts
 * (what may be snapshotted, what must be pruned, which backup wins on restore)
 * without a host, a workspace, or real files.
 *
 * Nothing here imports @deepseek-ai/*.
 */

/** Manifest format version written into every manifest.json. */
export const MANIFEST_VERSION = 1

/** Directory names that are never checkpointed, at any depth. */
export const SKIP_SEGMENTS = Object.freeze([
  '.git', 'node_modules', 'dist', 'build', 'out', '.dsh',
  '.hg', '.svn', '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__',
])

/** Root folder (relative to the workspace) that owns snapshots. */
export const CHECKPOINT_DIR = '.dsh/workflow-boost/checkpoints'

/** Normalize a host path to forward slashes without resolving it. */
export function toPosixPath(value) {
  return String(value ?? '').replace(/\\/gu, '/')
}

/** Resolve '.' and '..' segments lexically. */
export function normalizeSegments(path) {
  const source = toPosixPath(path)
  const drive = /^([A-Za-z]):/u.exec(source)
  const prefix = drive === null ? (source.startsWith('/') ? '/' : '') : drive[1] + ':'
  const body = drive === null ? source.slice(prefix.length) : source.slice(2)
  const segments = []
  for (const segment of body.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') { if (segments.length > 0) segments.pop(); continue }
    segments.push(segment)
  }
  return prefix + '/' + segments.join('/')
}

/** Case-normalized comparison form for containment checks. */
function comparable(value) {
  const posix = toPosixPath(value).replace(/\/+$/u, '')
  return /^[A-Za-z]:/u.test(posix) ? posix.toLowerCase() : posix
}

/** Whether an absolute path is the workspace itself or lives below it. */
export function isInsideWorkspace(workspace, filePath) {
  const root = comparable(workspace)
  const target = comparable(filePath)
  if (root.length === 0 || target.length === 0) return false
  return root === target || target.startsWith(root + '/')
}

/** Absolute checkpoint root for one workspace (posix separators; Node accepts them on Windows). */
export function checkpointRoot(workspace) {
  return toPosixPath(workspace).replace(/\/+$/u, '') + '/' + CHECKPOINT_DIR
}

/** True when the relative path lives under a skipped directory at any depth. */
export function shouldSkipCheckpointPath(relativePath) {
  const source = toPosixPath(relativePath).replace(/^\.\//u, '')
  if (source.length === 0) return true
  for (const segment of source.split('/')) {
    if (segment.length === 0) continue
    const lowered = segment.toLowerCase()
    if (SKIP_SEGMENTS.includes(lowered)) return true
    if (lowered.startsWith('.git')) return true
  }
  return false
}

/**
 * Decide whether one candidate file may be snapshotted, using lexical policy only.
 * Byte-size and symlink checks need lstat and belong to the runtime.
 * @returns ok:true with relativePath/absolutePath, or ok:false with a reason.
 */
export function classifyCheckpointTarget(workspace, filePath) {
  if (typeof workspace !== 'string' || workspace.trim().length === 0) return { ok: false, reason: 'no-workspace' }
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return { ok: false, reason: 'no-path' }
  const raw = filePath.trim()
  const absolute = raw.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(raw) || raw.startsWith('\\\\')
  const resolved = absolute ? normalizeSegments(raw) : normalizeSegments(toPosixPath(workspace) + '/' + raw)
  if (!isInsideWorkspace(workspace, resolved)) return { ok: false, reason: 'outside-workspace' }
  const root = toPosixPath(workspace).replace(/\/+$/u, '')
  const target = resolved.replace(/\/+$/u, '')
  const relative = target === root ? '' : target.slice(root.length + 1)
  if (relative.length === 0) return { ok: false, reason: 'workspace-root' }
  if (shouldSkipCheckpointPath(relative)) return { ok: false, reason: 'skipped-path' }
  return { ok: true, relativePath: relative, absolutePath: target }
}

/** Sanitize one path segment used inside the checkpoint tree. */
export function sanitizeSegment(value, maxLength = 80) {
  const source = String(value ?? '').replace(/[^A-Za-z0-9._-]/gu, '_')
  const trimmed = source.length > maxLength ? source.slice(0, maxLength) : source
  if (trimmed.length === 0) return 'unknown'
  if (trimmed === '.' || trimmed === '..') return '_'
  return trimmed
}

/** Canonical id for one snapshot point: '<turn>/<seq>'. */
export function checkpointId(turn, seq) {
  return String(Math.max(0, Math.floor(Number(turn) || 0))) + '/' + String(Math.max(1, Math.floor(Number(seq) || 1)))
}

/** Parse '3/2' (or '3:2') into { turn, seq }, or undefined when malformed. */
export function parseCheckpointId(value) {
  const match = /^\s*(\d+)\s*[/:]\s*(\d+)\s*$/u.exec(String(value ?? ''))
  if (match === null) return undefined
  return { turn: Number(match[1]), seq: Number(match[2]) }
}

/** Next free sequence number for a turn given the existing ones. */
export function nextSequence(existingSeqs) {
  let max = 0
  for (const value of Array.isArray(existingSeqs) ? existingSeqs : []) {
    const number = Math.floor(Number(value))
    if (Number.isFinite(number) && number > max) max = number
  }
  return max + 1
}

/** Sum the original byte sizes recorded in one manifest's file entries. */
export function manifestBytes(manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files : []
  let total = 0
  for (const file of files) {
    const size = Number(file?.size)
    if (Number.isFinite(size) && size > 0) total += size
  }
  return total
}

/** True when a parsed manifest has the shape this module can restore. */
export function isValidManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') return false
  if (manifest.version !== MANIFEST_VERSION) return false
  if (typeof manifest.sessionId !== 'string' || manifest.sessionId.length === 0) return false
  if (!Number.isFinite(Number(manifest.turn)) || !Number.isFinite(Number(manifest.seq))) return false
  return Array.isArray(manifest.files) && manifest.files.every((file) =>
    file !== null && typeof file === 'object' &&
    typeof file.path === 'string' && file.path.length > 0 &&
    (file.state === 'present' || file.state === 'absent'))
}

/**
 * Build the manifest object written next to the bytes.
 * @param input.sessionId - sanitized session segment.
 * @param input.turn - folded turn number.
 * @param input.seq - sequence within the turn.
 * @param input.intent - fs intent event name that triggered the snapshot.
 * @param input.tool - tool name from the actor, when known.
 * @param input.workspace - workspace root at snapshot time.
 * @param input.files - [{path, absolutePath, state, size, sha256, backup}].
 */
export function buildManifest(input) {
  const turn = Math.max(0, Math.floor(Number(input?.turn) || 0))
  const seq = Math.max(1, Math.floor(Number(input?.seq) || 1))
  return {
    version: MANIFEST_VERSION,
    id: checkpointId(turn, seq),
    sessionId: String(input?.sessionId ?? ''),
    turn,
    seq,
    createdAt: typeof input?.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    intent: String(input?.intent ?? ''),
    tool: String(input?.tool ?? ''),
    workspace: String(input?.workspace ?? ''),
    files: (Array.isArray(input?.files) ? input.files : []).map((file) => ({
      path: String(file?.path ?? ''),
      absolutePath: String(file?.absolutePath ?? ''),
      state: file?.state === 'absent' ? 'absent' : 'present',
      ...file?.state === 'absent' ? {} : {
        size: Math.max(0, Math.floor(Number(file?.size) || 0)),
        sha256: String(file?.sha256 ?? ''),
        backup: String(file?.backup ?? ''),
      },
    })),
  }
}

/**
 * Plan retention work. Pure: the caller executes the removals.
 *
 * Rules, in order:
 *  1. per session, keep only the newest keepTurns turn directories;
 *  2. across everything left, delete oldest snapshots until the total backup
 *     byte count fits maxTotalBytes (LRU by createdAt, then by turn/seq).
 * @param input.sessions - [{sessionId, turns: [{turn, checkpoints: [{seq, bytes, createdAt}]}]}]
 * @returns {removeTurns, removeCheckpoints, keptBytes, removedBytes}
 */
export function planRetention(input) {
  const sessions = Array.isArray(input?.sessions) ? input.sessions : []
  const keepTurns = Math.max(0, Math.floor(Number(input?.keepTurns) || 0))
  const maxTotalBytes = Math.max(0, Math.floor(Number(input?.maxTotalBytes) || 0))
  const removeTurns = []
  const removeCheckpoints = []
  const surviving = []
  for (const session of sessions) {
    const sessionId = String(session?.sessionId ?? '')
    const turns = (Array.isArray(session?.turns) ? session.turns : [])
      .map((turn) => ({ turn: Math.max(0, Math.floor(Number(turn?.turn) || 0)), checkpoints: Array.isArray(turn?.checkpoints) ? turn.checkpoints.slice() : [] }))
      .sort((left, right) => right.turn - left.turn)
    turns.forEach((turn, index) => {
      if (index < keepTurns) surviving.push({ sessionId, turn })
      else removeTurns.push({ sessionId, turn: turn.turn })
    })
  }
  const candidates = []
  for (const session of surviving) {
    for (const checkpoint of session.turn.checkpoints) {
      pushCandidate(candidates, session.sessionId, session.turn.turn, checkpoint)
    }
  }
  candidates.sort((left, right) => {
    const byTime = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
    if (byTime !== 0) return byTime
    if (left.turn !== right.turn) return left.turn - right.turn
    return left.seq - right.seq
  })
  let total = 0
  for (const candidate of candidates) total += candidate.bytes
  const removed = new Set(candidates.map((candidate) => candidate.key))
  for (const candidate of candidates) {
    if (total <= maxTotalBytes) break
    removed.delete(candidate.key)
    total -= candidate.bytes
    removeCheckpoints.push({ sessionId: candidate.sessionId, turn: candidate.turn, seq: candidate.seq })
  }
  return {
    removeTurns,
    removeCheckpoints,
    keptBytes: total,
    removedBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0) - total,
  }
}

/** Push one retention candidate with a stable identity key. */
function pushCandidate(list, sessionId, turn, checkpoint) {
  const seq = Math.max(1, Math.floor(Number(checkpoint?.seq) || 1))
  const bytes = Math.max(0, Math.floor(Number(checkpoint?.bytes) || 0))
  list.push({
    key: sessionId + '/' + turn + '/' + seq,
    sessionId,
    turn,
    seq,
    bytes,
    createdAt: typeof checkpoint?.createdAt === 'string' ? checkpoint.createdAt : '',
  })
}

/** Line-based LCS diff, bounded so a huge file cannot stall post-execute or a tool call. */
function diffLines(beforeLines, afterLines, limit) {
  const n = beforeLines.length
  const m = afterLines.length
  if (n * m > limit) return undefined
  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = beforeLines[i] === afterLines[j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && beforeLines[i] === afterLines[j]) {
      ops.push({ kind: 'equal', text: beforeLines[i] })
      i += 1
      j += 1
    } else if (j < m && (i >= n || table[i * width + (j + 1)] >= table[(i + 1) * width + j])) {
      ops.push({ kind: 'insert', text: afterLines[j] })
      j += 1
    } else {
      ops.push({ kind: 'delete', text: beforeLines[i] })
      i += 1
    }
  }
  return ops
}

/**
 * Render a bounded unified diff between two texts.
 * @param input.path - display path used in the ---/+++ headers.
 * @param input.before - old text, or null when the file did not exist.
 * @param input.after - new text, or null when the file was deleted.
 * @param input.context - unchanged lines around each hunk (default 2).
 * @param input.maxLines - hard cap on emitted diff lines (default 100).
 */
export function renderUnifiedDiff(input) {
  const path = String(input?.path ?? 'file')
  const before = input?.before === null || input?.before === undefined ? null : String(input.before)
  const after = input?.after === null || input?.after === undefined ? null : String(input.after)
  const context = Math.max(0, Math.min(6, Math.floor(Number(input?.context ?? 2) || 0)))
  const maxLines = Math.max(4, Math.min(400, Math.floor(Number(input?.maxLines ?? 100) || 100)))
  const beforeLines = before === null ? [] : before.replace(/\r\n/gu, '\n').split('\n')
  const afterLines = after === null ? [] : after.replace(/\r\n/gu, '\n').split('\n')
  const ops = diffLines(beforeLines, afterLines, 4000000)
  if (ops === undefined) return 'Diff for ' + path + ' is too large to render (files exceed the 2,000-line LCS budget).'
  // Build hunks: every run of non-equal ops plus 'context' equal lines around it.
  const changedAt = ops.map((op, index) => op.kind === 'equal' ? -1 : index).filter((index) => index >= 0)
  if (changedAt.length === 0) return 'No differences in ' + path + ' (the checkpoint content matches the current file).'
  const hunks = []
  let start = Math.max(0, changedAt[0] - context)
  let end = Math.min(ops.length, changedAt[0] + context + 1)
  for (const index of changedAt.slice(1)) {
    if (index - context <= end) end = Math.min(ops.length, index + context + 1)
    else {
      hunks.push([start, end])
      start = Math.max(0, index - context)
      end = Math.min(ops.length, index + context + 1)
    }
  }
  hunks.push([start, end])
  // Convert op indices into old/new line numbers.
  const oldAt = new Array(ops.length + 1).fill(0)
  const newAt = new Array(ops.length + 1).fill(0)
  for (let index = 0; index < ops.length; index += 1) {
    oldAt[index + 1] = oldAt[index] + (ops[index].kind === 'insert' ? 0 : 1)
    newAt[index + 1] = newAt[index] + (ops[index].kind === 'delete' ? 0 : 1)
  }
  const lines = ['--- a/' + path, '+++ b/' + path]
  let emitted = 0
  for (const [from, to] of hunks) {
    const oldCount = oldAt[to] - oldAt[from]
    const newCount = newAt[to] - newAt[from]
    lines.push('@@ -' + (oldAt[from] + 1) + ',' + oldCount + ' +' + (newAt[from] + 1) + ',' + newCount + ' @@')
    for (const op of ops.slice(from, to)) {
      if (emitted >= maxLines) break
      lines.push((op.kind === 'equal' ? ' ' : op.kind === 'insert' ? '+' : '-') + op.text)
      emitted += 1
    }
    if (emitted >= maxLines) break
  }
  if (emitted >= maxLines) lines.push('... diff truncated at ' + maxLines + ' lines ...')
  return lines.join('\n')
}

/** Human byte count for the checkpoint list (kept dependency-free). */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return Math.round(value) + ' B'
  if (value < 1048576) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1073741824) return (value / 1048576).toFixed(1) + ' MB'
  return (value / 1073741824).toFixed(2) + ' GB'
}

/**
 * Render the checkpoint list for one session.
 * @param input.sessionId - current session id (for the header).
 * @param input.entries - [{id, turn, seq, intent, tool, createdAt, bytes, files: [{path, state}]}]
 * @param input.limit - max snapshot lines rendered.
 */
export function renderCheckpointList(input) {
  const entries = Array.isArray(input?.entries) ? input.entries : []
  const limit = Math.max(1, Math.min(200, Math.floor(Number(input?.limit ?? 40) || 40)))
  const lines = []
  if (entries.length === 0) {
    lines.push('No file checkpoints recorded for this session yet. Checkpoints are created automatically before a file is written, edited or deleted.')
    return lines.join('\n')
  }
  const sorted = entries.slice().sort((left, right) => right.turn - left.turn || right.seq - left.seq)
  const totalBytes = sorted.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0)
  lines.push('File checkpoints for session ' + String(input?.sessionId ?? '?') + ': ' + sorted.length + ' snapshot(s), ' + formatBytes(totalBytes) + ' of backed-up bytes.')
  const shown = sorted.slice(0, limit)
  let lastTurn = -1
  for (const entry of shown) {
    if (entry.turn !== lastTurn) {
      lastTurn = entry.turn
      const turnBytes = sorted.filter((item) => item.turn === entry.turn).reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)
      const turnCount = sorted.filter((item) => item.turn === entry.turn).length
      lines.push('Turn ' + entry.turn + ': ' + turnCount + ' snapshot(s), ' + formatBytes(turnBytes))
    }
    const files = Array.isArray(entry.files) ? entry.files : []
    const summary = files.map((file) => (file.state === 'absent' ? '(absent) ' : '') + file.path).join(', ')
    lines.push('  ' + entry.id + '  ' + String(entry.intent ?? 'write') + (entry.tool ? '/' + entry.tool : '') + '  ' + summary + '  ' + formatBytes(entry.bytes) + (entry.createdAt ? '  ' + entry.createdAt : ''))
  }
  if (sorted.length > shown.length) lines.push('... ' + (sorted.length - shown.length) + ' older snapshot(s) not shown.')
  lines.push('Restore everything touched in the latest turn with checkpoint_restore({"latest": true}); inspect one snapshot with checkpoint_diff({"id": "turn/seq"}).')
  return lines.join('\n')
}

/** Case-insensitive path comparison form used for user-supplied path filters. */
function comparableRelative(value) {
  return toPosixPath(value).replace(/^\.\//u, '').replace(/\/+$/u, '').toLowerCase()
}

/** Whether a manifest file entry matches one of the requested paths (relative or absolute). */
function matchesFilter(file, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return true
  const relative = comparableRelative(file?.path)
  const absolute = comparableRelative(normalizeSegments(file?.absolutePath ?? ''))
  for (const filter of filters) {
    const candidate = comparableRelative(filter)
    if (candidate.length === 0) continue
    if (relative === candidate || absolute === candidate) return true
    if (relative.endsWith('/' + candidate)) return true
  }
  return false
}

/**
 * Pick what a restore call should put back.
 *
 * - explicit id -> exactly that snapshot point (optionally filtered by paths);
 * - otherwise -> the latest *turn*: for every path touched in that turn the
 *   OLDEST snapshot is chosen, i.e. the state before the turn began. That is
 *   what "undo the latest turn" means when a file was edited twice.
 * @param input.manifests - parsed manifests of this session, in any order.
 * @param input.id - optional '<turn>/<seq>' snapshot id.
 * @param input.paths - optional subset of paths to restore.
 * @returns ok:true with entries [{manifestId, file}], or ok:false with a reason.
 */
export function selectRestorePlan(input) {
  const manifests = (Array.isArray(input?.manifests) ? input.manifests : [])
    .filter((manifest) => manifest !== null && typeof manifest === 'object')
  const filters = Array.isArray(input?.paths) ? input.paths.filter((path) => typeof path === 'string' && path.trim().length > 0) : []
  if (manifests.length === 0) return { ok: false, reason: 'no-checkpoints' }
  const explicit = typeof input?.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : undefined
  if (explicit !== undefined) {
    const parsed = parseCheckpointId(explicit)
    const manifest = manifests.find((candidate) => candidate.id === explicit || (parsed !== undefined && Number(candidate.turn) === parsed.turn && Number(candidate.seq) === parsed.seq))
    if (manifest === undefined) return { ok: false, reason: 'snapshot-not-found', id: explicit }
    const entries = (Array.isArray(manifest.files) ? manifest.files : [])
      .filter((file) => matchesFilter(file, filters))
      .map((file) => ({ manifestId: manifest.id, file }))
    if (entries.length === 0) return { ok: false, reason: 'no-matching-paths', id: manifest.id }
    return { ok: true, mode: 'snapshot', id: manifest.id, entries }
  }
  let latestTurn = -1
  for (const manifest of manifests) {
    const turn = Number(manifest.turn)
    if (Number.isFinite(turn) && turn > latestTurn) latestTurn = turn
  }
  const inTurn = manifests
    .filter((manifest) => Number(manifest.turn) === latestTurn)
    .sort((left, right) => Number(left.seq) - Number(right.seq))
  const chosen = new Map()
  for (const manifest of inTurn) {
    for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
      if (!matchesFilter(file, filters)) continue
      if (chosen.has(comparableRelative(file.path))) continue
      chosen.set(comparableRelative(file.path), { manifestId: manifest.id, file })
    }
  }
  if (chosen.size === 0) return { ok: false, reason: 'no-matching-paths', id: checkpointId(latestTurn, 1) }
  return { ok: true, mode: 'turn', id: checkpointId(latestTurn, 1), turn: latestTurn, entries: [...chosen.values()] }
}

/**
 * Render the outcome of one restore.
 * @param input.id - snapshot or turn id shown in the header.
 * @param input.mode - 'snapshot' | 'turn'.
 * @param input.restored - [{path, action, bytes}].
 * @param input.skipped - [{path, reason}].
 * @param input.failed - [{path, reason}].
 */
export function renderRestoreSummary(input) {
  const restored = Array.isArray(input?.restored) ? input.restored : []
  const skipped = Array.isArray(input?.skipped) ? input.skipped : []
  const failed = Array.isArray(input?.failed) ? input.failed : []
  const lines = []
  const scope = input?.mode === 'turn' ? 'latest turn (snapshots up to ' + String(input?.id ?? '?') + ')' : 'snapshot ' + String(input?.id ?? '?')
  lines.push('checkpoint_restore: ' + scope + ' — restored ' + restored.length + ' file(s), skipped ' + skipped.length + ', failed ' + failed.length + '.')
  for (const item of restored) {
    if (item.action === 'deleted') lines.push('  deleted ' + item.path + ' (it did not exist when the snapshot was taken)')
    else lines.push('  restored ' + item.path + ' (' + formatBytes(item.bytes) + ')')
  }
  for (const item of skipped) lines.push('  skipped ' + item.path + ': ' + item.reason)
  for (const item of failed) lines.push('  FAILED ' + item.path + ': ' + item.reason)
  if (failed.length > 0) lines.push('Some files could not be restored; re-run checkpoint_restore after resolving the failures. Nothing else was rolled back.')
  else if (restored.length > 0) lines.push('Re-read the restored files before continuing; the model-visible history still describes the pre-restore content.')
  return lines.join('\n')
}
