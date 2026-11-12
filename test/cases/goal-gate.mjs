/**
 * goalGate 2.0 cases: 0.1.1 #5 regression, multi-command verification, evidence
 * freshness, the completion gate and native goal blockers — all in a clean Node
 * process with a fake ctx and a fake `loadHost` (no @deepseek-ai packages).
 */
import { test, assert, assertEqual } from '../harness.mjs'
import {
  FAIL_LINE,
  GOAL_GATE_DEFAULTS,
  NOT_CONFIGURED_LINE,
  PASS_LINE,
  blockReasonFor,
  buildPassRecord,
  foldEvidence,
  gateReason,
  goalRefFromView,
  hasFreshPass,
  initialEvidenceState,
  isGoalCompletionCall,
  normalizeVerifyCommands,
  overallOk,
  parseVerifyReport,
  renderVerifyReport,
  resolveSettings,
  reviewGateReason,
  shouldRecordBlocker,
  summarizeCommandRun,
  tailText,
  verifyInvocation,
} from '../../lib/pure/goal-policy.js'
import {
  createEvidenceStore,
  evidenceOf,
  install,
  maybeBlockGoal,
  resolveCwd,
  runVerify,
} from '../../lib/goal-gate.js'

const NOW = 1700000000000

/** Fake Row context exposing only the seams goalGate touches. */
function fakeCtx(options = {}) {
  const listeners = []
  const tools = []
  const commands = []
  const sections = []
  const services = { ...(options.services ?? {}) }
  const ctx = {
    on(name, listener) {
      listeners.push({ name, listener, options: options.registerOptions })
      return () => {
        const index = listeners.findIndex((entry) => entry.listener === listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    get(name) {
      if (Object.hasOwn(services, name)) return services[name]
      if (name === 'systemPrompt') {
        return { section: (section) => { sections.push(section); return () => {} } }
      }
      if (name === 'workingDirectory') {
        return options.noCwd === true ? undefined : { get: () => options.cwd ?? 'C:/fake-work' }
      }
      if (name === 'tools') return { register: (definition) => { tools.push(definition); return () => {} } }
      if (name === 'commands') return { register: (definition) => { commands.push(definition); return () => {} } }
      return undefined
    },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
  }
  return { ctx, listeners, tools, commands, sections }
}

/** Fake plugin state with an injectable synchronous loadHost and event feed. */
function fakeState(extra = {}) {
  const logs = []
  const feed = []
  const sessionState = {
    onEvent(listener) { feed.push(listener); return () => {} },
    emit(session, event) { for (const listener of feed) listener(session, event, undefined) },
  }
  return {
    log(level, message) { logs.push({ level, message }) },
    logs,
    sessionState,
    loadHost: () => ({ defineTool: (definition) => definition }),
    ...extra,
  }
}

/** One PASS report shaped exactly like renderVerifyReport. */
function passReport(at = NOW) {
  return [
    PASS_LINE,
    'commands: 1 configured, 1 required',
    '[PASS] unit (required)',
    '  command: exit 0',
    '  exit code: 0',
    '  output tail:',
    '    ok',
    'cwd: C:/fake-work',
    'checked at: ' + new Date(at).toISOString(),
  ].join('\n')
}

const ENFORCE = { goalGate: { mode: 'enforce', verifyCommands: [{ name: 'unit', command: 'exit 0', required: true }] } }

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('verifyCommands wins over the legacy verifyCommand and is normalized', () => {
  const settings = resolveSettings({
    goalGate: {
      mode: 'advisory',
      verifyCommand: 'pnpm test',
      verifyCommands: [
        { name: 'unit', command: 'pnpm test', required: false, timeoutMs: 5000 },
        { command: 'pnpm lint' },
        { name: 'skip', command: '   ' },
      ],
    },
  })
  assertEqual(settings.mode, 'advisory')
  assertEqual(settings.commands.length, 2)
  assertEqual(settings.commands[0].name, 'unit')
  assertEqual(settings.commands[0].required, false)
  assertEqual(settings.commands[0].timeoutMs, 5000)
  assertEqual(settings.commands[1].name, 'check-2')
  assertEqual(settings.commands[1].required, true)
})

test('legacy verifyCommand becomes one required step; empty config has no steps', () => {
  const legacy = normalizeVerifyCommands({ verifyCommand: '  pnpm test  ', verifyTimeoutMs: 1234 })
  assertEqual(legacy.length, 1)
  assertEqual(legacy[0], { name: 'verify', command: 'pnpm test', required: true, timeoutMs: 1234 })
  assertEqual(normalizeVerifyCommands({ verifyCommand: '   ', verifyCommands: [] }).length, 0)
  assertEqual(normalizeVerifyCommands({}).length, 0)
  const settings = resolveSettings({})
  assertEqual(settings.mode, 'enforce')
  assertEqual(settings.configured, false)
  assertEqual(settings.freshWithinMs, GOAL_GATE_DEFAULTS.freshWithinMs)
})

// ---------------------------------------------------------------------------
// 0.1.1 #5: an empty configuration must never pass or satisfy the gate
// ---------------------------------------------------------------------------

test('install throws fast in enforce mode without any verification command', () => {
  const { ctx } = fakeCtx()
  let message = ''
  try {
    install(ctx, { goalGate: { mode: 'enforce', verifyCommand: '' } }, fakeState())
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert(message.length > 0, 'enforce + empty config must throw during install')
  assert(/no verification command/u.test(message), message)
})

test('hasFreshPass only accepts a fresh real PASS', () => {
  const settings = resolveSettings(ENFORCE)
  const real = { at: NOW, ok: true, evidenceOnly: false }
  assert(hasFreshPass(real, settings, NOW + 1000), 'fresh real pass must pass')
  assert(!hasFreshPass({ ...real, evidenceOnly: true }, settings, NOW + 1000), 'evidence-only record must be rejected')
  assert(!hasFreshPass({ ...real, ok: false }, settings, NOW + 1000), 'failed record must be rejected')
  assert(!hasFreshPass({ ...real, at: undefined }, settings, NOW), 'record without a timestamp must be rejected')
  assert(!hasFreshPass({ ...real, at: NOW - settings.freshWithinMs - 1 }, settings, NOW), 'stale pass must be rejected')
  assert(!hasFreshPass(null, settings, NOW), 'missing record must be rejected')
})

test('gate reasons cover missing, failing, stale and not-configured evidence', () => {
  const settings = resolveSettings(ENFORCE)
  const missing = gateReason(settings, null, NOW)
  assert(/has not run/u.test(missing), missing)
  assert(/Configured verification steps: "unit"/u.test(missing), 'must list configured steps')
  const failed = gateReason(settings, { at: NOW, ok: false, evidenceOnly: false, exitCode: 2 }, NOW)
  assert(/failed \(exit code 2/u.test(failed), failed)
  const stale = gateReason(settings, { at: NOW - settings.freshWithinMs - 60000, ok: true, evidenceOnly: false }, NOW)
  assert(/freshness window/u.test(stale), stale)
  const notConfigured = gateReason(settings, { at: NOW, ok: false, evidenceOnly: true }, NOW)
  assert(/evidence-only runs never count/u.test(notConfigured), notConfigured)
})

test('isGoalCompletionCall is broad on names and strict on arguments', () => {
  assert(isGoalCompletionCall('update_goal', { action: 'complete' }))
  assert(isGoalCompletionCall('goal_update', { status: 'complete' }))
  assert(isGoalCompletionCall('set_goal', { phase: 'COMPLETE' }))
  assert(isGoalCompletionCall('goal_done', { complete: true }))
  assert(!isGoalCompletionCall('update_goal', { action: 'pause' }))
  assert(!isGoalCompletionCall('goal_verify', {}))
  assert(!isGoalCompletionCall('read', { action: 'complete' }))
  assert(!isGoalCompletionCall('update_goal', null))
  assert(!isGoalCompletionCall('update_goal', ['complete']))
})

// ---------------------------------------------------------------------------
// Multi-command reporting and verdicts
// ---------------------------------------------------------------------------

test('overallOk requires at least one command and every required command to pass', () => {
  assert(!overallOk([]), 'no commands cannot pass')
  assert(overallOk([{ required: true, ok: true }, { required: false, ok: false }]), 'optional failure must not fail the run')
  assert(!overallOk([{ required: true, ok: true }, { required: true, ok: false }]), 'required failure must fail the run')
})

test('buildPassRecord records real-run evidence and never evidence-only success', () => {
  const record = buildPassRecord({
    at: NOW,
    results: [
      { name: 'a', required: true, ok: true, exitCode: 0 },
      { name: 'b', required: true, ok: false, exitCode: 3 },
    ],
  })
  assertEqual(record.ok, false)
  assertEqual(record.evidenceOnly, false)
  assertEqual(record.exitCode, 3)
  assertEqual(record.commands.length, 2)
  const evidenceOnly = buildPassRecord({ at: NOW, results: [] })
  assertEqual(evidenceOnly.ok, false, 'evidence-only runs are never ok')
  assertEqual(evidenceOnly.evidenceOnly, true)
})

test('renderVerifyReport lists every command, exit code and output tail', () => {
  const report = renderVerifyReport({
    results: [
      { name: 'unit', command: 'pnpm test', required: true, ok: true, exitCode: 0, outputTail: 'all tests passed' },
      { name: 'lint', command: 'pnpm lint', required: false, ok: false, exitCode: 1, outputTail: 'warning: x' },
    ],
    cwd: 'C:/work',
    elapsedMs: 1200,
    checkedAt: NOW,
  })
  const lines = report.split('\n')
  assertEqual(lines[0], PASS_LINE, 'optional failure alone must still PASS')
  assert(report.includes('[PASS] unit (required)'), report)
  assert(report.includes('[FAIL] lint (optional)'), report)
  assert(report.includes('exit code: 0'), 'first exit code shown')
  assert(report.includes('exit code: 1'), 'second exit code shown')
  assert(report.includes('all tests passed') && report.includes('warning: x'), 'both output tails shown')
  assert(report.includes('cwd: C:/work'), report)
  assert(report.includes('checked at: ' + new Date(NOW).toISOString()), report)
})

test('renderVerifyReport FAILs when a required command fails and never PASSes evidence-only', () => {
  const failed = renderVerifyReport({
    results: [
      { name: 'unit', command: 'pnpm test', required: true, ok: true, exitCode: 0 },
      { name: 'build', command: 'pnpm build', required: true, ok: false, timedOut: true },
    ],
    cwd: 'C:/work',
    checkedAt: NOW,
  })
  assertEqual(failed.split('\n')[0], FAIL_LINE)
  assert(failed.includes('exit code: timed out'), failed)
  assert(/Do not mark the goal complete/u.test(failed), failed)

  const evidenceOnly = renderVerifyReport({ evidenceOnly: true, results: [], cwd: 'C:/work', checkedAt: NOW })
  assertEqual(evidenceOnly.split('\n')[0], NOT_CONFIGURED_LINE)
  assert(/NOT a pass/u.test(evidenceOnly), evidenceOnly)
})

test('tailText keeps the end and marks the omitted prefix', () => {
  const tail = tailText('HEAD' + 'x'.repeat(5000) + 'TAIL', 100)
  assert(tail.endsWith('TAIL'), 'tail preserved')
  assert(tail.includes('chars omitted'), 'omission marked')
  assert(tail.length < 200, 'bounded')
})

test('verifyInvocation and summarizeCommandRun normalize process results', () => {
  assertEqual(verifyInvocation('exit 0', 'win32', 'C:/Windows/system32/cmd.exe'), {
    file: 'C:/Windows/system32/cmd.exe',
    args: ['/d', '/s', '/c', 'exit 0'],
  })
  assertEqual(verifyInvocation('pnpm test', 'linux', undefined), { file: '/bin/sh', args: ['-c', 'pnpm test'] })
  const ok = summarizeCommandRun({ name: 'a', command: 'c', required: true }, { code: 0, stdout: 'out\n', stderr: '' }, 12)
  assertEqual(ok.ok, true)
  assertEqual(ok.exitCode, 0)
  assert(ok.outputTail.includes('out'), ok.outputTail)
  const failed = summarizeCommandRun({ name: 'b', command: 'c', required: true }, { code: 3, stdout: '', stderr: 'boom' }, 1)
  assertEqual(failed.ok, false)
  assert(failed.outputTail.includes('boom'), failed.outputTail)
  const missing = summarizeCommandRun({ name: 'c', command: 'c', required: true }, undefined, 0)
  assertEqual(missing.ok, false)
  assertEqual(missing.failedToStart, true)
})

// ---------------------------------------------------------------------------
// Evidence parsing/folding (resume-safe projection contract)
// ---------------------------------------------------------------------------

test('parseVerifyReport reads PASS, FAIL and not-configured reports', () => {
  const pass = parseVerifyReport(passReport(NOW), NOW + 5000)
  assertEqual(pass.ok, true)
  assertEqual(pass.evidenceOnly, false)
  assertEqual(pass.at, NOW)
  const fail = parseVerifyReport(FAIL_LINE + '\nfailed stuff', 111)
  assertEqual(fail.ok, false)
  assertEqual(fail.at, 111)
  const none = parseVerifyReport(NOT_CONFIGURED_LINE + '\nnot configured', 222)
  assertEqual(none.ok, false)
  assertEqual(none.evidenceOnly, true)
})

test('foldEvidence turns goal_verify results into fresh evidence and a failure streak', () => {
  const session = {}
  let state = initialEvidenceState()
  state = foldEvidence(state, { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'goal_verify' } })
  assertEqual(state.pending.c1, 'goal_verify')
  state = foldEvidence(state, { type: 'tool/result', seq: 2, time: NOW, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: passReport(NOW) }] } } })
  assertEqual(state.lastPass.ok, true)
  assertEqual(state.lastPass.evidenceOnly, false)
  assertEqual(state.failureStreak, 0)
  assertEqual(state.pending.c1, undefined, 'pending call cleared')
  const unrelated = foldEvidence(state, { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'zzz', content: [] } } })
  assertEqual(unrelated, state, 'unrelated result returns the same state reference')
  assertEqual(session, {}, 'fold never mutates or needs the session')
  let failing = initialEvidenceState()
  failing = foldEvidence(failing, { type: 'tool/call', seq: 4, data: { callId: 'c2', name: 'goal_verify' } })
  failing = foldEvidence(failing, { type: 'tool/result', seq: 5, time: NOW, data: { message: { toolCallId: 'c2', content: [{ type: 'text', text: FAIL_LINE }] } } })
  assertEqual(failing.failureStreak, 1)
  let recovered = failing
  recovered = foldEvidence(recovered, { type: 'tool/call', seq: 6, data: { callId: 'c3', name: 'goal_verify' } })
  recovered = foldEvidence(recovered, { type: 'tool/result', seq: 7, time: NOW + 10, data: { message: { toolCallId: 'c3', content: [{ type: 'text', text: passReport(NOW + 10) }] } } })
  assertEqual(recovered.failureStreak, 0, 'a passing run resets the failure streak')
})

