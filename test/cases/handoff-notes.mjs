/**
 * handoffNotes cases: pure rendering/truncation/containment, trigger decisions,
 * pressure and post-compaction injection, once-per-turn suppression, the
 * handoff_note tool, and fail-open behavior without a workspace.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, assert, assertEqual } from '../harness.mjs'
import { createFakeContext, createFakeSession, fakeLoadHost } from '../fakes.mjs'
import {
  MODEL_NOTES_HEADING,
  NOTE_DIR,
  isInsideWorkspace,
  noteRelativePath,
  pressureRatioOf,
  renderHandoffInjection,
  renderHandoffNote,
  renderHandoffNotice,
  resolveHandoffConfig,
  resolveNotePath,
  sanitizeSegment,
  shouldRefreshHandoff,
  truncateNote,
} from '../../lib/pure/handoff-core.js'
import { install, resolveConfig } from '../../lib/handoff-notes.js'

const TODOS = [
  { content: '读契约', status: 'completed' },
  { content: '写 handoffNotes（验收：单测全绿）', status: 'in_progress' },
  { content: '更新 README', status: 'pending' },
]

const TOOL_RING = [
  { seq: 1, name: 'read', isError: false },
  { seq: 2, name: 'bash', isError: true },
  { seq: 3, name: 'edit', isError: false },
]

// --- pure configuration ----------------------------------------------------

test('config defaults and clamps match the 1.1.0 contract', () => {
  const settings = resolveHandoffConfig({})
  assertEqual(settings.enabled, true)
  assertEqual(settings.minPressureRatio, 0.6)
  assertEqual(settings.maxNoteChars, 4000)
  assertEqual(settings.injectAfterCompaction, true)
  assertEqual(settings.refreshEveryTools, 10)
  assertEqual(resolveConfig({}).minPressureRatio, 0.6)
  assertEqual(resolveHandoffConfig({ enabled: false }).enabled, false)
  const clamped = resolveHandoffConfig({ handoffNotes: { minPressureRatio: 0.1, maxNoteChars: 999999, injectAfterCompaction: false, refreshEveryTools: 3 } })
  assertEqual(clamped.minPressureRatio, 0.3)
  assertEqual(clamped.maxNoteChars, 20000)
  assertEqual(clamped.injectAfterCompaction, false)
  assertEqual(clamped.refreshEveryTools, 3)
})

test('session ids are sanitized into one safe path segment', () => {
  const escaped = sanitizeSegment('../../etc/passwd')
  assertEqual(escaped, 'etc_passwd')
  assert(!escaped.includes('/') && !escaped.includes('\\') && !escaped.includes('..'))
  assertEqual(sanitizeSegment('C:\\Windows\\system32'), 'C__Windows_system32')
  assertEqual(sanitizeSegment(''), 'unknown')
  assertEqual(sanitizeSegment(null), 'unknown')
  assertEqual(sanitizeSegment('a'.repeat(200)).length, 64)
  assertEqual(sanitizeSegment('CON'), 'session-CON')
  assertEqual(noteRelativePath('sess-1'), NOTE_DIR + '/sess-1.md')
})

test('note paths never leave the workspace', () => {
  assertEqual(isInsideWorkspace('/ws', '/ws/.dsh/workflow-boost/handoff/a.md'), true)
  assertEqual(isInsideWorkspace('/ws', '/ws-other/a.md'), false)
  assertEqual(isInsideWorkspace('/ws', '/etc/passwd'), false)
  assertEqual(isInsideWorkspace('C:/Work', 'c:/work/x/y.md'), true)
  for (const id of ['../../etc/passwd', '..\\..\\win.ini', '/abs/path']) {
    const target = resolveNotePath('/ws', id)
    assertEqual(isInsideWorkspace('/ws', target), true, 'resolved path for ' + id + ' must stay inside')
    assert(target.endsWith('.md'))
  }
})

// --- pure rendering --------------------------------------------------------

test('renderHandoffNote carries goal, todos, Next, activity and edits', () => {
  const note = renderHandoffNote({
    sessionId: 'sess-1',
    workspace: '/ws',
    goal: { title: 'Ship handoffNotes', status: 'active' },
    todos: TODOS,
    toolRing: TOOL_RING,
    toolCount: 7,
    errorCount: 1,
    lastMutationSeq: 42,
    turn: 3,
    step: 2,
    now: '2026-11-12T08:00:00.000Z',
    maxNoteChars: 4000,
  })
  assert(note.startsWith('# Handoff notes — session sess-1'))
  assert(note.includes('Updated: 2026-11-12T08:00:00.000Z'))
  assert(note.includes('Workspace: /ws'))
  assert(note.includes('Position: turn 3 · step 2 · tool calls 7 (1 error(s))'))
  assert(note.includes('## Active goal'))
  assert(note.includes('Ship handoffNotes'))
  assert(note.includes('status: active'))
  assert(note.includes('Progress: 1/3 complete, 1 in progress.'))
  assert(note.includes('- [x] 1. 读契约'))
  assert(note.includes('- [>] 2. 写 handoffNotes（验收：单测全绿）'))
  assert(note.includes('- [ ] 3. 更新 README'))
  assert(note.includes('## Next'))
  assert(note.includes('2. 写 handoffNotes（验收：单测全绿）'))
  assert(note.includes('## Recent tool activity'))
  assert(note.includes('- read ✓'))
  assert(note.includes('- bash ✗'))
  assert(note.includes('Edits since seq 42'))
  assert(note.includes(MODEL_NOTES_HEADING))
})

test('renderHandoffNote degrades when goal and todos are missing', () => {
  const note = renderHandoffNote({ sessionId: 's2', todos: null, toolRing: [], lastMutationSeq: -1, now: 0 })
  assert(note.includes('(no active goal recorded by the goals service)'))
  assert(note.includes('(no task list recorded yet)'))
  assert(note.includes('No write/edit recorded in this session yet.'))
  assert(note.includes('- (unnamed tool)') === false)
  assert(note.includes('(no tool calls recorded yet)'))
})

test('a refresh preserves model-authored notes', () => {
  const first = renderHandoffNote({ sessionId: 's3', todos: TODOS, toolRing: TOOL_RING, now: 0 })
  const withModel = first + '\n\n' + MODEL_NOTES_HEADING + '\nremember: the flaky test is order-dependent'
  const refreshed = renderHandoffNote({
    sessionId: 's3',
    todos: TODOS,
    toolRing: TOOL_RING,
    previousText: withModel,
    now: 1,
  })
  assert(refreshed.includes('remember: the flaky test is order-dependent'))
  assertEqual((refreshed.match(/# Handoff notes/gu) ?? []).length, 1, 'refresh must not duplicate generated headers')

  const rawOnly = 'raw model note without a heading'
  const fromRaw = renderHandoffNote({ sessionId: 's3', todos: TODOS, previousText: rawOnly, now: 2 })
  assert(fromRaw.includes(rawOnly), 'model text without the generated header is preserved too')
})

test('notes truncate to maxNoteChars with an explicit marker', () => {
  const longTodos = []
  for (let index = 0; index < 80; index += 1) longTodos.push({ content: 'task-' + index + ' ' + 'x'.repeat(80), status: 'pending' })
  const note = renderHandoffNote({ sessionId: 's4', todos: longTodos, toolRing: TOOL_RING, maxNoteChars: 500 })
  assert(note.length <= 500)
  assert(note.includes('[... note truncated at 500 characters ...]'))
  const clipped = truncateNote('x'.repeat(100), 40)
  assertEqual(clipped.length, 40, 'a budget too small for the marker simply clips')
  assert(!clipped.includes('truncated'))
  const marked = truncateNote('x'.repeat(100), 60)
  assert(marked.length <= 60)
  assert(marked.includes('truncated'))
  assertEqual(truncateNote('short', 100), 'short')
  assertEqual(truncateNote('x'.repeat(100), 10).length, 10, 'marker must fit or be dropped, never exceed the budget')
})

test('notices and post-compaction injections stay bounded and useful', () => {
  const note = renderHandoffNote({
    sessionId: 's5',
    goal: { title: 'Ship handoffNotes' },
    todos: TODOS,
    toolRing: TOOL_RING,
    lastMutationSeq: 7,
    now: 0,
  })
  const path = noteRelativePath('s5')
  const notice = renderHandoffNotice({ noteText: note, notePath: path, reason: 'pressure' })
  assert(notice.includes('[Handoff note — automatically refreshed under context pressure'))
  assert(notice.includes(path))
  assert(notice.includes('Goal: Ship handoffNotes'))
  assert(notice.includes('Next: 2.'))
  assert(notice.length <= 800)
  const injection = renderHandoffInjection({ noteText: note, notePath: path })
  assert(injection.includes('[Handoff note — re-injected after context compaction'))
  assert(injection.includes('# Handoff notes — session s5'))
  assert(injection.length <= 2400)
  assertEqual(renderHandoffNotice({ noteText: note, maxChars: 200 }).length <= 200, true)
})

test('pressure and compaction decisions follow the configured thresholds', () => {
  assertEqual(pressureRatioOf({ pressureTokens: 600, contextWindow: 1000 }), 0.6)
  assertEqual(pressureRatioOf({ pressureTokens: 600 }), undefined)
  assertEqual(pressureRatioOf(null), undefined)
  const base = { minPressureRatio: 0.6, refreshEveryTools: 10, pressureRatio: 0.7, toolsSinceNote: 9, compactionPending: false, notedThisTurn: false }
  assertEqual(shouldRefreshHandoff(base).action, 'none')
  assertEqual(shouldRefreshHandoff({ ...base, toolsSinceNote: 10 }).action, 'refresh')
  assertEqual(shouldRefreshHandoff({ ...base, toolsSinceNote: 10, pressureRatio: 0.59 }).action, 'none')
  assertEqual(shouldRefreshHandoff({ ...base, toolsSinceNote: 10, notedThisTurn: true }).action, 'none')
  assertEqual(shouldRefreshHandoff({ ...base, toolsSinceNote: 1, compactionPending: true }).action, 'inject-compaction')
  assertEqual(shouldRefreshHandoff({ ...base, toolsSinceNote: 3, refreshEveryTools: 3 }).action, 'refresh')
})

// --- wiring over fakes -----------------------------------------------------

async function createWiring(options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'wfb-handoff-'))
  const folded = {
    todos: options.todos === undefined ? TODOS.map((todo) => ({ ...todo })) : options.todos,
    toolRing: TOOL_RING.map((entry) => ({ ...entry })),
    toolCount: 3,
    errorCount: 1,
    lastMutationSeq: 9,
    turn: 1,
    step: 2,
    lastCompactionEndSeq: -1,
  }
  const services = {
    workingDirectory: { get: () => workspace },
    tokenMeter: {
      contextPressure: () => (options.pressureRatio === undefined
        ? { pressureTokens: 200, contextWindow: 1000 }
        : { pressureTokens: Math.round(options.pressureRatio * 1000), contextWindow: 1000 }),
    },
    ...options.services,
  }
  const context = createFakeContext({ services })
  const session = createFakeSession({ id: options.sessionId ?? 'sess-1' })
  const state = { log() {}, sessionState: { stateOf: () => folded }, loadHost: fakeLoadHost }
  const disposer = install(context.ctx, { handoffNotes: { enabled: true } }, state)
  if (disposer !== undefined) await disposer.ready
  const notePath = join(workspace, '.dsh', 'workflow-boost', 'handoff', sanitizeSegment(session.id, 64) + '.md')
  return {
    workspace,
    folded,
    context,
    session,
    state,
    disposer,
    notePath,
    exec: { agent: { session } },
    async postExecute() {
      const chain = context.listeners.get('tools/post-execute') ?? []
      let index = 0
      const next = async () => (index < chain.length ? chain[index++](this.exec, undefined, next) : { kind: 'accept' })
      return next()
    },
  }
}

function contextsOf(decision) {
  return Array.isArray(decision?.additionalContexts) ? decision.additionalContexts : []
}

async function drive(wiring, times) {
  const decisions = []
  for (let index = 0; index < times; index += 1) decisions.push(await wiring.postExecute())
  return decisions
}

test('pressure triggers one refresh and a short notice after N tool calls', async () => {
  const wiring = await createWiring({ pressureRatio: 0.7 })
  try {
    const firstNine = await drive(wiring, 9)
    for (const decision of firstNine) assertEqual(contextsOf(decision).length, 0)
    const tenth = await wiring.postExecute()
    const messages = contextsOf(tenth)
    assertEqual(messages.length, 1)
    assertEqual(messages[0].source.kind, 'dsh-workflow-boost')
    assertEqual(messages[0].source.form, 'notice')
    const text = messages[0].content[0].text
    assert(text.includes('[Handoff note — automatically refreshed under context pressure'))
    assert(text.includes('Next: 2. 写 handoffNotes（验收：单测全绿）'))
    assert(text.includes(noteRelativePath('sess-1')))
    assert(existsSync(wiring.notePath), 'note file must be written')
    const file = await readFile(wiring.notePath, 'utf8')
    assert(file.includes('# Handoff notes — session sess-1'))
    assert(file.includes('## Active goal'))
  } finally {
    wiring.disposer?.()
    await rm(wiring.workspace, { recursive: true, force: true })
  }
})

test('the pressure notice is injected at most once per turn', async () => {
  const wiring = await createWiring({ pressureRatio: 0.8 })
  try {
    await drive(wiring, 10)
    const again = await drive(wiring, 10)
    for (const decision of again) assertEqual(contextsOf(decision).length, 0, 'same turn stays silent')
    wiring.folded.turn = 2
    const nextTurn = await drive(wiring, 10)
    assertEqual(nextTurn.reduce((total, decision) => total + contextsOf(decision).length, 0), 1, 'a new turn may refresh again once')
  } finally {
    wiring.disposer?.()
    await rm(wiring.workspace, { recursive: true, force: true })
  }
})

test('a compaction checkpoint injects the rendered note once', async () => {
  const wiring = await createWiring({ pressureRatio: 0.1 })
  try {
    const before = await drive(wiring, 3)
    for (const decision of before) assertEqual(contextsOf(decision).length, 0)
    await wiring.context.emit('session/event', wiring.session, { type: 'compaction/end', seq: 77, data: {} })
    wiring.folded.lastCompactionEndSeq = 77
    const after = await wiring.postExecute()
    const messages = contextsOf(after)
    assertEqual(messages.length, 1)
    const text = messages[0].content[0].text
    assert(text.includes('[Handoff note — re-injected after context compaction'))
    assert(text.includes('# Handoff notes — session sess-1'))
    assert(existsSync(wiring.notePath))
    const afterAgain = await wiring.postExecute()
    assertEqual(contextsOf(afterAgain).length, 0, 'pending compaction is consumed once')
  } finally {
    wiring.disposer?.()
    await rm(wiring.workspace, { recursive: true, force: true })
  }
})

test('handoff_note reads, writes and appends inside the plugin directory', async () => {
  const wiring = await createWiring({ pressureRatio: 0.8 })
  try {
    const tool = wiring.context.tools.find((definition) => definition.name === 'handoff_note')
    assert(tool !== undefined, 'handoff_note must be registered')
    const write = await tool.execute({ action: 'write', text: '# my plan\nkeep the failing test' }, wiring.exec)
    assert(write.includes('succeeded'))
    assertEqual(await readFile(wiring.notePath, 'utf8'), '# my plan\nkeep the failing test')
    const read = await tool.execute({ action: 'read' }, wiring.exec)
    assert(read.includes('keep the failing test'))
    const append = await tool.execute({ action: 'append', text: 'second note' }, wiring.exec)
    assert(append.includes('succeeded'))
    const combined = await readFile(wiring.notePath, 'utf8')
    assert(combined.includes('keep the failing test') && combined.includes('second note'))
    const missing = await tool.execute({ action: 'write' }, wiring.exec)
    assert(missing.includes('requires a non-empty text argument'))
    const unknown = await tool.execute({ action: 'explode' }, wiring.exec)
    assert(unknown.includes('unknown action'))
    wiring.folded.turn = 9
    wiring.folded.todos = TODOS.map((todo) => ({ ...todo }))
    const refreshed = await drive(wiring, 10)
    assertEqual(contextsOf(refreshed[9]).length, 1)
    const afterRefresh = await readFile(wiring.notePath, 'utf8')
    assert(afterRefresh.includes(MODEL_NOTES_HEADING))
    assert(afterRefresh.includes('keep the failing test'), 'model notes survive a state refresh')
  } finally {
    wiring.disposer?.()
    await rm(wiring.workspace, { recursive: true, force: true })
  }
})

test('writes go through ctx.fs when the service is detectable', async () => {
  const calls = []
  const fakeFs = {
    async resolve(pathValue, opts) {
      calls.push(['resolve', pathValue, opts])
      return { targetKey: 'fake-key', displayPath: pathValue }
    },
    async readText(target) {
      calls.push(['readText', target.displayPath])
      const error = new Error('missing')
      error.code = 'FS_NOT_FOUND'
      throw error
    },
    async writeText(target, content) {
      calls.push(['writeText', target.displayPath, content.length])
      return { operation: 'create' }
    },
  }
  const wiring = await createWiring({ pressureRatio: 0.1, services: { fs: fakeFs } })
  try {
    await wiring.context.emit('session/event', wiring.session, { type: 'compaction/end', seq: 9, data: {} })
    wiring.folded.lastCompactionEndSeq = 9
    const decision = await wiring.postExecute()
    assertEqual(contextsOf(decision).length, 1, 'injection still happens when the host fs service owns the write')
    const operations = calls.map((call) => call[0])
    assert(operations.includes('resolve'), 'paths are resolved through ctx.fs')
    assert(operations.includes('readText'), 'the existing note is read through ctx.fs')
    assert(operations.includes('writeText'), 'the refreshed note is written through ctx.fs')
    const write = calls.find((call) => call[0] === 'writeText')
    const writtenPath = write[1].replaceAll('\\', '/')
    assert(writtenPath.includes('.dsh/workflow-boost/handoff'), 'note path goes through ctx.fs: ' + writtenPath)
    assert(writtenPath.endsWith('.md'))
  } finally {
    wiring.disposer?.()
    await rm(wiring.workspace, { recursive: true, force: true })
  }
})

test('read falls back to a state-derived note before the first write', async () => {
  const wiring = await createWiring({ pressureRatio: 0.1 })
  try {
    const tool = wiring.context.tools.find((definition) => definition.name === 'handoff_note')
    const read = await tool.execute({ action: 'read' }, wiring.exec)
    assert(read.includes('No handoff note file exists yet'))
    assert(read.includes('# Handoff notes — session sess-1'))
    assert(read.includes('写 handoffNotes'))
    assertEqual(existsSync(wiring.notePath), false, 'a read must not create the file')
  } finally {
    wiring.disposer?.()
    await rm(wiring.workspace, { recursive: true, force: true })
  }
})

test('a traversal-shaped session id still writes inside the workspace', async () => {
  const wiring = await createWiring({ sessionId: '../../escape', pressureRatio: 0.1 })
  try {
    await wiring.context.emit('session/event', wiring.session, { type: 'compaction/end', seq: 5, data: {} })
    wiring.folded.lastCompactionEndSeq = 5
    const decision = await wiring.postExecute()
    assertEqual(contextsOf(decision).length, 1)
    assertEqual(existsSync(wiring.notePath), true)
    assertEqual(isInsideWorkspace(wiring.workspace, wiring.notePath), true)
    assert(existsSync(join(wiring.workspace, '..', 'escape.md')) === false)
  } finally {
    wiring.disposer?.()
    await rm(wiring.workspace, { recursive: true, force: true })
  }
})

test('missing workspace or broken context fails open', async () => {
  const context = createFakeContext({ services: { tokenMeter: { contextPressure: () => ({ pressureTokens: 900, contextWindow: 1000 }) } } })
  const session = createFakeSession()
  const state = { log() {}, sessionState: { stateOf: () => ({ todos: TODOS, toolRing: TOOL_RING, turn: 1 }) }, loadHost: fakeLoadHost }
  const disposer = install(context.ctx, { handoffNotes: { enabled: true } }, state)
  assertEqual(typeof disposer, 'function')
  await disposer.ready
  for (let index = 0; index < 12; index += 1) {
    const decision = await (async () => {
      const chain = context.listeners.get('tools/post-execute') ?? []
      let cursor = 0
      const next = async () => (cursor < chain.length ? chain[cursor++]({ agent: { session } }, undefined, next) : { kind: 'accept' })
      return next()
    })()
    assertEqual(contextsOf(decision).length, 0, 'no workspace means no injection')
  }
  disposer()
  const broken = {
    logger: { info() {}, warn() {}, debug() {} },
    on() { throw new Error('boom') },
    get() { throw new Error('boom') },
    effect() { throw new Error('boom') },
    tools: { register() { throw new Error('boom') } },
  }
  const brokenState = { log() {}, loadHost: () => Promise.reject(new Error('no host')) }
  let result
  try {
    result = install(broken, { handoffNotes: { enabled: true } }, brokenState)
  } catch (error) {
    throw new Error('install must fail open: ' + error.message)
  }
  assert(result === undefined || typeof result === 'function')
})
