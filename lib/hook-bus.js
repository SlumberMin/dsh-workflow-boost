/**
 * hookBus — 用户配置的生命周期 hook 命令总线（Claude Code hooks 兼容子集）。
 *
 * 1.1.0 的 P1-7：DSH 0.2.2-rc.1 只有内部事件、没有面向用户的 hook 服务；
 * 这个模块把六类生命周期事件映射到用户配置的 shell 命令，语义对齐 Claude
 * Code 的公开子集（exit 0 JSON / exit 2 / 其它 fail-open）。
 *
 *   PreToolUse       ← tools/pre-execute     exit 2 或 {decision:'deny'} → deny
 *   PostToolUse      ← tools/post-execute    exit 2 → block；{additionalContext} → 注入
 *   Stop             ← agent/turn-stopping   {continue:true,message} / exit 2 → steer 一次
 *   PreCompact       ← session/event(compaction/start)   {additionalContext} 入队
 *   UserPromptSubmit ← session/event(user/message, source.kind='user') 同上
 *   SessionStart     ← agent/created         纯 side effect
 *
 * 安全：默认 enabled:false；命令只来自用户配置，模型输入只进 stdin JSON，
 * 永不拼进命令行；stdout 非法 JSON、超时、异常 exit 全部 fail-open。
 * 所有宿主能力（runCommand / dsh-llm 的消息构造）都可被 state 注入，便于
 * 干净环境测试；静态 import 宿主包是禁止的。
 *
 * @module dsh-workflow-boost/lib/hook-bus
 */
import { randomUUID } from 'node:crypto'
import { sectionDefaults } from './defaults.js'
import { loadHost, logInfo, logWarn, runCommand } from './shared.js'
import {
  buildHookPayload,
  contentToText,
  hookTimeout,
  mapContextResult,
  mapPostToolResult,
  mapPreToolResult,
  mapStopResult,
  resolveHookBusOptions,
  selectHooks,
  shellInvocation,
  summarizeToolResult,
} from './pure/hook-core.js'

/** 注入消息的 producer source；notice 形式，历史里不渲染成用户提问。 */
export const SOURCE_KIND = 'dsh-workflow-boost'

/** 每回合最多 steer 一次，避免 Stop hook 把轮次无限续开。 */
const MAX_STEERS_PER_TURN = 1

/**
 * 消息工厂：优先宿主 dsh-llm 的 createUserMessage（inbox 校验需要 id/role），
 * 干净环境退回等价普通对象（额外带 id/role 保证可被 inbox 接受）。
 */