test('goalRefFromView and blockReasonFor build values the goal service accepts', () => {
  assertEqual(goalRefFromView({ id: 'goal-1', revision: 4, phase: 'active' }), { id: 'goal-1', revision: 4 })
  assertEqual(goalRefFromView({ revision: 4 }), undefined)
  assertEqual(goalRefFromView(null), undefined)
  assertEqual(shouldRecordBlocker(3, { blockAfterFailures: 3, useGoalsService: true }), true)
  assertEqual(shouldRecordBlocker(2, { blockAfterFailures: 3, useGoalsService: true }), false)
  assertEqual(shouldRecordBlocker(9, { blockAfterFailures: 3, useGoalsService: false }), false)
  const reason = blockReasonFor({ commands: [{ name: 'unit', required: true, ok: false, exitCode: 2 }] })
  assertEqual(reason.code, 'verification-failed')
  assert(/unit \(exit 2\)/u.test(reason.message), reason.message)
  assert(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(reason.code), 'lower-kebab-case blocker code')
})

// ---------------------------------------------------------------------------
// Host module: installation, synchronous gate listener, native blocker
// ---------------------------------------------------------------------------

test('advisory install without a command registers the tool and the static prompt section', () => {
  const { ctx, tools, sections } = fakeCtx()
  const state = fakeState()
  const dispose = install(ctx, { goalGate: { mode: 'advisory', verifyCommand: '' } }, state)
  assertEqual(typeof dispose, 'function')
  assertEqual(tools.length, 1)
  assertEqual(tools[0].name, 'goal_verify')
  assertEqual(sections.length, 1)
  assert(/Goal completion requires evidence/u.test(sections[0].text))
  assertEqual(state.logs.filter((entry) => entry.level === 'warn').length, 0, JSON.stringify(state.logs))
})

