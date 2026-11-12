/**
 * stuckDetector 的纯决策层：五模式判定、提醒/拒绝文案、配置归一。
 *
 * 设计依据 OpenHands Stuck Detector（五模式 + 阈值 4/3/3/6/上下文错误）与
 * DSH 原生 repeat-tool-reminder 的 3/5/8 提醒语义：先提醒、后拦截。
 *
 * 这里不 import 任何宿主包；ring 的条目形状与 lib/session-state.js 的
 * toolRing 完全一致（{ seq, name, argsKey, resultKey, isError, turn, step }），
 * 所以判定可以直接吃持久化折叠状态，resume 后计数不丢。
 *
 * 所有判定对"工具名缺失/形状不认识"的输入返回 undefined（fail-open）：
 * 宁可漏拦，也不能误伤正常调用。
 */
import { DEFAULTS } from '../defaults.js'
import { globMatches, shortDigest, stableStringify } from '../shared.js'

/** 恢复/报告类工具：重复调用它们正是"卡住"的解法，永不拦截。 */
export const RECOVERY_TOOLS = new Set([
  'get_goal',
  'goal_verify',
  'cache_report',
  'job_output',
  'job_list',
  'ask_user_question',
])

/** 同族后缀（宿主或其它插件注册的恢复工具）。 */
const RECOVERY_SUFFIX = /(?:^|_)(?:status|report|verify|diagnose|doctor|inspect)$/iu

/** 拒绝/提醒文案里内联的 arguments 预览上限。 */
export const PREVIEW_CHARS = 160

/** 上下文溢出失败的稳定错误码（宿主 LlmError 用这些 code）。 */
export const OVERFLOW_CODES = new Set([
  'CONTEXT_WINDOW_EXCEEDED',
  'CONTEXT_LENGTH_EXCEEDED',
  'CONTEXT_OVERFLOW',
  'TOKEN_LIMIT_EXCEEDED',
])

