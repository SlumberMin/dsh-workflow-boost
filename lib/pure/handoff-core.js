/**
 * Pure handoff-notes logic — no host imports, no file I/O.
 *
 * The value of a handoff note is that it survives compaction: after a summary
 * replaces the history, the model still needs to know the goal, the plan, what
 * "done" means, and what it just did. Everything a note says is derived from
 * fold state (goal, todos, tool ring, last mutation, timestamps), so the whole
 * rendering and triggering policy lives here and is unit-testable without a
 * session or a filesystem. lib/handoff-notes.js only adds the file and the
 * event wiring.
 *
 * Note files are plugin-owned: their name comes from a sanitized session id and
 * the directory is fixed under <workspace>/.dsh/workflow-boost/handoff. Model
 * text can be written into a note, but it can never steer the path.
 *
 * @module dsh-workflow-boost/lib/pure/handoff-core
 */
import { sectionDefaults } from '../defaults.js'
import { MARKS, nextActionable, normalizeTodos, todoCounts } from './focus-render.js'

/** Directory (workspace-relative, POSIX form) that owns every note file. */
export const NOTE_DIR = '.dsh/workflow-boost/handoff'

/** Heading that separates generated sections from model-authored notes. */
export const MODEL_NOTES_HEADING = '## Notes from the model'

/** A note is refreshed at most once every N tool calls while under pressure. */
export const DEFAULT_REFRESH_EVERY_TOOLS = 10

/** Budget of the short pressure notice injected as additional context. */
export const NOTICE_MAX_CHARS = 800

/** Budget of the full note re-injected after a compaction. */
export const COMPACTION_INJECT_MAX_CHARS = 2400

/** How many of the newest tool-ring entries the note lists. */
export const TOOL_LINES = 10

/** Windows reserved device names cannot be used as a file name. */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/** Collapse a value into one safe path segment. */
export function sanitizeSegment(value, maxLength = 64) {
  const raw = value === undefined || value === null
    ? ''
    : typeof value === 'string' ? value : String(value)
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/gu, '_')
    .replace(/\.{2,}/gu, '.')
    .replace(/^[._-]+/u, '')
    .replace(/[._-]+$/u, '')
    .slice(0, Math.max(1, Math.floor(Number(maxLength) || 64)))
  if (cleaned.length === 0) return 'unknown'
  return RESERVED_NAMES.test(cleaned) ? 'session-' + cleaned : cleaned
}

/** Session identity safe for a file name; falls back to 'unknown'. */
export function sessionIdOf(session) {
  try {
    const id = session?.id ?? session?.header?.id
    if (typeof id === 'string' && id.length > 0) return sanitizeSegment(id, 64)
  } catch {
    /* fall through */
  }
  return 'unknown'
}

/** Workspace-relative POSIX path of one session's note file. */
export function noteRelativePath(sessionId) {
  return NOTE_DIR + '/' + sanitizeSegment(sessionId, 64) + '.md'
}

/** Absolute POSIX path of one session's note file. */
export function resolveNotePath(workspace, sessionId) {
  const root = String(workspace ?? '').replace(/[\\/]+$/u, '')
  return root + '/' + noteRelativePath(sessionId)
}

