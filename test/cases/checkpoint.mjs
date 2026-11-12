/** Case file: fileCheckpoint (pre-write snapshots, restore, retention, skips). */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, assert } from '../harness.mjs'
import * as core from '../../lib/pure/checkpoint-core.js'
import { install, resolveSettings, sessionIdOf } from '../../lib/checkpoint.js'

const cases = []
const case_ = (name, fn) => cases.push([name, fn])

/** Minimal ctx exposing the documented seams this module reads. */
function makeCtx(options = {}) {
  const listeners = new Map()
  const registered = []
  const ctx = {
    listeners,
    registered,
    on(name, listener) {
      if (options.onThrows === true && name.startsWith('fs/')) throw new Error('fs intents unavailable')
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    get(name) {
      if (name === 'workingDirectory') return options.workingDirectory
      if (name === 'userQuestions') return options.userQuestions
      if (name === 'commands') return options.commands
      return undefined
    },
  }
  ctx.tools = { register(definition) { registered.push(definition); return () => {} } }
  return ctx
}

/** State stub whose folded turn number can be advanced by the test. */
function makeState(turnRef = { turn: 1 }) {
  return {
    turnRef,
    logs: [],
    log(level, message) { this.logs.push([level, message]) },
    loadHost: async () => ({ defineTool: (definition) => definition }),
    sessionState: {
      stateOf: () => ({ turn: turnRef.turn }),
      onEvent: () => () => {},
    },
  }
}

async function withWorkspace(fn) {
  const workspace = await mkdtemp(join(tmpdir(), 'wfb-checkpoint-'))
  try {
    return await fn(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function makeSession(id = 'sess-A') {
  const session = { id }
  const agent = { session }
  return { session, agent, actor: { name: 'write', agent, signal: undefined } }
}

/** Run the registered fs intent listeners like Cordis' waterfall would. */
async function fireIntent(ctx, event, displayPath, actor) {
  const list = ctx.listeners.get(event) ?? []
  assert(list.length >= 1, 'no listener registered for ' + event)
  const call = (index) => index >= list.length ? Promise.resolve(undefined) : list[index]({ displayPath }, actor, () => call(index + 1))
  return call(0)
}

/** Register the module and wait for async tool registration. */
async function setup(ctx, config, state) {
  const disposer = install(ctx, config, state)
  assert(typeof disposer === 'function', 'install returned a disposer')
  await disposer.ready
  return disposer
}

function findTool(ctx, name) {
  const tool = ctx.registered.find((definition) => definition.name === name)
  assert(tool !== undefined, 'tool ' + name + ' registered')
  return tool
}

async function toolExec(ctx, name, args, session) {
  const tool = findTool(ctx, name)
  return tool.execute(args, { agent: { session }, signal: undefined })
}

case_('core: path policy skips VCS/build/dependency/own dirs and escapes', () => {
  assert(core.shouldSkipCheckpointPath('node_modules/x/a.js'), 'node_modules skipped')
  assert(core.shouldSkipCheckpointPath('packages/app/dist/a.js'), 'dist skipped at depth')
  assert(core.shouldSkipCheckpointPath('.git/HEAD'), '.git skipped')
  assert(core.shouldSkipCheckpointPath('.dsh/workflow-boost/x'), '.dsh skipped')
  assert(core.shouldSkipCheckpointPath('src/a.js') === false, 'source file allowed')
  const outside = core.classifyCheckpointTarget('C:/ws', 'C:/other/a.txt')
  assert(outside.ok === false && outside.reason === 'outside-workspace', 'outside rejected')
  const inside = core.classifyCheckpointTarget('C:/ws', 'C:/ws/src/a.txt')
  assert(inside.ok === true && inside.relativePath === 'src/a.txt', 'inside mapped: ' + JSON.stringify(inside))
  const skipped = core.classifyCheckpointTarget('C:/ws', 'C:/ws/node_modules/x/a.js')
  assert(skipped.ok === false && skipped.reason === 'skipped-path', 'skipped dir rejected')
})

case_('core: retention keeps newest turns and enforces the byte cap (LRU)', () => {
  const sessions = [
    { sessionId: 's1', turns: [
      { turn: 1, checkpoints: [{ seq: 1, bytes: 100, createdAt: '2026-01-01T00:00:01Z' }] },
      { turn: 2, checkpoints: [{ seq: 1, bytes: 100, createdAt: '2026-01-01T00:00:02Z' }] },
      { turn: 3, checkpoints: [{ seq: 1, bytes: 100, createdAt: '2026-01-01T00:00:03Z' }] },
    ] },
  ]
  const keepTurns = core.planRetention({ sessions, keepTurns: 2, maxTotalBytes: 1000 })
  assert(keepTurns.removeTurns.length === 1 && keepTurns.removeTurns[0].turn === 1, 'oldest turn removed: ' + JSON.stringify(keepTurns.removeTurns))
  assert(keepTurns.keptBytes === 200, 'kept bytes counted: ' + keepTurns.keptBytes)
  const byteCapped = core.planRetention({ sessions, keepTurns: 5, maxTotalBytes: 150 })
  assert(byteCapped.removeCheckpoints.length === 2, 'two oldest snapshots removed: ' + JSON.stringify(byteCapped.removeCheckpoints))
  assert(byteCapped.keptBytes === 100, 'one snapshot kept: ' + byteCapped.keptBytes)
})

case_('core: restore plan picks the oldest state per path inside the latest turn', () => {
  const manifests = [
    { id: '1/1', turn: 1, seq: 1, createdAt: '2026-01-01T00:00:01Z', files: [{ path: 'src/a.txt', state: 'present', absolutePath: 'C:/ws/src/a.txt' }] },
    { id: '2/1', turn: 2, seq: 1, createdAt: '2026-01-01T00:00:02Z', files: [{ path: 'src/b.txt', state: 'absent', absolutePath: 'C:/ws/src/b.txt' }] },
    { id: '2/2', turn: 2, seq: 2, createdAt: '2026-01-01T00:00:03Z', files: [{ path: 'src/a.txt', state: 'present', absolutePath: 'C:/ws/src/a.txt' }] },
    { id: '2/3', turn: 2, seq: 3, createdAt: '2026-01-01T00:00:04Z', files: [{ path: 'src/a.txt', state: 'present', absolutePath: 'C:/ws/src/a.txt' }] },
  ]
  const latest = core.selectRestorePlan({ manifests })
  assert(latest.ok === true && latest.mode === 'turn', 'turn mode selected')
  assert(latest.entries.length === 2, 'both paths restored once: ' + JSON.stringify(latest.entries.map((entry) => entry.file.path)))
  const forA = latest.entries.find((entry) => entry.file.path === 'src/a.txt')
  assert(forA.manifestId === '2/2', 'a.txt uses its first snapshot inside the turn (2/2), got ' + forA.manifestId)
  const one = core.selectRestorePlan({ manifests, id: '2/3' })
  assert(one.ok === true && one.mode === 'snapshot' && one.entries.length === 1, 'explicit id restores one snapshot')
  const subset = core.selectRestorePlan({ manifests, paths: ['src/a.txt'] })
  assert(subset.ok === true && subset.entries.length === 1 && subset.entries[0].file.path === 'src/a.txt', 'paths filter applied')
  const missing = core.selectRestorePlan({ manifests, id: '9/9' })
  assert(missing.ok === false && missing.reason === 'snapshot-not-found', 'unknown id rejected')
})

case_('runtime: write + delete in one turn restore byte-for-byte (latest turn)', async () => {
  await withWorkspace(async (workspace) => {
    const turnRef = { turn: 1 }
    const state = makeState(turnRef)
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    await setup(ctx, { checkpoint: { autoRestore: true } }, state)
    const { session, actor } = makeSession()

    const aPath = join(workspace, 'src', 'a.txt')
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(aPath, 'v1')
    await fireIntent(ctx, 'fs/write-intent', aPath, actor)
    await writeFile(aPath, 'v2')

    const cPath = join(workspace, 'src', 'c.txt')
    await writeFile(cPath, 'keep-me')
    await fireIntent(ctx, 'fs/delete-intent', cPath, actor)
    await rm(cPath)

    const listText = await toolExec(ctx, 'checkpoint_list', {}, session)
    assert(/2 snapshot\(s\)/u.test(listText), 'two snapshots listed: ' + listText)

    const restored = await toolExec(ctx, 'checkpoint_restore', { latest: true }, session)
    assert(/restored 2 file\(s\)/u.test(restored), 'both files restored: ' + restored)
    assert(await readFile(aPath, 'utf8') === 'v1', 'modified file returned to its pre-turn bytes')
    assert(await readFile(cPath, 'utf8') === 'keep-me', 'deleted file recreated')
  })
})

case_('runtime: paths subset restores only the requested file and asks first', async () => {
  await withWorkspace(async (workspace) => {
    const turnRef = { turn: 2 }
    const state = makeState(turnRef)
    const asked = []
    const userQuestions = {
      async ask(request) {
        asked.push(request)
        return { answers: [{ id: 'checkpoint-restore', selected: ['Restore'] }] }
      },
    }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace }, userQuestions })
    await setup(ctx, { checkpoint: { autoRestore: false } }, state)
    const { session, actor } = makeSession('sess-subset')
    const aPath = join(workspace, 'a.txt')
    const bPath = join(workspace, 'b.txt')
    await writeFile(aPath, 'a-old')
    await writeFile(bPath, 'b-old')
    await fireIntent(ctx, 'fs/write-intent', aPath, actor)
    await fireIntent(ctx, 'fs/write-intent', bPath, actor)
    await writeFile(aPath, 'a-new')
    await writeFile(bPath, 'b-new')

    const text = await toolExec(ctx, 'checkpoint_restore', { paths: ['a.txt'] }, session)
    assert(asked.length === 1, 'confirmation asked once')
    assert(asked[0].questions[0].options.some((option) => option.label === 'Restore'), 'restore option offered')
    assert(await readFile(aPath, 'utf8') === 'a-old', 'requested file restored: ' + text)
    assert(await readFile(bPath, 'utf8') === 'b-new', 'unrequested file untouched')
  })
})

case_('runtime: cancellation, missing channel and corrupt backup all refuse', async () => {
  await withWorkspace(async (workspace) => {
    const turnRef = { turn: 3 }
    const state = makeState(turnRef)
    const { session, actor } = makeSession('sess-refuse')
    const aPath = join(workspace, 'a.txt')
    await writeFile(aPath, 'old')
    const cancelled = { async ask() { return { answers: [{ id: 'checkpoint-restore', selected: [] }] } } }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace }, userQuestions: cancelled })
    await setup(ctx, { checkpoint: { autoRestore: false } }, state)
    await fireIntent(ctx, 'fs/write-intent', aPath, actor)
    await writeFile(aPath, 'new')
    const cancelText = await toolExec(ctx, 'checkpoint_restore', {}, session)
    assert(/cancelled/u.test(cancelText), 'rejection cancels: ' + cancelText)
    assert(await readFile(aPath, 'utf8') === 'new', 'file unchanged after cancelled restore')

    const ctx2 = makeCtx({ workingDirectory: { get: () => workspace } })
    const state2 = makeState({ turn: 3 })
    await setup(ctx2, { checkpoint: { autoRestore: false } }, state2)
    const refused = await toolExec(ctx2, 'checkpoint_restore', {}, session)
    assert(/refused/u.test(refused), 'missing confirmation channel refuses: ' + refused)
    assert(await readFile(aPath, 'utf8') === 'new', 'file unchanged after refused restore')

    const manifests = (await import('node:fs/promises'))
    const root = join(workspace, '.dsh', 'workflow-boost', 'checkpoints', sessionIdOf(session))
    const turnEntries = await manifests.readdir(root)
    assert(turnEntries.length >= 1, 'checkpoint directory written')
    const seqDir = join(root, turnEntries[0], (await manifests.readdir(join(root, turnEntries[0])))[0])
    const backupFile = join(seqDir, 'content.bin')
    await writeFile(backupFile, 'corrupted!')
    const ctx3 = makeCtx({ workingDirectory: { get: () => workspace } })
    await setup(ctx3, { checkpoint: { autoRestore: true } }, makeState({ turn: 3 }))
    const corrupt = await toolExec(ctx3, 'checkpoint_restore', {}, session)
    assert(/sha256 mismatch/u.test(corrupt), 'corrupt backup refused: ' + corrupt)
    assert(await readFile(aPath, 'utf8') === 'new', 'file unchanged after corrupt backup')
  })
})