test('resolveCwd uses only the workingDirectory service (no process.cwd fallback)', () => {
  const { ctx } = fakeCtx({ cwd: 'C:/session-dir' })
  assertEqual(resolveCwd(ctx, { agent: { session: {} } }), 'C:/session-dir')
  const missing = fakeCtx({ noCwd: true })
  assertEqual(resolveCwd(missing.ctx, { agent: { session: {} } }), undefined)
  assertEqual(resolveCwd(fakeCtx({ noCwd: true }).ctx, {}), undefined)
})

test('maybeBlockGoal records a native blocker only when the goal service is usable', () => {
  const calls = []
  const agent = {}
  const { ctx } = fakeCtx({
    services: {
      goals: {
        get: () => ({ id: 'goal-1', revision: 7, phase: 'active' }),
        block: (target, ref, reason) => calls.push({ target, ref, reason }),
      },
    },
  })
  const store = createEvidenceStore()
  store.write(agent, { ...initialEvidenceState(), failureStreak: 3 })
  const settings = resolveSettings({ goalGate: { ...ENFORCE.goalGate, blockAfterFailures: 3 } })
  const record = { at: NOW, ok: false, commands: [{ name: 'unit', required: true, ok: false, exitCode: 1 }] }
  assertEqual(maybeBlockGoal(ctx, fakeState(), store, { agent }, settings, record), true)
  assertEqual(calls.length, 1)
  assertEqual(calls[0].ref, { id: 'goal-1', revision: 7 })
  assertEqual(calls[0].reason.code, 'verification-failed')
  assertEqual(maybeBlockGoal(ctx, fakeState(), store, { agent }, settings, record), false, 'blocked once per failure streak')
  const freshStore = () => {
    const fresh = createEvidenceStore()
    fresh.write(agent, { ...initialEvidenceState(), failureStreak: 3 })
    return fresh
  }
  const missing = fakeCtx()
  assertEqual(maybeBlockGoal(missing.ctx, fakeState(), freshStore(), { agent }, settings, record), false, 'missing service fails open')
  const broken = fakeCtx({ services: { goals: { get: () => ({ id: 'g', revision: 1, phase: 'active' }), block: () => { throw new Error('nope') } } } })
  assertEqual(maybeBlockGoal(broken.ctx, fakeState(), freshStore(), { agent }, settings, record), false, 'throwing service fails open')
})

