/**
 * turnGuard 的纯决策层：预算计算、提醒/收尾文案、finishChecks 判定。
 *
 * 这里不 import 任何宿主包，也不碰 ctx/session —— 单元测试在干净 Node
 * 环境里直接调用。步数、耗时、token 增量、是否写过文件、是否有活跃 goal、
 * 最后一次 goal_verify 的序号等事实由 lib/turn-guard.js 采集后传进来。
 * 文案也放纯层：模型看到的是固定字符串，改文案不应该动宿主接线。
 *
 * 数值语义上 `steps` 是"本回合已执行的步数"（pre-step 的第 N 步调用之后
 * 记 N），所以 steps >= maxSteps 表示预算已经用完、下一步不该再开始。
 */
import { DEFAULTS } from '../defaults.js'

const MINUTE_MS = 60000

function finite(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clampNumber(value, fallback, min, max) {
  return Math.min(max, Math.max(min, finite(value, fallback)))
}

function clampInt(value, fallback, min, max) {
  return Math.floor(clampNumber(value, fallback, min, max))
}

/**
 * 合并 turnGuard 配置并夹到安全范围。
 * @param section - sectionDefaults('turnGuard', config) 的结果（可能缺省）。
 * @returns 规范化后的配置；数值坏值一律回落到 defaults.js。
 */
export function resolveTurnOptions(section) {
  const base = DEFAULTS.turnGuard
  const raw = section !== null && typeof section === 'object' ? section : {}
  const mode = raw.mode === 'enforce' ? 'enforce' : 'advisory'
  return {
    enabled: raw.enabled !== false,
    mode,
    maxSteps: clampInt(raw.maxSteps, base.maxSteps, 1, 5000),
    maxMinutes: clampInt(raw.maxMinutes, base.maxMinutes, 0, 1440),
    maxTokens: clampInt(raw.maxTokens, base.maxTokens, 0, 1000000000),
    warnAt: clampNumber(raw.warnAt, base.warnAt, 0.1, 0.95),
    hardStop: raw.hardStop === true,
    finishChecks: raw.finishChecks !== false,
    // enforce 与 hardStop 都表示"steer 之后真的取消"；advisory 永不取消。
    cancelAtLimit: raw.hardStop === true || mode === 'enforce',
  }
}

/**
 * 计算本回合预算状态。
 * @param usage - { steps, elapsedMs, tokens }，任何字段缺失都按 0 处理。
 * @param options - resolveTurnOptions 的结果。
 * @returns 预算对象；approaching 只在"尚未超限且越过 warnAt"时为 true。
 */
export function turnBudget(usage, options) {
  const steps = Math.max(0, clampInt(usage?.steps, 0, 0, Number.MAX_SAFE_INTEGER))
  const elapsedMs = Math.max(0, finite(usage?.elapsedMs, 0))
  const tokens = Math.max(0, finite(usage?.tokens, 0))
  const maxSteps = options.maxSteps
  const maxMinutes = options.maxMinutes
  const maxTokens = options.maxTokens
  const ratios = {
    steps: maxSteps > 0 ? steps / maxSteps : 0,
    minutes: maxMinutes > 0 ? elapsedMs / (maxMinutes * MINUTE_MS) : 0,
    tokens: maxTokens > 0 ? tokens / maxTokens : 0,
  }
  const stepLimit = maxSteps > 0 && steps >= maxSteps
  const timeLimit = maxMinutes > 0 && elapsedMs >= maxMinutes * MINUTE_MS
  const tokenLimit = maxTokens > 0 && tokens >= maxTokens
  const exceeded = stepLimit || timeLimit || tokenLimit
  const ratio = Math.max(ratios.steps, ratios.minutes, ratios.tokens)
  // 严格大于：150 步预算的 80% 是第 120 步，验收要求第 121 步才提醒。
  const approaching = !exceeded && ratio > options.warnAt
  return {
    steps,
    elapsedMs,
    tokens,
    ratios,
    ratio,
    exceeded,
    approaching,
    stepLimit,
    timeLimit,
    tokenLimit,
  }
}

/** 人类可读的预算消耗：steps 121/150 (81%), 3/60 min (5%)... */
export function describeUsage(budget, options) {
  const parts = []
  if (options.maxSteps > 0) parts.push('steps ' + budget.steps + '/' + options.maxSteps + ' (' + Math.round(budget.ratios.steps * 100) + '%)')
  if (options.maxMinutes > 0) parts.push('time ' + (Math.round((budget.elapsedMs / MINUTE_MS) * 10) / 10) + '/' + options.maxMinutes + ' min (' + Math.round(budget.ratios.minutes * 100) + '%)')
  if (options.maxTokens > 0) parts.push('tokens ' + Math.round(budget.tokens) + '/' + options.maxTokens + ' (' + Math.round(budget.ratios.tokens * 100) + '%)')
  return parts.length > 0 ? parts.join(', ') : 'no budget configured'
}

/** 人类可读的预算上限。 */
export function describeLimits(options) {
  const parts = []
  if (options.maxSteps > 0) parts.push(options.maxSteps + ' steps')
  if (options.maxMinutes > 0) parts.push(options.maxMinutes + ' minutes')
  if (options.maxTokens > 0) parts.push(options.maxTokens + ' tokens')
  return parts.length > 0 ? parts.join(' / ') : 'unbounded'
}

/**
 * 预算 80% 提醒（一次）。用 user-role notice 注入，不改系统提示词，
 * 请求前缀保持可缓存。
 */
export function renderBudgetReminder(budget, options) {
  return '[Turn budget — automatic notice from dsh-workflow-boost turnGuard, not a user request.]\n'
    + 'This turn is approaching its budget: ' + describeUsage(budget, options) + ' used (limits: ' + describeLimits(options) + ').\n'
    + 'Finish the current subtask instead of starting a new exploration: verify what changed, mark finished todos completed, and keep the final report short.'
}

/** 预算超限时的收尾 steer 文案。 */
export function renderBudgetSteer(budget, options) {
  const cancelled = options.cancelAtLimit ? ' The turn is cancelled right after this notice.' : ''
  return '[Turn budget exhausted — automatic notice from dsh-workflow-boost turnGuard.]\n'
    + 'This turn reached ' + describeUsage(budget, options) + ' (limits: ' + describeLimits(options) + ').\n'
    + 'Stop starting new work. Summarise now: what is complete, what was verified, what remains, and the exact next step. Call no more tools unless a single call is required to leave the workspace consistent.' + cancelled
}

/** 默认的"新鲜验证"工具名；goalGate 注册的验证工具。 */
export const GOAL_VERIFY_TOOLS = Object.freeze(['goal_verify'])

/**
 * 本回合是否已跑过 goal_verify 且发生在最后一次写操作之后。
 *
 * sessionState.toolRing 是持久化的（session/event 折叠），因此 resume 后
 * 仍能判断；无写操作（lastMutationSeq < 0）时只看最近一次验证是否存在。
 * @param ring - 折叠状态的 toolRing。
 * @param lastMutationSeq - 本回合最后一次写操作的 seq。
 * @param names - 视为验证的工具名集合。
 * @returns true 表示有"新鲜"验证。
 */
export function freshVerifyInRing(ring, lastMutationSeq, names) {
  const entries = Array.isArray(ring) ? ring : []
  const wanted = names instanceof Set ? names : new Set(Array.isArray(names) ? names : GOAL_VERIFY_TOOLS)
  const since = Number(lastMutationSeq)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === null || typeof entry !== 'object') continue
    if (!wanted.has(entry.name)) continue
    const seq = Number(entry.seq)
    if (!Number.isFinite(seq)) continue
    // 从新到旧扫，第一条验证就是最新的：它不新鲜即整体不新鲜。
    if (Number.isFinite(since) && since >= 0) return seq > since
    return true
  }
  return false
}