/** 上下文溢出错误文本的特征；只用于 isError 结果，避免误伤正常输出。 */
const OVERFLOW_PATTERNS = Object.freeze([
  /context[_ -]?(?:window|length|size)[_ -]?(?:exceeded|exceed|limit|overflow)/iu,
  /maximum context length/iu,
  /exceeds? (?:the )?(?:model'?s? )?(?:maximum |context )?(?:context|token)/iu,
  /prompt (?:is )?too long/iu,
  /input (?:is )?too long/iu,
  /too many tokens/iu,
  /reduce the length of the (?:messages|prompt|input)/iu,
])

function finite(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * 合并 duplicateGuard 配置并做兼容映射。
 *
 * 兼容：旧版的 `maxIdenticalCalls` 映射到 `blockAt`。只有当前 blockAt 仍是
 * 默认值时才采用旧键，这样新配置显式给了 blockAt 时不会被旧键覆盖。
 * @param section - sectionDefaults('duplicateGuard', config) 的结果。
 * @param extras - { legacyBlockAt } 旧配置的 maxIdenticalCalls。
 * @returns 规范化后的阈值与白名单。
 */
export function resolveStuckOptions(section, extras) {
  const base = DEFAULTS.duplicateGuard
  const raw = section !== null && typeof section === 'object' ? section : {}
  let blockAt = clampInt(raw.blockAt, base.blockAt, 2, 50)
  const legacy = extras !== null && typeof extras === 'object' ? Number(extras.legacyBlockAt) : Number.NaN
  if (Number.isSafeInteger(legacy) && legacy >= 2 && blockAt === base.blockAt) blockAt = Math.min(50, legacy)
  let remindAt = clampInt(raw.remindAt, base.remindAt, 2, 20)
  // 提醒必须严格早于拦截，否则"先提醒后拦截"退化成只有拦截。
  if (remindAt >= blockAt) remindAt = Math.max(2, blockAt - 1)
  const whitelist = Array.isArray(raw.whitelist)
    ? raw.whitelist.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : []
  return {
    enabled: raw.enabled !== false,
    remindAt,
    blockAt,
    identicalObservationAt: clampInt(raw.identicalObservationAt, base.identicalObservationAt, 2, 20),
    consecutiveErrorsAt: clampInt(raw.consecutiveErrorsAt, base.consecutiveErrorsAt, 2, 20),
    monologueAt: clampInt(raw.monologueAt, base.monologueAt, 2, 20),
    alternatingAt: clampInt(raw.alternatingAt, base.alternatingAt, 3, 30),
    contextOverflowAt: clampInt(raw.contextOverflowAt, base.contextOverflowAt, 2, 10),
    whitelist,
  }
}

/** 恢复/报告类工具判定。 */
export function isRecoveryTool(name) {
  const tool = String(name ?? '')
  if (tool.length === 0) return false
  return RECOVERY_TOOLS.has(tool) || RECOVERY_SUFFIX.test(tool)
}

/**
 * 该工具是否永不参与卡死判定：恢复类、用户白名单（支持 * 通配）、
 * 以及没有工具名的调用（fail-open）。
 */
export function isExempt(name, options) {
  const tool = String(name ?? '')
  if (tool.length === 0) return true
  if (isRecoveryTool(tool)) return true
  const whitelist = Array.isArray(options?.whitelist) ? options.whitelist : []
  for (const pattern of whitelist) {
    if (pattern === tool) return true
    try {
      if (globMatches(pattern, tool)) return true
    } catch {
      /* 坏 pattern 只跳过 */
    }
  }
  return false
}

/** 单行 arguments 预览；无法序列化时返回空串。 */
export function previewArguments(args) {
  let text
  try {
    text = stableStringify(args)
  } catch {
    return ''
  }
  if (typeof text !== 'string' || text.length === 0 || text === '{}' || text === 'null') return ''
  const oneLine = text.replace(/\s+/gu, ' ')
  return oneLine.length <= PREVIEW_CHARS ? oneLine : oneLine.slice(0, PREVIEW_CHARS - 3) + '...'
}

/**
 * 动作签名。必须与 lib/session-state.js 的折叠口径一致：
 * name + fnv1a(stableStringify(arguments ?? {}))，否则 ring 与实时调用对不上。
 */
export function callSignature(name, args) {
  const tool = typeof name === 'string' ? name : ''
  if (tool.length === 0) return { name: '', argsKey: '', callKey: '', preview: '' }
  let serialized
  try {
    serialized = stableStringify(args ?? {})
  } catch {
    serialized = ''
  }
  const argsKey = shortDigest(serialized)
  return { name: tool, argsKey, callKey: tool + '|' + argsKey, preview: previewArguments(args) }
}

/** 观察签名；与 session-state 一致：结果文本前 2000 字符的摘要 + isError。 */
export function observationSignature(text, isError) {
  return { resultKey: shortDigest(String(text ?? '').slice(0, 2000)), isError: isError === true }
}

/** ring 条目归一化。没有工具名的条目直接丢弃（老日志/异常路径 fail-open）。 */
export function normalizeRing(ring, sinceSeq) {
  const out = []
  for (const raw of Array.isArray(ring) ? ring : []) {
    if (raw === null || typeof raw !== 'object') continue
    const name = typeof raw.name === 'string' ? raw.name : ''
    if (name.length === 0) continue
    const seq = Number(raw.seq)
    if (Number.isFinite(sinceSeq) && sinceSeq >= 0 && Number.isFinite(seq) && seq <= sinceSeq) continue
    const argsKey = typeof raw.argsKey === 'string' ? raw.argsKey : ''
    out.push({
      seq: Number.isFinite(seq) ? seq : -1,
      name,
      argsKey,
      actionKey: name + '|' + argsKey,
      resultKey: typeof raw.resultKey === 'string' ? raw.resultKey : '',
      isError: raw.isError === true,
    })
  }
  return out
}

/** 尾部连续满足 predicate 的条目数。 */
function trailingRun(entries, predicate) {
  let count = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!predicate(entries[index])) break
    count += 1
  }
  return count
}

