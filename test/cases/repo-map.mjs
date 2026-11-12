/**
 * repoMap 1.0.0 cases.
 *
 * Covers the 0.1.1 #6 acceptance points (workspace containment, no
 * symbol x file x full-text scan, deadline-bounded partial results) plus the
 * P1-6 enhancements (personalized PageRank, sqrt-damped edges, unreferenced
 * self loops, incremental disk index, focus filter, token budget). Async
 * cases (install/execute with a real temp workspace) run through atest() and
 * their failures are surfaced by one final synchronous harness test.
 */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, assert, assertEqual } from '../harness.mjs'
import { estimateTokens } from '../../lib/shared.js'
import * as core from '../../lib/pure/repo-map-core.js'
import { install } from '../../lib/repo-map.js'

/** One source-file record as the scanner would build it. */
function fileRecord(path, text, language = 'js') {
  return {
    path,
    language,
    symbols: core.extractSymbols(text, language),
    tokens: core.tokenizeIdentifiers(text),
  }
}

/** Wait for the async tool registration (install loads the host package lazily). */
function settled(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('extractSymbols: js/ts/python definitions, deduped and language-gated', () => {
  const jsText = 'export function helper() {}\nexport const arrow = () => {}\nclass Widget {}\nfunction helper() {}\n'
  const jsSymbols = core.extractSymbols(jsText, 'js')
  for (const name of ['helper', 'arrow', 'Widget']) assert(jsSymbols.includes(name), 'missing ' + name)
  assertEqual(jsSymbols.filter((name) => name === 'helper').length, 1, 'definition deduped')
  const pySymbols = core.extractSymbols('def run(x):\n  pass\nclass Job:\n  pass\n', 'py')
  assert(pySymbols.includes('run') && pySymbols.includes('Job'), 'python defs')
  assertEqual(core.extractSymbols('const x = 1', 'unknown-language'), [], 'unknown language ignored')
})

test('tokenizeIdentifiers: one-pass token counts per file', () => {
  const counts = core.tokenizeIdentifiers('const helper = helper + other\nhelper()\n')
  assert(counts instanceof Map, 'returns a Map')
  assertEqual(counts.get('helper'), 3)
  assertEqual(counts.get('other'), 1)
  assertEqual(core.tokenCount(counts, 'missing'), 0)
  assertEqual(core.tokenizeIdentifiers('').size, 0)
  const plain = { shared: 2 }
  assertEqual(core.tokenCount(plain, 'shared'), 2)
})

test('rankFiles: widely referenced definitions outrank isolated files', () => {
  const util = fileRecord('src/util.js', 'export function helper() { return 1 }\n')
  const alpha = fileRecord('src/alpha.js', 'export function alpha() { return helper() }\n')
  const beta = fileRecord('src/beta.js', 'export function beta() { return helper() + helper() }\n')
  const orphan = fileRecord('src/orphan.js', 'export function lonely() { return 0 }\n')
  const ranked = core.rankFiles([alpha, beta, util, orphan])
  assertEqual(ranked.length, 4)
  assertEqual(ranked[0].path, 'src/util.js', 'referenced definition file first')
  const orphanScore = ranked.find((entry) => entry.path === 'src/orphan.js').score
  assert(ranked[0].score > orphanScore, 'isolated file ranks below the referenced definition')
  assertEqual(ranked[0].chat, false)
})

test('rankFiles: sqrt edge damping and conversation personalization', () => {
  const one = fileRecord('lib/one.js', 'export function one() {}\n')
  const many = fileRecord('lib/many.js', 'export function many() {}\n')
  const callerText = 'export function callOne() { one() }\nexport function callMany() { many(); many(); many(); many(); many(); many(); many(); many(); many() }\n'
  const caller = fileRecord('lib/caller.js', callerText)
  const graph = core.buildRankGraph([one, many, caller])
  const row = graph.weights.get(graph.nodes.indexOf('lib/caller.js'))
  const oneWeight = row.get(graph.nodes.indexOf('lib/one.js'))
  const manyWeight = row.get(graph.nodes.indexOf('lib/many.js'))
  assert(Math.abs(oneWeight - 1) < 1e-9, 'one reference -> weight 1, got ' + oneWeight)
  assert(Math.abs(manyWeight - 3) < 1e-9, 'nine references -> sqrt(9) = 3, got ' + manyWeight)
  const plain = core.rankFiles([one, many, caller])
  const scoreOf = (path) => plain.find((entry) => entry.path === path).score
  assert(scoreOf('lib/many.js') > scoreOf('lib/one.js'), 'damped multi-referenced definition ranks higher')
  const alpha = fileRecord('src/alpha.js', 'export function alpha() {}\n')
  const zeta = fileRecord('src/zeta.js', 'export function zeta() {}\n')
  const personalized = core.rankFiles([alpha, zeta], { chatFiles: new Set(['src/zeta.js']) })
  assertEqual(personalized[0].path, 'src/zeta.js', 'chat file first')
  assertEqual(personalized[0].chat, true)
  const plainEqual = core.rankFiles([alpha, zeta], { chatFiles: new Set(['src/zeta.js']), personalize: false })
  assertEqual(plainEqual[0].path, 'src/alpha.js', 'path tie-break when personalization is off')
})

test('buildRankGraph: unreferenced definitions carry a 0.1 self loop', () => {
  const orphan = fileRecord('src/orphan.js', 'export function lonely() {}\n')
  const graph = core.buildRankGraph([orphan])
  assert(Math.abs((graph.selfLoops.get('src/orphan.js') ?? 0) - 0.1) < 1e-9, 'self loop weight 0.1')
  const used = fileRecord('src/used.js', 'export function used() {}\n')
  const caller = fileRecord('src/caller.js', 'used()\n')
  const referencedGraph = core.buildRankGraph([used, caller])
  assertEqual(referencedGraph.selfLoops.get('src/used.js') ?? 0, 0, 'referenced definition has no self loop')
  const manyOrphans = fileRecord('src/many-orphans.js', 'export function o1() {}\nexport function o2() {}\nexport function o3() {}\nexport function o4() {}\nexport function o5() {}\n')
  const mixed = core.rankFiles([used, caller, manyOrphans])
  assert(mixed[0].path !== 'src/many-orphans.js', 'many unreferenced defs do not dominate referenced files')
})

test('renderMap: focus filter, per-file cap and token budget', () => {
  const ranked = [
    { path: 'src/a.js', symbols: ['alpha', 'beta'] },
    { path: 'src/b.js', symbols: ['gamma'] },
  ]
  const all = core.renderMap(ranked, { budget: 500 })
  assertEqual(all.shown, 2)
  const focused = core.renderMap(ranked, { budget: 500, focus: 'beta' })
  assertEqual(focused.shown, 1)
  assert(focused.lines[0].includes('beta'))
  assert(!focused.lines.join(' ').includes('gamma'))
  const pathFocus = core.renderMap(ranked, { budget: 500, focus: 'src/b' })
  assertEqual(pathFocus.shown, 1)
  const tight = core.renderMap(ranked, { budget: 5 })
  assert(tight.usedTokens <= 5, 'budget respected')
  const capped = core.renderMap([{ path: 'x.js', symbols: ['a1', 'a2', 'a3'] }], { budget: 500, maxSymbolsPerFile: 2 })
  assert(capped.lines[0].includes('\u2026'), 'per-file symbol cap marked')
})

test('effectiveBudget: widens when the conversation has no files', () => {
  assertEqual(core.effectiveBudget(1000, { hasChatFiles: false, personalize: true }), 1500)
  assertEqual(core.effectiveBudget(1000, { hasChatFiles: true, personalize: true }), 1000)
  assertEqual(core.effectiveBudget(1000, { hasChatFiles: false, personalize: false }), 1000)
})

test('renderMapText: token budget and incomplete annotation', () => {
  const ranked = []
  for (let index = 0; index < 40; index += 1) {
    ranked.push({ path: 'src/file' + index + '.js', symbols: ['symbolNumber' + index, 'other' + index] })
  }
  const rendered = core.renderMapText({
    root: 'D:/ws',
    ranked,
    totalFiles: 40,
    totalSymbols: 80,
    budget: 300,
    focus: 'file',
    incomplete: ['time budget 20000ms exceeded while scanning'],
  })
  assert(rendered.text.includes('incomplete'), 'incomplete note present')
  assert(rendered.text.includes('time budget'), 'time budget reason present')
  assert(rendered.text.includes('Focus filter'), 'focus noted')
  assert(estimateTokens(rendered.text) <= 300, 'rendered within budget, got ' + estimateTokens(rendered.text))
})

test('classifyWorkspacePath: inside accepted; ../, system, NUL and symlink escapes refused', () => {
  const root = 'D:/work/repo'
  const inside = core.classifyWorkspacePath({ root, target: core.resolveRequestedPath(root, 'src/app.js') })
  assertEqual(inside.ok, true)
  assertEqual(inside.relative, 'src/app.js')
  const atRoot = core.classifyWorkspacePath({ root, target: root })
  assertEqual(atRoot.ok, true)
  assertEqual(atRoot.relative, '')
  const up = core.classifyWorkspacePath({ root, target: core.resolveRequestedPath(root, '../etc/passwd') })
  assertEqual(up.ok, false)
  assertEqual(up.code, 'outside-workspace')
  assert(up.message.includes('outside the workspace'), 'clear error: ' + up.message)
  const windows = core.classifyWorkspacePath({ root, target: 'C:/Windows/System32' })
  assertEqual(windows.ok, false)
  assertEqual(windows.code, 'system-path')
  const posix = core.classifyWorkspacePath({ root: '/home/me/project', target: '/etc/passwd' })
  assertEqual(posix.ok, false)
  const nul = core.classifyWorkspacePath({ root, target: 'D:/work/repo/a' + String.fromCharCode(0) + 'b.js' })
  assertEqual(nul.code, 'invalid-path')
  const symlink = core.classifyWorkspacePath({
    root,
    target: 'D:/work/repo/link/evil.js',
    realRoot: 'D:/work/repo',
    realTarget: 'C:/outside/evil.js',
  })
  assertEqual(symlink.ok, false)
  assertEqual(symlink.code, 'symlink-escape')
})

test('serializeIndex/parseIndex: roundtrip; corrupt or out-of-bounds cache discarded', () => {
  const records = [fileRecord('src/a.js', 'export function helper() {}\n')]
  records[0].mtimeMs = 1234.5
  records[0].size = 28
  const text = core.serializeIndex('D:/work/repo', records)
  const parsed = core.parseIndex(text, 'D:/work/repo')
  assert(parsed !== undefined)
  assertEqual(parsed.files.length, 1)
  assertEqual(parsed.files[0].path, 'src/a.js')
  assertEqual(parsed.files[0].tokens.helper, 1)
  assertEqual(core.parseIndex('{not json', 'D:/work/repo'), undefined)
  assertEqual(core.parseIndex('{}', 'D:/work/repo'), undefined)
  assertEqual(core.parseIndex(text, 'D:/other/repo'), undefined)
  const wrongVersion = JSON.parse(text)
  wrongVersion.version = 999
  assertEqual(core.parseIndex(JSON.stringify(wrongVersion), 'D:/work/repo'), undefined)
  const outOfBounds = JSON.parse(text)
  outOfBounds.files[0].path = '../../etc/passwd'
  assertEqual(core.parseIndex(JSON.stringify(outOfBounds), 'D:/work/repo'), undefined)
  assertEqual(core.INDEX_FILE, 'repomap-index.json')
  assertEqual(core.INDEX_DIR, '.dsh/workflow-boost')
})

test('extractPathHints/matchChatFiles: mentions matched, traversal and URLs ignored', () => {
  const hints = core.extractPathHints('Please update src/lib/util.mjs and ./lib/core.js; ignore https://example.com/x.js and version 1.2.3')
  assert(hints.includes('src/lib/util.mjs'), 'relative path hint: ' + JSON.stringify(hints))
  assert(hints.includes('./lib/core.js'), 'dot-relative hint')
  assert(!hints.some((hint) => hint.includes('example.com')), 'URL not treated as a file')
  const files = [{ path: 'src/lib/util.mjs' }, { path: 'lib/core.js' }]
  const matched = core.matchChatFiles(files, ['src/lib/util.mjs', './lib/core.js'])
  assertEqual(Array.from(matched).sort(), ['lib/core.js', 'src/lib/util.mjs'])
  const byBaseName = core.matchChatFiles(files, ['core.js'])
  assertEqual(Array.from(byBaseName), ['lib/core.js'])
  assertEqual(core.matchChatFiles(files, ['../secret.js']).size, 0, 'traversal hint ignored')
})

test('resolveConfig: defaults and clamps', () => {
  const defaults = core.resolveConfig({})
  assertEqual(defaults.enabled, true)
  assertEqual(defaults.maxFiles, 2500)
  assertEqual(defaults.tokenBudget, 1400)
  assertEqual(defaults.timeBudgetMs, 20000)
  assertEqual(defaults.incremental, true)
  assertEqual(defaults.personalize, true)
  const clamped = core.resolveConfig({ maxFiles: 1, tokenBudget: 999999, timeBudgetMs: 1, cacheTtlMs: -5, maxFileBytes: 1 })
  assertEqual(clamped.maxFiles, 10)
  assertEqual(clamped.tokenBudget, 20000)
  assertEqual(clamped.timeBudgetMs, 1000)
  assertEqual(clamped.cacheTtlMs, 0)
  assertEqual(clamped.maxFileBytes, 1024)
  assertEqual(core.resolveConfig({ enabled: false }).enabled, false)
})

const asyncFailures = []

async function atest(name, fn) {
  const entry = { name, error: undefined }
  try {
    await fn()
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error)
  }
  asyncFailures.push(entry)
}

