/**
 * reviewGate 1.1.0 cases: config validation, git planning, diff parsing,
 * deterministic checks, report rendering, evidence records, tool registration
 * and the "git unavailable, nothing guessed" path — all in a clean Node process
 * with fake host seams (no @deepseek-ai packages, no real git).
 */
import { test, assert, assertEqual } from '../harness.mjs'
import {
  LARGE_DELETION_LINES,
  MAX_PATH_CHARS,
  REVIEW_CONTRACT,
  REVIEW_DEFAULTS,
  buildGitInvocation,
  buildGitPlan,
  buildReviewRecord,
  isConflictMarker,
  matchDebugPrint,
  matchSecret,
  normalizePaths,
  parseStatusPorcelain,
  parseUnifiedDiff,
  redactSecretSnippet,
  renderReviewReport,
  renderUnavailableReview,
  resolveReviewConfig,
  runChecks,
  sortFindings,
  truncateDiff,
  validateRef,
} from '../../lib/pure/review-core.js'
import { install, readReview, runReview } from '../../lib/review-gate.js'

const NOW = 1700000000000
const PRICES = undefined

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,6 @@',
  ' const a = 1',
  '+console.log(a)',
  '+const key = "AKIAIOSFODNN7EXAMPLE"',
  '+<<<<<<< HEAD',
  '-const old = 2',
  '+const next = 3',
].join('\n')

const CLEAN_DIFF = [
  'diff --git a/src/calc.js b/src/calc.js',
  '--- a/src/calc.js',
  '+++ b/src/calc.js',
  '@@ -1,2 +1,3 @@',
  ' const sum = (a, b) => a + b',
  '+const product = (a, b) => a * b',
].join('\n')

/** Parse + run all checks in one call, the way the host module does. */
function checkDiff(diffText, options = {}) {
  const parsed = parseUnifiedDiff(diffText)
  const checks = runChecks({ parsed, checks: options.checks ?? REVIEW_DEFAULTS.checks, focus: options.focus, truncated: options.truncated })
  return { parsed, checks }
}

/** Fake plugin state with injectable loader, runner, log and evidence map. */
function fakeState(overrides = {}) {
  const logs = []
  const calls = []
  return {
    log(level, message) { logs.push({ level, message }) },
    logs,
    calls,
    loadHost: () => ({ defineTool: (definition) => definition }),
    async runCommand(file, args, options) {
      calls.push({ file, args, options })
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    },
    reviews: new WeakMap(),
    ...overrides,
  }
}

