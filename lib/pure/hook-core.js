/**
 * hookBus 的纯逻辑层：配置归一、matcher、payload 构建、结果解析、平台 shell 包装。
 *
 * 这里不 import 任何宿主包，也不执行命令 —— 单元测试在干净 Node 环境里直接
 * 调用。真正的 spawn 走 lib/hook-bus.js 的 (state?.runCommand ?? runCommand)。
 *
 * 语义对齐 Claude Code hooks 的公开子集：
 *   - exit 2 表示"拦截"（PreToolUse deny / PostToolUse block / Stop continue）；
 *   - exit 0 且 stdout 是 JSON 时按事件字段解释；
 *   - 其它 exit、非法 JSON、超时全部 fail-open（只给调用方一个 warning 字符串）。
 *
 * 安全红线：命令只来自用户配置；模型输入只进 stdin JSON，绝不拼进命令。
 *
 * @module dsh-workflow-boost/lib/pure/hook-core
 */
import { DEFAULTS } from '../defaults.js'

/** 支持的六个生命周期事件（与 lib/config.js 的 schema 保持一致）。 */
export const HOOK_EVENTS = Object.freeze([
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PreCompact',
  'UserPromptSubmit',
  'SessionStart',
])

/** 只有这两个事件按工具名匹配 matcher。 */
export const TOOL_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse'])

const TIMEOUT_MIN_MS = 500
const TIMEOUT_MAX_MS = 120000
const STDIN_TEXT_CAP = 4000

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * 归一 hookBus 配置。
 *
 * 非法 hook 不抛错：记在 dropped 里由模块 log warn，然后跳过 —— 一个坏配置项
 * 不能拖垮其余 hook。enabled 默认 false（默认关闭是安全红线）。
 * @param section - sectionDefaults('hookBus', config) 的结果。
 * @returns { enabled, timeoutMs, hooks, dropped }。
 */
export function resolveHookBusOptions(section) {
  const base = DEFAULTS.hookBus
  const raw = section !== null && typeof section === 'object' ? section : {}
  const timeoutMs = clampInt(raw.timeoutMs, base.timeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS)
  const hooks = []
  const dropped = []
  const list = Array.isArray(raw.hooks) ? raw.hooks : []
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    if (entry === null || typeof entry !== 'object') {
      dropped.push({ index, reason: 'not an object' })
      continue
    }
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (command.length === 0) {
      dropped.push({ index, reason: 'empty command' })
      continue
    }
    const event = typeof entry.event === 'string' ? entry.event : ''
    if (!HOOK_EVENTS.includes(event)) {
      dropped.push({ index, reason: 'unknown event ' + JSON.stringify(event) })
      continue
    }
    const name = typeof entry.name === 'string' && entry.name.trim().length > 0
      ? entry.name.trim().slice(0, 80)
      : 'hook-' + (index + 1)
    const matcher = typeof entry.matcher === 'string' ? entry.matcher.trim() : ''
    const rawTimeout = Number(entry.timeoutMs)
    const hookTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= TIMEOUT_MIN_MS
      ? Math.min(TIMEOUT_MAX_MS, Math.floor(rawTimeout))
      : undefined
    hooks.push({ name, event, matcher, command, timeoutMs: hookTimeoutMs })
  }
  return { enabled: raw.enabled === true, timeoutMs, hooks, dropped }
}

/**
 * matcher 正则匹配工具名。空 matcher 匹配所有工具；非法正则不匹配任何工具
 * （fail-open：宁可不跑 hook，也不误拦）。
 */
export function matcherMatches(matcher, toolName) {
  const pattern = typeof matcher === 'string' ? matcher.trim() : ''
  const tool = String(toolName ?? '')
  if (pattern.length === 0) return true
  if (tool.length === 0) return false
  try {
    return new RegExp(pattern, 'u').test(tool)
  } catch {
    return false
  }
}

/**
 * 选出某个事件的 hook（保持配置顺序）。
 * @param options - resolveHookBusOptions 的结果。
 * @param event - 六个事件之一。
 * @param toolName - 工具名；非工具事件忽略。
 */
