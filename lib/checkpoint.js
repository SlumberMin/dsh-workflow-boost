/**
 * checkpoint — snapshot file bytes before a write/edit/delete and restore them.
 *
 * Why the fs intent events: tools/post-execute runs *after* the mutation, so by
 * then the previous bytes are gone. `fs/write-intent`, `fs/edit-intent` and
 * `fs/delete-intent` are waterfalls dispatched immediately before the write
 * with the resolved target, which is exactly the observation point a file-level
 * undo needs. Some hosts/versions may not dispatch them: when registering those
 * listeners fails, or a write tool succeeds without a single intent, the module
 * degrades to an explicit hint on the pre-execute path and never blocks a
 * mutation. Everything is fail-open; a checkpoint problem never changes the
 * model's edit result.
 *
 * Layout: <workspace>/.dsh/workflow-boost/checkpoints/<sessionId>/<turn>/<seq>/
 * with manifest.json and the original bytes. Skipped: paths outside the
 * workspace, VCS/build/dependency/config dirs, files above maxFileBytes, and
 * symlinks. Retention keeps the newest keepTurns turns and enforces an LRU byte
 * cap across sessions.
 *
 * The model-facing tools are checkpoint_list, checkpoint_diff and
 * checkpoint_restore. Restore validates every backup sha256 and requires an
 * explicit confirmation through the userQuestions service unless autoRestore is
 * enabled; with no confirmation channel it refuses instead of guessing.
 *
 * @module dsh-workflow-boost/lib/checkpoint
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sectionDefaults } from './defaults.js'
import { loadHost, logInfo, logWarn } from './shared.js'
import {
  buildManifest,
  checkpointRoot,
  classifyCheckpointTarget,
  formatBytes,
  isInsideWorkspace,
  isValidManifest,
  manifestBytes,
  nextSequence,
  planRetention,
  renderCheckpointList,
  renderRestoreSummary,
  renderUnifiedDiff,
  sanitizeSegment,
  selectRestorePlan,
} from './pure/checkpoint-core.js'

/** fs intent events hooked for snapshotting, and the manifest intent label. */
const INTENTS = [
  ['fs/write-intent', 'write'],
  ['fs/edit-intent', 'edit'],
  ['fs/delete-intent', 'delete'],
]

/** Tool names whose success is probed for intent availability. */
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'replace', 'apply_patch', 'str_replace_editor'])

/** Folder created next to manifest.json holding the original bytes. */
const BACKUP_FILE = 'content.bin'

/** Source label for notices (kept consistent with the other modules). */
export const SOURCE_KIND = 'dsh-workflow-boost'

/** Resolve the module config, merging lib/defaults.js with the row section. */
export function resolveSettings(config) {
  const merged = sectionDefaults('checkpoint', config)
  const clamp = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.floor(number)))
  }
  return {
    enabled: merged.enabled !== false,
    maxPerTurn: clamp(merged.maxPerTurn, 30, 1, 1000),
    keepTurns: clamp(merged.keepTurns, 20, 1, 10000),
    maxTotalBytes: clamp(merged.maxTotalBytes, 536870912, 1024, 1099511627776),
    maxFileBytes: clamp(merged.maxFileBytes, 5242880, 1, 1099511627776),
    autoRestore: merged.autoRestore === true,
  }
}

