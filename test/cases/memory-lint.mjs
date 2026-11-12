/** Case file: memoryLint (instruction-file audit + memory proposals). */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, assert } from '../harness.mjs'
import * as core from '../../lib/pure/memory-core.js'
import { install, resolveSettings, proposalPath } from '../../lib/memory-lint.js'

/** Minimal ctx exposing the documented seams this module reads. */
function makeCtx(options = {}) {
  const listeners = new Map()
  const registered = []
  const services = options.services ?? {}
  const ctx = {
    listeners,
    registered,
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    get(name) {
      if (name === 'workingDirectory') return options.workingDirectory
      if (name === 'fs') return options.fs
      return services[name]
    },
    tools: { register(definition) { registered.push(definition); return () => {} } },
  }
  return ctx
}

function makeState(options = {}) {
  return {
    logs: [],
    log(level, message) { this.logs.push([level, message]) },
    loadHost: options.loadHost ?? (async () => ({ defineTool: (definition) => definition })),
    sessionState: { stateOf: () => ({ turn: 1 }), onEvent: () => () => {} },
  }
}

async function withWorkspace(fn) {
  const workspace = await mkdtemp(join(tmpdir(), 'wfb-memory-'))
  try {
    return await fn(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

async function setup(ctx, config, state) {
  const disposer = install(ctx, config, state)
  assert(typeof disposer === 'function', 'install returned a disposer')
  await disposer.ready
  await new Promise((resolve) => setImmediate(resolve))
  return disposer
}

function findTool(ctx, name) {
  const tool = ctx.registered.find((definition) => definition.name === name)
  assert(tool !== undefined, 'tool ' + name + ' registered')
  return tool
}

/** Run one registered tool with a fake execution context. */
async function runTool(ctx, name, args, session) {
  return findTool(ctx, name).execute(args, { agent: { session }, signal: undefined })
}

/** Fake ctx.fs service backed by node fs, counting host-API usage. */
function makeFsService(state) {
  const calls = { resolve: 0, stat: 0, readText: 0 }
  return {
    calls,
    async resolve(path) { calls.resolve += 1; return { displayPath: String(path).replace(/\\/gu, '/'), targetKey: String(path) } },
    async stat(target) {
      calls.stat += 1
      try {
        const info = await state.stat(target.displayPath)
        return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
      } catch { return undefined }
    },
    async readText(target) { calls.readText += 1; return state.readFile(target.displayPath, 'utf8') },
  }
}

/** Wire a post-execute listener invocation the way Cordis would. */
async function runPost(ctx, exec) {
  const listeners = ctx.listeners.get('tools/post-execute') ?? []
  assert(listeners.length >= 1, 'post-execute listener not registered')
  return listeners[0](exec, { isError: false }, async () => ({ kind: 'accept' }))
}

test('core: duplicate headings with different content are flagged, identical ones are not', () => {
  const different = core.auditDuplicateHeadings({
    display: 'AGENTS.md',
    absolutePath: 'C:/ws/AGENTS.md',
    text: '# Rules\n## Package manager\nuse pnpm\n## Package manager\nuse npm\n',
  })
  assert(different.length === 1, 'one duplicate heading finding expected, got ' + different.length)
  assert(different[0].rule === 'duplicate-heading' && different[0].severity === 'warning', 'rule/severity')
  assert(different[0].line === 4, 'flagged line points at the duplicate, got ' + different[0].line)

  const identical = core.auditDuplicateHeadings({
    display: 'AGENTS.md',
    absolutePath: 'C:/ws/AGENTS.md',
    text: '## Notes\nsame body\n## Notes\nsame body\n',
  })
  assert(identical.length === 0, 'identical bodies are noise, not a finding')

  const fenced = core.auditDuplicateHeadings({
    display: 'AGENTS.md',
    absolutePath: 'C:/ws/AGENTS.md',
    text: '# A\n' + String.fromCharCode(96, 96, 96) + 'md\n## Not a heading\n' + String.fromCharCode(96, 96, 96) + '\n## A\ndifferent\n',
  })
  assert(fenced.length === 1, 'headings inside code fences are ignored, only the real duplicate remains')
})

test('core: contradictory directives are detected without flagging negations as positives', () => {
  const file = { display: 'CLAUDE.md', absolutePath: 'C:/ws/CLAUDE.md', text: '' }
  const polarity = core.auditConflictingRules({ ...file, text: '- never use vitest\n- use vitest\n' })
  assert(polarity.some((finding) => finding.severity === 'error' && finding.message.includes('vitest')), 'same-token polarity error: ' + JSON.stringify(polarity))
  assert(!polarity.some((finding) => finding.message.includes('line 1 says to use')), 'a negated line must not become the positive side')

  const family = core.auditConflictingRules({ ...file, text: '- Use npm for installs\n- Use pnpm for installs\n' })
  assert(family.some((finding) => finding.rule === 'conflicting-rule' && /npm/.test(finding.message) && /pnpm/.test(finding.message)), 'package-manager contradiction detected')

  const alwaysNever = core.auditConflictingRules({ ...file, text: '- Always run the frontend tests\n- Never run the frontend tests\n' })
  assert(alwaysNever.length >= 1, 'always vs never phrase detected')

  const coherent = core.auditConflictingRules({ ...file, text: '- Use pnpm\n- Run the unit tests before committing\n' })
  assert(coherent.length === 0, 'coherent rules produce no conflict')
})

test('core: dead @imports and relative links are reported, valid/external ones are not', () => {
  const file = {
    display: 'AGENTS.md',
    absolutePath: 'C:/ws/AGENTS.md',
    text: '# Rules\n@import style/rules.md\nSee [guide](docs/guide.md) and [web](https://example.com/x.md).\n',
  }
  const findings = core.auditReferences(file, (candidate) => candidate.includes('missing') ? 'missing' : candidate.includes('style') ? 'missing' : 'exists')
  assert(findings.length === 1, 'only the dead @import is missing, got ' + JSON.stringify(findings))
  assert(findings[0].message.includes('style/rules.md'), 'import target named: ' + findings[0].message)
  const external = core.auditReferences({ ...file, text: '[web](https://example.com/x.md) [anchor](#rules)' }, () => 'missing')
  assert(external.length === 0, 'external URLs and anchors are ignored')
  assert(core.extractReferences('@~/home-notes.md').length === 0, 'home imports are ignored: they are outside the project chain')
  assert(core.referenceCandidate(file, '~/home-notes.md') === undefined, 'home imports are not resolved into the project')
})

test('core: size, empty and TODO rules plus severity ordering', () => {
  const big = core.auditOversized({ display: 'AGENTS.md', text: 'x\n'.repeat(600), size: 1200 })
  assert(big.length === 1 && big[0].rule === 'oversized-file', 'line-limit oversize flagged')
  assert(big[0].message.includes('skill'), 'oversize suggests a skill')
  const bigBytes = core.auditOversized({ display: 'AGENTS.md', text: 'x', size: 40000 })
  assert(bigBytes.length === 1, 'byte-limit oversize flagged')
  assert(core.auditEmpty({ display: 'EMPTY.md', text: '  \n' }).length === 1, 'empty file flagged')
  assert(core.auditTodoMarkers({ display: 'AGENTS.md', text: 'ok\nTODO rotate the key\nFIXME later\n' }).length === 1, 'TODO markers aggregated')

  const audit = core.auditMemoryFiles([
    { display: 'b.md', absolutePath: 'C:/ws/b.md', text: 'TODO one' },
    { display: 'a.md', absolutePath: 'C:/ws/a.md', text: '' },
    { display: 'c.md', absolutePath: 'C:/ws/c.md', text: '- never use npm\n- use npm\n' },
  ], {})
  assert(audit.findings[0].severity === 'error', 'errors sort before warnings/info')
  assert(audit.counts.error >= 1 && audit.counts.info >= 2, 'counts: ' + JSON.stringify(audit.counts))
})

test('core: project-root discovery and candidate chain stay inside the chain', () => {
  const marker = (path) => path.toLowerCase() === 'c:/repo/.git'
  assert(core.findProjectRoot('C:/repo/src/deep', marker) === 'C:/repo', 'project root found by walking up')
  assert(core.findProjectRoot('D:/standalone/x', marker) === 'D:/standalone/x', 'no marker means the endpoint itself')
  assert(core.isInsidePath('C:/repo', 'C:/repo/src/a.md') === true, 'inside path')
  assert(core.isInsidePath('C:/repo', 'C:/repo-evil/a.md') === false, 'sibling prefix is outside')
  assert(core.isInsidePath('C:/repo', 'C:/other/a.md') === false, 'unrelated path is outside')
  const candidates = core.instructionCandidates('C:/repo', 'C:/repo/src', 6)
  assert(candidates.length === 6, 'maxFiles caps the candidate list')
  assert(candidates[0].absolutePath === 'C:/repo/AGENTS.md', 'root AGENTS.md comes first: ' + candidates[0].absolutePath)
  const compact = core.displayPath('C:/repo', 'C:/repo/src/AGENTS.md')
  assert(compact === 'src/AGENTS.md', 'workspace-relative display path, got ' + compact)
})

test('core: proposal dedupe, corrupt-line tolerance and truncation', () => {
  const first = core.planProposalAppend({ entries: [], text: 'Use pnpm', maxProposals: 3, createdAt: '2026-01-01T00:00:00Z' })
  assert(first.status === 'added' && first.entries.length === 1, 'first proposal added')
  const duplicate = core.planProposalAppend({ entries: first.entries, text: '  use   PNPM ', maxProposals: 3 })
  assert(duplicate.status === 'duplicate', 'case/whitespace variant is a duplicate')
  let entries = first.entries
  for (const text of ['Always run tests', 'Never commit secrets', 'Prefer small diffs']) {
    entries = core.planProposalAppend({ entries, text, maxProposals: 3 }).entries
  }
  assert(entries.length === 3, 'maxProposals caps the store')
  assert(entries[2].text === 'Prefer small diffs', 'newest proposal kept')
  assert(!entries.some((entry) => entry.text === 'Use pnpm'), 'oldest proposal dropped')

  const parsed = core.parseProposalJsonl('{"text":"a"}\nnot json\n{"text":"  "}\n{"text":"b","reason":"r"}')
  assert(parsed.length === 2 && parsed[1].reason === 'r', 'corrupt/invalid lines ignored: ' + JSON.stringify(parsed))
  const invalid = core.planProposalAppend({ entries: [], text: '   ' })
  assert(invalid.status === 'invalid', 'empty text rejected')
  assert(core.renderProposalResult({ status: 'duplicate', entries }).includes('identical'), 'duplicate wording')
  assert(core.renderPendingNotice(3).includes('3 pending memory proposal'), 'pending notice wording: ' + core.renderPendingNotice(3))
  assert(core.renderPendingNotice(0) === '', 'zero pending renders nothing')
})

test('runtime: memory_audit walks the project root to cwd chain and reports findings', async () => {
  await withWorkspace(async (repoRoot) => {
    await mkdir(join(repoRoot, '.git'), { recursive: true })
    await writeFile(join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await mkdir(join(repoRoot, 'sub'), { recursive: true })
    const rootFile = join(repoRoot, 'AGENTS.md')
    await writeFile(rootFile, '# Root rules\n- Use npm for installs\n- Use pnpm for installs\n')
    await writeFile(join(repoRoot, 'sub', 'CLAUDE.md'), '# Sub rules\n@import missing-notes.md\n')

    const settings = resolveSettings({ memoryLint: { enabled: true } })
    assert(settings.enabled === true && settings.injectPending === true, 'defaults resolved')
    const ctx = makeCtx({ workingDirectory: { get: () => join(repoRoot, 'sub') } })
    const state = makeState()
    await setup(ctx, { memoryLint: { enabled: true } }, state)

    const report = await runTool(ctx, 'memory_audit', {}, { id: 'sess-a' })
    assert(report.includes('Memory audit'), 'report header: ' + report.slice(0, 120))
    assert(report.includes('Project root:') && report.includes('.git') === false, 'project root line present')
    assert(report.includes('AGENTS.md'), 'root instruction file scanned')
    assert(report.includes('CLAUDE.md'), 'nested instruction file scanned')
    assert(report.includes('conflicting-rule'), 'npm/pnpm contradiction reported')
    assert(report.includes('broken-reference'), 'dead import reported')
    assert(report.includes('never modifies instruction files'), 'read-only promise stated')
  })
})

test('runtime: memory_audit uses ctx.fs when detectable and skips oversized files', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'AGENTS.md'), '# Rules\nUse pnpm\n')
    await writeFile(join(workspace, 'CLAUDE.md'), 'x'.repeat(5000))
    const fsp = await import('node:fs/promises')
    const fsService = makeFsService(fsp)
    const ctx = makeCtx({ workingDirectory: { get: () => workspace }, fs: fsService })
    await setup(ctx, { memoryLint: { enabled: true, maxFileBytes: 1024 } }, makeState())
    const report = await runTool(ctx, 'memory_audit', {}, { id: 'sess-b' })
    assert(fsService.calls.resolve > 0 && fsService.calls.readText > 0, 'ctx.fs API used, calls=' + JSON.stringify(fsService.calls))
    assert(report.includes('AGENTS.md'), 'small file audited')
    assert(report.includes('Skipped:') && report.includes('maxFileBytes'), 'oversized file skipped with a note: ' + report)
  })
})