case_('runtime: enabled by default and registers all three tools', async () => {
  await withWorkspace(async (workspace) => {
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    const disposer = install(ctx, {}, makeState())
    assert(typeof disposer === 'function', 'default checkpoint config installs')
    await disposer.ready
    for (const name of ['checkpoint_list', 'checkpoint_diff', 'checkpoint_restore']) {
      assert(ctx.registered.some((definition) => definition.name === name), name + ' registered')
    }
    const disabled = install(makeCtx(), { checkpoint: { enabled: false } }, makeState())
    assert(disabled === undefined, 'explicit disable returns no disposer')
    assert(resolveSettings({}).enabled === true, 'defaults say enabled')
  })
})

case_('runtime: skipped targets never create snapshots', async () => {
  await withWorkspace(async (workspace) => {
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    const state = makeState({ turn: 1 })
    await setup(ctx, { checkpoint: { maxFileBytes: 10 } }, state)
    const { session, actor } = makeSession('sess-skip')
    const root = join(workspace, '.dsh', 'workflow-boost', 'checkpoints', sessionIdOf(session))
    const cases = [
      join(workspace, 'node_modules', 'x', 'a.js'),
      join(workspace, '.git', 'HEAD'),
      join(workspace, '.dsh', 'other.txt'),
      join(workspace, '..', 'outside-' + Date.now() + '.txt'),
    ]
    for (const target of cases) {
      await mkdir(join(target, '..'), { recursive: true }).catch(() => {})
      await writeFile(target, 'x').catch(() => {})
      await fireIntent(ctx, 'fs/write-intent', target, actor)
    }
    const big = join(workspace, 'big.txt')
    await writeFile(big, '01234567890123456789')
    await fireIntent(ctx, 'fs/write-intent', big, actor)

    const listText = await toolExec(ctx, 'checkpoint_list', {}, session)
    assert(/No file checkpoints/u.test(listText), 'nothing snapshotted: ' + listText)
    let entries = []
    try { entries = await (await import('node:fs/promises')).readdir(root) } catch { entries = [] }
    assert(entries.length === 0, 'no session checkpoint directory, got ' + entries.join(','))
  })
})