// ---------------------------------------------------------------------------
// requireReview (1.1.0): reviewGate evidence gates completion
// ---------------------------------------------------------------------------

test('resolveSettings exposes requireReview and reviewGateReason explains every state', () => {
  const settings = resolveSettings({ goalGate: { verifyCommands: [{ name: 'unit', command: 'exit 0' }], requireReview: true } })
  assertEqual(settings.requireReview, true)
  assertEqual(resolveSettings({ goalGate: { verifyCommands: [{ name: 'unit', command: 'exit 0' }] } }).requireReview, false)
  assertEqual(reviewGateReason({ requireReview: false }, { status: 'missing' }, NOW), undefined)
  const missing = reviewGateReason(settings, { status: 'missing' }, NOW)
  assert(/review_diff has not reviewed/u.test(missing), missing)
  const blocked = reviewGateReason(settings, { status: 'blocked', record: { findings: 2, files: 3 } }, NOW)
  assert(/2 blocker finding/u.test(blocked), blocked)
  assert(/review_diff again/u.test(blocked), blocked)
  const stale = reviewGateReason(settings, { status: 'stale', ageMs: 5 * settings.freshWithinMs, record: { findings: 0, files: 1 } }, NOW)
  assert(/freshness window/u.test(stale), stale)
  assertEqual(reviewGateReason(settings, { status: 'ok', record: { findings: 0 } }, NOW), undefined)
  assertEqual(reviewGateReason(settings, { status: 'weird' }, NOW), undefined, 'unknown status never invents a block')
})

