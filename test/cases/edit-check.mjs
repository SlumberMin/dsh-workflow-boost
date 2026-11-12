/** Case file: editCheck (post-edit lint/typecheck gate + reflexion). */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, assert } from '../harness.mjs'
import { estimateTokens } from '../../lib/shared.js'
import * as core from '../../lib/pure/edit-check-core.js'
import { install, resolveSettings } from '../../lib/edit-check.js'

const cases = []
const case_ = (name, fn) => cases.push([name, fn])

/** Minimal ctx exposing the documented seams this module reads. */
function makeCtx(options = {}) {
  const listeners = new Map()
  const tools = []
  const ctx = {
    listeners,
    tools,
    on(name, listener) {
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
  ctx.tools = { register(definition) { tools.push(definition); return () => {} } }
  return ctx
}

/** Minimal plugin state; loadHost is injected so tool loading stays host-free. */
function makeState(options = {}) {
  let turn = options.turn ?? 1
  return {
    turn,
    log() {},
    loadHost: async () => ({ defineTool: (definition) => definition }),
    sessionState: {
      stateOf: () => ({ turn }),
      onEvent: () => () => {},
    },
  }
}

function writeExec(workspace, filePath = 'src/a.ts', extra = {}) {
  const session = { id: 's-1' }
  return {
    exec: {
      name: 'write',
      arguments: { file_path: filePath, content: 'x' },
      agent: { session },
      signal: undefined,
      ...extra,
    },
    session,
  }
}

/** Invoke the registered post-execute listener the way Cordis would. */
async function runPost(ctx, exec, result = { isError: false }) {
  const listeners = ctx.listeners.get('tools/post-execute') ?? []
  assert(listeners.length >= 1, 'post-execute listener not registered')
  return listeners[0](exec, result, async () => ({ kind: 'accept' }))
}

function nodeCommand(script) {
  return [process.execPath, '-e', script]
}

const counterScript = (counter) => 'require("node:fs").appendFileSync(' + JSON.stringify(counter) + ', "x")'

async function withWorkspace(fn) {
  const workspace = await mkdtemp(join(tmpdir(), 'wfb-editcheck-'))
  try {
    return await fn(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

case_('core: command strings split like a shell without using one', () => {
  const parsed = core.parseCommandLine('npx tsc --noEmit -p .')
  assert(String(parsed.command).includes('npx'), 'command kept')
  assert(parsed.args.length === 4, 'args split: ' + JSON.stringify(parsed.args))
  const quoted = core.parseCommandLine('node -e "process.exit(1)"')
  assert(quoted.args[1] === 'process.exit(1)', 'double-quoted argument kept: ' + JSON.stringify(quoted.args))
  const single = core.parseCommandLine("node -e 'a b'")
  assert(single.args[1] === 'a b', 'single-quoted argument kept')
  const arrayForm = core.parseCommandLine(['node', '-e', 'x y'])
  assert(arrayForm.command === 'node' && arrayForm.args[1] === 'x y', 'argv array accepted')
  let threw = false
  try { core.parseCommandLine('   ') } catch { threw = true }
  assert(threw, 'empty command must throw so the runtime can skip it')
})

case_('core: write tools and their touched files are recognised', () => {
  assert(core.isWriteTool('write') && core.isWriteTool('apply_patch') && core.isWriteTool('str_replace_editor'), 'write tools identified')
  assert(!core.isWriteTool('read') && !core.isWriteTool('bash'), 'non-write tools excluded')
  assert(core.pathsFromToolCall('write', { file_path: 'src/a.ts' })[0] === 'src/a.ts', 'write path')
  assert(core.pathsFromToolCall('str_replace_editor', { path: 'src/b.ts' })[0] === 'src/b.ts', 'str_replace_editor path')
  const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '*** Move to: src/c.ts', '*** Add File: src/new.ts', '*** Delete File: src/old.ts', '*** End Patch'].join('\n')
  const paths = core.pathsFromPatch(patch)
  assert(paths.includes('src/a.ts') && paths.includes('src/c.ts') && paths.includes('src/new.ts') && paths.includes('src/old.ts'), 'patch paths: ' + JSON.stringify(paths))
  const outside = core.relativeToWorkspace('C:/ws', 'C:/other/a.ts')
  assert(outside.ok === false && outside.reason === 'outside-workspace', 'outside path rejected')
  const inside = core.relativeToWorkspace('C:/ws', 'C:/ws/src/a.ts')
  assert(inside.ok === true && inside.relative === 'src/a.ts', 'inside path mapped: ' + JSON.stringify(inside))
})

case_('core: glob when selects checks and duplicate commands collapse', () => {
  const checks = [
    { name: 'tsc', when: ['**/*.ts'], command: 'npx tsc --noEmit' },
    { name: 'tsc-dup', when: ['src/**'], command: 'npx tsc --noEmit' },
    { name: 'lint', when: ['**/*.js'], command: 'eslint .' },
    { name: 'always', command: 'npm test' },
  ]
  const selected = core.selectMatchingChecks(checks, ['src/a.ts'])
  assert(selected.length === 2, 'identical tsc command deduped + always matches: ' + JSON.stringify(selected.map((check) => check.name)))
  assert(selected[0].name === 'tsc' && selected[1].name === 'always', 'config order preserved')
  assert(core.checkMatchesFile({ when: [] }, 'anything') === true, 'omitted when matches everything')
})

case_('core: failure text keeps the head, tail, first error and token budget', () => {
  const lines = []
  for (let index = 0; index < 120; index += 1) lines.push('line ' + index + ' noise')
  lines.splice(2, 0, 'src/a.ts(10,7): error TS2322: Type string is not assignable to number')
  const output = lines.join('\n')
  const text = core.buildCheckFailureText({ check: { name: 'tsc', command: 'npx tsc', maxOutputTokens: 400 }, run: { code: 2, stdout: output, stderr: '' } })
  assert(text.includes('error TS2322'), 'first error pinpointed')
  assert(text.includes('lines omitted'), 'middle of a long output elided')
  assert(text.includes('line 119 noise'), 'tail kept')
  assert(estimateTokens(text) <= 420, 'bounded by the check budget, got ' + estimateTokens(text))
  const reflection = core.buildReflectionMessage({ failures: [text, text, text], attempt: 1, maxReflections: 3, budget: 1200, files: ['src/a.ts'] })
  assert(reflection.includes('fix attempt 1/3'), 'attempt counter present')
  assert(estimateTokens(reflection) <= 1200, 'reflection bounded, got ' + estimateTokens(reflection))
  const exhausted = core.buildReflectionMessage({ failures: [text], attempt: 4, maxReflections: 3, exhausted: true, budget: 1200 })
  assert(/Stop automatic fix attempts/u.test(exhausted), 'exhausted wording asks the model to report')
})

case_('install: disabled by default (zero listeners, zero cost)', () => {
  const ctx = makeCtx()
  const disposer = install(ctx, {}, makeState())
  assert(disposer === undefined, 'default config returns no disposer')
  assert((ctx.listeners.get('tools/post-execute') ?? []).length === 0, 'no listener registered')
  const disabled = install(ctx, { editCheck: { enabled: false, checks: [{ name: 'x', command: 'true' }] } }, makeState())
  assert(disabled === undefined, 'explicit disable returns no disposer')
})

case_('install: failing check injects a bounded reflection in the session cwd', async () => {
  await withWorkspace(async (workspace) => {
    const settings = {
      editCheck: {
        enabled: true,
        debounceMs: 0,
        checks: [{
          name: 'typecheck',
          when: ['**/*.ts'],
          command: nodeCommand('console.error("src/a.ts(3,5): error TS2322: boom"); process.exit(2)'),
          maxOutputTokens: 600,
        }],
      },
    }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    const state = makeState({ turn: 4 })
    const disposer = install(ctx, settings, state)
    assert(typeof disposer === 'function', 'disposer returned')
    const { exec } = writeExec(workspace)
    const decision = await runPost(ctx, exec)
    assert(decision.kind === 'accept', 'decision kind preserved')
    assert(Array.isArray(decision.additionalContexts) && decision.additionalContexts.length === 1, 'one context injected')
    const message = decision.additionalContexts[0]
    const text = message.content[0].text
    assert(message.role === 'user' && message.source.form === 'notice', 'injected as a user notice')
    assert(text.includes('error TS2322'), 'compiler error surfaced: ' + text)
    assert(text.includes('fix attempt 1/3'), 'reflexion counter surfaced')
    assert(estimateTokens(text) <= 600, 'context within budget, got ' + estimateTokens(text))
    disposer()
  })
})

case_('install: passing check stays silent unless reportSuccess is set', async () => {
  await withWorkspace(async (workspace) => {
    const base = {
      editCheck: {
        enabled: true,
        debounceMs: 0,
        checks: [{ name: 'unit', when: ['**/*.ts'], command: nodeCommand('process.exit(0)') }],
      },
    }
    let ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    let disposer = install(ctx, base, makeState())
    assert((await runPost(ctx, writeExec(workspace).exec)).additionalContexts === undefined, 'silent on success by default')
    disposer()

    ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    disposer = install(ctx, { editCheck: { ...base.editCheck, reportSuccess: true, debounceMs: 0 } }, makeState())
    const decision = await runPost(ctx, writeExec(workspace).exec)
    const text = decision.additionalContexts?.[0]?.content?.[0]?.text ?? ''
    assert(text.includes('passed'), 'success reported when configured: ' + text)
    disposer()
  })
})

case_('install: debounce and maxPerTurn cap the number of runs', async () => {
  await withWorkspace(async (workspace) => {
    const counter = join(workspace, 'runs.txt')
    const settings = {
      editCheck: {
        enabled: true,
        debounceMs: 60000,
        maxPerTurn: 10,
        checks: [{ name: 'count', command: nodeCommand(counterScript(counter)) }],
      },
    }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    install(ctx, settings, makeState({ turn: 1 }))
    const exec = writeExec(workspace).exec
    const first = await runPost(ctx, exec)
    assert(first.additionalContexts === undefined, 'passing check silent')
    const second = await runPost(ctx, exec)
    assert(second.additionalContexts === undefined, 'passing check silent again')
    const { readFile } = await import('node:fs/promises')
    const runs = (await readFile(counter, 'utf8')).length
    assert(runs === 1, 'debounce forced a single run, got ' + runs)
  })

  await withWorkspace(async (workspace) => {
    const counter = join(workspace, 'runs.txt')
    const settings = {
      editCheck: {
        enabled: true,
        debounceMs: 0,
        maxPerTurn: 1,
        checks: [{ name: 'count', command: nodeCommand(counterScript(counter)) }],
      },
    }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    install(ctx, settings, makeState({ turn: 2 }))
    const exec = writeExec(workspace).exec
    await runPost(ctx, exec)
    await runPost(ctx, exec)
    const { readFile } = await import('node:fs/promises')
    const runs = (await readFile(counter, 'utf8')).length
    assert(runs === 1, 'maxPerTurn forced a single run, got ' + runs)
  })
})

case_('install: maxReflections exhaustion asks the model to stop and report', async () => {
  await withWorkspace(async (workspace) => {
    const settings = {
      editCheck: {
        enabled: true,
        debounceMs: 0,
        maxPerTurn: 10,
        maxReflections: 2,
        checks: [{ name: 'broken', command: nodeCommand('console.error("boom"); process.exit(1)') }],
      },
    }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    install(ctx, settings, makeState({ turn: 3 }))
    const exec = writeExec(workspace).exec
    const first = await runPost(ctx, exec)
    assert(first.additionalContexts[0].content[0].text.includes('fix attempt 1/2'), 'first attempt 1/2')
    const second = await runPost(ctx, exec)
    assert(second.additionalContexts[0].content[0].text.includes('fix attempt 2/2'), 'second attempt 2/2')
    const third = await runPost(ctx, exec)
    const exhausted = third.additionalContexts[0].content[0].text
    assert(/Stop automatic fix attempts/u.test(exhausted), 'third run switches to report-only: ' + exhausted)
    const fourth = await runPost(ctx, exec)
    assert(fourth.additionalContexts === undefined, 'no further checks once exhausted')
  })
})

case_('install: timeout and spawn failures fail open (no injection, no throw)', async () => {
  await withWorkspace(async (workspace) => {
    const slow = {
      editCheck: {
        enabled: true,
        debounceMs: 0,
        checks: [{ name: 'slow', command: nodeCommand('setTimeout(() => {}, 5000)'), timeoutMs: 1000 }],
      },
    }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    install(ctx, slow, makeState({ turn: 5 }))
    const decision = await runPost(ctx, writeExec(workspace).exec)
    assert(decision.kind === 'accept' && decision.additionalContexts === undefined, 'timeout did not inject or block')

    const missing = {
      editCheck: {
        enabled: true,
        debounceMs: 0,
        checks: [{ name: 'missing', command: ['definitely-not-a-real-command-wfb', '--x'] }],
      },
    }
    const ctx2 = makeCtx({ workingDirectory: { get: () => workspace } })
    install(ctx2, missing, makeState({ turn: 5 }))
    const decision2 = await runPost(ctx2, writeExec(workspace).exec)
    assert(decision2.kind === 'accept' && decision2.additionalContexts === undefined, 'spawn failure did not inject or block')
  })
})

case_('install: no workingDirectory service and outside-workspace files are skipped', async () => {
  const counter = join(tmpdir(), 'wfb-editcheck-counter-' + process.pid + '.txt')
  const { readFile } = await import('node:fs/promises')
  try {
    const settings = {
      editCheck: {
        enabled: true,
        debounceMs: 0,
        checks: [{ name: 'count', command: nodeCommand(counterScript(counter)) }],
      },
    }
    let ctx = makeCtx({ workingDirectory: undefined })
    install(ctx, settings, makeState())
    const noWorkspace = await runPost(ctx, writeExec('C:/ws').exec)
    assert(noWorkspace.additionalContexts === undefined, 'missing workspace skipped without throwing')

    ctx = makeCtx({ workingDirectory: { get: () => 'C:/ws' } })
    install(ctx, settings, makeState())
    const outside = await runPost(ctx, writeExec('C:/ws', 'C:/elsewhere/a.ts').exec)
    assert(outside.additionalContexts === undefined, 'outside-workspace edit skipped')
    let runs = 0
    try { runs = (await readFile(counter, 'utf8')).length } catch { runs = 0 }
    assert(runs === 0, 'no check ran for skipped targets, got ' + runs)
  } finally {
    await rm(counter, { force: true })
  }
})

case_('install: tool failure results never trigger checks', async () => {
  await withWorkspace(async (workspace) => {
    const counter = join(workspace, 'runs.txt')
    const settings = {
      editCheck: {
        enabled: true,
        debounceMs: 0,
        checks: [{ name: 'count', command: nodeCommand(counterScript(counter)) }],
      },
    }
    const ctx = makeCtx({ workingDirectory: { get: () => workspace } })
    install(ctx, settings, makeState())
    const decision = await runPost(ctx, writeExec(workspace).exec, { isError: true })
    assert(decision.additionalContexts === undefined, 'error result skipped')
    let ran = false
    try {
      const { readFile } = await import('node:fs/promises')
      await readFile(counter, 'utf8')
      ran = true
    } catch { ran = false }
    assert(ran === false, 'check command did not run for a failed tool')
  })
})

case_('install: resolveSettings clamps numeric config', () => {
  const settings = resolveSettings({ editCheck: { enabled: true, debounceMs: -5, maxPerTurn: 0, maxReflections: 999, checks: [{ name: 'x', command: 'true' }] } })
  assert(settings.enabled === true, 'enabled')
  assert(settings.debounceMs === 0, 'negative debounce clamped: ' + settings.debounceMs)
  assert(settings.maxPerTurn === 1, 'maxPerTurn floor: ' + settings.maxPerTurn)
  assert(settings.maxReflections === 20, 'maxReflections ceiling: ' + settings.maxReflections)
  assert(settings.checks.length === 1, 'check kept')
})

case_('install: a throwing ctx.on never breaks the agent', () => {
  const ctx = {
    on() { throw new Error('event bus unavailable') },
    get() { return undefined },
    tools: { register() { return () => {} } },
  }
  const state = makeState()
  let disposer
  try {
    disposer = install(ctx, { editCheck: { enabled: true, checks: [{ name: 'x', command: 'true' }] } }, state)
  } catch (error) {
    throw new Error('install must be fail-open, threw: ' + error.message)
  }
  assert(disposer === undefined, 'no listener means no disposer, but no throw either')
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