/** Fake context exposing ctx.tools.register and the workingDirectory service. */
function fakeCtx(options = {}) {
  const tools = []
  const services = { ...(options.services ?? {}) }
  const ctx = {
    get(name) {
      if (Object.hasOwn(services, name)) return services[name]
      if (name === 'workingDirectory' && options.noCwd !== true) {
        return { get: () => options.cwd ?? 'C:/repo' }
      }
      return undefined
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
  }
  return { ctx, tools, services }
}

/** A fake git runner matching on the shell command line. */
function fakeGit(extra = {}) {
  return async (file, args, options) => {
    const line = String(args[args.length - 1] ?? '')
    if (line.includes('status --porcelain')) {
      return { code: 0, stdout: '?? notes.txt\n M src/app.js\n', stderr: '', timedOut: false, ...(extra.status ?? {}) }
    }
    if (line.includes('rev-parse')) {
      return { code: 0, stdout: 'abc1234\n', stderr: '', timedOut: false, ...(extra.revParse ?? {}) }
    }
    if (line.includes('--stat')) {
      return { code: 0, stdout: ' src/app.js | 4 ++++\n 1 file changed, 3 insertions(+), 1 deletion(-)\n', stderr: '', timedOut: false, ...(extra.stat ?? {}) }
    }
    return { code: 0, stdout: extra.diff ?? DIFF, stderr: '', timedOut: false, ...(extra.diffResult ?? {}) }
  }
}

// ---------------------------------------------------------------------------
// Configuration and argument safety
// ---------------------------------------------------------------------------

test('resolveReviewConfig applies defaults, switches and clamps', () => {
  const defaults = resolveReviewConfig({})
  assertEqual(defaults.enabled, true)
  assertEqual(defaults.maxDiffChars, 12000)
  assertEqual(defaults.checks, { secrets: true, conflictMarkers: true, debugPrints: true, largeDeletion: true })
  const custom = resolveReviewConfig({
    reviewGate: { enabled: false, maxDiffChars: 999999, checks: { secrets: false, debugPrints: false } },
  })
  assertEqual(custom.enabled, false)
  assertEqual(custom.maxDiffChars, 60000)
  assertEqual(custom.checks.secrets, false)
  assertEqual(custom.checks.conflictMarkers, true)
  assertEqual(resolveReviewConfig({ enabled: false }).enabled, false)
  assertEqual(REVIEW_DEFAULTS.checks.largeDeletion, true)
})

test('validateRef accepts revision names and rejects shell-looking input', () => {
  assertEqual(validateRef(undefined), { ok: true, value: undefined })
  assertEqual(validateRef('  '), { ok: true, value: undefined })
  assertEqual(validateRef('HEAD~2'), { ok: true, value: 'HEAD~2' })
  assertEqual(validateRef('origin/main'), { ok: true, value: 'origin/main' })
  assertEqual(validateRef('abc1234').ok, true)
  assertEqual(validateRef('HEAD; rm -rf /').ok, false)
  assertEqual(validateRef('HEAD && whoami').ok, false)
  assertEqual(validateRef('$(whoami)').ok, false)
  assertEqual(validateRef('a'.repeat(200)).ok, false)
  assertEqual(validateRef(42).ok, false)
})

test('normalizePaths drops unsafe or option-like paths', () => {
  assertEqual(normalizePaths(undefined), { ok: true, paths: [], dropped: 0 })
  assertEqual(normalizePaths(['src/a.js', 'docs/b.md']).paths, ['src/a.js', 'docs/b.md'])
  assertEqual(normalizePaths('src/a.js\ndocs/b.md').paths, ['src/a.js', 'docs/b.md'])
  const unsafe = normalizePaths(['src/a.js', '--output=/tmp/x', '$(whoami)'])
  assertEqual(unsafe.ok, true)
  assertEqual(unsafe.paths, ['src/a.js'])
  assertEqual(unsafe.dropped, 2)
  assertEqual(normalizePaths(['-p', '$(x)']).ok, false)
  assertEqual(normalizePaths(['a'.repeat(MAX_PATH_CHARS + 1)]).ok, false)
})

test('buildGitPlan picks HEAD / explicit base / unborn-repository probes', () => {
  const head = buildGitPlan({ base: undefined, paths: [], hasHead: true })
  assertEqual(head[0].kind, 'status')
  assertEqual(head[1].args.slice(0, 2), ['diff', 'HEAD'])
  assertEqual(head[2].args.slice(0, 2), ['diff', 'HEAD'])
  const explicit = buildGitPlan({ base: 'HEAD~2', paths: ['src/a.js'], hasHead: true })
  assertEqual(explicit[1].args, ['diff', 'HEAD~2', '--stat', '--', 'src/a.js'])
  assertEqual(explicit[2].args, ['diff', 'HEAD~2', '--no-color', '--', 'src/a.js'])
  const unborn = buildGitPlan({ base: undefined, paths: [], hasHead: false })
  assertEqual(unborn.map((step) => step.kind), ['status', 'stat', 'stat', 'diff', 'diff'])
  assert(unborn.some((step) => step.args.includes('--cached')), 'unborn repos inspect the index')
})

test('buildGitInvocation wraps git in the platform shell', () => {
  const win = buildGitInvocation(['diff', 'HEAD', '--stat'], 'win32', 'C:/Windows/system32/cmd.exe')
  assertEqual(win.file, 'C:/Windows/system32/cmd.exe')
  assertEqual(win.args.slice(0, 3), ['/d', '/s', '/c'])
  assertEqual(win.args[3], 'git diff HEAD --stat')
  const posix = buildGitInvocation(['diff', 'HEAD', '--no-color'], 'linux', undefined)
  assertEqual(posix, { file: '/bin/sh', args: ['-c', 'git diff HEAD --no-color'] })
  const spaced = buildGitInvocation(['diff', 'HEAD', '--', 'src/my file.js'], 'linux', undefined)
  assert(spaced.args[1].includes("'src/my file.js'"), spaced.args[1])
})

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseStatusPorcelain counts untracked and changed files', () => {
  const status = parseStatusPorcelain('?? notes.txt\n M src/app.js\nA  new.js\n')
  assertEqual(status.untracked, 1)
  assertEqual(status.changed, 2)
  assertEqual(status.files.length, 3)
  assertEqual(status.files[0].path, 'notes.txt')
})