/** Normalize a path for containment comparison (Windows is case-insensitive). */
function comparablePath(value) {
  return String(value ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
}

/** Whether target is root itself or lives below it. Lexical only. */
export function isInsideWorkspace(root, target) {
  const base = comparablePath(root)
  const path = comparablePath(target)
  if (base.length === 0 || path.length === 0) return false
  return path === base || path.startsWith(base + '/')
}

/** Workspace-relative display path of a note file, or the raw path when outside. */
export function displayNotePath(workspace, absolutePath) {
  const base = comparablePath(workspace)
  const path = comparablePath(absolutePath)
  if (base.length === 0 || !path.startsWith(base + '/')) return String(absolutePath ?? '')
  const original = String(absolutePath ?? '').replace(/\\/gu, '/')
  const originalBase = String(workspace ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '')
  return original.slice(originalBase.length + 1)
}

/** Clamp a finite ratio into [min, max]. */
function clampRatio(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Clamp a finite integer into [min, max]. */
function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * Resolve the row section. refreshEveryTools is an internal default (the row
 * schema documents only the four public knobs) but a raw override is honored so
 * tests and power users do not need a schema change.
 * @param config - plugin row config.
 * @returns normalized settings.
 */
export function resolveHandoffConfig(config) {
  const merged = sectionDefaults('handoffNotes', config)
  return {
    enabled: config?.enabled !== false && merged.enabled !== false,
    minPressureRatio: clampRatio(merged.minPressureRatio, 0.6, 0.3, 0.95),
    maxNoteChars: clampInteger(merged.maxNoteChars, 4000, 200, 20000),
    injectAfterCompaction: merged.injectAfterCompaction !== false,
    refreshEveryTools: clampInteger(
      merged.refreshEveryTools === undefined ? DEFAULT_REFRESH_EVERY_TOOLS : merged.refreshEveryTools,
      DEFAULT_REFRESH_EVERY_TOOLS,
      1,
      1000,
    ),
  }
}

/**
 * Pressure ratio from the token meter's contextPressure shape.
 * @param pressure - { pressureTokens, contextWindow } or anything.
 * @returns ratio in [0, ...), or undefined when the window is unknown.
 */
export function pressureRatioOf(pressure) {
  if (pressure === null || typeof pressure !== 'object') return undefined
  const tokens = Number(pressure.pressureTokens)
  const window = Number(pressure.contextWindow)
  if (!Number.isFinite(tokens) || tokens < 0) return undefined
  if (!Number.isFinite(window) || window <= 0) return undefined
  return tokens / window
}

/**
 * Decide what one post-execute call owes.
 *
 * Compaction wins over the pressure path: after the history was summarized the
 * note must be re-injected even when pressure is currently low or the list is
 * unchanged. Both paths are once-per-turn at most.
 * @param input.pressureRatio - current pressure ratio (undefined = unknown).
 * @param input.toolsSinceNote - tool calls since the last note refresh.
 * @param input.minPressureRatio - configured pressure threshold.
 * @param input.refreshEveryTools - minimum tool-call gap between notes.
 * @param input.compactionPending - a compaction/end was observed and not yet served.
 * @param input.notedThisTurn - a note was already injected in this turn.
 * @returns { action: 'none'|'refresh'|'inject-compaction', reason }.
 */
export function shouldRefreshHandoff(input = {}) {
  if (input.compactionPending === true) return { action: 'inject-compaction', reason: 'compaction' }
  if (input.notedThisTurn === true) return { action: 'none', reason: 'already-noted-this-turn' }
  const tools = Number(input.toolsSinceNote)
  const gap = clampInteger(input.refreshEveryTools, DEFAULT_REFRESH_EVERY_TOOLS, 1, 1000)
  if (!Number.isFinite(tools) || tools < gap) return { action: 'none', reason: 'few-tools-since-last-note' }
  const ratio = Number(input.pressureRatio)
  const threshold = clampRatio(input.minPressureRatio, 0.6, 0.3, 0.95)
  if (!Number.isFinite(ratio) || ratio < threshold) return { action: 'none', reason: 'pressure-below-threshold' }
  return { action: 'refresh', reason: 'pressure' }
}

/** Clip text to a character budget, appending a truncation marker only when it fits. */
export function truncateNote(text, maxChars) {
  const source = String(text ?? '')
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0))
  if (budget === 0) return ''
  if (source.length <= budget) return source
  const marker = '\n\n[... note truncated at ' + budget + ' characters ...]'
  const head = Math.max(0, budget - marker.length)
  return head === 0 ? source.slice(0, budget) : source.slice(0, head) + marker
}

/** Extract the model-authored tail of a note ('' when it has none). */
export function extractModelNotes(text) {
  const source = String(text ?? '')
  const index = source.indexOf(MODEL_NOTES_HEADING)
  if (index < 0) return ''
  return source.slice(index + MODEL_NOTES_HEADING.length).replace(/^\s*/u, '').trim()
}

/** Whether a note already carries model-authored content. */
export function hasModelNotes(text) {
  return extractModelNotes(text).length > 0
}

/** Whether text is a note this module generated (as opposed to model-authored). */
export function isGeneratedNote(text) {
  const source = String(text ?? '')
  return source.startsWith('# Handoff notes') || source.includes(MODEL_NOTES_HEADING)
}

/**
 * Model-authored content to carry across a refresh. A generated note contributes
 * its "## Notes from the model" tail; a file the model wrote by hand (tool write
 * or append) has no such heading, so its whole content is preserved instead of
 * being silently clobbered by the next refresh.
 * @param text - current note file content.
 * @returns the text to keep under the model-notes heading ('' when none).
 */
