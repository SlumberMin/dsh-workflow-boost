/**
 * turnGuard — 回合预算 + 收尾门禁（Claude Code Stop hook / OpenHands hooks）。
 *
 * DSH 的 dsh-agent-loop 明确没有内建回合预算，官方建议从
 * agent/turn-stopping 这类生命周期扩展点取消失控轮次。本模块只做三件事：
 *
 *  1. agent/pre-step 计数本回合的步数/耗时/token 压力（持久化部分来自
 *     state.sessionState.stateOf(session) 的 turn/step；时间戳只能放
 *     per-agent WeakMap，resume 会丢，最坏是少提醒一次，不误伤）。
 *  2. 越过 warnAt（默认 80%）时，在下一次 tools/post-execute 的
 *     additionalContexts 里注入一次"接近预算"提醒。走历史尾部追加，
 *     系统提示词与请求前缀不动，KV-cache 不受影响。
 *  3. agent/turn-stopping 时判定超限：agent.steer 一条收尾通知（每回合最多
 *     1 次），hardStop 或 enforce 模式再 agent.cancel 真停；未超限时做
 *     finishChecks（活跃 goal 无新鲜 goal_verify / todo 仍 in_progress）。
 *
 * 所有回调 fail-open：任何异常只记 warn，绝不让宿主看到 throw。宿主包一律
 * 动态加载（state.loadHost 优先，测试可注入 fake），干净环境也能 import。
 *
 * @module dsh-workflow-boost/lib/turn-guard
 */
import { randomUUID } from 'node:crypto'
import { sectionDefaults } from './defaults.js'
import { loadHost, logInfo, logWarn } from './shared.js'
import {
  describeUsage,
  detectFinishIssue,
  freshVerifyInRing,
  inProgressTodos,
  renderBudgetReminder,
  renderBudgetSteer,
  renderFinishSteer,
  resolveTurnOptions,
  turnBudget,
} from './pure/turn-guard-core.js'

/** 注入消息的 producer source；带 notice 形式，历史里不会渲染成用户提问。 */
export const SOURCE_KIND = 'dsh-workflow-boost-turn-guard'

/** 读折叠状态；失败返回 undefined（fail-open）。 */
function safeStateOf(state, session) {
  try {
    if (session === undefined || session === null) return undefined
    return state?.sessionState?.stateOf?.(session)
  } catch {
    return undefined
  }
}

/** 取服务；注册表拒绝时返回 undefined。 */
function safeService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** tokenMeter 的上下文压力（provider 上报的 prompt 大小）；不可用返回 undefined。 */
function pressureTokens(ctx, session) {
  try {
    const meter = safeService(ctx, 'tokenMeter')
    const pressure = typeof meter?.contextPressure === 'function' ? meter.contextPressure(session) : undefined
    const tokens = Number(pressure?.pressureTokens)
    return Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined
  } catch {
    return undefined
  }
}

/**
 * notice 消息工厂：优先用宿主 dsh-llm 的 createUserMessage（inbox 校验需要
 * id/role/source），干净环境或加载失败时退回等价普通对象。
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
          return { id: 'wfb-turn-' + randomUUID(), role: 'user', content: [{ type: 'text', text }], source }
        }
      })()
    }
    return pending
  }
}

/** 把一个 additional context 追加到 post-execute 决策，保留决策种类与下游上下文。 */
function withContexts(decision, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return decision
  const base = decision !== null && typeof decision === 'object' ? decision : { kind: 'accept' }
  const existing = Array.isArray(base.additionalContexts) ? base.additionalContexts : []
  return { ...base, additionalContexts: [...messages, ...existing] }
}

/**
 * 安装 turnGuard。
 * @param ctx - Cordis 上下文（index.js 在 ctx.effect 里调用）。
 * @param config - 整行插件配置。
 * @param state - 共享插件状态（log/sessionState/loadHost）。
 * @returns disposer；未挂载任何监听时返回空函数。
 */