test('parseUnifiedDiff tracks files, new-file line numbers and stats', () => {
  const parsed = parseUnifiedDiff(DIFF)
  assertEqual(parsed.stats.files, 1)
  assertEqual(parsed.stats.insertions, 4)
  assertEqual(parsed.stats.deletions, 1)
  assertEqual(parsed.files[0].path, 'src/app.js')
  assertEqual(parsed.files[0].addedLines.map((entry) => entry.line), [2, 3, 4, 5])
  assertEqual(parsed.files[0].addedLines[0].text, 'console.log(a)')
  const deleted = parseUnifiedDiff('diff --git a/gone.js b/gone.js\n--- a/gone.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n')
  assertEqual(deleted.files[0].deletedFile, true)
  assertEqual(deleted.stats.deletions, 2)
})

// ---------------------------------------------------------------------------
// Deterministic checks
// ---------------------------------------------------------------------------

test('secrets check flags credentials but redacts the snippet', () => {
  assert(matchSecret('const key = "AKIAIOSFODNN7EXAMPLE"'), 'AWS key detected')
  assert(matchSecret('-----BEGIN RSA PRIVATE KEY-----'), 'private key header detected')
  assert(matchSecret('github_token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"'), 'GitHub token detected')
  assertEqual(matchSecret('const value = 1'), undefined)
  const result = checkDiff(DIFF)
  const secret = result.checks.findings.find((finding) => finding.rule === 'secrets')
  assert(secret !== undefined, 'secret finding present')
  assertEqual(secret.severity, 'blocker')
  assert(secret.snippet.includes('[redacted]'), 'secret snippet redacted: ' + secret.snippet)
  assert(!secret.snippet.includes('AKIAIOSFODNN7EXAMPLE'), 'raw secret must not be rendered')
  assertEqual(secret.file, 'src/app.js')
  assertEqual(secret.line, 3)
  assert(secret.suggestion.length > 0, 'suggested fix present')
  assert(redactSecretSnippet('AKIAIOSFODNN7EXAMPLE').includes('[redacted]'))
})

test('conflict markers are blockers', () => {
  assert(isConflictMarker('<<<<<<< HEAD'))
  assert(isConflictMarker('======='))
  assert(isConflictMarker('>>>>>>> branch'))
  assert(!isConflictMarker('normal text'))
  const result = checkDiff(DIFF)
  const conflict = result.checks.findings.find((finding) => finding.rule === 'conflictMarkers')
  assert(conflict !== undefined, 'conflict finding present')
  assertEqual(conflict.severity, 'blocker')
  assert(conflict.message.includes('conflict'))
})

test('debug prints are warnings and match the common languages', () => {
  assert(matchDebugPrint('console.log("x")'))
  assert(matchDebugPrint('debugger'))
  assert(matchDebugPrint('print("x")'))
  assert(matchDebugPrint('System.out.println("x")'))
  assertEqual(matchDebugPrint('const logger = getLogger()'), undefined)
  const result = checkDiff(DIFF)
  const debug = result.checks.findings.find((finding) => finding.rule === 'debugPrints')
  assert(debug !== undefined, 'debug finding present')
  assertEqual(debug.severity, 'warning')
  assertEqual(debug.line, 2)
})

test('large deletions and whole-file deletions are warnings', () => {
  const bigParsed = {
    files: [{ path: 'data/big.csv', deletions: LARGE_DELETION_LINES + 1, addedLines: [], deletedFile: false }],
    stats: { files: 1, insertions: 0, deletions: LARGE_DELETION_LINES + 1 },
  }
  const big = runChecks({ parsed: bigParsed, checks: REVIEW_DEFAULTS.checks })
  assertEqual(big.findings.length, 1)
  assertEqual(big.findings[0].rule, 'largeDeletion')
  assertEqual(big.findings[0].severity, 'warning')
  const gone = runChecks({
    parsed: { files: [{ path: 'old.js', deletions: 12, addedLines: [], deletedFile: true }], stats: {} },
    checks: REVIEW_DEFAULTS.checks,
  })
  assertEqual(gone.findings[0].rule, 'largeDeletion')
  assert(gone.findings[0].message.includes('entire file deleted'), gone.findings[0].message)
})

