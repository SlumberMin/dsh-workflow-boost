/**
 * hookBus 测试：纯解析/映射 + fake ctx/runCommand 驱动的六事件集成。
 *
 * 测试不允许静态依赖 @deepseek-ai/*：install 通过 state.runCommand 注入 fake
 * 命令执行器，通过 state.loadHost 注入（或缺失）消息工厂。
 */
import { test, assert, assertEqual } from '../harness.mjs'
import { sectionDefaults } from '../../lib/defaults.js'
import { install } from '../../lib/hook-bus.js'
import {
  HOOK_EVENTS,
  buildHookPayload,
  clipText,
  contentToText,
  hookTimeout,
  mapContextResult,
  mapPostToolResult,
  mapPreToolResult,
  mapStopResult,
  matcherMatches,
  parseHookStdout,
  resolveHookBusOptions,
  selectHooks,
  shellInvocation,
  summarizeToolResult,
} from '../../lib/pure/hook-core.js'

// ---------- 纯逻辑 ----------

test('resolveHookBusOptions defaults to disabled and drops invalid hooks', () => {
  const defaults = resolveHookBusOptions(sectionDefaults('hookBus', {}))
  assertEqual(defaults.enabled, false, 'hooks are off by default')
  assertEqual(defaults.timeoutMs, 10000)
  assertEqual(defaults.hooks.length, 0)
  const configured = resolveHookBusOptions({
    enabled: true,
    timeoutMs: 1,
    hooks: [
      { name: 'ok', event: 'PreToolUse', matcher: 'read', command: ' echo ok ' },
      { name: '', event: 'PostToolUse', command: 'echo x', timeoutMs: 3000 },
      { name: 'bad-event', event: 'Nope', command: 'echo x' },
      { name: 'no-command', event: 'Stop', command: '   ' },
      null,
    ],
  })
  assertEqual(configured.enabled, true)
  assertEqual(configured.timeoutMs, 500, 'timeout is clamped to the floor')
  assertEqual(configured.hooks.length, 2)
  assertEqual(configured.hooks[0].command, 'echo ok', 'command is trimmed')
  assertEqual(configured.hooks[1].name, 'hook-2', 'missing name gets a stable default')
  assertEqual(configured.hooks[1].timeoutMs, 3000)
  assertEqual(configured.dropped.length, 3)
  assertEqual(hookTimeout(configured.hooks[0], configured), 500, 'per-hook override falls back to the section timeout')
  assertEqual(hookTimeout(configured.hooks[1], configured), 3000)
  assertEqual(HOOK_EVENTS.length, 6)
})

test('matcher matches tool names and selectHooks filters by event', () => {
  assert(matcherMatches('', 'read'), 'empty matcher matches everything')
  assert(matcherMatches('read|write', 'write'), 'regex alternation')
  assert(matcherMatches('^read$', 'read'))
  assert(!matcherMatches('^read$', 'read_file'))
  assert(!matcherMatches('(', 'read'), 'invalid regex matches nothing (fail-open)')
  const options = resolveHookBusOptions({
    enabled: true,
    hooks: [
      { event: 'PreToolUse', matcher: 'read', command: 'a' },
      { event: 'PreToolUse', matcher: 'write', command: 'b' },
      { event: 'Stop', command: 'c' },
      { event: 'Stop', matcher: 'never-matches', command: 'd' },
    ],
  })
  const pre = selectHooks(options, 'PreToolUse', 'read')
  assertEqual(pre.map((hook) => hook.command), ['a'])
  assertEqual(selectHooks(options, 'PreToolUse', 'bash').length, 0)
  assertEqual(selectHooks(options, 'Stop', 'anything').map((hook) => hook.command), ['c', 'd'], 'non-tool events ignore matcher')
})

test('shellInvocation uses the platform shell wrapper', () => {
  assertEqual(shellInvocation('echo hi', 'win32', 'C:/Windows/cmd.exe'), {
    file: 'C:/Windows/cmd.exe',
    args: ['/d', '/s', '/c', 'echo hi'],
  })
  assertEqual(shellInvocation('echo hi', 'win32', undefined), { file: 'cmd.exe', args: ['/d', '/s', '/c', 'echo hi'] })
  assertEqual(shellInvocation('echo hi', 'linux', undefined), { file: '/bin/sh', args: ['-c', 'echo hi'] })
})