/** Session identity safe to use as a directory name. */
export function sessionIdOf(session) {
  try {
    const id = session?.id ?? session?.header?.id
    if (typeof id === 'string' && id.length > 0) return sanitizeSegment(id, 64)
  } catch { /* fall through */ }
  return 'unknown'
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

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** realpath that never throws. */
async function realpathSafe(path) {
  try { return await realpath(path) } catch { return undefined }
}

/** Read and validate one manifest.json; returns undefined for missing/corrupt files. */
async function readManifest(dir) {
  try {
    const text = await readFile(join(dir, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(text)
    return isValidManifest(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Load every manifest of one session, newest last. */
async function loadManifests(root, sessionId) {
  const sessionDir = join(root, sessionId)
  let turnEntries
  try { turnEntries = await readdir(sessionDir, { withFileTypes: true }) } catch { return [] }
  const manifests = []
  for (const turnEntry of turnEntries) {
    if (!turnEntry.isDirectory() || !/^\d+$/u.test(turnEntry.name)) continue
    let seqEntries
    try { seqEntries = await readdir(join(sessionDir, turnEntry.name), { withFileTypes: true }) } catch { continue }
    for (const seqEntry of seqEntries) {
      if (!seqEntry.isDirectory() || !/^\d+$/u.test(seqEntry.name)) continue
      const dir = join(sessionDir, turnEntry.name, seqEntry.name)
      const manifest = await readManifest(dir)
      if (manifest !== undefined) manifests.push({ ...manifest, dir })
    }
  }
  manifests.sort((left, right) => Number(left.turn) - Number(right.turn) || Number(left.seq) - Number(right.seq))
  return manifests
}

/**
 * Build the filesystem-facing runtime. Kept separate from install() so the
 * listener, tool and command definitions read as thin adapters.
 */
function createRuntime(ctx, settings, state) {
  /** per session-turn snapshot counter: 'sessionId\u0000turn' -> count */
  const turnCounts = new Map()
  /** sessions where a write succeeded without any intent event */
  const degraded = new Set()
  /** sessions that produced at least one fs intent (capability probe) */
  const sawIntent = new WeakSet()
  const warnedWorkspace = new Set()

  const bumpTurn = (sessionId, turn) => {
    const key = sessionId + '\u0000' + turn
    const next = (turnCounts.get(key) ?? 0) + 1
    turnCounts.set(key, next)
    // A process can serve thousands of sessions; drop old counters wholesale
    // rather than growing forever. Worst case a limit restarts mid-turn.
    if (turnCounts.size > 4096) turnCounts.clear()
    return next
  }

  const markDegraded = (session, reason) => {
    try {
      if (session === undefined || session === null) return
      if (degraded.has(session)) return
      degraded.add(session)
    } catch { return }
    logWarn(state, 'checkpoint: fs intent events unavailable (' + reason + '); file snapshots are degraded for this session')
  }

  const workspaceFor = (session) => {
    const workspace = workspaceOf(ctx, session)
    if (workspace === undefined && !warnedWorkspace.has(session)) {
      warnedWorkspace.add(session)
      logWarn(state, 'checkpoint: workingDirectory service unavailable; snapshots skipped for this session')
    }
    return workspace
  }

  /** Snapshot the current bytes of one resolved target before it is mutated. */
  const capture = async (kind, target, actor) => {
    const session = actor?.agent?.session
    if (session === undefined || session === null) return
    try { sawIntent.add(session) } catch { /* ignore */ }
    const workspace = workspaceFor(session)
    if (workspace === undefined) return
    const displayPath = typeof target?.displayPath === 'string'
      ? target.displayPath
      : typeof target?.targetKey === 'string' ? target.targetKey : ''
    const classified = classifyCheckpointTarget(workspace, displayPath)
    if (!classified.ok) {
      if (classified.reason === 'outside-workspace') logInfo(state, 'checkpoint: ignoring ' + displayPath + ' (outside the workspace)')
      return
    }
    const absolutePath = classified.absolutePath
    let info
    try { info = await lstat(absolutePath) } catch (error) {
      if (error?.code !== 'ENOENT') { logWarn(state, 'checkpoint: cannot stat ' + absolutePath + ': ' + describe(error)); return }
      info = undefined
    }
    let entry
    if (info === undefined) {
      entry = { path: classified.relativePath, absolutePath, state: 'absent' }
    } else {
      if (info.isSymbolicLink()) { logInfo(state, 'checkpoint: skipping symlink ' + classified.relativePath); return }
      if (!info.isFile()) { logInfo(state, 'checkpoint: skipping non-file ' + classified.relativePath); return }
      if (info.size > settings.maxFileBytes) {
        logInfo(state, 'checkpoint: skipping ' + classified.relativePath + ' (' + formatBytes(info.size) + ' > maxFileBytes)')
        return
      }
      let bytes
      try { bytes = await readFile(absolutePath) } catch (error) {
        logWarn(state, 'checkpoint: cannot read ' + classified.relativePath + ': ' + describe(error))
        return
      }
      if (bytes.length > settings.maxFileBytes) { logInfo(state, 'checkpoint: skipping oversized ' + classified.relativePath); return }
      const realWorkspace = await realpathSafe(workspace)
      const realFile = await realpathSafe(absolutePath)
      if (realWorkspace !== undefined && realFile !== undefined && !isInsideWorkspace(realWorkspace, realFile)) {
        logInfo(state, 'checkpoint: skipping ' + classified.relativePath + ' (resolves outside the workspace)')
        return
      }
      entry = {
        path: classified.relativePath,
        absolutePath,
        state: 'present',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
      }
    }
    const sessionId = sessionIdOf(session)
    const turn = currentTurn(state, session)
    if (bumpTurn(sessionId, turn) > settings.maxPerTurn) {
      logInfo(state, 'checkpoint: per-turn limit (' + settings.maxPerTurn + ') reached; snapshot skipped')
      return
    }
    const root = checkpointRoot(workspace)
    const turnDir = join(root, sessionId, String(turn))
    let existing = []
    try { existing = await readdir(turnDir) } catch { existing = [] }
    const seq = nextSequence(existing.map((name) => (/^\d+$/u.test(name) ? Number(name) : 0)))
    const finalDir = join(turnDir, String(seq))
    const tempDir = finalDir + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8)
    try {
      await mkdir(tempDir, { recursive: true })
      if (entry.state === 'present') await writeFile(join(tempDir, BACKUP_FILE), entry.bytes)
      const manifest = buildManifest({
        sessionId,
        turn,
        seq,
        intent: 'fs/' + kind + '-intent',
        tool: typeof actor?.name === 'string' ? actor.name : '',
        workspace,
        files: [{
          path: entry.path,
          absolutePath: entry.absolutePath,
          state: entry.state,
          ...entry.state === 'present' ? {
            size: entry.size,
            sha256: entry.sha256,
            backup: BACKUP_FILE,
          } : {},
        }],
      })
      await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
      await rename(tempDir, finalDir)
      logInfo(state, 'checkpoint: snapshot ' + manifest.id + ' ' + (entry.state === 'present' ? entry.path : '(absent) ' + entry.path))
    } catch (error) {
      logWarn(state, 'checkpoint: could not write snapshot for ' + entry.path + ': ' + describe(error))
      try { await rm(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      return
    }
    try { await prune(root) } catch (error) { logWarn(state, 'checkpoint: retention failed: ' + describe(error)) }
  }

  /** Enforce keepTurns and maxTotalBytes; deletions are best effort. */
  const prune = async (root) => {
    let sessionEntries
    try { sessionEntries = await readdir(root, { withFileTypes: true }) } catch { return }
    const sessions = []
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue
      let turnEntries
      try { turnEntries = await readdir(join(root, sessionEntry.name), { withFileTypes: true }) } catch { continue }
      const turns = []
      for (const turnEntry of turnEntries) {
        if (!turnEntry.isDirectory() || !/^\d+$/u.test(turnEntry.name)) continue
        const checkpoints = []
        let seqEntries
        try { seqEntries = await readdir(join(root, sessionEntry.name, turnEntry.name), { withFileTypes: true }) } catch { continue }
        for (const seqEntry of seqEntries) {
          if (!seqEntry.isDirectory() || !/^\d+$/u.test(seqEntry.name)) continue
          const manifest = await readManifest(join(root, sessionEntry.name, turnEntry.name, seqEntry.name))
          if (manifest === undefined) continue
          checkpoints.push({
            seq: Number(seqEntry.name),
            bytes: manifestBytes(manifest) + Buffer.byteLength(JSON.stringify(manifest)),
            createdAt: manifest.createdAt,
          })
        }
        turns.push({ turn: Number(turnEntry.name), checkpoints })
      }
      sessions.push({ sessionId: sessionEntry.name, turns })
    }
    const plan = planRetention({ sessions, keepTurns: settings.keepTurns, maxTotalBytes: settings.maxTotalBytes })
    for (const item of plan.removeTurns) {
      try { await rm(join(root, item.sessionId, String(item.turn)), { recursive: true, force: true }) } catch { /* best effort */ }
    }
    for (const item of plan.removeCheckpoints) {
      try { await rm(join(root, item.sessionId, String(item.turn), String(item.seq)), { recursive: true, force: true }) } catch { /* best effort */ }
    }
    if (plan.removeTurns.length > 0 || plan.removeCheckpoints.length > 0) {
      logInfo(state, 'checkpoint: retention removed ' + plan.removeTurns.length + ' turn(s), ' + plan.removeCheckpoints.length + ' snapshot(s)')
    }
  }

  return {
    degraded,
    hasIntent: (session) => { try { return sawIntent.has(session) } catch { return false } },
    markDegraded,
    capture,
    prune,
    workspaceFor,
    loadManifests,
  }
}

/** Resolve session + workspace + checkpoint root for one model-facing tool call. */
function toolContext(ctx, exec) {
  const session = exec?.agent?.session
  if (session === undefined || session === null) return { error: 'this checkpoint tool must be called by the model from an agent turn (no session is attached).' }
  const workspace = workspaceOf(ctx, session)
  if (workspace === undefined) return { error: 'checkpoint tools need the workingDirectory service; it is not mounted in this profile.' }
  return { session, workspace, root: checkpointRoot(workspace), sessionId: sessionIdOf(session) }
}

/** Implementations shared by the model-facing tools and the /checkpoint command. */
function createToolImplementations(ctx, settings, state, runtime) {
  const list = async (exec, args) => {
    const resolved = toolContext(ctx, exec)
    if (resolved.error !== undefined) return resolved.error
    const manifests = await runtime.loadManifests(resolved.root, resolved.sessionId)
    const entries = manifests.map((manifest) => ({
      id: manifest.id,
      turn: Number(manifest.turn),
      seq: Number(manifest.seq),
      intent: manifest.intent,
      tool: manifest.tool,
      createdAt: manifest.createdAt,
      bytes: manifestBytes(manifest),
      files: manifest.files.map((file) => ({ path: file.path, state: file.state })),
    }))
    const requested = Number(args?.limit)
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(200, Math.floor(requested)) : 40
    let text = renderCheckpointList({ sessionId: resolved.sessionId, entries, limit })
    if (runtime.degraded.has(resolved.session)) {
      text += '\nNote: this host did not emit fs intent events for a write in this session, so some edits may not have a snapshot.'
    }
    return text
  }

  const diff = async (exec, args) => {
    const resolved = toolContext(ctx, exec)
    if (resolved.error !== undefined) return resolved.error
    const manifests = await runtime.loadManifests(resolved.root, resolved.sessionId)
    if (manifests.length === 0) return 'checkpoint_diff: no checkpoints recorded for this session yet.'
    let manifest
    if (typeof args?.id === 'string' && args.id.trim().length > 0) {
      manifest = manifests.find((candidate) => candidate.id === args.id.trim())
      if (manifest === undefined) return 'checkpoint_diff: no checkpoint with id ' + args.id.trim() + '. Run checkpoint_list to see the available ids.'
    } else {
      manifest = manifests[manifests.length - 1]
    }
    let file
    if (typeof args?.path === 'string' && args.path.trim().length > 0) {
      const wanted = args.path.trim().replace(/\\/gu, '/').toLowerCase()
      file = manifest.files.find((candidate) => candidate.path.toLowerCase() === wanted || String(candidate.absolutePath ?? '').replace(/\\/gu, '/').toLowerCase() === wanted)
      if (file === undefined) return 'checkpoint_diff: snapshot ' + manifest.id + ' does not contain ' + args.path.trim() + '.'
    } else {
      file = manifest.files[0]
    }
    if (file === undefined) return 'checkpoint_diff: snapshot ' + manifest.id + ' has no file entries.'
    let before = null
    if (file.state === 'present') {
      try {
        const bytes = await readFile(join(manifest.dir, String(file.backup ?? 'content.bin')))
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (typeof file.sha256 === 'string' && file.sha256.length > 0 && actual !== file.sha256) {
          return 'checkpoint_diff: backup for ' + file.path + ' is corrupt (sha256 mismatch); it cannot be trusted for restore.'
        }
        before = decodeText(bytes)
        if (before === undefined) return 'checkpoint_diff: ' + file.path + ' was binary at snapshot time, so no text diff is available.'
      } catch (error) {
        return 'checkpoint_diff: cannot read the backup for ' + file.path + ': ' + describe(error)
      }
    }
    let after = null
    let note = ''
    try {
      const info = await lstat(file.absolutePath)
      if (info.isSymbolicLink()) note = ' (current path is a symlink; not diffed)'
      else if (info.isFile()) after = decodeText(await readFile(file.absolutePath))
      if (after === undefined) { after = null; note = ' (current file is binary; not diffed)' }
    } catch {
      note = ' (the file no longer exists)'
    }
    const header = 'checkpoint_diff ' + manifest.id + ' — ' + file.path + ' (snapshot state: ' + file.state + ')' + note
    return header + '\n' + renderUnifiedDiff({ path: file.path, before, after, maxLines: 100 })
  }

  const restore = async (exec, args) => {
    const resolved = toolContext(ctx, exec)
    if (resolved.error !== undefined) return resolved.error
    const manifests = await runtime.loadManifests(resolved.root, resolved.sessionId)
    const plan = selectRestorePlan({ manifests, id: args?.id, paths: Array.isArray(args?.paths) ? args.paths : undefined })
    if (!plan.ok) {
      if (plan.reason === 'no-checkpoints') return 'checkpoint_restore: no checkpoints recorded for this session yet.'
      if (plan.reason === 'snapshot-not-found') return 'checkpoint_restore: no checkpoint with id ' + String(plan.id) + '. Run checkpoint_list first.'
      if (plan.reason === 'no-matching-paths') return 'checkpoint_restore: none of the requested paths exist in ' + String(plan.id) + '.'
      return 'checkpoint_restore: nothing to restore (' + String(plan.reason) + ').'
    }
    if (!settings.autoRestore) {
      const approval = await requestConfirmation(ctx, exec, plan)
      if (approval !== true) return approval
    }
    const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]))
    // Verify every backup before touching the workspace: a partial restore after
    // a corrupt backup would leave an inconsistent tree.
    const failed = []
    const verified = []
    for (const item of plan.entries) {
      const manifest = manifestById.get(item.manifestId)
      if (manifest === undefined) { failed.push({ path: item.file.path, reason: 'snapshot disappeared' }); continue }
      const classified = classifyCheckpointTarget(resolved.workspace, item.file.absolutePath)
      if (!classified.ok) { failed.push({ path: item.file.path, reason: 'target no longer maps inside the workspace (' + classified.reason + ')' }); continue }
      if (item.file.state === 'absent') { verified.push({ item, manifest, bytes: null }); continue }
      let bytes
      try {
        bytes = await readFile(join(manifest.dir, String(item.file.backup ?? 'content.bin')))
      } catch (error) {
        failed.push({ path: item.file.path, reason: 'backup unreadable: ' + describe(error) })
        continue
      }
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (typeof item.file.sha256 !== 'string' || item.file.sha256.length === 0 || actual !== item.file.sha256) {
        failed.push({ path: item.file.path, reason: 'sha256 mismatch (backup corrupt)' })
        continue
      }
      verified.push({ item, manifest, bytes })
    }
    if (failed.length > 0) {
      return renderRestoreSummary({ id: plan.id, mode: plan.mode, restored: [], skipped: [], failed })
    }
    const restored = []
    const skipped = []
    const realWorkspace = await realpathSafe(resolved.workspace)
    for (const record of verified) {
      const file = record.item.file
      const absolutePath = file.absolutePath
      try {
        if (realWorkspace !== undefined) {
          // A lexical containment check cannot see a symlinked parent; require
          // the directory that will actually receive the bytes to be inside.
          const realParent = await realpathSafe(dirname(absolutePath))
          if (realParent !== undefined && !isInsideWorkspace(realWorkspace, realParent)) {
            failed.push({ path: file.path, reason: 'parent directory resolves outside the workspace' })
            continue
          }
        }
        const info = await lstat(absolutePath).catch(() => undefined)
        if (file.state === 'absent') {
          if (info === undefined) { skipped.push({ path: file.path, reason: 'already absent' }); continue }
          if (info.isDirectory()) { skipped.push({ path: file.path, reason: 'current path is a directory' }); continue }
          await rm(absolutePath, { force: true })
          restored.push({ path: file.path, action: 'deleted', bytes: 0 })
          continue
        }
        if (info !== undefined && info.isDirectory()) { skipped.push({ path: file.path, reason: 'current path is a directory' }); continue }
        if (info !== undefined && info.isSymbolicLink()) { skipped.push({ path: file.path, reason: 'current path is a symlink' }); continue }
        await writeAtomic(absolutePath, record.bytes)
        restored.push({ path: file.path, action: 'restored', bytes: record.bytes.length })
      } catch (error) {
        failed.push({ path: file.path, reason: describe(error) })
      }
    }
    const text = renderRestoreSummary({ id: plan.id, mode: plan.mode, restored, skipped, failed })
    logInfo(state, 'checkpoint: restore ' + plan.id + ' -> ' + restored.length + ' restored, ' + failed.length + ' failed')
    return text
  }

  return { list, diff, restore }
}

/** Decode a UTF-8 text buffer, or undefined when it looks binary. */
function decodeText(bytes) {
  if (bytes === undefined || bytes === null) return undefined
  const probe = bytes.subarray(0, 1024)
  for (const byte of probe) if (byte === 0) return undefined
  return bytes.toString('utf8')
}

/** Write bytes through a temporary sibling then rename, so a failed write never truncates the file. */
async function writeAtomic(target, bytes) {
  await mkdir(dirname(target), { recursive: true })
  const temp = target + '.wfb-restore-' + randomUUID().slice(0, 8)
  await writeFile(temp, bytes)
  try {
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Ask the user before overwriting files. Uses the same userQuestions service as
 * ask_user_question; when it is unavailable the restore is REFUSED rather than
 * performed silently.
 * @returns true when approved, or the refusal text to return to the model.
 */
async function requestConfirmation(ctx, exec, plan) {
  const service = (() => {
    try { return typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined } catch { return undefined }
  })()
  if (service === null || service === undefined || typeof service.ask !== 'function') {
    return 'checkpoint_restore refused: it needs user confirmation, but the userQuestions service is not mounted (set checkpoint.autoRestore=true only if you accept unattended restores).'
  }
  const agent = exec?.agent
  if (agent === undefined || agent === null) {
    return 'checkpoint_restore refused: it needs user confirmation, but this call has no live agent to route the question through.'
  }
  const files = plan.entries.map((entry) => entry.file.path)
  const question = {
    id: 'checkpoint-restore',
    header: 'Restore checkpoint',
    question: 'Restore ' + files.length + ' file(s) from checkpoint ' + plan.id + '? This overwrites their current content: ' + files.slice(0, 10).join(', ') + (files.length > 10 ? ', ...' : '') + '.',
    options: [
      { label: 'Restore', description: 'Overwrite the current files with the checkpoint bytes.' },
      { label: 'Cancel', description: 'Keep the current files unchanged.' },
    ],
  }
  let answer
  try {
    answer = await service.ask({
      questions: [question],
      agent,
      ...exec?.signal === undefined ? {} : { signal: exec.signal },
    })
  } catch (error) {
    return 'checkpoint_restore cancelled: the confirmation request failed (' + describe(error) + ').'
  }
  const selected = Array.isArray(answer?.answers) ? answer.answers[0]?.selected : undefined
  if (Array.isArray(selected) && selected.includes('Restore')) return true
  return 'checkpoint_restore cancelled: the user did not approve the restore.'
}

/** Build the registry-ready tool definitions for one install. */
function createToolFactories(ctx, settings, state, runtime) {
  const implementations = createToolImplementations(ctx, settings, state, runtime)
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
  return {
    implementations,
    factories: [
      () => ({
        name: 'checkpoint_list',
        description: 'List the file checkpoints recorded for this session: turn/seq ids, which files were snapshotted before a write/edit/delete, sizes and timestamps. Use it before restoring anything, or to explain what can be rolled back. Checkpoints are created automatically and never change the conversation.',
        parameters: {
          limit: { type: 'number', description: 'Maximum number of snapshots to show (default 40).' },
        },
        output,
        execute: async (args, exec) => implementations.list(exec, args ?? {}),
      }),
      () => ({
        name: 'checkpoint_diff',
        description: 'Show a bounded unified diff (at most 100 lines) between one checkpoint snapshot and the file current content. Use it to inspect what a restore would change before calling checkpoint_restore. Omit id to use the newest snapshot.',
        parameters: {
          id: { type: 'string', description: 'Snapshot id like "3/2" (turn/seq) from checkpoint_list. Defaults to the newest snapshot.' },
          path: { type: 'string', description: 'Optional file path inside the snapshot; defaults to its first file.' },
        },
        output,
        execute: async (args, exec) => implementations.diff(exec, args ?? {}),
      }),
      () => ({
        name: 'checkpoint_restore',
        description: 'Restore files from a checkpoint: with no id/latest it undoes every file touched in the latest turn (using the state before that turn); with id it restores exactly that snapshot point; paths limits the restore. Every backup sha256 is verified before writing. Unless checkpoint.autoRestore is enabled this asks the user for confirmation and is refused when no confirmation channel exists. Use it after a bad edit, a broken refactor, or when the user asks to roll back.',
        parameters: {
          latest: { type: 'boolean', description: 'Restore the latest turn (the default when id is omitted).' },
          id: { type: 'string', description: 'Snapshot id like "3/2" from checkpoint_list.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Optional subset of file paths (workspace-relative or absolute) to restore.' },
        },
        output,
        execute: async (args, exec) => implementations.restore(exec, args ?? {}),
      }),
    ],
  }
}

/**
 * Install the module.
 * @param ctx - Cordis plugin context.
 * @param config - resolved plugin row config.
 * @param state - shared plugin state with log, sessionState and optional loadHost.
 * @returns a disposer with a .ready promise for the async tool registration.
 */
export function install(ctx, config, state) {
  const settings = resolveSettings(config)
  if (!settings.enabled) return undefined
  const runtime = createRuntime(ctx, settings, state)
  const tools = createToolFactories(ctx, settings, state, runtime)
  let disposed = false
  const cleanups = []

  // 1. Preferred observation point: the fs intent waterfalls, before the bytes change.
  let intentsRegistered = false
  try {
    if (typeof ctx?.on === 'function') {
      for (const [event, kind] of INTENTS) {
        ctx.on(event, async (target, actor, next) => {
          if (!disposed) {
            try { await runtime.capture(kind, target, actor) } catch (error) {
              logWarn(state, 'checkpoint: snapshot failed: ' + describe(error))
            }
          }
          return next()
        }, { prepend: true })
      }
      intentsRegistered = true
    }
  } catch (error) {
    logWarn(state, 'checkpoint: fs intent listeners unavailable: ' + describe(error))
    intentsRegistered = false
  }

  // 2. Capability probe / degraded hint: never blocks, only records and logs.
  try {
    if (typeof ctx?.on === 'function') {
      if (!intentsRegistered) {
        ctx.on('tools/pre-execute', async (exec, next) => {
          try {
            const name = String(exec?.name ?? '')
            if (WRITE_TOOL_NAMES.has(name)) runtime.markDegraded(exec?.agent?.session, 'fs intent listeners could not be registered')
          } catch { /* hint only */ }
          return next()
        }, { prepend: true })
      } else {
        ctx.on('tools/post-execute', async (exec, result, next) => {
          try {
            if (result?.isError !== true && WRITE_TOOL_NAMES.has(String(exec?.name ?? ''))) {
              const session = exec?.agent?.session
              if (session !== undefined && session !== null && !runtime.hasIntent(session)) {
                runtime.markDegraded(session, 'a successful write produced no fs intent event')
              }
            }
          } catch { /* probe only */ }
          return next()
        }, { prepend: true })
      }
    }
  } catch (error) {
    logWarn(state, 'checkpoint: capability probe unavailable: ' + describe(error))
  }

  // 3. Tools need defineTool from the host package; load it lazily and asynchronously
  // so the plugin stays importable in a clean Node environment (unit tests).
  const ready = (async () => {
    try {
      if (typeof ctx?.tools?.register !== 'function') {
        logWarn(state, 'checkpoint: ctx.tools.register is unavailable; checkpoint_* tools not registered')
        return
      }
      const host = typeof state?.loadHost === 'function' ? state.loadHost : loadHost
      let toolsModule
      try { toolsModule = await host('@deepseek-ai/dsh-tools') } catch { toolsModule = undefined }
      if (disposed) return
      const define = typeof toolsModule?.defineTool === 'function' ? toolsModule.defineTool : (definition) => definition
      for (const factory of tools.factories) {
        const definition = factory()
        try {
          const cleanup = ctx.tools.register(define(definition))
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        } catch (error) {
          logWarn(state, 'checkpoint: could not register ' + definition.name + ': ' + describe(error))
        }
      }
      logInfo(state, 'checkpoint active (checkpoint_list/checkpoint_diff/checkpoint_restore registered)')
    } catch (error) {
      logWarn(state, 'checkpoint: tool registration failed: ' + describe(error))
    }
  })()

  // 4. Human-triggered /checkpoint command (does not consume a model turn).
  try {
    const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
    if (commands !== null && commands !== undefined && typeof commands.register === 'function') {
      const cleanup = commands.register({
        name: 'checkpoint',
        description: 'List the file checkpoints recorded for this session. Restoring is done by the model tool checkpoint_restore, which asks for confirmation.',
        input: { hint: '[id]' },
        handler: async (invocation) => {
          try {
            const text = await tools.implementations.list({ agent: invocation?.agent }, {})
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: 'checkpoint: ' + describe(error) }
          }
        },
      })
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
  } catch (error) {
    logWarn(state, 'checkpoint: /checkpoint command unavailable: ' + describe(error))
  }

  const disposer = () => {
    disposed = true
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup() } catch { /* disposal must not throw */ }
    }
  }
  disposer.ready = ready
  return disposer
}