test('runtime: memory_audit honours the path argument and the workspace boundary', async () => {
  await withWorkspace(async (repoRoot) => {
    await mkdir(join(repoRoot, '.git'), { recursive: true })
    await mkdir(join(repoRoot, 'sub'), { recursive: true })
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Root\nTODO clean me\n')
    await writeFile(join(repoRoot, 'sub', 'AGENTS.md'), '# Sub\n')
    const ctx = makeCtx({ workingDirectory: { get: () => repoRoot } })
    await setup(ctx, {}, makeState())
    const subReport = await runTool(ctx, 'memory_audit', { path: 'sub' }, { id: 'sess-c' })
    assert(subReport.includes('Files scanned:') && subReport.includes('AGENTS.md'), 'subdirectory audit works')
    assert(subReport.includes('TODO'), 'root finding still visible through the chain')

    const outside = await runTool(ctx, 'memory_audit', { path: '../outside' }, { id: 'sess-c' })
    assert(outside.includes('outside the session workspace'), 'escape refused: ' + outside)
    const missing = await runTool(ctx, 'memory_audit', { path: 'nope' }, { id: 'sess-c' })
    assert(missing.includes('does not exist'), 'missing path explained')
  })
})

test('runtime: memory_propose stores JSONL deduped and capped, and never edits AGENTS.md', async () => {
  await withWorkspace(async (workspace) => {
    const agentsFile = join(workspace, 'AGENTS.md')
    await writeFile(agentsFile, '# Rules\nOriginal content\n')
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    await setup(ctx, { memoryLint: { enabled: true, maxProposals: 2 } }, makeState())
    const session = { id: 'sess-propose' }

    const first = await runTool(ctx, 'memory_propose', { text: 'Use pnpm for installs', reason: 'user correction' }, session)
    assert(first.includes('recorded a new pending proposal'), 'first proposal recorded: ' + first)
    const duplicate = await runTool(ctx, 'memory_propose', { text: '  use   PNPM for installs ', reason: 'again' }, session)
    assert(duplicate.includes('identical proposal'), 'duplicate rejected: ' + duplicate)

    await runTool(ctx, 'memory_propose', { text: 'Always run unit tests' }, session)
    await runTool(ctx, 'memory_propose', { text: 'Never commit secrets' }, session)
    const store = proposalPath(workspace)
    const raw = await readFile(store, 'utf8')
    const entries = raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
    assert(entries.length === 2, 'maxProposals kept 2 entries, got ' + entries.length)
    assert(entries[1].text === 'Never commit secrets', 'newest kept')
    assert(!entries.some((entry) => entry.text.includes('pnpm')), 'oldest dropped')
    assert(await readFile(agentsFile, 'utf8') === '# Rules\nOriginal content\n', 'AGENTS.md untouched')
  })
})