test('install ignores requireReview when the reviewGate module is disabled', () => {
  const { ctx } = fakeCtx()
  const state = fakeState()
  const dispose = install(ctx, { goalGate: { ...ENFORCE.goalGate, requireReview: true }, reviewGate: { enabled: false } }, state)
  assertEqual(typeof dispose, 'function')
  assert(
    state.logs.some((entry) => entry.level === 'warn' && /reviewGate module is disabled/u.test(entry.message)),
    JSON.stringify(state.logs),
  )
  dispose()
})

// ---------------------------------------------------------------------------
// Async: real policy runs against trivial shell commands
// ---------------------------------------------------------------------------

const asyncTests = []
function testAsync(name, fn) {
  asyncTests.push({ name, fn })
}

/** Build a run context whose working directory is the current process dir. */
function runCtx(services) {
  return fakeCtx({ cwd: process.cwd(), services }).ctx
}

testAsync('runVerify runs steps in order, reports each result and never passes an empty configuration', async () => {
  const state = fakeState()
  const emptyExec = { agent: { session: {} } }
  const emptySettings = resolveSettings({ goalGate: { mode: 'advisory' } })
  const emptyStore = createEvidenceStore()
  const emptyResult = await runVerify(runCtx(), emptySettings, { handle: null }, emptyStore, emptyExec, state)
  assertEqual(emptyResult.ok, false)
  assertEqual(emptyResult.report.split('\n')[0], NOT_CONFIGURED_LINE)
  assert(/NOT a pass/u.test(emptyResult.report))
  const evidence = evidenceOf({ handle: null }, emptyStore, emptyExec.agent.session, emptyExec.agent)
  assertEqual(evidence.lastPass.evidenceOnly, true, 'evidence-only run must write a rejected record')
  assertEqual(evidence.lastPass.ok, false, 'evidence-only run must not write a passing record')
  assertEqual(hasFreshPass(evidence.lastPass, emptySettings, NOW + 1000), false, 'evidence-only record must never satisfy the gate')

  const settings = resolveSettings({
    goalGate: {
      verifyCommands: [
        { name: 'first', command: 'exit 0', required: true },
        { name: 'second', command: 'node -e "console.log(' + "'ORDER_OK'" + ')"', required: false },
        { name: 'third', command: 'exit 3', required: true },
      ],
    },
  })
  const store = createEvidenceStore()
  const exec = { agent: { session: {} } }
  const result = await runVerify(runCtx(), settings, { handle: null }, store, exec, state)
  assertEqual(result.ok, false, 'required third step failed')
  const report = result.report
  assertEqual(report.split('\n')[0], FAIL_LINE)
  const firstIndex = report.indexOf('[PASS] first (required)')
  const secondIndex = report.indexOf('[PASS] second (optional)')
  const thirdIndex = report.indexOf('[FAIL] third (required)')
  assert(firstIndex >= 0 && secondIndex > firstIndex && thirdIndex > secondIndex, 'steps reported in configured order')
  assert(report.includes('ORDER_OK'), report)
  assert(report.includes('exit code: 3'), report)
  const record = store.read(exec.agent).lastPass
  assertEqual(record.evidenceOnly, false)
  assertEqual(record.ok, false)
  assertEqual(store.read(exec.agent).failureStreak, 1)
})