function createMessageFactory(state) {
  const host = state?.loadHost ?? loadHost
  let pending
  return () => {
    if (pending === undefined) {
      pending = (async () => {
        let llm
        try {
          llm = await host('@deepseek-ai/dsh-llm')
        } catch {
          llm = undefined
        }
        const createUserMessage = typeof llm?.createUserMessage === 'function' ? llm.createUserMessage : undefined
        return (text) => {
          const source = { kind: SOURCE_KIND, form: 'notice', summary: 'hook: ' + String(text ?? '').replace(/\s+/gu, ' ').slice(0, 100) }
          if (createUserMessage !== undefined) return createUserMessage({ content: [{ type: 'text', text: String(text ?? '') }], source })
          return { id: 'wfb-hook-' + randomUUID(), role: 'user', content: [{ type: 'text', text: String(text ?? '') }], source }
        }
      })()
    }
    return pending
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 安装 hookBus。
 * @param ctx - Cordis 上下文（index.js 在 ctx.effect 里调用）。
 * @param config - 整行插件配置。
 * @param state - 共享插件状态；可注入 runCommand / loadHost / log。
 * @returns disposer。
 */
export function install(ctx, config, state) {
  let options
  try {
    options = resolveHookBusOptions(sectionDefaults('hookBus', config))
  } catch (error) {
    logWarn(state, 'hookBus: invalid config, module disabled: ' + describe(error))
    return () => {}
  }
  if (!options.enabled) return () => {}
  if (typeof ctx?.on !== 'function') {
    logWarn(state, 'hookBus: ctx.on is unavailable; hook bus is disabled')
    return () => {}
  }

  for (const drop of options.dropped) {
    logWarn(state, 'hookBus: dropped hook #' + drop.index + ' (' + drop.reason + ')')
  }

  const exec = state?.runCommand ?? runCommand
  const messageFactory = createMessageFactory(state)
  const disposers = []

  /** pre-compact / user-prompt 的 additionalContext 队列，按 session 隔离。 */
  const queues = new WeakMap()
  let orphanQueue = []

  /** Stop hook 的每回合 steer 记录。 */
  const stopState = new WeakMap()

  const has = (event) => options.hooks.some((hook) => hook.event === event)

  /** 会话工作目录：只用 workingDirectory 服务，不用宿主进程 cwd 兜底。 */
  const cwdOf = (session) => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      if (service === null || service === undefined || typeof service.get !== 'function') return undefined
      if (session === null || session === undefined) return undefined
      const cwd = service.get(session)
      return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
    } catch {
      return undefined
    }
  }

  const sessionOf = (agent) => (agent !== null && typeof agent === 'object' ? agent.session : undefined)
  const sessionIdOf = (session) => (session !== null && typeof session === 'object' && typeof session.id === 'string' ? session.id : undefined)

  /** 执行一个 hook 命令；任何异常都变成 fail-open 的 runs 结果。 */
  const runHook = async (hook, payloadJson, cwd) => {
    const invocation = shellInvocation(hook.command, process.platform, process.env.ComSpec)
    try {
      return await exec(invocation.file, invocation.args, {
        cwd,
        timeoutMs: hookTimeout(hook, options),
        stdin: payloadJson,
      })
    } catch (error) {
      return { code: -1, stdout: '', stderr: describe(error), timedOut: false }
    }
  }

  const enqueue = (session, context) => {
    if (typeof context !== 'string' || context.length === 0) return
    if (session === null || session === undefined) {
      orphanQueue = [...orphanQueue, context]
      return
    }
    const current = queues.get(session) ?? []
    queues.set(session, [...current, context])
  }

  const drain = (session) => {
    if (session === null || session === undefined) {
      const items = orphanQueue
      orphanQueue = []
      return items
    }
    const items = queues.get(session) ?? []
    queues.delete(session)
    return items
  }

  const listen = (name, handler) => {
    try {
      const dispose = ctx.on(name, handler)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logWarn(state, 'hookBus: could not listen for ' + name + ': ' + describe(error))
    }
  }

  // ---------- PreToolUse：拦截点 ----------

  if (has('PreToolUse')) {
    listen('tools/pre-execute', async (toolExec, next) => {
      let denyReason
      try {
        const toolName = typeof toolExec?.name === 'string' ? toolExec.name : ''
        const hooks = selectHooks(options, 'PreToolUse', toolName)
        if (hooks.length > 0) {
          const session = sessionOf(toolExec?.agent)
          const cwd = cwdOf(session)
          const payload = buildHookPayload({
            event: 'PreToolUse',
            toolName,
            toolInput: toolExec?.arguments,
            cwd,
            sessionId: sessionIdOf(session),
          })
          for (const hook of hooks) {
            const run = await runHook(hook, payload, cwd)
            const mapped = mapPreToolResult(hook, run)
            if (mapped.warning !== undefined) logWarn(state, mapped.warning)
            if (mapped.decision === 'deny') {
              denyReason = mapped.reason
              logInfo(state, 'hookBus: PreToolUse hook ' + JSON.stringify(hook.name) + ' denied tool ' + JSON.stringify(toolName))
              break
            }
          }
        }
      } catch (error) {
        logWarn(state, 'hookBus: PreToolUse failed open: ' + describe(error))
        denyReason = undefined
      }
      if (typeof denyReason === 'string' && denyReason.length > 0) return { kind: 'deny', reason: denyReason }
      return next()
    })
  }

  // ---------- PostToolUse：block / 上下文注入 + 队列注入点 ----------

  if (has('PostToolUse') || has('PreCompact') || has('UserPromptSubmit')) {
    listen('tools/post-execute', async (toolExec, result, next) => {
      let contexts = []
      let blockFeedback
      try {
        const session = sessionOf(toolExec?.agent)
        // 先取队列：即使 hook 失败，已排队的上下文也不能丢。
        contexts = drain(session)
        const toolName = typeof toolExec?.name === 'string' ? toolExec.name : ''
        const hooks = selectHooks(options, 'PostToolUse', toolName)
        if (hooks.length > 0) {
          const cwd = cwdOf(session)
          const payload = buildHookPayload({
            event: 'PostToolUse',
            toolName,
            toolInput: toolExec?.arguments,
            toolResponseText: summarizeToolResult(result),
            cwd,
            sessionId: sessionIdOf(session),
          })
          for (const hook of hooks) {
            const run = await runHook(hook, payload, cwd)
            const mapped = mapPostToolResult(hook, run)
            if (mapped.warning !== undefined) logWarn(state, mapped.warning)
            if (mapped.decision === 'block') {
              blockFeedback = mapped.feedback
              logInfo(state, 'hookBus: PostToolUse hook ' + JSON.stringify(hook.name) + ' blocked a tool result')
              break
            }
            if (mapped.decision === 'context') contexts = [...contexts, mapped.context]
          }
        }
      } catch (error) {
        logWarn(state, 'hookBus: PostToolUse failed open: ' + describe(error))
      }
      const downstream = await next()
      try {
        const messages = []
        if (contexts.length > 0) {
          const build = await messageFactory()
          for (const context of contexts) messages.push(build(context))
        }
        if (typeof blockFeedback === 'string') {
          const decision = { kind: 'block', feedback: blockFeedback }
          return messages.length > 0 ? { ...decision, additionalContexts: messages } : decision
        }
        if (messages.length === 0) return downstream
        const base = downstream !== null && typeof downstream === 'object' ? downstream : { kind: 'accept' }
        const existing = Array.isArray(base.additionalContexts) ? base.additionalContexts : []
        return { ...base, additionalContexts: [...messages, ...existing] }
      } catch (error) {
        logWarn(state, 'hookBus: PostToolUse injection failed: ' + describe(error))
        return downstream
      }
    })
  }

  // ---------- Stop：steer 保持轮次打开，每回合最多一次 ----------

  if (has('Stop')) {
    listen('agent/turn-stopping', async (payload) => {
      try {
        const agent = payload?.agent
        if (agent === null || typeof agent !== 'object') return undefined
        const hooks = selectHooks(options, 'Stop')
        if (hooks.length === 0) return undefined
        const turn = Number.isFinite(Number(payload?.turn)) ? Number(payload.turn) : 0
        let record = stopState.get(agent)
        if (record === undefined) {
          record = { turn, steers: 0 }
          stopState.set(agent, record)
        }
        if (record.turn !== turn) {
          record.turn = turn
          record.steers = 0
        }
        if (record.steers >= MAX_STEERS_PER_TURN) return undefined
        if (typeof agent.steer !== 'function') return undefined
        const session = sessionOf(agent)
        const cwd = cwdOf(session)
        const payloadJson = buildHookPayload({ event: 'Stop', cwd, sessionId: sessionIdOf(session) })
        for (const hook of hooks) {
          const run = await runHook(hook, payloadJson, cwd)
          const mapped = mapStopResult(hook, run)
          if (mapped.warning !== undefined) logWarn(state, mapped.warning)
          if (mapped.continue !== true) continue
          const text = typeof mapped.message === 'string' && mapped.message.trim().length > 0
            ? mapped.message.trim()
            : 'Stop hook ' + JSON.stringify(hook.name) + ' asked to continue this turn.'
          const build = await messageFactory()
          agent.steer(build(text))
          record.steers += 1
          logInfo(state, 'hookBus: Stop hook ' + JSON.stringify(hook.name) + ' steered the turn open')
          return undefined
        }
      } catch (error) {
        logWarn(state, 'hookBus: Stop hook failed open: ' + describe(error))
      }
      return undefined
    })
  }

  // ---------- PreCompact / UserPromptSubmit：上下文入队 ----------

  const runContextHooks = async (eventName, hooks, session, extra) => {
    const cwd = cwdOf(session)
    const payloadJson = buildHookPayload({
      event: eventName,
      cwd,
      sessionId: sessionIdOf(session),
      ...(extra ?? {}),
    })
    for (const hook of hooks) {
      const run = await runHook(hook, payloadJson, cwd)
      const mapped = mapContextResult(hook, run)
      if (mapped.warning !== undefined) logWarn(state, mapped.warning)
      if (mapped.context !== undefined) {
        enqueue(session, mapped.context)
        logInfo(state, 'hookBus: ' + eventName + ' hook ' + JSON.stringify(hook.name) + ' queued additional context')
      }
    }
  }

  if (has('PreCompact') || has('UserPromptSubmit')) {
    listen('session/event', (session, event) => {
      try {
        if (event === null || typeof event !== 'object') return
        if (event.type === 'compaction/start') {
          const hooks = selectHooks(options, 'PreCompact')
          if (hooks.length === 0) return
          void runContextHooks('PreCompact', hooks, session, { extra: { trigger: 'compaction' } })
            .catch((error) => logWarn(state, 'hookBus: PreCompact hook failed open: ' + describe(error)))
          return
        }
        if (event.type === 'user/message') {
          const message = event?.data?.message
          if (message === null || typeof message !== 'object' || message.source?.kind !== 'user') return
          const hooks = selectHooks(options, 'UserPromptSubmit')
          if (hooks.length === 0) return
          const promptText = contentToText(message.content)
          void runContextHooks('UserPromptSubmit', hooks, session, promptText.length > 0 ? { promptText } : {})
            .catch((error) => logWarn(state, 'hookBus: UserPromptSubmit hook failed open: ' + describe(error)))
        }
      } catch (error) {
        logWarn(state, 'hookBus: session event observation failed: ' + describe(error))
      }
    })
  }

  // ---------- SessionStart：纯 side effect ----------

  if (has('SessionStart')) {
    listen('agent/created', (payload) => {
      try {
        const hooks = selectHooks(options, 'SessionStart')
        if (hooks.length === 0) return
        const session = sessionOf(payload?.agent)
        const cwd = cwdOf(session)
        const payloadJson = buildHookPayload({ event: 'SessionStart', cwd, sessionId: sessionIdOf(session) })
        for (const hook of hooks) {
          // emit 型事件无法 await：fire-and-forget，异常只记日志。
          void runHook(hook, payloadJson, cwd).catch((error) => logWarn(state, 'hookBus: SessionStart hook failed: ' + describe(error)))
        }
      } catch (error) {
        logWarn(state, 'hookBus: SessionStart hook failed open: ' + describe(error))
      }
    })
  }

  logInfo(state, 'hookBus active (hooks=' + options.hooks.length + ' timeoutMs=' + options.timeoutMs + ')')

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* disposal must never throw */
      }
    }
  }
}