case_('runtime: keepTurns prunes old turns, maxTotalBytes prunes by LRU', async () => {
  await withWorkspace(async (workspace) => {
    const turnRef = { turn: 1 }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    await setup(ctx, { checkpoint: { keepTurns: 2 } }, makeState(turnRef))
    const { session, actor } = makeSession('sess-prune')
    for (let turn = 1; turn <= 4; turn += 1) {
      turnRef.turn = turn
      const target = join(workspace, 'file-' + turn + '.txt')
      await writeFile(target, 'turn ' + turn)
      await fireIntent(ctx, 'fs/write-intent', target, actor)
    }
    const sessionDir = join(workspace, '.dsh', 'workflow-boost', 'checkpoints', sessionIdOf(session))
    const { readdir } = await import('node:fs/promises')
    const turns = (await readdir(sessionDir)).sort()
    assert(turns.length === 2 && turns[0] === '3' && turns[1] === '4', 'keepTurns kept the newest two turns: ' + turns.join(','))
  })

  await withWorkspace(async (workspace) => {
    const turnRef = { turn: 1 }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    await setup(ctx, { checkpoint: { maxTotalBytes: 1024 } }, makeState(turnRef))
    const { session, actor } = makeSession('sess-bytes')
    for (let index = 0; index < 3; index += 1) {
      const target = join(workspace, 'file-' + index + '.txt')
      await writeFile(target, 'x'.repeat(400))
      await fireIntent(ctx, 'fs/write-intent', target, actor)
    }
    const listText = await toolExec(ctx, 'checkpoint_list', {}, session)
    assert(/1 snapshot\(s\)/u.test(listText), 'byte cap kept exactly the newest snapshot: ' + listText)
  })
})

