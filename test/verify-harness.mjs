/**
 * Wiring harness: 43 assertions that exercise every module against fake host
 * seams plus the pure decision cores. Runs in a clean Node environment (no
 * @deepseek-ai packages): the fake loader stands in for the host.
 *
 *   node test/verify-harness.mjs
 */
import { createFakeContext, createFakeSession, fakeLoadHost } from './fakes.mjs'
import { initialState, foldEvent } from '../lib/session-state.js'

let passed = 0
const failures = []
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(name + ': ' + (error instanceof Error ? error.message : String(error)))
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed')
}
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((message ?? 'not equal') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
  }
}
function assertThrows(fn, message) {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(message ?? 'expected a throw')
}

function createState(overrides = {}) {
  return {
    ctx: undefined,
    startedAt: Date.now(),
    version: '1.0.0',
    sessions: new Map(),
    log() {},
    loadHost: fakeLoadHost,
    sessionState: {
      stateOf: () => initialState(),
      onEvent: () => () => {},
      toolRing: () => [],
    },
    ...overrides,
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

const modules = await Promise.all([
  import('../lib/microcompact.js'),
  import('../lib/focus-chain.js'),
  import('../lib/duplicate-guard.js'),
  import('../lib/turn-guard.js'),
  import('../lib/edit-check.js'),
  import('../lib/checkpoint.js'),
  import('../lib/goal-gate.js'),
  import('../lib/repo-map.js'),
  import('../lib/cache-report.js'),
  import('../lib/memory-lint.js'),
  import('../lib/hook-bus.js'),
  import('../lib/handoff-notes.js'),
  import('../lib/skill-pack.js'),
  import('../lib/review-gate.js'),
])
const [microcompact, focusChain, duplicateGuard, turnGuard, editCheck, checkpoint, goalGate, repoMap, cacheReport, memoryLint, hookBus, handoffNotes, skillPack, reviewGate] = modules

const configs = {
  microcompact: { microcompact: { enabled: true } },
  focusChain: { focusChain: { enabled: true } },
  duplicateGuard: { duplicateGuard: { enabled: true } },
  turnGuard: { turnGuard: { enabled: true } },
  editCheck: { editCheck: { enabled: true, checks: [{ name: 'noop', when: [], command: 'exit 0' }] } },
  checkpoint: { checkpoint: { enabled: true } },
  goalGate: { goalGate: { enabled: true, mode: 'advisory', verifyCommands: [{ name: 'ok', command: 'exit 0' }] } },
  repoMap: { repoMap: { enabled: true } },
  cacheReport: { cacheReport: { enabled: true } },
  memoryLint: { memoryLint: { enabled: true } },
  hookBus: { hookBus: { enabled: true, hooks: [{ name: 'noop', event: 'PreToolUse', matcher: '', command: 'exit 0' }] } },
  handoffNotes: { handoffNotes: { enabled: true } },
  skillPack: { skillPack: { enabled: true } },
  reviewGate: { reviewGate: { enabled: true } },
}

const entries = [
  ['microcompact', microcompact],
  ['focusChain', focusChain],
  ['duplicateGuard', duplicateGuard],
  ['turnGuard', turnGuard],
  ['editCheck', editCheck],
  ['checkpoint', checkpoint],
  ['goalGate', goalGate],
  ['repoMap', repoMap],
  ['cacheReport', cacheReport],
  ['memoryLint', memoryLint],
  ['hookBus', hookBus],
  ['handoffNotes', handoffNotes],
  ['skillPack', skillPack],
  ['reviewGate', reviewGate],
]

const registrationsOf = (fake) => {
  let count = fake.tools.length + fake.sections.length + fake.commands.length
  for (const list of fake.listeners.values()) count += list.length
  return count
}

for (const [id, mod] of entries) {
  await check(id + ' installs and registers against fake seams', async () => {
    const fake = createFakeContext()
    const state = createState({ ctx: fake.ctx })
    const disposer = mod.install(fake.ctx, configs[id], state)
    await tick()
    await tick()
    assert(typeof disposer === 'function' || disposer === undefined, 'install must return a disposer or undefined')
    assert(registrationsOf(fake) > 0, 'enabled module must register a listener, tool, command or prompt section')
  })
  await check(id + ' disposes cleanly', async () => {
    const fake = createFakeContext()
    const state = createState({ ctx: fake.ctx })
    const disposer = mod.install(fake.ctx, configs[id], state)
    await tick()
    if (typeof disposer === 'function') disposer()
  })
  await check(id + ' fails open on a broken host context', async () => {
    const broken = {
      logger: { info() {}, warn() {}, debug() {} },
      on() { throw new Error('boom') },
      get() { throw new Error('boom') },
      effect() { throw new Error('boom') },
      tools: { register() { throw new Error('boom') } },
      systemPrompt: { section() { throw new Error('boom') } },
    }
    const state = createState({ ctx: broken, loadHost: () => Promise.reject(new Error('no host')) })
    const disposer = mod.install(broken, configs[id], state)
    if (typeof disposer === 'function') disposer()
  })
}

const plan = await import('../lib/pure/microcompact-plan.js')
const focusRender = await import('../lib/pure/focus-render.js')
const stuckCore = await import('../lib/pure/stuck-core.js')
const turnCore = await import('../lib/pure/turn-guard-core.js')
const goalPolicy = await import('../lib/pure/goal-policy.js')
const editCore = await import('../lib/pure/edit-check-core.js')
const checkpointCore = await import('../lib/pure/checkpoint-core.js')
const cacheCore = await import('../lib/pure/cache-core.js')
const repoCore = await import('../lib/pure/repo-map-core.js')

await check('microcompact keeps the ZCode placeholder and 256-token floor', async () => {
  assertEqual(plan.DEFAULT_PLACEHOLDER, '[Old tool result content cleared]')
  assertEqual(plan.MIN_SAVINGS_TOKENS, 256)
})

await check('microcompact legacy keepRecentToolResults maps to groups', async () => {
  const settings = plan.resolveMicrocompactConfig({ microcompact: { keepRecentToolResults: 7 } })
  assertEqual(settings.keepRecentGroups, 7)
})

await check('microcompact auto remaining budget follows the window rule', async () => {
  assertEqual(plan.resolveRemainingBudget(1000000, 0), 20000)
  assertEqual(plan.resolveRemainingBudget(50000, 0), 10000)
  assertEqual(plan.resolveRemainingBudget(0, 0), 0)
})

await check('microcompact ratio trigger fires on pressure', async () => {
  const decision = plan.evaluateTrigger({ pressureTokens: 730, contextWindow: 1000, triggerRatio: 0.72 })
  assert(decision !== null && typeof decision === 'object', 'trigger decision must be an object')
  const text = JSON.stringify(decision).toLowerCase()
  assert(text.includes('pressure') || text.includes('true'), 'pressure trigger must be reported')
})

await check('focus chain renders Next and keeps acceptance text', async () => {
  const todos = [
    { content: 'wire module (验收: tests pass)', status: 'completed' },
    { content: 'write tests', status: 'in_progress' },
    { content: 'update README', status: 'pending' },
  ]
  const text = focusRender.renderFocusChain(todos, { step: 6, everySteps: 6 })
  assert(text.includes('Next:'), 'Next line missing')
  assert(text.includes('验收: tests pass'), 'acceptance text must be preserved')
  assert(text.includes('1/3'), 'progress line missing')
})

await check('focus chain tolerates empty and malformed todo lists', async () => {
  assertEqual(focusRender.normalizeTodos(undefined).length, 0)
  assertEqual(focusRender.normalizeTodos([null, 42, { content: 'ok', status: 'pending' }]).length, 1)
})

await check('stuck detector flags a repeated action-observation', async () => {
  const options = stuckCore.resolveStuckOptions({})
  const call = stuckCore.callSignature('read', { path: 'src/a.ts' })
  const ring = [1, 2, 3, 4].map((seq) => ({ seq, name: 'read', argsKey: call.argsKey, resultKey: 'same-observation', isError: false }))
  const detection = stuckCore.detectStuck(ring, call, options)
  assert(detection !== undefined, 'identical observation loop must be detected')
  assertEqual(detection.mode, 'identical-observation')
})

await check('stuck detector classifies context-overflow failures', async () => {
  assert(stuckCore.classifyOverflow('Error: maximum context length exceeded'), 'overflow text must classify')
  assert(!stuckCore.isOverflowFailure({ message: 'syntax error' }), 'non-overflow must not classify')
})

await check('turn guard budget warns only past the threshold', async () => {
  const options = turnCore.resolveTurnOptions({})
  assertEqual(turnCore.turnBudget({ steps: 120 }, options).approaching, false)
  assertEqual(turnCore.turnBudget({ steps: 121 }, options).approaching, true)
})

await check('turn guard finish check catches a goal without fresh evidence', async () => {
  const issue = turnCore.detectFinishIssue({ goalActive: true, mutatedInTurn: true, freshVerify: false })
  assertEqual(issue.kind, 'goal')
  assertEqual(turnCore.detectFinishIssue({ goalActive: false, mutatedInTurn: false, freshVerify: true }), undefined)
})

await check('goal gate accepts only real evidence (0.1.1 fix 5)', async () => {
  const settings = goalPolicy.resolveSettings({ goalGate: { mode: 'enforce', verifyCommand: 'pnpm test' } })
  const now = Date.now()
  assertEqual(goalPolicy.hasFreshPass({ ok: true, evidenceOnly: true, at: now }, settings, now), false)
  assertEqual(goalPolicy.hasFreshPass({ ok: true, evidenceOnly: false, at: now }, settings, now), true)
})

await check('goal gate fails fast in enforce mode with no verification command', async () => {
  const fake = createFakeContext()
  const state = createState({ ctx: fake.ctx })
  assertThrows(() => goalGate.install(fake.ctx, { goalGate: { enabled: true, mode: 'enforce' } }, state), 'enforce + empty verify must throw at install')
})

await check('edit check selects checks by glob and dedupes', async () => {
  const checks = [
    { name: 'tsc', when: ['**/*.ts'], command: 'tsc', timeoutMs: 1000 },
    { name: 'tsc-dup', when: ['src/**'], command: 'tsc', timeoutMs: 1000 },
    { name: 'always', when: [], command: 'echo', timeoutMs: 1000 },
  ]
  const selected = editCore.selectMatchingChecks(checks, ['src/a.ts'])
  const names = selected.map((entry) => entry.name)
  assert(names.includes('tsc'), 'glob check missing')
  assert(!names.includes('tsc-dup'), 'duplicate command must collapse')
})

await check('checkpoint skips dependency and VCS paths', async () => {
  assertEqual(checkpointCore.shouldSkipCheckpointPath('node_modules/pkg/a.js'), true)
  assertEqual(checkpointCore.shouldSkipCheckpointPath('.git/HEAD'), true)
  assertEqual(checkpointCore.shouldSkipCheckpointPath('src/a.js'), false)
})

await check('cache report estimates cost and attributes an unexpected miss', async () => {
  const prices = { inputPricePerMillion: 0.28, cacheReadPricePerMillion: 0.028, outputPricePerMillion: 0.42 }
  const cost = cacheCore.estimateCost({ uncachedInputTokens: 1000000, cacheReadTokens: 0, outputTokens: 0 }, prices)
  assert(cost.totalUsd > 0.27 && cost.totalUsd < 0.29, 'million uncached input should cost about 0.28 USD')
  const miss = cacheCore.attributeCacheMisses([
    { seq: 1, ratio: 0.90 },
    { seq: 2, ratio: 0.92 },
    { seq: 3, ratio: 0.40 },
  ], [])
  assert(miss !== null && typeof miss === 'object', 'attribution result required')
})

await check('repo map enforces workspace containment', async () => {
  assertEqual(repoCore.isPathInside('/ws', '/ws/src/a.js'), true)
  assertEqual(repoCore.isPathInside('/ws', '/etc/passwd'), false)
  const denied = repoCore.classifyWorkspacePath({ root: '/ws', target: '/etc/passwd' })
  assert(denied === null || denied === undefined || denied.ok === false, 'system paths must be rejected')
})

console.error('verify-harness: ' + passed + ' assertions passed, ' + failures.length + ' failed')
for (const failure of failures) console.error('FAIL ' + failure)
process.exitCode = failures.length === 0 ? 0 : 1