testAsync('runVerify passes with required commands and records fresh evidence', async () => {
  const agent = {}
  const session = {}
  const settings = resolveSettings({ goalGate: { verifyCommands: [{ name: 'unit', command: 'exit 0', required: true }] } })
  const store = createEvidenceStore()
  const exec = { agent: { session: {} } }
  const result = await runVerify(runCtx(), settings, { handle: null }, store, exec, fakeState())
  assertEqual(result.ok, true)
  assertEqual(result.report.split('\n')[0], PASS_LINE)
  const record = store.read(exec.agent).lastPass
  assertEqual(record.evidenceOnly, false)
  assertEqual(record.ok, true)
  assert(hasFreshPass(record, settings, record.at + 1000), 'recorded pass must satisfy the gate immediately')
})

testAsync('runVerify reports a missing working directory instead of running elsewhere', async () => {
  const settings = resolveSettings({ goalGate: { verifyCommands: [{ name: 'unit', command: 'exit 0', required: true }] } })
  const { ctx } = fakeCtx({ noCwd: true })
  const result = await runVerify(ctx, settings, { handle: null }, createEvidenceStore(), { agent: { session: {} } }, fakeState())
  assertEqual(result.ok, false)
  assert(result.report.includes('cwd: (unknown)'), result.report)
  assert(result.report.includes('not started'), result.report)
})

