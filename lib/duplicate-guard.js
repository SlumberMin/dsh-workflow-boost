/**
 * stuckDetector — duplicateGuard 2.0（OpenHands Stuck Detector 五模式）。
 *
 * 0.1.0 只按 (name + args) 完全相同计数、第 N+1 次拒绝，漏掉四类真实卡死：
 * 同动作连续失败、A-B 乒乓、连续独白、反复上下文溢出。本模块按 OpenHands
 * 的五模式判定，并继承原生 repeat-tool-reminder 的"先提醒、后拦截"语义：
 *
 *   - tools/post-execute 观察真实结果 + 动作签名，达 remindAt 时注入一条
 *     additionalContexts 提醒（对齐原生 3 次提醒）；
 *   - tools/pre-execute 判定，达各模式阈值或通用 blockAt 时返回
 *     { kind: 'deny', reason }，reason 固定包含模式名、次数、替代动作；
 *   - agent/pre-step 处理"连续 assistant 独白"与 request-error 累积的
 *     context-overflow advisory；
 *   - agent/request-error 观察上下文溢出错误码，连续 N 次后 advisory。
 *
 * 计数来源是 state.sessionState.toolRing（session/event 折叠、可跨 resume），
 * 不在内存里另起一套。每一条判定在工具名缺失/状态形状异常时 fail-open。
 *
 * @module dsh-workflow-boost/lib/duplicate-guard
 */
import { randomUUID } from 'node:crypto'
import { sectionDefaults } from './defaults.js'
import { contentText, loadHost, logInfo, logWarn } from './shared.js'
import {
  callSignature,
  classifyOverflow,
  detectStuck,
  isExempt,
  isOverflowFailure,
  monologueFromMessages,
  renderDenial,
  renderMonologueReminder,
  renderOverflowAdvice,
  renderReminder,
  reminderFor,
  resolveStuckOptions,
} from './pure/stuck-core.js'

/** 注入消息的 producer source；notice 形式，历史里不渲染成用户提问。 */
export const SOURCE_KIND = 'dsh-workflow-boost-stuck-detector'

/** 读折叠状态；失败返回 undefined（fail-open）。 */
function safeStateOf(state, session) {
  try {
    if (session === undefined || session === null) return undefined
    return state?.sessionState?.stateOf?.(session)
  } catch {
    return undefined
  }
}

/** 读本轮真实用户输入的边界 seq（见 install 内说明）；未知返回 undefined。 */
function safeUserSeq(map, session) {
  try {
    return session === undefined || session === null ? undefined : map.get(session)
  } catch {
    return undefined
  }
}

/**
 * notice 消息工厂：优先宿主 dsh-llm 的 createUserMessage；干净环境退回等价对象。
 */
function createNoticeFactory(state) {
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
        return (text, summary) => {
          const source = { kind: SOURCE_KIND, form: 'notice', summary: String(summary ?? '').slice(0, 120) }
          if (createUserMessage !== undefined) return createUserMessage({ content: [{ type: 'text', text }], source })
          return { id: 'wfb-stuck-' + randomUUID(), role: 'user', content: [{ type: 'text', text }], source }
        }
      })()
    }
    return pending
  }
}

/** 把 additional contexts 追加到 post-execute 决策，保留下游内容与决策种类。 */
function addContexts(decision, messages) {
  if (messages.length === 0) return decision
  const base = decision !== null && typeof decision === 'object' ? decision : { kind: 'accept' }
  const existing = Array.isArray(base.additionalContexts) ? base.additionalContexts : []
  return { ...base, additionalContexts: [...messages, ...existing] }
}

/**
 * 安装 stuck detector。
 * @param ctx - Cordis 上下文。
 * @param config - 整行插件配置。
 * @param state - 共享插件状态（log/sessionState/loadHost）。
 * @returns disposer。
 */