test('clean diff has no findings and checks can be switched off', () => {
  const clean = checkDiff(CLEAN_DIFF)
  assertEqual(clean.checks.findings.length, 0)
  assertEqual(clean.checks.blockerCount, 0)
  assertEqual(clean.parsed.stats.insertions, 1)
  const disabled = checkDiff(DIFF, { checks: { secrets: false, conflictMarkers: false, debugPrints: false, largeDeletion: true } })
  assertEqual(disabled.checks.findings.length, 0, 'all relevant checks disabled')
})

test('focus filters findings and sorting puts blockers first', () => {
  const result = checkDiff(DIFF, { focus: 'secrets' })
  assert(result.checks.findings.length > 0)
  assert(result.checks.findings.every((finding) => finding.rule === 'secrets'), 'focus keeps only matching findings')
  const none = checkDiff(DIFF, { focus: 'no-such-file' })
  assertEqual(none.checks.findings.length, 0)
  const sorted = sortFindings([
    { severity: 'warning', file: 'b.js', line: 2 },
    { severity: 'blocker', file: 'z.js', line: 9 },
    { severity: 'warning', file: 'a.js', line: 1 },
  ])
  assertEqual(sorted[0].severity, 'blocker')
  assertEqual(sorted[1].file, 'a.js')
})

test('truncateDiff marks the cut and keeps a newline boundary', () => {
  const text = 'a'.repeat(40) + '\n' + 'b'.repeat(40) + '\n' + 'c'.repeat(40)
  const cut = truncateDiff(text, 60)
  assertEqual(cut.truncated, true)
  assert(cut.omitted > 0)
  assert(cut.text.length <= 60)
  assertEqual(truncateDiff('short', 12000).truncated, false)
  assertEqual(truncateDiff('short', 12000).text, 'short')
})

// ---------------------------------------------------------------------------
// Rendering and evidence
// ---------------------------------------------------------------------------

test('renderReviewReport is risk-first, actionable and ends with a checklist', () => {
  const { checks, parsed } = checkDiff(DIFF)
  const report = renderReviewReport({
    findings: checks.findings,
    stats: { files: parsed.stats.files, insertions: parsed.stats.insertions, deletions: parsed.stats.deletions, untracked: 1 },
    untrackedFiles: ['notes.txt'],
    statText: ' src/app.js | 4 ++++',
    base: 'HEAD',
    cwd: 'C:/repo',
    elapsedMs: 42,
    checkedAt: NOW,
    maxChars: 12000,
  })
  assert(report.startsWith('review_diff: BLOCKED'), report.split('\n')[0])
  assert(report.includes('这是确定性检查，不是完整代码审查'), 'deterministic disclaimer present')
  assert(report.includes('Human review checklist:'), 'human checklist present')
  assert(report.includes('untracked (not content-reviewed'), 'untracked honesty')
  assert(report.includes('fix: '), 'each finding has a suggested fix')
  const blockerIndex = report.indexOf('[BLOCKER]')
  const warningIndex = report.indexOf('[WARNING]')
  assert(blockerIndex >= 0 && warningIndex > blockerIndex, 'blockers render before warnings')
  assert(report.includes('base=HEAD'), report)
  assert(report.includes('cwd: C:/repo'), report)
})

test('renderReviewReport respects the maxChars budget and clean reports are positive', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    rule: 'debugPrints',
    severity: 'warning',
    file: 'src/file' + index + '.js',
    line: index + 1,
    snippet: 'console.log(' + index + ')',
    message: 'console debug output added (console)',
    suggestion: 'Remove the debug output, or put it behind an explicit debug flag.',
  }))
  const capped = renderReviewReport({
    findings: many,
    stats: { files: 40, insertions: 40, deletions: 0, untracked: 0 },
    cwd: 'C:/repo',
    checkedAt: NOW,
    maxChars: 1000,
  })
  assert(capped.includes('report truncated at 1000 chars'), 'budget marker present')
  assert(capped.length <= 1200, 'report stays near the budget')
  const clean = renderReviewReport({ findings: [], stats: { files: 1, insertions: 1, deletions: 0, untracked: 0 }, cwd: 'C:/repo' })
  assert(clean.startsWith('review_diff: CLEAN'), clean.split('\n')[0])
  assert(clean.includes('No secret-looking additions'), clean)
})