test('runtime: injectPending notices once per agent and only when proposals exist', async () => {
  await withWorkspace(async (workspace) => {
    const storeDir = join(workspace, '.dsh', 'workflow-boost')
    await mkdir(storeDir, { recursive: true })
    const store = join(storeDir, 'memory-proposals.jsonl')
    await writeFile(store, JSON.stringify({ id: 'a', text: 'Use pnpm', createdAt: '2026-01-01T00:00:00Z' }) + '\n')
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    const state = makeState()
    const disposer = await setup(ctx, { memoryLint: { enabled: true, injectPending: true } }, state)
    const agent = { session: { id: 'sess-inject' } }
    const first = await runPost(ctx, { agent })
    const notice = first.additionalContexts?.[0]
    assert(notice !== undefined, 'pending notice injected')
    const text = notice.content[0].text
    assert(text.includes('1 pending memory proposal') && text.includes('run memory_audit'), 'notice wording: ' + text)
    const second = await runPost(ctx, { agent })
    assert(second.additionalContexts === undefined, 'only once per agent')
    const otherAgent = await runPost(ctx, { agent: { session: { id: 'sess-other' } } })
    assert(otherAgent.additionalContexts?.[0] !== undefined, 'a different agent gets its own notice')
    disposer()
  })

  await withWorkspace(async (workspace) => {
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    await setup(ctx, { memoryLint: { enabled: true, injectPending: false } }, makeState())
    assert((ctx.listeners.get('tools/post-execute') ?? []).length === 0, 'disabled injection registers no listener')
  })
})