export function install(ctx, config, state) {
  let options
  try {
    options = resolveTurnOptions(sectionDefaults('turnGuard', config))
  } catch (error) {
    logWarn(state, 'turnGuard: invalid config, module disabled: ' + describe(error))
    return () => {}
  }
  if (!options.enabled) return () => {}
  if (typeof ctx?.on !== 'function') {
    logWarn(state, 'turnGuard: ctx.on is unavailable; turn guard is disabled')
    return () => {}
  }

  /** 每 agent 的回合记录；agent 是 WeakMap 键，不会泄漏。 */
  const perAgent = new WeakMap()
  const disposers = []
  const factory = createNoticeFactory(state)
  let active = true

  const recordFor = (agent) => {
    if (agent === null || typeof agent !== 'object') return undefined
    let record = perAgent.get(agent)
    if (record === undefined) {
      record = {
        turn: -1,
        steps: 0,
        firstAt: 0,
        warned: false,
        warnPending: false,
        steered: false,
        tokenBase: undefined,
        tokenNow: undefined,
        lastBudget: undefined,
      }
      perAgent.set(agent, record)
    }
    return record
  }

  const usageOf = (record) => ({
    steps: record?.steps ?? 0,
    elapsedMs: record !== undefined && record.firstAt > 0 ? Date.now() - record.firstAt : 0,
    tokens:
      record !== undefined && record.tokenBase !== undefined && record.tokenNow !== undefined
        ? Math.max(0, record.tokenNow - record.tokenBase)
        : 0,
  })

  /** 在 pre-step 更新本回合计数，并在越过 warnAt 时登记一次待注入提醒。 */
  const trackStep = (payload) => {
    const agent = payload?.agent
    const record = recordFor(agent)
    if (record === undefined) return
    const fold = safeStateOf(state, agent.session)
    const turn = Number.isFinite(Number(payload?.turn)) ? Number(payload.turn) : Number(fold?.turn) || 0
    const step = Number.isFinite(Number(payload?.step)) ? Number(payload.step) : Number(fold?.step) || 0
    if (record.turn !== turn) {
      record.turn = turn
      record.steps = 0
      record.firstAt = Date.now()
      record.warned = false
      record.warnPending = false
      record.steered = false
      record.tokenBase = undefined
      record.tokenNow = undefined
    }
    if (!(record.firstAt > 0)) record.firstAt = Date.now()
    record.steps = Math.max(record.steps, Math.max(0, step))
    // maxTokens 默认 0（关）。开启时用 tokenMeter.contextPressure 的回合内增量
    // 近似"本回合新增上下文"，不含输出 token；provider 未上报时整项失效。
    if (options.maxTokens > 0) {
      const pressure = pressureTokens(ctx, agent.session)
      if (pressure !== undefined) {
        if (record.tokenBase === undefined) record.tokenBase = pressure
        record.tokenNow = pressure
      }
    }
    const budget = turnBudget(usageOf(record), options)
    record.lastBudget = budget
    if (budget.approaching && !record.warned && !record.warnPending && !record.steered) {
      record.warnPending = true
      logInfo(state, 'turnGuard: budget warning armed at ' + describeUsage(budget, options))
    }
  }

  const listen = (name, handler) => {
    try {
      const dispose = ctx.on(name, handler)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logWarn(state, 'turnGuard: could not listen for ' + name + ': ' + describe(error))
    }
  }

  // 1) 步数/耗时/token 计数。
  listen('agent/pre-step', (payload, next) => {
    if (!active) return next()
    try {
      trackStep(payload)
    } catch (error) {
      logWarn(state, 'turnGuard: step accounting failed: ' + describe(error))
    }
    return next()
  })

  // 2) 预算提醒：同一回合只注入一次，挂在工具结果之后的下一条历史尾部。
  listen('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!active) return downstream
    try {
      const record = recordFor(exec?.agent)
      if (record === undefined || !record.warnPending || record.warned) return downstream
      record.warnPending = false
      record.warned = true
      const budget = record.lastBudget ?? turnBudget(usageOf(record), options)
      const build = await factory()
      const message = build(renderBudgetReminder(budget, options), 'turn budget ' + Math.round((budget.ratio || 0) * 100) + '%')
      logInfo(state, 'turnGuard: injected budget reminder (' + describeUsage(budget, options) + ')')
      return withContexts(downstream, [message])
    } catch (error) {
      logWarn(state, 'turnGuard: budget reminder injection failed: ' + describe(error))
      return downstream
    }
  })

  // 3) 收尾门禁：超限 steer 一次（可选 cancel），否则做 finishChecks。
  listen('agent/turn-stopping', async (payload) => {
    if (!active) return undefined
    try {
      await checkTurnClose(payload)
    } catch (error) {
      logWarn(state, 'turnGuard: turn-close check failed: ' + describe(error))
    }
    return undefined
  })

  /** 活跃 goal 视图；没有 goals 服务或读取失败都当作"无活跃 goal"（不误拦）。 */
  const activeGoal = (agent) => {
    const goals = safeService(ctx, 'goals')
    if (goals === null || goals === undefined || typeof goals.get !== 'function') return undefined
    try {
      const view = goals.get(agent)
      if (view === null || view === undefined) return undefined
      const phase = typeof view.phase === 'string' ? view.phase : view.goal?.phase
      return phase === 'active' ? view : undefined
    } catch {
      return undefined
    }
  }

  const checkTurnClose = async (payload) => {
    const agent = payload?.agent
    if (agent === null || typeof agent !== 'object') return
    if (payload?.signal?.aborted === true) return
    const record = recordFor(agent)
    if (record !== undefined && record.steered) return
    const fold = safeStateOf(state, agent.session)
    const steps = Math.max(record?.steps ?? 0, Number(fold?.step) || 0)
    const budget = turnBudget(
      {
        steps,
        elapsedMs: record !== undefined && record.firstAt > 0 ? Date.now() - record.firstAt : 0,
        tokens: usageOf(record).tokens,
      },
      options,
    )
    let text = ''
    let reason = ''
    if (budget.exceeded) {
      text = renderBudgetSteer(budget, options)
      reason = 'budget exceeded (' + describeUsage(budget, options) + ')'
    } else if (options.finishChecks) {
      const issue = detectFinishIssue({
        goalActive: activeGoal(agent) !== undefined,
        mutatedInTurn: fold?.mutatedInTurn === true,
        freshVerify: freshVerifyInRing(fold?.toolRing, Number(fold?.lastMutationSeq)),
        inProgress: inProgressTodos(fold?.todos),
      })
      text = renderFinishSteer(issue)
      reason = issue === undefined ? '' : 'finish check: ' + issue.kind
    }
    if (text.length === 0) return
    if (typeof agent.steer !== 'function') return
    if (record !== undefined) record.steered = true
    const build = await factory()
    const message = build(text, reason.slice(0, 120))
    agent.steer(message)
    logInfo(state, 'turnGuard: steered turn close (' + reason + ')')
    if (budget.exceeded && options.cancelAtLimit && typeof agent.cancel === 'function') {
      try {
        agent.cancel({ kind: 'hook', reason: 'turnGuard: turn budget exhausted (' + describeUsage(budget, options) + ')' })
        logInfo(state, 'turnGuard: cancelled the turn after the final steer')
      } catch (error) {
        logWarn(state, 'turnGuard: agent.cancel failed: ' + describe(error))
      }
    }
  }

  logInfo(
    state,
    'turnGuard active (mode=' + options.mode + ' maxSteps=' + options.maxSteps + ' maxMinutes=' + options.maxMinutes
      + ' warnAt=' + options.warnAt + ' finishChecks=' + options.finishChecks + ' hardStop=' + options.hardStop + ')',
  )

  return () => {
    active = false
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