case_('runtime: capability probe falls back to a pre-execute hint, never blocks', async () => {
  await withWorkspace(async (workspace) => {
    const ctx = makeCtx({ workingDirectory: { get: () => workspace }, onThrows: true })
    const state = makeState({ turn: 1 })
    const disposer = install(ctx, {}, state)
    assert(typeof disposer === 'function', 'install survived fs intent registration failure')
    await disposer.ready
    const preExecute = (ctx.listeners.get('tools/pre-execute') ?? [])
    assert(preExecute.length === 1, 'pre-execute fallback registered')
    const { session } = makeSession('sess-degraded')
    const result = await preExecute[0]({ name: 'write', agent: { session } }, async () => 'allow')
    assert(result === 'allow', 'fallback does not block the tool')
    const listText = await toolExec(ctx, 'checkpoint_list', {}, session)
    assert(/did not emit fs intent events/u.test(listText), 'degraded note recorded: ' + listText)
    assert(ctx.registered.length === 3, 'tools still registered in degraded mode')
    disposer()
  })
})

case_('runtime: checkpoint_diff shows a bounded unified diff', async () => {
  await withWorkspace(async (workspace) => {
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    await setup(ctx, {}, makeState({ turn: 1 }))
    const { session, actor } = makeSession('sess-diff')
    const target = join(workspace, 'a.txt')
    await writeFile(target, 'old line 1\nold line 2\n')
    await fireIntent(ctx, 'fs/write-intent', target, actor)
    await writeFile(target, 'new line 1\nold line 2\n')
    const text = await toolExec(ctx, 'checkpoint_diff', {}, session)
    assert(text.includes('--- a/a.txt') && text.includes('+++ b/a.txt'), 'unified headers present: ' + text)
    assert(text.includes('-old line 1') && text.includes('+new line 1'), 'changed lines shown')
    assert(text.split('\n').length < 120, 'diff bounded')

    const missing = await toolExec(ctx, 'checkpoint_diff', { id: '9/9' }, session)
    assert(/no checkpoint with id/u.test(missing), 'unknown id explained: ' + missing)
  })
})