export function preservedModelNotes(text) {
  const extracted = extractModelNotes(text)
  if (extracted.length > 0) return extracted
  const source = String(text ?? '').trim()
  if (source.length === 0 || isGeneratedNote(source)) return ''
  return source
}

/** Render one goal (string or service object) as a single bounded line. */
export function goalLine(goal) {
  if (goal === undefined || goal === null) return ''
  if (typeof goal === 'string') return goal.replace(/\s+/gu, ' ').trim().slice(0, 500)
  if (typeof goal !== 'object') return ''
  let value = goal
  if (goal.goal !== null && typeof goal.goal === 'object') value = goal.goal
  const parts = []
  for (const key of ['title', 'objective', 'description', 'summary', 'text']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      parts.push(candidate.replace(/\s+/gu, ' ').trim().slice(0, 500))
      break
    }
  }
  if (parts.length === 0 && typeof value.id === 'string' && value.id.length > 0) parts.push('goal ' + value.id)
  const status = typeof value.status === 'string' ? value.status : typeof value.state === 'string' ? value.state : ''
  if (status.length > 0) parts.push('status: ' + status)
  if (value.active === false) parts.push('inactive')
  return parts.join(' — ')
}

/** Render the recent tool ring as a compact activity list (newest last). */
export function renderToolActivity(toolRing, limit = TOOL_LINES) {
  const entries = Array.isArray(toolRing) ? toolRing : []
  const max = clampInteger(limit, TOOL_LINES, 1, 50)
  const shown = entries.slice(-max)
  if (shown.length === 0) return '(no tool calls recorded yet)'
  const lines = []
  for (const entry of shown) {
    const name = typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : '(unnamed tool)'
    const mark = entry?.isError === true ? '✗' : '✓'
    lines.push('- ' + name + ' ' + mark)
  }
  return lines.join('\n')
}

/** Render one displayed todo line, keeping any acceptance clause verbatim. */
function todoLine(todo, position) {
  const mark = MARKS[todo.status] ?? MARKS.pending
  const content = String(todo.content ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240)
  return '- ' + mark + ' ' + position + '. ' + content
}

/**
 * Render the state-derived note. Deterministic for a fixed input, so tests can
 * compare sections instead of a whole blob.
 * @param input.sessionId - raw session id (sanitized inside).
 * @param input.workspace - workspace root shown in the header (optional).
 * @param input.goal - active goal from the goals service (optional).
 * @param input.todos - todo list from the session-state fold.
 * @param input.toolRing - recent tool activity ring.
 * @param input.toolCount - total tool calls this session.
 * @param input.errorCount - total tool errors this session.
 * @param input.lastMutationSeq - newest write/edit seq (-1 when none).
 * @param input.turn / input.step - current fold position.
 * @param input.previousText - current note text, so model notes survive a refresh.
 * @param input.now - timestamp (number or ISO string) for the Updated line.
 * @param input.maxNoteChars - hard character budget.
 * @returns the rendered note, truncated when over budget.
 */