/** 尾部 A-B-A-B 交替长度与"下一个应出现"的动作键。 */
export function trailingAlternation(entries) {
  const list = Array.isArray(entries) ? entries : []
  const size = list.length
  if (size < 2) return undefined
  const last = list[size - 1].actionKey
  const previous = list[size - 2].actionKey
  if (last === previous) return undefined
  let count = 2
  for (let index = size - 3; index >= 0; index -= 1) {
    const expected = (size - 1 - index) % 2 === 0 ? last : previous
    if (list[index].actionKey !== expected) break
    count += 1
  }
  return { count, next: previous }
}

/**
 * 拦截判定（在 tools/pre-execute 调用）。
 * @param ring - 持久化 toolRing。
 * @param call - callSignature 的结果。
 * @param options - resolveStuckOptions 的结果；可带 sinceSeq 只统计最近一条用户消息之后。
 * @returns detection（触发 deny）或 undefined（放行）。
 */
export function detectStuck(ring, call, options) {
  if (call === null || typeof call !== 'object' || typeof call.name !== 'string' || call.name.length === 0) return undefined
  if (isExempt(call.name, options)) return undefined
  const entries = normalizeRing(ring, options?.sinceSeq)
  if (entries.length === 0) return undefined
  const sameAction = (entry) => entry.name === call.name && entry.argsKey === call.argsKey

  // 模式 2：同动作连续错误 ≥ N —— 错误是最强的"没有进展"信号，优先判定。
  const errorRun = trailingRun(entries, (entry) => sameAction(entry) && entry.isError)
  if (errorRun >= options.consecutiveErrorsAt) {
    return {
      mode: 'consecutive-errors',
      name: call.name,
      preview: call.preview,
      past: errorRun,
      attempt: errorRun + 1,
      threshold: options.consecutiveErrorsAt,
      nextBlockAt: options.blockAt + 1,
    }
  }

  // 模式 1：同动作 → 同观察 ≥ N（观察未知的条目不算，避免误判）。
  let observationKey
  let observationRun = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!sameAction(entry) || entry.resultKey.length === 0) break
    const key = entry.resultKey + '|' + (entry.isError ? '1' : '0')
    if (observationKey === undefined) observationKey = key
    if (key !== observationKey) break
    observationRun += 1
  }
  if (observationRun >= options.identicalObservationAt) {
    return {
      mode: 'identical-observation',
      name: call.name,
      preview: call.preview,
      past: observationRun,
      attempt: observationRun + 1,
      threshold: options.identicalObservationAt,
      nextBlockAt: options.blockAt + 1,
    }
  }

  // 模式 4：A-B-A-B 交替 ≥ N 且本次调用继续该交替。
  const alternation = trailingAlternation(entries)
  if (alternation !== undefined && alternation.count >= options.alternatingAt && call.callKey === alternation.next) {
    return {
      mode: 'alternating-abab',
      name: call.name,
      preview: call.preview,
      past: alternation.count,
      attempt: alternation.count + 1,
      threshold: options.alternatingAt,
      nextBlockAt: options.blockAt + 1,
    }
  }

  // 通用重复调用：同 name+args 连续 ≥ blockAt。
  const callRun = trailingRun(entries, sameAction)
  if (callRun >= options.blockAt) {
    return {
      mode: 'identical-call',
      name: call.name,
      preview: call.preview,
      past: callRun,
      attempt: callRun + 1,
      threshold: options.blockAt,
      nextBlockAt: options.blockAt + 1,
    }
  }
  return undefined
}

/**
 * 提醒判定（在 tools/post-execute 观察完本次调用后调用）。
 * 只在"含本次调用在内恰好达到 remindAt"时返回，天然每个连续串只提醒一次。
 */
export function reminderFor(ring, call, options) {
  if (call === null || typeof call !== 'object' || typeof call.name !== 'string' || call.name.length === 0) return undefined
  if (isExempt(call.name, options)) return undefined
  const entries = normalizeRing(ring, options?.sinceSeq)
  const run = trailingRun(entries, (entry) => entry.name === call.name && entry.argsKey === call.argsKey)
  const count = run + 1
  if (count !== options.remindAt) return undefined
  return {
    mode: 'identical-call',
    name: call.name,
    preview: call.preview,
    past: count,
    attempt: count,
    threshold: options.remindAt,
    nextBlockAt: options.blockAt + 1,
  }
}