testAsync('runVerify records a native blocker after the configured failure count', async () => {
  const calls = []
  const agent = {}
  const { ctx } = fakeCtx({
    cwd: process.cwd(),
    services: {
      goals: {
        get: () => ({ id: 'goal-9', revision: 2, phase: 'active' }),
        block: (target, ref, reason) => calls.push({ target, ref, reason }),
      },
    },
  })
  const settings = resolveSettings({
    goalGate: { blockAfterFailures: 1, verifyCommands: [{ name: 'unit', command: 'exit 5', required: true }] },
  })
  const result = await runVerify(ctx, settings, { handle: null }, createEvidenceStore(), { agent: { session: {} } }, fakeState())
  assertEqual(result.ok, false)
  assertEqual(calls.length, 1)
  assertEqual(calls[0].ref, { id: 'goal-9', revision: 2 })
  assertEqual(calls[0].reason.code, 'verification-failed')
})

testAsync('enforce gate denies a completion without evidence and allows it after a live PASS', async () => {
  const { ctx, listeners } = fakeCtx()
  const state = fakeState()
  install(ctx, ENFORCE, state)
  const gate = listeners.find((entry) => entry.name === 'tools/pre-execute')
  assert(gate !== undefined, 'gate listener registered')
  const agent = {}
  const session = {}
  const next = () => ({ kind: 'allow' })
  const denied = await gate.listener({ name: 'update_goal', arguments: { action: 'complete' }, agent }, next)
  assertEqual(denied.kind, 'deny')
  assert(/goal_verify/u.test(denied.reason), denied.reason)

  state.sessionState.emit(session, { type: 'tool/call', seq: 1, data: { callId: 'v1', name: 'goal_verify' } })
  state.sessionState.emit(session, {
    type: 'tool/result',
    seq: 2,
    time: Date.now(),
    data: { message: { toolCallId: 'v1', content: [{ type: 'text', text: passReport(Date.now()) }] } },
  })
  const allowed = await gate.listener({ name: 'update_goal', arguments: { action: 'complete' }, agent: { ...agent, session } }, next)
  assertEqual(allowed.kind, 'allow', 'fresh pass must allow completion')
})

testAsync('install fails open when host seams throw and accepts an async loader', async () => {
  const ctx = {
    on() { throw new Error('on down') },
    get() { throw new Error('get down') },
    tools: { register() { throw new Error('register down') } },
  }
  const state = fakeState({ loadHost: async () => ({ defineTool: (definition) => definition }) })
  let dispose
  try {
    dispose = install(ctx, ENFORCE, state)
  } catch (error) {
    throw new Error('install must not throw when host seams fail: ' + (error instanceof Error ? error.message : String(error)))
  }
  assertEqual(typeof dispose, 'function')
  await new Promise((resolve) => setTimeout(resolve, 0))
  dispose()
  assertEqual(typeof install(fakeCtx().ctx, { goalGate: ENFORCE.goalGate }, fakeState()), 'function')
})