export function install(ctx, config, state) {
  let options
  try {
    const raw = config?.duplicateGuard
    options = resolveStuckOptions(sectionDefaults('duplicateGuard', config), {
      legacyBlockAt: raw?.maxIdenticalCalls,
    })
  } catch (error) {
    logWarn(state, 'stuckDetector: invalid config, module disabled: ' + describe(error))
    return () => {}
  }
  if (!options.enabled) return () => {}
  if (typeof ctx?.on !== 'function') {
    logWarn(state, 'stuckDetector: ctx.on is unavailable; loop detection is disabled')
    return () => {}
  }

  const factory = createNoticeFactory(state)
  const perAgent = new WeakMap()
  /**
   * 每条真实用户输入之后的计数窗口。
   *
   * 只认 source.kind === 'user' 的 user/message：本模块自己注入的 notice 也是
   * user 消息，若用折叠状态的 lastUserMessageSeq 当边界，提醒一发出就把计数
   * 清零，blockAt 永远到不了。这里用 sessionState.onEvent 单独记真实输入边界；
   * resume 后该边界丢失，退化为"整个 ring 都算"（更保守，不误伤）。
   */
  const userBoundary = new WeakMap()
  const disposers = []

  try {
    state?.sessionState?.onEvent?.((session, event) => {
      try {
        if (event?.type !== 'user/message') return
        const sourceKind = event?.data?.message?.source?.kind
        if (sourceKind !== 'user') return
        const seq = Number(event.seq)
        if (Number.isFinite(seq)) userBoundary.set(session, seq)
      } catch {
        /* 观察器不得打断事件流 */
      }
    })
  } catch (error) {
    logWarn(state, 'stuckDetector: session-state observer unavailable: ' + describe(error))
  }

  const recordFor = (agent) => {
    if (agent === null || typeof agent !== 'object') return undefined
    let record = perAgent.get(agent)
    if (record === undefined) {
      record = { overflowStreak: 0, requestOverflow: 0, pending: [], monologueNotified: false }
      perAgent.set(agent, record)
    }
    return record
  }

  const foldOf = (agent) => safeStateOf(state, agent?.session)
  const sinceSeqOf = (agent) => safeUserSeq(userBoundary, agent?.session)

  const listen = (name, handler) => {
    try {
      const dispose = ctx.on(name, handler)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logWarn(state, 'stuckDetector: could not listen for ' + name + ': ' + describe(error))
    }
  }

  /** 判定点：pre-execute。只在 ring 已持久化且工具名已知时才可能 deny。 */
  const decideBlock = (exec) => {
    const call = callSignature(exec?.name, exec?.arguments)
    if (call.name.length === 0 || isExempt(call.name, options)) return undefined
    const fold = foldOf(exec?.agent)
    if (fold === undefined) return undefined
    return detectStuck(fold.toolRing, call, { ...options, sinceSeq: sinceSeqOf(exec?.agent) })
  }

  /** 观察点：命中 remindAt 的通用重复调用提醒。 */
  const observeRepeat = (exec) => {
    const call = callSignature(exec?.name, exec?.arguments)
    if (call.name.length === 0 || isExempt(call.name, options)) return undefined
    const fold = foldOf(exec?.agent)
    if (fold === undefined) return undefined
    const detection = reminderFor(fold.toolRing, call, { ...options, sinceSeq: sinceSeqOf(exec?.agent) })
    return detection === undefined
      ? undefined
      : { text: renderReminder(detection), summary: detection.mode + ' x' + detection.past }
  }

  /** 观察点：连续 context-overflow 失败（工具错误路径）。 */
  const observeOverflow = (exec, result) => {
    const record = recordFor(exec?.agent)
    if (record === undefined) return []
    const text = contentText(result?.content) || String(result?.error?.message ?? '')
    const isError = result?.isError === true || typeof result?.error?.message === 'string'
    if (!isError || !classifyOverflow(text)) {
      record.overflowStreak = 0
      return []
    }
    record.overflowStreak += 1
    if (record.overflowStreak < options.contextOverflowAt) return []
    const streak = record.overflowStreak
    record.overflowStreak = 0
    return [{ text: renderOverflowAdvice(streak, options), summary: 'context overflow x' + streak }]
  }

  /** 观察点：pre-step 注入独白提醒与 request-error 累积的 advisory。 */
  const collectPreStep = (payload) => {
    const agent = payload?.agent
    const record = recordFor(agent)
    if (record === undefined) return []
    const notices = record.pending.splice(0, record.pending.length)
    const fold = foldOf(agent)
    const monologue = Math.max(Number(fold?.monologue) || 0, monologueFromMessages(payload?.messages))
    if (monologue >= options.monologueAt) {
      if (!record.monologueNotified) {
        record.monologueNotified = true
        notices.push({ text: renderMonologueReminder(monologue, options), summary: 'monologue x' + monologue })
      }
    } else {
      record.monologueNotified = false
    }
    return notices
  }

  /** 把 notices 变成正式的 user-role message 后再挂到决策上。 */
  const deliver = async (notices, target, mode) => {
    if (notices.length === 0) return target
    const build = await factory()
    const messages = notices.map((notice) => build(notice.text, notice.summary))
    logInfo(state, 'stuckDetector: ' + mode + ' (' + notices.map((notice) => notice.summary).join(', ') + ')')
    if (mode === 'post-execute') return addContexts(target, messages)
    const base = target !== null && typeof target === 'object' ? target : { kind: 'enter' }
    const existing = Array.isArray(base.messages) ? base.messages : []
    return { ...base, messages: [...existing, ...messages] }
  }

  // 1) 拦截点。
  listen('tools/pre-execute', async (exec, next) => {
    let detection
    try {
      detection = decideBlock(exec)
    } catch (error) {
      logWarn(state, 'stuckDetector: detection failed, allowing the call: ' + describe(error))
      detection = undefined
    }
    if (detection === undefined) return next()
    logInfo(state, 'stuckDetector: denied [' + detection.mode + '] ' + JSON.stringify(detection.name) + ' (count ' + detection.past + ')')
    return { kind: 'deny', reason: renderDenial(detection) }
  })

  // 2) 观察点：提醒语义与 context-overflow advisory。
  listen('tools/post-execute', async (exec, result, next) => {
    let notices = []
    try {
      const repeat = observeRepeat(exec)
      notices = observeOverflow(exec, result)
      if (repeat !== undefined) notices.unshift(repeat)
    } catch (error) {
      logWarn(state, 'stuckDetector: post-execute observation failed: ' + describe(error))
      notices = []
    }
    const downstream = await next()
    try {
      return await deliver(notices, downstream, 'post-execute')
    } catch (error) {
      logWarn(state, 'stuckDetector: reminder injection failed: ' + describe(error))
      return downstream
    }
  })

  // 3) 独白 / overflow advisory 在下一步 pre-step 以消息形式注入。
  listen('agent/pre-step', async (payload, next) => {
    let notices = []
    try {
      notices = collectPreStep(payload)
    } catch (error) {
      logWarn(state, 'stuckDetector: pre-step observation failed: ' + describe(error))
      notices = []
    }
    const decision = await next()
    try {
      if (notices.length === 0) return decision
      const rejected = decision === null || typeof decision !== 'object' || decision.kind === 'reject'
      if (rejected || payload?.signal?.aborted === true) {
        // 决策被拒绝/取消时把 advisory 放回队列，下一步再投递，避免丢失。
        const record = recordFor(payload?.agent)
        if (record !== undefined) record.pending.unshift(...notices)
        return decision
      }
      return await deliver(notices, decision, 'pre-step')
    } catch (error) {
      logWarn(state, 'stuckDetector: pre-step injection failed: ' + describe(error))
      return decision
    }
  })

  // 4) 请求级上下文溢出（provider 错误码）也计入连续失败。
  listen('agent/request-error', async (payload, next) => {
    try {
      const record = recordFor(payload?.agent)
      if (record !== undefined) {
        if (isOverflowFailure(payload?.failure)) {
          record.requestOverflow += 1
          if (record.requestOverflow >= options.contextOverflowAt) {
            const streak = record.requestOverflow
            record.requestOverflow = 0
            record.pending.push({ text: renderOverflowAdvice(streak, options), summary: 'context overflow x' + streak })
          }
        } else {
          record.requestOverflow = 0
        }
      }
    } catch (error) {
      logWarn(state, 'stuckDetector: request-error observation failed: ' + describe(error))
    }
    return next()
  })

  logInfo(
    state,
    'stuckDetector active (remindAt=' + options.remindAt + ' blockAt=' + options.blockAt
      + ' identicalObservationAt=' + options.identicalObservationAt + ' consecutiveErrorsAt=' + options.consecutiveErrorsAt
      + ' alternatingAt=' + options.alternatingAt + ' monologueAt=' + options.monologueAt
      + ' contextOverflowAt=' + options.contextOverflowAt + ')',
  )

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

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