/** 统计 todo 里 in_progress 的数量与第一条内容（渲染用）。 */
export function inProgressTodos(todos) {
  const list = Array.isArray(todos) ? todos : []
  const active = list.filter((todo) => todo !== null && typeof todo === 'object' && todo.status === 'in_progress')
  const first = active.length > 0 ? String(active[0].content ?? '').trim() : ''
  return { count: active.length, first: first.length > 120 ? first.slice(0, 119) + '…' : first }
}

/**
 * 收尾门禁判定：活跃 goal + 本回合有写 + 无新鲜验证，或 todo 仍 in_progress。
 * 两个条件都满足时 goal 优先（验证证据比进度标记更重要）。
 * @param facts - { goalActive, mutatedInTurn, freshVerify, inProgress }。
 * @returns issue 或 undefined（放行）。
 */
export function detectFinishIssue(facts) {
  const goalActive = facts?.goalActive === true
  const mutatedInTurn = facts?.mutatedInTurn === true
  const freshVerify = facts?.freshVerify === true
  if (goalActive && mutatedInTurn && !freshVerify) {
    return {
      kind: 'goal',
      summary: 'active goal, workspace changed this turn, no goal_verify after the last write',
    }
  }
  const raw = facts?.inProgress
  const count = typeof raw === 'number' ? raw : Number(raw?.count ?? 0)
  if (Number.isFinite(count) && count > 0) {
    const first = raw !== null && typeof raw === 'object' && typeof raw.first === 'string' ? raw.first : ''
    return { kind: 'todo', count, sample: first }
  }
  return undefined
}

/** 收尾门禁的 steer 文案；未知 issue 返回空串（调用方据此不发 steer）。 */
export function renderFinishSteer(issue) {
  if (issue?.kind === 'goal') {
    return '[Turn close check — automatic notice from dsh-workflow-boost turnGuard, not a user request.]\n'
      + 'An active goal exists and this turn changed the workspace, but no fresh goal_verify evidence was recorded after the last write. Run goal_verify now (or explain exactly why verification cannot run), report its result, then summarise; do not close the turn on unverified changes.'
  }
  if (issue?.kind === 'todo') {
    const sample = typeof issue.sample === 'string' && issue.sample.length > 0 ? ' (first: ' + issue.sample + ')' : ''
    return '[Turn close check — automatic notice from dsh-workflow-boost turnGuard, not a user request.]\n'
      + issue.count + ' todo item(s) are still in_progress' + sample + '. Mark them completed with todo_write, or state precisely why they stay open, then give the final summary.'
  }
  return ''
}