/** 提醒文案：模式名 + 次数 + 下次会被拦截 + 替代动作。 */
export function renderReminder(detection) {
  const args = detection.preview.length > 0 ? ' (' + detection.preview + ')' : ''
  return '[Stuck detector — automatic notice from dsh-workflow-boost, not a user request.]\n'
    + 'Pattern detected: ' + detection.mode + ' — ' + detection.name + ' was called ' + detection.past
    + ' times in a row with identical arguments' + args + '.\n'
    + 'Retrying the same call cannot produce new information; identical calls are blocked on attempt '
    + detection.nextBlockAt + '. Change the approach now: use the result you already have, vary the arguments (path/pattern/offset/command), switch tools, or report the blocker to the user.'
}

/** 拒绝文案：必须含模式名、次数、可执行的替代动作。 */
export function renderDenial(detection) {
  const tool = detection.name
  const args = detection.preview.length > 0 ? ' with arguments ' + detection.preview : ''
  const head = 'stuck-detector blocked this call [' + detection.mode + ']: '
  if (detection.mode === 'consecutive-errors') {
    return head + tool + args + ' has failed ' + detection.past + ' times in a row, so attempt ' + detection.attempt
      + ' would repeat the same failure. Read the error text you already have, fix the underlying cause, vary the arguments or the tool, or report the exact error to the user.'
  }
  if (detection.mode === 'identical-observation') {
    return head + tool + args + ' returned the same observation ' + detection.past + ' times in a row, so attempt '
      + detection.attempt + ' cannot add new information. Use the result you already have, vary the arguments (path/pattern/offset/command), switch to a different tool, or tell the user what is blocking progress.'
  }
  if (detection.mode === 'alternating-abab') {
    return head + 'two actions have alternated A-B-A-B for ' + detection.past + ' calls without progress, so attempt '
      + detection.attempt + ' would continue the oscillation. Break the loop: change the arguments of one action, inspect the results you already have, or ask the user to decide between them.'
  }
  return head + tool + args + ' was already called with identical arguments ' + detection.past
    + ' times in a row, so attempt ' + detection.attempt + ' would return the same result. Vary the arguments, reuse the result you already have, switch tools, or report the blocker instead of retrying.'
}

/** 从 pre-step messages 近似"连续 assistant 独白"（fold.monologue 缺失时的兜底）。 */
export function monologueFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  let count = 0
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index] !== null && typeof list[index] === 'object' && list[index].role === 'assistant') count += 1
    else break
  }
  return count
}

/** 模式 3（独白）的 advisory 文案。 */
export function renderMonologueReminder(monologue, options) {
  return '[Stuck detector — automatic notice from dsh-workflow-boost, not a user request.]\n'
    + 'You have written ' + monologue + ' assistant messages without a tool call or new input (advisory threshold '
    + options.monologueAt + '). Take one concrete step before explaining further: call a tool to inspect or change something, or finish with a concrete result instead of narrating.'
}

/** 比例地判断一个错误文本是否是上下文溢出。 */
export function classifyOverflow(text) {
  const source = String(text ?? '')
  if (source.length === 0) return false
  for (const pattern of OVERFLOW_PATTERNS) {
    if (pattern.test(source)) return true
  }
  return false
}

/** 判断 request-error 的 failure 是否上下文溢出（先看 code，再退回文本）。 */
export function isOverflowFailure(failure) {
  if (failure === null || typeof failure !== 'object') return false
  const code = typeof failure.code === 'string' ? failure.code : ''
  if (OVERFLOW_CODES.has(code)) return true
  return classifyOverflow(failure.message)
}

/** 模式 5（连续上下文溢出）的 advisory 文案。 */
export function renderOverflowAdvice(streak, options) {
  return '[Stuck detector — automatic notice from dsh-workflow-boost, not a user request.]\n'
    + 'Context overflow failures happened ' + streak + ' times in a row (advisory threshold ' + options.contextOverflowAt + ').\n'
    + 'Reduce the context before retrying: run the compact command (/compact) or ask the user to compact or start a fresh session, then retry with a smaller request. Do not resend the same oversized input unchanged.'
}