test('buildHookPayload carries the Claude Code compatible fields', () => {
  const pre = JSON.parse(buildHookPayload({
    event: 'PreToolUse',
    toolName: 'read',
    toolInput: { path: 'a.ts' },
    cwd: 'D:/ws',
    sessionId: 's1',
  }))
  assertEqual(pre.hook_event_name, 'PreToolUse')
  assertEqual(pre.tool_name, 'read')
  assertEqual(pre.tool_input, { path: 'a.ts' })
  assertEqual(pre.cwd, 'D:/ws')
  assertEqual(pre.session_id, 's1')
  assertEqual(pre.tool_response, undefined)
  const post = JSON.parse(buildHookPayload({ event: 'PostToolUse', toolName: 'bash', toolInput: {}, toolResponseText: 'done' }))
  assertEqual(post.tool_response, 'done')
  assertEqual(post.cwd, undefined, 'missing cwd is omitted, never guessed')
  assertEqual(post.session_id, undefined)
  const stop = JSON.parse(buildHookPayload({ event: 'Stop' }))
  assertEqual(stop, { hook_event_name: 'Stop' })
  const prompt = JSON.parse(buildHookPayload({ event: 'UserPromptSubmit', promptText: 'hello' }))
  assertEqual(prompt.prompt, 'hello')
})

test('parseHookStdout only accepts plain objects', () => {
  assertEqual(parseHookStdout('{"decision":"deny"}'), { decision: 'deny' })
  assertEqual(parseHookStdout('  {"a":1}  '), { a: 1 })
  assertEqual(parseHookStdout('not json'), undefined)
  assertEqual(parseHookStdout(''), undefined)
  assertEqual(parseHookStdout('[1,2]'), undefined)
  assertEqual(parseHookStdout('"text"'), undefined)
  assertEqual(parseHookStdout('null'), undefined)
  assertEqual(parseHookStdout(undefined), undefined)
})

test('mapPreToolResult implements exit code and JSON decision semantics', () => {
  const hook = { name: 'p' }
  assertEqual(mapPreToolResult(hook, { code: 2, stderr: 'nope', stdout: '' }), { decision: 'deny', reason: 'nope' })
  assertEqual(
    mapPreToolResult(hook, { code: 2, stderr: '', stdout: '' }).reason,
    'hook "p" denied this tool call (exit 2)',
  )
  assertEqual(mapPreToolResult(hook, { code: 0, stdout: '{"decision":"deny","reason":"rule"}' }), { decision: 'deny', reason: 'rule' })
  assertEqual(mapPreToolResult(hook, { code: 0, stdout: '{"decision":"allow"}' }), { decision: 'allow' })
  assertEqual(mapPreToolResult(hook, { code: 0, stdout: '{}' }), { decision: 'pass' })
  assertEqual(mapPreToolResult(hook, { code: 0, stdout: 'garbage' }), { decision: 'pass' })
  const failed = mapPreToolResult(hook, { code: 1, stderr: 'boom' })
  assertEqual(failed.decision, 'pass')
  assert(failed.warning.includes('exited with code 1'), 'non-zero exit is a fail-open warning')
  const timeout = mapPreToolResult(hook, { code: -1, timedOut: true })
  assertEqual(timeout.decision, 'pass')
  assert(timeout.warning.includes('timed out'))
})

test('mapPostToolResult blocks on exit 2 and injects additionalContext', () => {
  const hook = { name: 'post' }
  assertEqual(mapPostToolResult(hook, { code: 2, stderr: 'revert that', stdout: '' }), { decision: 'block', feedback: 'revert that' })
  assertEqual(
    mapPostToolResult(hook, { code: 0, stdout: '{"additionalContext":"remember X"}' }),
    { decision: 'context', context: 'remember X' },
  )
  assertEqual(mapPostToolResult(hook, { code: 0, stdout: '{"other":1}' }), { decision: 'pass' })
  assertEqual(mapPostToolResult(hook, { code: 3, stdout: '' }).decision, 'pass')
  assertEqual(mapPostToolResult(hook, { code: 0, stdout: '' }).decision, 'pass')
})

test('mapStopResult continues only when asked', () => {
  const hook = { name: 'stop' }
  assertEqual(mapStopResult(hook, { code: 0, stdout: '{"continue":true,"message":"finish X"}' }), { continue: true, message: 'finish X' })
  assertEqual(mapStopResult(hook, { code: 2, stderr: 'not done', stdout: '' }), { continue: true, message: 'not done' })
  assertEqual(mapStopResult(hook, { code: 0, stdout: '{"continue":false}' }), { continue: false })
  assertEqual(mapStopResult(hook, { code: 0, stdout: '' }), { continue: false })
  const timedOut = mapStopResult(hook, { code: -1, timedOut: true })
  assertEqual(timedOut.continue, false)
  assert(timedOut.warning.includes('timed out'))
})