export function selectHooks(options, event, toolName) {
  const hooks = Array.isArray(options?.hooks) ? options.hooks : []
  const isToolEvent = TOOL_EVENTS.includes(event)
  return hooks.filter((hook) => hook.event === event && (!isToolEvent || matcherMatches(hook.matcher, toolName)))
}

/**
 * 平台 shell 包装：Windows 走 $ComSpec /d /s /c，POSIX 走 /bin/sh -c。
 * 命令是用户配置的受信字符串（模型无法注入），shell 语义是 Claude Code
 * hooks 兼容性的一部分（允许管道/重定向）。
 * @param command - 配置命令。
 * @param platform - process.platform。
 * @param comspec - process.env.ComSpec。
 * @returns { file, args } 交给 runCommand。
 */
export function shellInvocation(command, platform, comspec) {
  const text = String(command ?? '')
  if (platform === 'win32') {
    const file = typeof comspec === 'string' && comspec.length > 0 ? comspec : 'cmd.exe'
    return { file, args: ['/d', '/s', '/c', text] }
  }
  return { file: '/bin/sh', args: ['-c', text] }
}

/** 单个 hook 的生效超时。 */
export function hookTimeout(hook, options) {
  const own = Number(hook?.timeoutMs)
  if (Number.isFinite(own) && own >= TIMEOUT_MIN_MS) return Math.min(TIMEOUT_MAX_MS, Math.floor(own))
  return clampInt(options?.timeoutMs, DEFAULTS.hookBus.timeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS)
}

/** 截断文本并标注省略量（stdin payload 只放摘要，避免巨大 JSON）。 */
export function clipText(text, max = STDIN_TEXT_CAP) {
  const source = String(text ?? '')
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : STDIN_TEXT_CAP
  if (source.length <= cap) return source
  return source.slice(0, cap) + '… (+' + (source.length - cap) + ' chars)'
}

/** 把消息 content（字符串或 text block 数组）压成纯文本。 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 把工具结果压成 tool_response 摘要（PostToolUse payload 用）。
 * 只放文本摘要，不放结构化大对象。
 */
export function summarizeToolResult(result, max = STDIN_TEXT_CAP) {
  if (result === null || result === undefined) return ''
  const prefix = result !== null && typeof result === 'object' && result.isError === true ? '[error] ' : ''
  const text = typeof result === 'string'
    ? result
    : contentToText(result?.content) || String(result?.error?.message ?? '')
  return prefix + clipText(text, max)
}

/**
 * 构建 stdin JSON。PreToolUse/PostToolUse 固定带 hook_event_name/tool_name/
 * tool_input；cwd/session_id 只在可用时出现（不猜宿主进程 cwd）。
 * @returns JSON 字符串；极端情况下退化为最小合法 JSON。
 */
export function buildHookPayload(input) {
  const event = String(input?.event ?? '')
  const payload = { hook_event_name: event }
  if (TOOL_EVENTS.includes(event)) {
    payload.tool_name = String(input?.toolName ?? '')
    payload.tool_input = input?.toolInput !== undefined ? input.toolInput : {}
  }
  if (input?.toolResponseText !== undefined) payload.tool_response = clipText(input.toolResponseText)
  if (input?.promptText !== undefined) payload.prompt = clipText(input.promptText)
  const cwd = input?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) payload.cwd = cwd
  const sessionId = input?.sessionId
  if (typeof sessionId === 'string' && sessionId.length > 0) payload.session_id = sessionId
  const extra = input?.extra
  if (extra !== null && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) payload[key] = value
  }
  try {
    return JSON.stringify(payload)
  } catch {
    // tool_input 含循环引用等极端输入：退化为最小 payload，hook 仍可执行。
    return JSON.stringify({ hook_event_name: event })
  }
}

/** 解析 stdout JSON：只有普通对象算 JSON，非法/空/数组/标量都视为"无 JSON"。 */
export function parseHookStdout(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (text.length === 0) return undefined
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value
}

