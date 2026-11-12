/**
 * Pure focus-chain rendering — no host imports, no session access.
 *
 * focusChain re-injects the live todo list into history so the model keeps the
 * active plan in front of it. What the model loses over a long turn is not the
 * list (todo/write is durable) but the *framing*: which item is next, how far
 * along the plan is, and what "done" means for each item. This module owns the
 * exact model-facing text and the content hash used to suppress duplicates;
 * lib/focus-chain.js only decides when to inject and builds the host message.
 *
 * Acceptance criteria: todo content may carry an explicit acceptance clause in
 * full-width parentheses, e.g. "补测试（验收：node test/unit.mjs 全绿）". The
 * renderer keeps that clause byte-for-byte: completing an item must still be
 * verifiable after the plan is compressed, so clipping it away would lose the
 * only durable statement of what the item promised.
 *
 * @module dsh-workflow-boost/lib/pure/focus-render
 */
import { shortDigest } from '../shared.js'

/** Status markers rendered in the snapshot; unknown statuses render as pending. */
export const MARKS = Object.freeze({
  completed: '[x]',
  in_progress: '[>]',
  blocked: '[!]',
  pending: '[ ]',
})

/** Default limits when the caller does not pass config (lib/defaults.js is authoritative). */
export const DEFAULT_MAX_ITEMS = 40
export const DEFAULT_MAX_ITEM_CHARS = 160
export const DEFAULT_MIN_ITEMS = 1

/** Acceptance clause: a full-width parenthesized "验收：..." (or ASCII fallback). */
const ACCEPTANCE_RE = /[（(]\s*验收\s*[：:][\s\S]*?[）)]/

/** Collapse only the task text, never the acceptance clause. */
function collapse(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * Split one todo content into its task text and its verbatim acceptance clause.
 * @param content - raw todo content.
 * @returns task text plus the untouched acceptance clause ('' when absent).
 */
export function splitAcceptance(content) {
  const source = String(content ?? '')
  const match = ACCEPTANCE_RE.exec(source)
  if (match === null) return { text: collapse(source), acceptance: '' }
  const text = collapse(source.slice(0, match.index) + ' ' + source.slice(match.index + match[0].length))
  return { text, acceptance: match[0].trim() }
}

/** Clip task text to a character budget without touching the acceptance clause. */
function clip(text, maxChars) {
  const source = String(text ?? '')
  if (source.length <= maxChars) return source
  const budget = Math.max(1, maxChars)
  return source.slice(0, budget - 1) + '…'
}

/** Keep only well-formed todo records. */
export function normalizeTodos(todos) {
  if (!Array.isArray(todos)) return []
  return todos.filter((todo) => todo !== null && typeof todo === 'object' && typeof todo.content === 'string')
}

/** Count items by status; unknown statuses count as pending. */
export function todoCounts(todos) {
  const counts = { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0 }
  for (const todo of normalizeTodos(todos)) {
    counts.total += 1
    if (todo.status === 'completed') counts.completed += 1
    else if (todo.status === 'in_progress') counts.inProgress += 1
    else if (todo.status === 'blocked') counts.blocked += 1
    else counts.pending += 1
  }
  return counts
}

/**
 * The next actionable item: the first in-progress item, else the first pending
 * one. Completed and blocked items are never suggested as "Next".
 * @param todos - current list.
 * @returns the chosen todo (with its 1-based position), or undefined.
 */
export function nextActionable(todos) {
  const items = normalizeTodos(todos)
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].status === 'in_progress') return { todo: items[index], index: index + 1 }
  }
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].status === 'pending') return { todo: items[index], index: index + 1 }
  }
  return undefined
}

/**
 * Render one focus-chain snapshot. Pure, so the exact model-facing text is
 * unit-testable without a session.
 * @param todos - current todo list.
 * @param options.includeProgress - render the n/m progress line.
 * @param options.includeNextAction - render an explicit Next line.
 * @param options.maxItems - maximum items rendered in one snapshot.
 * @param options.maxItemChars - maximum characters of one item's task text.
 * @param options.step - tool-call ordinal that triggered the snapshot.
 * @param options.everySteps - configured period, for the "every N calls" hint.
 * @param options.afterCompaction - mark the snapshot as a post-compaction re-anchor.
 * @returns the snapshot text, or an empty string for an empty list.
 */
export function renderFocusChain(todos, options = {}) {
  const items = normalizeTodos(todos)
  if (items.length === 0) return ''
  const includeProgress = options.includeProgress !== false
  const includeNextAction = options.includeNextAction !== false
  const maxItems = Math.max(1, Math.floor(Number(options.maxItems) || DEFAULT_MAX_ITEMS))
  const maxItemChars = Math.max(1, Math.floor(Number(options.maxItemChars) || DEFAULT_MAX_ITEM_CHARS))
  const counts = todoCounts(items)
  const header =
    '[Focus chain — automatically injected snapshot of the current task list, not a new user request.]' +
    (options.step === undefined ? '' : ' (task list refreshed after ' + options.step + ' tool calls' + (options.everySteps === undefined ? '' : ', every ' + options.everySteps) + ')') +
    (options.afterCompaction === true ? ' (re-anchored after context compaction; treat this list as the current plan)' : '')
  const lines = [header]
  if (includeProgress) {
    const parts = [counts.completed + '/' + counts.total + ' complete']
    if (counts.inProgress > 0) parts.push(counts.inProgress + ' in progress')
    if (counts.blocked > 0) parts.push(counts.blocked + ' blocked')
    lines.push('Progress: ' + parts.join(', ') + '.')
  }
  if (includeNextAction) {
    const next = nextActionable(items)
    if (next !== undefined) {
      const parts = splitAcceptance(next.todo.content)
      const suffix = parts.acceptance.length > 0 ? ' ' + parts.acceptance : ''
      lines.push('Next: ' + next.index + '. ' + clip(parts.text, maxItemChars) + suffix)
    }
  }
  const shown = items.slice(0, maxItems)
  for (let index = 0; index < shown.length; index += 1) {
    const todo = shown[index]
    const mark = MARKS[todo.status] ?? MARKS.pending
    const parts = splitAcceptance(todo.content)
    const suffix = parts.acceptance.length > 0 ? ' ' + parts.acceptance : ''
    lines.push(mark + ' ' + (index + 1) + '. ' + clip(parts.text, maxItemChars) + suffix)
  }
  if (items.length > shown.length) lines.push('... (' + (items.length - shown.length) + ' more items not shown)')
  lines.push(
    'Work the in-progress item first; mark each item completed as soon as it is done and rewrite the list with todo_write when it changes. Do not restate this list to the user.',
  )
  return lines.join('\n')
}

/**
 * Stable content hash of one rendered snapshot. The wiring layer stores it per
 * agent so an unchanged list is not re-injected every period.
 * @param text - rendered snapshot.
 * @returns short hex digest.
 */
export function focusChainKey(text) {
  return shortDigest(String(text ?? ''))
}