test('mapContextResult extracts additionalContext only', () => {
  const hook = { name: 'ctx' }
  assertEqual(mapContextResult(hook, { code: 0, stdout: '{"additionalContext":"note"}' }), { context: 'note' })
  assertEqual(mapContextResult(hook, { code: 0, stdout: '{}' }), {})
  assertEqual(mapContextResult(hook, { code: 0, stdout: 'bad json' }), {})
  const failed = mapContextResult(hook, { code: 4, stdout: '' })
  assertEqual(failed.context, undefined)
  assert(failed.warning.includes('exited with code 4'))
})

test('text helpers summarize tool results without leaking structure', () => {
  assertEqual(contentToText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  assertEqual(contentToText('plain'), 'plain')
  assertEqual(contentToText(undefined), '')
  assertEqual(summarizeToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }), '[error] boom')
  assertEqual(summarizeToolResult({ content: [] }), '')
  assertEqual(summarizeToolResult({ content: [], error: { message: 'oops' } }), 'oops')
  assert(clipText('x'.repeat(30), 10).includes('+20 chars'))
  assertEqual(clipText('short', 100), 'short')
})

// ---------- 集成（fake ctx / runCommand） ----------

function createCtx(services = {}) {
  const listeners = new Map()
  return {
    listeners,
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
    get(name) {
      return services[name]
    },
  }
}

function createState(runCommand, options = {}) {
  const calls = []
  const logs = []
  const state = {
    calls,
    logs,
    log(level, message) {
      logs.push({ level, message })
    },
    runCommand: async (file, args, runOptions) => {
      calls.push({ file, args, runOptions })
      return runCommand(file, args, runOptions)
    },
    loadHost: options.loadHost ?? (async () => undefined),
  }
  return state
}

const config = (hooks) => ({ hookBus: { enabled: true, timeoutMs: 5000, hooks } })
const handler = (ctx, name) => (ctx.listeners.get(name) ?? [])[0]
const preExecute = (ctx, toolExec) => handler(ctx, 'tools/pre-execute')(toolExec, () => Promise.resolve({ kind: 'allow' }))
const postExecute = (ctx, toolExec, result) =>
  handler(ctx, 'tools/post-execute')(toolExec, result, () => Promise.resolve({ kind: 'accept' }))
const turnStopping = (ctx, payload) => handler(ctx, 'agent/turn-stopping')(payload)
const fireEvent = (ctx, name, ...args) => {
  for (const listener of ctx.listeners.get(name) ?? []) listener(...args)
}
const flush = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))

function createAgent(session) {
  const agent = { session, steers: [] }
  agent.steer = (message) => agent.steers.push(message)
  return agent
}

test('default configuration installs nothing', () => {
  const ctx = createCtx()
  const state = createState(async () => ({ code: 0 }))
  const dispose = install(ctx, {}, state)
  assertEqual(ctx.listeners.size, 0, 'disabled by default')
  assert(typeof dispose === 'function')
  dispose()
  const disabledCtx = createCtx()
  install(disabledCtx, { hookBus: { enabled: false, hooks: [{ event: 'Stop', command: 'echo hi' }] } }, createState(async () => ({ code: 0 })))
  assertEqual(disabledCtx.listeners.size, 0)
})

test('PreToolUse denies on exit 2 with the configured command and JSON stdin', async () => {
  const ctx = createCtx({ workingDirectory: { get: () => 'D:/ws' } })
  const session = { id: 's-1' }
  const state = createState(async () => ({ code: 2, stdout: '', stderr: 'blocked by policy' }))
  install(ctx, config([{ name: 'deny-push', event: 'PreToolUse', matcher: '^bash$', command: 'guard --check' }]), state)
  const decision = await preExecute(ctx, { name: 'bash', arguments: { command: 'git push --force' }, agent: { session } })
  assertEqual(decision.kind, 'deny')
  assertEqual(decision.reason, 'blocked by policy')
  assertEqual(state.calls.length, 1)
  const call = state.calls[0]
  assertEqual(call.args[call.args.length - 1], 'guard --check', 'the model never supplies the command')
  const stdin = JSON.parse(call.runOptions.stdin)
  assertEqual(stdin.hook_event_name, 'PreToolUse')
  assertEqual(stdin.tool_name, 'bash')
  assertEqual(stdin.tool_input.command, 'git push --force')
  assertEqual(stdin.cwd, 'D:/ws')
  assertEqual(stdin.session_id, 's-1')
  assertEqual(call.runOptions.timeoutMs, 5000)
})