function normalizeRun(run) {
  return {
    code: Number.isFinite(Number(run?.code)) ? Number(run.code) : -1,
    stdout: typeof run?.stdout === 'string' ? run.stdout : '',
    stderr: typeof run?.stderr === 'string' ? run.stderr : '',
    timedOut: run?.timedOut === true,
  }
}

function textOr(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 ? text : fallback
}

function warningFor(hook, message) {
  return 'hookBus: hook ' + JSON.stringify(String(hook?.name ?? '')) + ' ' + message
}

/** 非 0/2 exit、超时、非法 JSON 的统一 fail-open 警告。 */
function failOpenWarning(hook, run) {
  if (run.timedOut) return warningFor(hook, 'timed out and was ignored (fail-open)')
  if (run.code !== 0 && run.code !== 2) return warningFor(hook, 'exited with code ' + run.code + ' and was ignored (fail-open)')
  return undefined
}

/**
 * PreToolUse 结果映射。
 * @returns { decision: 'deny'|'allow'|'pass', reason?, warning? }
 */
export function mapPreToolResult(hook, run) {
  const result = normalizeRun(run)
  const warning = failOpenWarning(hook, result)
  if (warning !== undefined) return { decision: 'pass', warning }
  if (result.code === 2) {
    return {
      decision: 'deny',
      reason: textOr(result.stderr, 'hook ' + JSON.stringify(String(hook?.name ?? '')) + ' denied this tool call (exit 2)'),
    }
  }
  const json = parseHookStdout(result.stdout)
  if (json === undefined) return { decision: 'pass' }
  if (json.decision === 'deny') {
    return {
      decision: 'deny',
      reason: textOr(json.reason, 'hook ' + JSON.stringify(String(hook?.name ?? '')) + ' denied this tool call'),
    }
  }
  if (json.decision === 'allow') return { decision: 'allow' }
  return { decision: 'pass' }
}

/**
 * PostToolUse 结果映射：exit 2 → block；JSON additionalContext → 注入上下文。
 * @returns { decision: 'block'|'context'|'pass', feedback?, context?, warning? }
 */
export function mapPostToolResult(hook, run) {
  const result = normalizeRun(run)
  const warning = failOpenWarning(hook, result)
  if (warning !== undefined) return { decision: 'pass', warning }
  if (result.code === 2) {
    return {
      decision: 'block',
      feedback: textOr(result.stderr, 'hook ' + JSON.stringify(String(hook?.name ?? '')) + ' blocked this tool result (exit 2)'),
    }
  }
  const json = parseHookStdout(result.stdout)
  if (json === undefined) return { decision: 'pass' }
  const context = typeof json.additionalContext === 'string' ? json.additionalContext.trim() : ''
  if (context.length > 0) return { decision: 'context', context }
  return { decision: 'pass' }
}

/**
 * Stop 结果映射：continue:true 或 exit 2 都表示保持轮次打开。
 * @returns { continue: boolean, message?, warning? }
 */
export function mapStopResult(hook, run) {
  const result = normalizeRun(run)
  const warning = failOpenWarning(hook, result)
  if (warning !== undefined) return { continue: false, warning }
  if (result.code === 2) {
    return {
      continue: true,
      message: textOr(result.stderr, 'hook ' + JSON.stringify(String(hook?.name ?? '')) + ' asked to continue this turn (exit 2)'),
    }
  }
  const json = parseHookStdout(result.stdout)
  if (json === undefined) return { continue: false }
  if (json.continue === true) {
    const message = typeof json.message === 'string' ? json.message.trim() : ''
    return { continue: true, message }
  }
  return { continue: false }
}

/**
 * PreCompact / UserPromptSubmit 结果映射：只取 additionalContext 入队。
 * @returns { context?: string, warning? }
 */
export function mapContextResult(hook, run) {
  const result = normalizeRun(run)
  const warning = failOpenWarning(hook, result)
  if (warning !== undefined) return { warning }
  const json = parseHookStdout(result.stdout)
  if (json === undefined) return {}
  const context = typeof json.additionalContext === 'string' ? json.additionalContext.trim() : ''
  return context.length > 0 ? { context } : {}
}