testAsync('requireReview blocks completion until a fresh blocker-free review exists', async () => {
  const { ctx, listeners } = fakeCtx()
  const state = fakeState()
  install(ctx, { ...ENFORCE, goalGate: { ...ENFORCE.goalGate, requireReview: true } }, state)
  const gate = listeners.find((entry) => entry.name === 'tools/pre-execute')
  assert(gate !== undefined, 'gate listener registered')
  const agent = {}
  const session = {}
  const next = () => ({ kind: 'allow' })
  const call = (target) => gate.listener({ name: 'update_goal', arguments: { action: 'complete' }, agent: target }, next)

  let result = await call(agent)
  assertEqual(result.kind, 'deny')
  assert(/goal_verify/u.test(result.reason), 'verify evidence is still required first: ' + result.reason)

  state.sessionState.emit(session, { type: 'tool/call', seq: 1, data: { callId: 'v1', name: 'goal_verify' } })
  state.sessionState.emit(session, {
    type: 'tool/result',
    seq: 2,
    time: Date.now(),
    data: { message: { toolCallId: 'v1', content: [{ type: 'text', text: passReport(Date.now()) }] } },
  })
  const liveAgent = { ...agent, session }
  result = await call(liveAgent)
  assertEqual(result.kind, 'deny', 'fresh verify evidence alone is not enough when a review is required')
  assert(/review_diff/u.test(result.reason), result.reason)

  state.reviews = new WeakMap()
  state.reviews.set(liveAgent, { at: Date.now(), ok: true, findings: 0, files: 1 })
  result = await call(liveAgent)
  assertEqual(result.kind, 'allow', 'fresh blocker-free review must allow completion')

  state.reviews.set(liveAgent, { at: Date.now(), ok: false, findings: 2, files: 1 })
  result = await call(liveAgent)
  assertEqual(result.kind, 'deny', 'blocker findings must block completion')
  assert(/blocker finding/u.test(result.reason), result.reason)

  state.reviews.set(liveAgent, { at: Date.now() - 8 * 24 * 60 * 60 * 1000, ok: true, findings: 0, files: 1 })
  result = await call(liveAgent)
  assertEqual(result.kind, 'deny', 'stale review must block completion')
  assert(/freshness window/u.test(result.reason), result.reason)
})

testAsync('requireReview fails open when the reviewer module failed to register', async () => {
  const { ctx, listeners } = fakeCtx()
  const state = fakeState()
  state.reviewGateReady = false
  install(ctx, { ...ENFORCE, goalGate: { ...ENFORCE.goalGate, requireReview: true } }, state)
  const gate = listeners.find((entry) => entry.name === 'tools/pre-execute')
  const session = {}
  state.sessionState.emit(session, { type: 'tool/call', seq: 1, data: { callId: 'v1', name: 'goal_verify' } })
  state.sessionState.emit(session, {
    type: 'tool/result',
    seq: 2,
    time: Date.now(),
    data: { message: { toolCallId: 'v1', content: [{ type: 'text', text: passReport(Date.now()) }] } },
  })
  const result = await gate.listener({ name: 'update_goal', arguments: { action: 'complete' }, agent: { session } }, () => ({ kind: 'allow' }))
  assertEqual(result.kind, 'allow', 'an unavailable reviewer must not trap completion forever')
})

testAsync('requireReview fails open when the reviewer is disabled', async () => {
  const { ctx, listeners } = fakeCtx()
  const state = fakeState()
  install(ctx, { ...ENFORCE, goalGate: { ...ENFORCE.goalGate, requireReview: true }, reviewGate: { enabled: false } }, state)
  const gate = listeners.find((entry) => entry.name === 'tools/pre-execute')
  const agent = {}
  const session = {}
  state.sessionState.emit(session, { type: 'tool/call', seq: 1, data: { callId: 'v1', name: 'goal_verify' } })
  state.sessionState.emit(session, {
    type: 'tool/result',
    seq: 2,
    time: Date.now(),
    data: { message: { toolCallId: 'v1', content: [{ type: 'text', text: passReport(Date.now()) }] } },
  })
  const result = await gate.listener({ name: 'update_goal', arguments: { action: 'complete' }, agent: { ...agent, session } }, () => ({ kind: 'allow' }))
  assertEqual(result.kind, 'allow', 'a disabled reviewer must not trap completion forever')
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