test('PreToolUse honours JSON decisions, matcher mismatch and fail-open exits', async () => {
  const ctx = createCtx()
  const session = { id: 's' }
  const state = createState(async () => ({ code: 0, stdout: '{"decision":"deny","reason":"rule says no"}' }))
  install(ctx, config([{ event: 'PreToolUse', matcher: '^write$', command: 'check' }]), state)
  assertEqual((await preExecute(ctx, { name: 'read', arguments: {}, agent: { session } })).kind, 'allow', 'matcher mismatch allows')
  const denied = await preExecute(ctx, { name: 'write', arguments: {}, agent: { session } })
  assertEqual(denied.kind, 'deny')
  assertEqual(denied.reason, 'rule says no')

  // 非 0/2 exit：放行并 log warn（fail-open）。
  const failCtx = createCtx()
  const failState = createState(async () => ({ code: 7, stdout: '', stderr: 'crash' }))
  install(failCtx, config([{ event: 'PreToolUse', command: 'broken' }]), failState)
  assertEqual((await preExecute(failCtx, { name: 'read', arguments: {}, agent: { session } })).kind, 'allow')
  assert(failState.logs.some((entry) => entry.level === 'warn' && entry.message.includes('exited with code 7')))
})

test('PostToolUse injects additionalContext and blocks on exit 2', async () => {
  const ctx = createCtx()
  const session = { id: 's' }
  const state = createState(async () => ({ code: 0, stdout: '{"additionalContext":"remember the schema"}' }))
  install(ctx, config([{ event: 'PostToolUse', matcher: 'write', command: 'fmt' }]), state)
  const accepted = await postExecute(ctx, { name: 'write', arguments: { path: 'a.ts' }, agent: { session } }, { content: [{ type: 'text', text: 'ok' }], isError: false })
  assertEqual(accepted.kind, 'accept')
  assertEqual(accepted.additionalContexts.length, 1)
  assertEqual(accepted.additionalContexts[0].content[0].text, 'remember the schema')
  assertEqual(accepted.additionalContexts[0].source.kind, 'dsh-workflow-boost')
  assertEqual(accepted.additionalContexts[0].source.form, 'notice')
  const stdin = JSON.parse(state.calls[0].runOptions.stdin)
  assertEqual(stdin.hook_event_name, 'PostToolUse')
  assertEqual(stdin.tool_response, 'ok')

  const blockCtx = createCtx()
  const blockState = createState(async () => ({ code: 2, stdout: '', stderr: 'revert the change' }))
  install(blockCtx, config([{ event: 'PostToolUse', command: 'guard' }]), blockState)
  const blocked = await postExecute(blockCtx, { name: 'write', arguments: {}, agent: { session } }, { content: [], isError: false })
  assertEqual(blocked.kind, 'block')
  assertEqual(blocked.feedback, 'revert the change')
})

test('PreCompact and UserPromptSubmit contexts are queued and injected once', async () => {
  const ctx = createCtx()
  const session = { id: 's' }
  const state = createState(async (file, args) => {
    const command = args[args.length - 1]
    if (command === 'compact-hook') return { code: 0, stdout: '{"additionalContext":"compaction note"}' }
    return { code: 0, stdout: '{"additionalContext":"prompt note"}' }
  })
  install(ctx, config([
    { name: 'pre-compact', event: 'PreCompact', command: 'compact-hook' },
    { name: 'prompt', event: 'UserPromptSubmit', command: 'prompt-hook' },
  ]), state)
  fireEvent(ctx, 'session/event', session, { type: 'compaction/start', data: {} })
  fireEvent(ctx, 'session/event', session, {
    type: 'user/message',
    data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'do X' }] } },
  })
  await flush()
  assertEqual(state.calls.length, 2)
  const promptCall = state.calls.find((call) => call.args[call.args.length - 1] === 'prompt-hook')
  assertEqual(JSON.parse(promptCall.runOptions.stdin).prompt, 'do X')
  const injected = await postExecute(ctx, { name: 'read', arguments: {}, agent: { session } }, { content: [], isError: false })
  assertEqual(injected.additionalContexts.length, 2, 'both queued contexts arrive together')
  const texts = injected.additionalContexts.map((message) => message.content[0].text).sort()
  assertEqual(texts, ['compaction note', 'prompt note'])
  const again = await postExecute(ctx, { name: 'read', arguments: {}, agent: { session } }, { content: [], isError: false })
  assertEqual(again.additionalContexts, undefined, 'the queue is drained once')
  // 非用户来源的 user/message 不触发 UserPromptSubmit。
  const before = state.calls.length
  fireEvent(ctx, 'session/event', session, {
    type: 'user/message',
    data: { message: { source: { kind: 'repeat-tool-reminder' }, content: [] } },
  })
  await flush()
  assertEqual(state.calls.length, before)
})