await atest('rankFilesAsync: normal ranking equals sync ordering; past deadline is partial', async () => {
  const files = []
  for (let index = 0; index < 200; index += 1) {
    files.push(fileRecord('src/f' + index + '.js', 'export function fn' + index + '() {}\n'))
  }
  files.push(fileRecord('src/hub.js', 'export function hub() {}\n'))
  files.push(fileRecord('src/use.js', 'hub()\n'))
  const normal = await core.rankFilesAsync(files, {})
  assertEqual(normal.incomplete, false)
  assertEqual(normal.ranked.length, files.length)
  const syncRanked = core.rankFiles(files, {})
  assertEqual(normal.ranked[0].path, syncRanked[0].path, 'async and sync ordering agree')
  const timed = await core.rankFilesAsync(files, { deadline: Date.now() - 1 })
  assertEqual(timed.incomplete, true, 'past deadline marks incomplete')
  assertEqual(timed.ranked.length, files.length, 'partial ranking still returns every file')
})

await atest('install: missing host packages fails open without throwing', async () => {
  const warnings = []
  const disposer = install({}, {}, {
    log: (level, message) => {
      if (level === 'warn') warnings.push(String(message))
    },
    loadHost: async () => undefined,
  })
  assert(typeof disposer === 'function', 'returns a disposer')
  await settled(20)
  assert(warnings.some((line) => line.includes('did not provide defineTool') || line.includes('repo_map')), 'warns when defineTool is missing')
  disposer()
})