test('buildReviewRecord and readReview expose freshness and blockers', () => {
  const record = buildReviewRecord({
    at: NOW,
    findings: [{ severity: 'blocker' }, { severity: 'warning' }],
    stats: { files: 2, insertions: 3, deletions: 4, untracked: 1 },
    truncated: false,
  })
  assertEqual(record.ok, false)
  assertEqual(record.findings, 1)
  assertEqual(record.warnings, 1)
  assertEqual(record.files, 2)
  assertEqual(record.untracked, 1)
  const state = fakeState()
  const agent = {}
  assertEqual(readReview(state, agent, 60000, NOW).status, 'missing')
  state.reviews.set(agent, { at: NOW, ok: true, findings: 0, files: 1 })
  const fresh = readReview(state, agent, 60000, NOW + 1000)
  assertEqual(fresh.status, 'ok')
  assertEqual(readReview(state, agent, 1000, NOW + 5000).status, 'stale')
  assertEqual(readReview(state, agent, Infinity, NOW + 9999999).status, 'ok')
  state.reviews.set(agent, { at: NOW, ok: false, findings: 2, files: 1 })
  assertEqual(readReview(state, agent, 60000, NOW + 1000).status, 'blocked')
  assertEqual(readReview({ reviews: {} }, agent, 60000, NOW).status, 'missing')
  assertEqual(readReview(state, null, 60000, NOW).status, 'missing')
})

test('renderUnavailableReview is explicit and does not guess', () => {
  const report = renderUnavailableReview('git is not installed')
  assert(report.includes('unavailable'), report)
  assert(report.includes('nothing was guessed'), report)
  assert(report.includes('No review record was written'), report)
})

// ---------------------------------------------------------------------------
// Host module
// ---------------------------------------------------------------------------

test('install registers review_diff with an injectable loader and fails open', () => {
  const { ctx, tools } = fakeCtx()
  const state = fakeState()
  const dispose = install(ctx, { reviewGate: { enabled: true } }, state)
  assertEqual(typeof dispose, 'function')
  assertEqual(tools.length, 1)
  assertEqual(tools[0].name, 'review_diff')
  assert(Object.hasOwn(tools[0].parameters, 'base'), 'base parameter declared')
  assert(Object.hasOwn(tools[0].parameters, 'paths'), 'paths parameter declared')
  assert(Object.hasOwn(tools[0].parameters, 'focus'), 'focus parameter declared')
  assert(state.reviews instanceof WeakMap, 'evidence map initialized')
  dispose()
  const broken = {
    get() { throw new Error('boom') },
    tools: { register() { throw new Error('boom') } },
  }
  let threw = false
  try {
    const disposeBroken = install(broken, { reviewGate: { enabled: true } }, fakeState({ loadHost: async () => ({ defineTool: (definition) => definition }) }))
    disposeBroken()
  } catch {
    threw = true
  }
  assertEqual(threw, false, 'install must not throw with broken seams')
})

const asyncTests = []
function testAsync(name, fn) {
  asyncTests.push({ name, fn })
}

testAsync('runReview turns a diff into findings, stats and a blocker record', async () => {
  const { ctx } = fakeCtx()
  const state = fakeState({ runCommand: fakeGit() })
  const exec = { agent: { session: {} } }
  const result = await runReview(ctx, resolveReviewConfig({}), state, {}, exec)
  assertEqual(result.ok, false, 'blockers make the review fail')
  assert(result.report.startsWith('review_diff: BLOCKED'), result.report.split('\n')[0])
  assert(result.report.includes('secrets'), result.report)
  assert(result.report.includes('conflictMarkers'), result.report)
  assert(result.report.includes('debugPrints'), result.report)
  assertEqual(state.reviews.get({}), undefined, 'different agent object must not share evidence')
  const direct = state.reviews.get(exec.agent)
  assert(direct !== undefined, 'evidence stored for the live agent')
  assertEqual(direct.ok, false)
  assertEqual(direct.findings >= 2, true, 'secrets + conflict blockers counted')
  assertEqual(direct.files, 1)
  assertEqual(direct.untracked, 1)
  assertEqual(direct.at > 0, true)
})

testAsync('runReview passes a clean diff and records fresh evidence', async () => {
  const { ctx } = fakeCtx()
  const state = fakeState({ runCommand: fakeGit({ diff: CLEAN_DIFF }) })
  const exec = { agent: { session: {} } }
  const settings = resolveReviewConfig({ reviewGate: { enabled: true } })
  const result = await runReview(ctx, settings, state, { focus: 'calc' }, exec)
  assertEqual(result.ok, true)
  assert(result.report.startsWith('review_diff: CLEAN'), result.report.split('\n')[0])
  const record = state.reviews.get(exec.agent)
  assertEqual(record.ok, true)
  assertEqual(record.findings, 0)
  assertEqual(readReview(state, exec.agent, 60000).status, 'ok')
})