case_('core: unified diff renders created and deleted files', () => {
  const created = core.renderUnifiedDiff({ path: 'new.txt', before: null, after: 'hello\n' })
  assert(created.includes('+hello'), 'created file lines added: ' + created)
  const deleted = core.renderUnifiedDiff({ path: 'old.txt', before: 'bye\n', after: null })
  assert(deleted.includes('-bye'), 'deleted file lines removed: ' + deleted)
  const same = core.renderUnifiedDiff({ path: 'same.txt', before: 'a\n', after: 'a\n' })
  assert(/No differences/u.test(same), 'identical content reported as no diff')
})

case_('runtime: a throwing ctx.on only degrades, tools still register', async () => {
  const ctx = {
    on() { throw new Error('event bus unavailable') },
    get() { return undefined },
    tools: { register(definition) { this.definitions.push(definition); return () => {} }, definitions: [] },
  }
  let disposer
  try {
    disposer = install(ctx, {}, makeState())
  } catch (error) {
    throw new Error('install must be fail-open, threw: ' + error.message)
  }
  assert(typeof disposer === 'function', 'disposer returned despite no event bus')
  await disposer.ready
  assert(ctx.tools.definitions.length === 3, 'three checkpoint tools registered, got ' + ctx.tools.definitions.length)
})

for (const [name, fn] of cases) {
  let failure = null
  try {
    await fn()
  } catch (error) {
    failure = error
  }
  test(name, () => {
    if (failure !== null) throw failure
  })
}