export function renderHandoffNote(input = {}) {
  const sessionId = sanitizeSegment(input.sessionId, 64)
  const todos = normalizeTodos(input.todos)
  const counts = todoCounts(todos)
  const toolRing = Array.isArray(input.toolRing) ? input.toolRing : []
  const errors = Number.isFinite(Number(input.errorCount)) ? Number(input.errorCount) : toolRing.filter((entry) => entry?.isError === true).length
  const toolCount = Number.isFinite(Number(input.toolCount)) ? Number(input.toolCount) : toolRing.length
  const lastMutationSeq = Number(input.lastMutationSeq)
  const updated = (() => {
    if (typeof input.now === 'string' && input.now.length > 0) return input.now
    const time = Number(input.now)
    return new Date(Number.isFinite(time) ? time : Date.now()).toISOString()
  })()
  const lines = ['# Handoff notes — session ' + sessionId, 'Updated: ' + updated]
  if (typeof input.workspace === 'string' && input.workspace.length > 0) lines.push('Workspace: ' + input.workspace)
  const position = []
  if (Number.isFinite(Number(input.turn))) position.push('turn ' + Number(input.turn))
  if (Number.isFinite(Number(input.step))) position.push('step ' + Number(input.step))
  position.push('tool calls ' + toolCount + (errors > 0 ? ' (' + errors + ' error(s))' : ''))
  lines.push('Position: ' + position.join(' · '))
  lines.push('', '## Active goal')
  const goal = goalLine(input.goal)
  lines.push(goal.length > 0 ? goal : '(no active goal recorded by the goals service)')
  lines.push('', '## Task list')
  if (todos.length === 0) {
    lines.push('(no task list recorded yet)')
  } else {
    lines.push('Progress: ' + counts.completed + '/' + counts.total + ' complete' +
      (counts.inProgress > 0 ? ', ' + counts.inProgress + ' in progress' : '') +
      (counts.blocked > 0 ? ', ' + counts.blocked + ' blocked' : '') + '.')
    for (let index = 0; index < todos.length; index += 1) lines.push(todoLine(todos[index], index + 1))
  }
  lines.push('', '## Next')
  const next = nextActionable(todos)
  lines.push(next === undefined ? '(no actionable todo item)' : next.index + '. ' + String(next.todo.content ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240))
  lines.push('', '## Recent tool activity')
  lines.push(renderToolActivity(toolRing))
  lines.push('', '## Edits')
  lines.push(Number.isFinite(lastMutationSeq) && lastMutationSeq >= 0
    ? 'Edits since seq ' + lastMutationSeq + ' (write/edit the files touched after that point).'
    : 'No write/edit recorded in this session yet.')
  lines.push('', MODEL_NOTES_HEADING)
  const modelNotes = preservedModelNotes(input.previousText)
  if (modelNotes.length > 0) lines.push(modelNotes)
  return truncateNote(lines.join('\n'), input.maxNoteChars === undefined ? 4000 : input.maxNoteChars)
}

/** Extract the Next line of a rendered note, for the short notice. */
function noteNextLine(noteText) {
  const match = /^## Next\n([^\n]+)/mu.exec(String(noteText ?? ''))
  return match === null ? '' : match[1].trim()
}

/** Extract the Active goal body (first line) of a rendered note. */
function noteGoalLine(noteText) {
  const match = /^## Active goal\n([^\n]+)/mu.exec(String(noteText ?? ''))
  return match === null ? '' : match[1].trim()
}

/**
 * Render the short notice injected on the pressure path. It names the file and
 * repeats only the two facts the next step needs most (goal and Next), so the
 * injection stays cheap.
 * @param input.noteText - freshly rendered note.
 * @param input.notePath - workspace-relative path for the model to re-read.
 * @param input.reason - 'pressure' or 'compaction'.
 * @param input.maxChars - notice budget.
 */
export function renderHandoffNotice(input = {}) {
  const maxChars = clampInteger(input.maxChars, NOTICE_MAX_CHARS, 200, 4000)
  const noteText = String(input.noteText ?? '')
  const path = typeof input.notePath === 'string' ? input.notePath : ''
  const header = '[Handoff note — automatically refreshed under context pressure' +
    (path.length > 0 ? '; saved at ' + path : '') + '. It records the goal, plan, next step and recent activity.]'
  const lines = [header]
  const goal = noteGoalLine(noteText)
  if (goal.length > 0 && !goal.startsWith('(no active goal')) lines.push('Goal: ' + goal)
  const next = noteNextLine(noteText)
  if (next.length > 0 && !next.startsWith('(no actionable')) lines.push('Next: ' + next)
  return truncateNote(lines.join('\n'), maxChars)
}

/**
 * Render the full re-injection used after a compaction checkpoint: the model
 * lost the history the note describes, so it gets the note body itself.
 * @param input.noteText - rendered note.
 * @param input.notePath - workspace-relative path.
 * @param input.maxChars - injection budget.
 */
export function renderHandoffInjection(input = {}) {
  const maxChars = clampInteger(input.maxChars, COMPACTION_INJECT_MAX_CHARS, 200, 20000)
  const noteText = String(input.noteText ?? '')
  const path = typeof input.notePath === 'string' ? input.notePath : ''
  const header = '[Handoff note — re-injected after context compaction' +
    (path.length > 0 ? '; full note saved at ' + path : '') + '. Re-anchor on it before continuing.]'
  const body = truncateNote(noteText, Math.max(0, maxChars - header.length - 2))
  return header + '\n' + body
}