testAsync('runReview reports a missing working directory without running git', async () => {
  const { ctx } = fakeCtx({ noCwd: true })
  const state = fakeState({ runCommand: fakeGit() })
  const result = await runReview(ctx, resolveReviewConfig({}), state, {}, { agent: { session: {} } })
  assertEqual(result.ok, false)
  assert(result.report.includes('working directory is unknown'), result.report)
  assertEqual(state.calls.length, 0, 'no git command runs without a cwd')
})

testAsync('runReview reports git-unavailable and writes no record', async () => {
  const { ctx } = fakeCtx()
  const state = fakeState({ runCommand: fakeGit({ status: { code: 128, stdout: '', stderr: 'fatal: not a git repository' } }) })
  const exec = { agent: { session: {} } }
  const result = await runReview(ctx, resolveReviewConfig({}), state, {}, exec)
  assertEqual(result.ok, false)
  assert(result.report.includes('unavailable'), result.report)
  assert(result.report.includes('not a git repository'), result.report)
  assertEqual(state.reviews.get(exec.agent), undefined, 'no record is written when git is unusable')
})

testAsync('runReview rejects an unsafe base before running git', async () => {
  const { ctx } = fakeCtx()
  const state = fakeState({ runCommand: fakeGit() })
  const result = await runReview(ctx, resolveReviewConfig({}), state, { base: 'HEAD; rm -rf /' }, { agent: { session: {} } })
  assertEqual(result.ok, false)
  assert(result.report.includes('invalid base argument'), result.report)
  assertEqual(state.calls.length, 0)
  assertEqual(truncateDiff('', 1000).truncated, false)
})

testAsync('reviewGate reports readiness only when review_diff actually registered', async () => {
  const okState = fakeState()
  install(fakeCtx().ctx, { reviewGate: { enabled: true } }, okState)
  assertEqual(okState.reviewGateReady, true, 'successful registration marks the reviewer ready')
  const brokenState = fakeState({ loadHost: async () => ({ defineTool: (definition) => definition }) })
  const brokenCtx = {
    get() { throw new Error('boom') },
    tools: { register() { throw new Error('boom') } },
  }
  install(brokenCtx, { reviewGate: { enabled: true } }, brokenState)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assertEqual(brokenState.reviewGateReady, false, 'a failed registration must not mark the reviewer ready')
  const noHostState = fakeState({ loadHost: () => undefined })
  install(fakeCtx().ctx, { reviewGate: { enabled: true } }, noHostState)
  assertEqual(noHostState.reviewGateReady, false, 'a missing host package must not mark the reviewer ready')
  const disabledState = fakeState()
  install(fakeCtx().ctx, { reviewGate: { enabled: false } }, disabledState)
  assertEqual(disabledState.reviewGateReady, false, 'a disabled reviewer is not ready')
})

testAsync('runReview reuses maxDiffChars as the analysis and rendering budget', async () => {
  const padding = Array.from({ length: 80 }, (_, index) => '+const filler' + index + ' = ' + index)
  const bigDiff = [
    'diff --git a/src/big.js b/src/big.js',
    '--- a/src/big.js',
    '+++ b/src/big.js',
    '@@ -0,0 +1,82 @@',
    ...padding,
    '+const leaked = "AKIAIOSFODNN7EXAMPLE"',
  ].join('§n')
  const { ctx } = fakeCtx()
  const state = fakeState({ runCommand: fakeGit({ diff: bigDiff }) })
  const exec = { agent: { session: {} } }
  const settings = resolveReviewConfig({ reviewGate: { enabled: true, maxDiffChars: 1000 } })
  const result = await runReview(ctx, settings, state, {}, exec)
  assert(result.report.includes('truncated: the diff exceeded maxDiffChars=1000'), result.report)
  assert(result.report.includes('report truncated at 1000 chars') || result.report.length <= 1400, 'report respects the budget')
  const record = state.reviews.get(exec.agent)
  assertEqual(record.truncated, true)
  assertEqual(record.findings, 0, 'checks beyond the cut are not claimed as run')
  assertEqual(record.files, 1, 'stats still describe the whole diff')
})

for (const entry of asyncTests) {
  try {
    await entry.fn()
    test(entry.name, () => {})
  } catch (error) {
    test(entry.name, () => {
      throw error
    })
  }
}