test('Stop steers the turn open at most once per turn', async () => {
  const ctx = createCtx()
  const session = { id: 's' }
  const agent = createAgent(session)
  let mode = 'continue'
  const state = createState(async () => {
    if (mode === 'continue') return { code: 0, stdout: '{"continue":true,"message":"finish the report"}' }
    return { code: 2, stdout: '', stderr: 'tests still failing' }
  })
  install(ctx, config([{ name: 'stop-hook', event: 'Stop', command: 'stop-check' }]), state)
  await turnStopping(ctx, { agent, turn: 1, signal: { aborted: false } })
  assertEqual(agent.steers.length, 1)
  assertEqual(agent.steers[0].content[0].text, 'finish the report')
  assertEqual(agent.steers[0].source.kind, 'dsh-workflow-boost')
  assertEqual(agent.steers[0].source.form, 'notice')
  await turnStopping(ctx, { agent, turn: 1, signal: { aborted: false } })
  assertEqual(agent.steers.length, 1, 'one steer per turn')
  mode = 'exit2'
  await turnStopping(ctx, { agent, turn: 2, signal: { aborted: false } })
  assertEqual(agent.steers.length, 2, 'a new turn can steer again')
  assertEqual(agent.steers[1].content[0].text, 'tests still failing')
})

test('SessionStart runs as a side effect on agent/created', async () => {
  const ctx = createCtx({ workingDirectory: { get: () => 'D:/ws' } })
  const state = createState(async () => ({ code: 0, stdout: '{"continue":true}' }))
  install(ctx, config([{ name: 'start', event: 'SessionStart', command: 'bootstrap' }]), state)
  fireEvent(ctx, 'agent/created', { agent: { session: { id: 's9' } } })
  await flush()
  assertEqual(state.calls.length, 1)
  const stdin = JSON.parse(state.calls[0].runOptions.stdin)
  assertEqual(stdin.hook_event_name, 'SessionStart')
  assertEqual(stdin.session_id, 's9')
  assertEqual(stdin.cwd, 'D:/ws')
})

test('a timed-out hook fails open and is logged', async () => {
  const ctx = createCtx()
  const state = createState(async () => ({ code: -1, stdout: '', stderr: '', timedOut: true }))
  install(ctx, config([{ name: 'slow', event: 'PreToolUse', command: 'slow-check', timeoutMs: 800 }]), state)
  const decision = await preExecute(ctx, { name: 'read', arguments: {}, agent: { session: {} } })
  assertEqual(decision.kind, 'allow')
  assertEqual(state.calls[0].runOptions.timeoutMs, 800, 'per-hook timeout reaches runCommand')
  assert(state.logs.some((entry) => entry.level === 'warn' && entry.message.includes('timed out')))
})

test('install is fail-open with a hostile ctx and disposes listeners', () => {
  const throwing = {
    on() {
      throw new Error('boom')
    },
    get() {
      throw new Error('boom')
    },
  }
  const dispose = install(throwing, config([{ event: 'PreToolUse', command: 'x' }]), createState(async () => ({ code: 0 })))
  assert(typeof dispose === 'function')
  dispose()
  const empty = install({}, config([{ event: 'Stop', command: 'x' }]), createState(async () => ({ code: 0 })))
  assert(typeof empty === 'function')
  empty()
  const ctx = createCtx()
  const state = createState(async () => ({ code: 0 }))
  const cleanup = install(ctx, config([{ event: 'PreToolUse', command: 'x' }]), state)
  assertEqual(ctx.listeners.get('tools/pre-execute').length, 1)
  cleanup()
  assertEqual(ctx.listeners.get('tools/pre-execute').length, 0)
})

test('only configured events register listeners', () => {
  const ctx = createCtx()
  install(ctx, config([
    { event: 'PreToolUse', command: 'a' },
    { event: 'Stop', command: 'b' },
  ]), createState(async () => ({ code: 0 })))
  assert(handler(ctx, 'tools/pre-execute') !== undefined)
  assert(handler(ctx, 'agent/turn-stopping') !== undefined)
  assertEqual(handler(ctx, 'tools/post-execute'), undefined)
  assertEqual(handler(ctx, 'session/event'), undefined)
  assertEqual(handler(ctx, 'agent/created'), undefined)
})