await atest('install: registers repo_map, maps a temp workspace, refuses outside paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'wfb-repomap-'))
  const outside = await mkdtemp(join(tmpdir(), 'wfb-repomap-outside-'))
  const registered = []
  const warnings = []
  try {
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(outside, 'secret.js'), 'export function secret() {}\n')
    let linked = false
    try {
      await symlink(outside, join(workspace, 'linked'), 'junction')
      linked = true
    } catch {
      linked = false
    }
    await writeFile(join(workspace, 'src', 'util.js'), 'export function helper() { return 1 }\n')
    await writeFile(join(workspace, 'src', 'app.js'), 'export function run() { return helper() }\n')
    const pluginState = {
      log: (level, message) => {
        if (level === 'warn') warnings.push(String(message))
      },
      loadHost: async () => ({ defineTool: (definition) => definition }),
    }
    const ctx = {
      get(name) {
        return name === 'workingDirectory' ? { get: () => workspace } : undefined
      },
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {}
        },
      },
    }
    const disposer = install(ctx, { repoMap: { cacheTtlMs: 0, timeBudgetMs: 20000, tokenBudget: 800 } }, pluginState)
    assert(typeof disposer === 'function', 'returns a disposer')
    await settled(30)
    assertEqual(registered.length, 1, 'repo_map registered')
    const tool = registered[0]
    assertEqual(tool.name, 'repo_map')
    const exec = { agent: { session: {} } }
    const text = await tool.execute({}, exec)
    assert(typeof text === 'string', 'execute returns text')
    assert(text.includes('Repository map'), 'map header rendered')
    assert(text.includes('src/util.js'), 'workspace file mapped')
    const refusal = await tool.execute({ path: '../' }, exec)
    assert(refusal.includes('refused'), 'outside path refused: ' + refusal.slice(0, 120))
    assert(refusal.includes('outside the workspace'), 'clear outside-workspace error')
    const systemRefusal = await tool.execute({ path: 'C:/Windows' }, exec)
    assert(systemRefusal.includes('refused'), 'system path refused')
    assert(systemRefusal.includes('protected system location'), 'system path reason')
    if (linked) {
      const escapeRefusal = await tool.execute({ path: 'linked' }, exec)
      assert(escapeRefusal.includes('refused'), 'symlink path refused: ' + escapeRefusal.slice(0, 120))
      assert(escapeRefusal.includes('symlink-escape'), 'symlink escape reported')
    }
    const indexText = await readFile(join(workspace, '.dsh', 'workflow-boost', 'repomap-index.json'), 'utf8')
    const parsedIndex = JSON.parse(indexText)
    assert(Array.isArray(parsedIndex.files) && parsedIndex.files.length >= 2, 'incremental disk index written')
    const second = await tool.execute({}, exec)
    assert(second.includes('Repository map'), 'second call maps from the incremental index')
    disposer()
    assertEqual(warnings.length, 0, 'no warnings: ' + warnings.join(' | '))
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

await atest('install: missing working directory returns a structured refusal', async () => {
  const registered = []
  const pluginState = {
    log: () => {},
    loadHost: async () => ({ defineTool: (definition) => definition }),
  }
  const ctx = { get: () => undefined, tools: { register(definition) { registered.push(definition); return () => {} } } }
  const disposer = install(ctx, { repoMap: { cacheTtlMs: 0 } }, pluginState)
  await settled(30)
  assertEqual(registered.length, 1)
  const text = await registered[0].execute({}, {})
  assert(text.includes('refused'), 'structured refusal')
  assert(text.includes('no-workspace'), 'no-workspace code')
  disposer()
})

test('async cases completed', () => {
  const failed = asyncFailures.filter((entry) => entry.error !== undefined)
  assert(failed.length === 0, failed.map((entry) => entry.name + ': ' + entry.error).join(' | '))
  assertEqual(asyncFailures.length, 4, 'async case count')
})