test('runtime: missing services and broken hosts fail open', async () => {
  await withWorkspace(async (workspace) => {
    const ctx = makeCtx({ workingDirectory: undefined })
    await setup(ctx, { memoryLint: { enabled: true } }, makeState())
    const noWorkspace = await runTool(ctx, 'memory_audit', {}, { id: 'sess-d' })
    assert(noWorkspace.includes('workingDirectory service is unavailable'), 'missing workspace explained: ' + noWorkspace)
    const propose = await runTool(ctx, 'memory_propose', { text: 'x' }, { id: 'sess-d' })
    assert(propose.includes('workingDirectory service is unavailable'), 'proposal fails open without a workspace')
    assert((ctx.listeners.get('tools/post-execute') ?? []).length === 1, 'injection listener stays harmless')
  })

  const broken = {
    on() { throw new Error('boom') },
    get() { throw new Error('boom') },
    tools: { register() { throw new Error('boom') } },
  }
  const state = makeState({ loadHost: () => Promise.reject(new Error('no host')) })
  let disposer
  try {
    disposer = install(broken, { memoryLint: { enabled: true } }, state)
  } catch (error) {
    throw new Error('install must be fail-open, threw: ' + error.message)
  }
  assert(typeof disposer === 'function', 'disposer returned on a broken host')
  await disposer.ready
  disposer()

  const disabled = install(makeCtx(), { memoryLint: { enabled: false } }, makeState())
  assert(disabled === undefined, 'disabled module returns no disposer')
  const settings = resolveSettings({ memoryLint: { maxFiles: -3, maxProposals: 5000, injectPending: false } })
  assert(settings.maxFiles === 1 && settings.maxProposals === 1000 && settings.injectPending === false, 'clamps applied: ' + JSON.stringify(settings))
})
