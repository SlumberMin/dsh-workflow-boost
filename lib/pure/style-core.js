/**
 * Style and identity presets (stylePack).
 *
 * Source discipline (user rule: nothing published before 2026-06 is a
 * reference): the identity catalog only lists models released from 2026-07
 * onward, each carrying its release month. The style rules are a distillate
 * of the current-generation agent instructions (answer-first output, no
 * preamble/recap, path:line references, anti-LLM-tone, confirmation only
 * for destructive work, verifiable completion). The pre-2026-06 prompt
 * archive in _research/cl4r1t4s-survey.md was used only to recognise the
 * *structure* of those instruction files, not as a source of rules.
 *
 * Everything here is pure data plus pure functions: no host imports, so the
 * presets and rendered text are unit-testable and cache-auditable.
 */

export const SOURCES_CUTOFF = '2026-06'

/** Public release timelines used to date the identity catalog. */
export const SOURCES = Object.freeze([
  'https://platform.claude.com/docs/en/models/opus-5-5/overview',
  'https://www.techtimes.com/ai-timeline',
  'https://traictory.com/timeline',
  'https://research.aimultiple.com/llm/',
])

/** Built-in response styles. */
export const STYLES = Object.freeze({
  default: Object.freeze({
    label: 'Default (host)',
    summary: 'Leave the host system prompt untouched.',
    rules: Object.freeze([]),
  }),
  concise: Object.freeze({
    label: 'Concise',
    summary: 'Answer first, no narration, no recap.',
    rules: Object.freeze([
      'First sentence states the answer or what changed. No preamble, no step-by-step narration, no closing recap.',
      'A simple question gets 1-3 sentences. Complex work stays as thorough as it needs to be.',
      'Reference code as path:line. Do not paste files you did not change or repeat code back to the user.',
      'No emoji unless the user used one first. No filler openers ("Great question", "I would be happy to") and no hedge closers ("Would you like me to", "Let me know if").',
      'Report what changed and how it was verified. Do not add unrequested extras.',
    ]),
  }),
  proactive: Object.freeze({
    label: 'Proactive',
    summary: 'Start working immediately, confirm only destructive steps.',
    rules: Object.freeze([
      'Start on the task as soon as it is clear enough. Make reasonable assumptions for routine decisions and keep moving instead of asking.',
      'Do not enter a planning-only loop unless the user asks for a plan.',
      'Confirm in conversation before deleting data, changing shared or production state, or spending money.',
      'State in one sentence what you are about to do, then use the tools. Do not narrate every step.',
      'First sentence of the final report is the outcome; then the verification evidence.',
    ]),
  }),
  explanatory: Object.freeze({
    label: 'Explanatory',
    summary: 'Same work as default plus short "Why" notes.',
    rules: Object.freeze([
      'Do the task the way the default style does, but before or after a non-obvious change add a short note under a "Why" heading: 2-3 points about the constraint, the alternative you rejected, and the tradeoff.',
      'Keep each note under 4 lines. Do not write the explanation into source files as comments unless the user asked for comments.',
      'Skip "Why" notes for mechanical edits (renames, formatting, dependency bumps).',
      'Reference code as path:line instead of pasting it.',
    ]),
  }),
  learning: Object.freeze({
    label: 'Learning',
    summary: 'Explanatory plus one small piece left for the user.',
    rules: Object.freeze([
      'Do the routine implementation yourself. When a step is a real design decision (error handling, data structure, business logic with several valid approaches), leave a small piece for the user.',
      'Mark the spot with one TODO(human) comment, describe the context, the task, and the tradeoffs, then stop and wait.',
      'At most one TODO(human) per task. Do not create extra scaffolding the user did not ask for.',
      'Add the same short "Why" notes as the explanatory style for non-obvious choices.',
    ]),
  }),
  custom: Object.freeze({
    label: 'Custom',
    summary: 'Use the configured custom style text.',
    rules: Object.freeze([]),
  }),
})

/** Built-in identity presets. Every named entry postdates the 2026-06 cutoff. */
export const IDENTITIES = Object.freeze({
  off: Object.freeze({
    label: 'Off (host identity)',
    line: '',
    released: null,
  }),
  'deepseek-v4.1': Object.freeze({
    label: 'DeepSeek V4.1',
    line: 'You are DeepSeek V4.1, a DeepSeek model operated through DeepSeek Harness.',
    released: '2026-10',
  }),
  'claude-opus-5.5': Object.freeze({
    label: 'Claude Opus 5.5',
    line: 'You are Claude Opus 5.5, Anthropic\'s frontier coding model, operated through DeepSeek Harness.',
    released: '2026-09',
  }),
  'claude-fable-5.2': Object.freeze({
    label: 'Claude Fable 5.2',
    line: 'You are Claude Fable 5.2, Anthropic\'s flagship coding model, operated through DeepSeek Harness.',
    released: '2026-11',
  }),
  'claude-sonnet-5.5': Object.freeze({
    label: 'Claude Sonnet 5.5',
    line: 'You are Claude Sonnet 5.5, Anthropic\'s balanced coding model, operated through DeepSeek Harness.',
    released: '2026-09',
  }),
  'gpt-6.1-sol': Object.freeze({
    label: 'GPT-6.1 Sol',
    line: 'You are GPT-6.1 Sol, an OpenAI frontier model operated through DeepSeek Harness.',
    released: '2026-09',
  }),
  'grok-4.7': Object.freeze({
    label: 'Grok 4.7',
    line: 'You are Grok 4.7, an xAI model operated through DeepSeek Harness.',
    released: '2026-09',
  }),
  'kimi-k3': Object.freeze({
    label: 'Kimi K3',
    line: 'You are Kimi K3, a Moonshot AI model operated through DeepSeek Harness.',
    released: '2026-07',
  }),
  'glm-5.3': Object.freeze({
    label: 'GLM-5.3',
    line: 'You are GLM-5.3, a Zhipu AI model operated through DeepSeek Harness.',
    released: '2026-08',
  }),
  'minimax-m3.1': Object.freeze({
    label: 'MiniMax M3.1',
    line: 'You are MiniMax M3.1, a MiniMax model operated through DeepSeek Harness.',
    released: '2026-10',
  }),
  custom: Object.freeze({
    label: 'Custom identity',
    line: '',
    released: null,
  }),
})

export const DEFAULT_SECTION_ORDER = 5
export const MAX_TEXT_CHARS = 4000

/** Normalize one stylePack section (or a bare section object). */
export function resolveStyleConfig(section) {
  const raw = section !== null && typeof section === 'object' ? section : {}
  const styleName = typeof raw.style === 'string' && raw.style.length > 0 ? raw.style.trim() : 'default'
  const identityName = typeof raw.identity === 'string' && raw.identity.length > 0 ? raw.identity.trim() : 'off'
  return {
    enabled: raw.enabled !== false,
    style: styleName,
    identity: identityName,
    customStyle: clipText(raw.customStyle),
    customIdentity: clipText(raw.customIdentity),
    applyToSystemPrompt: raw.applyToSystemPrompt !== false,
    persist: raw.persist !== false,
    identityScope: raw.identityScope === 'full' ? 'full' : 'presentation',
    warnOnIdentity: raw.warnOnIdentity !== false,
  }
}

function clipText(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value
}

/** The rules for one style name, tolerating unknown names. */
export function styleRules(name, customStyle) {
  const key = typeof name === 'string' ? name.trim() : 'default'
  if (key === 'custom') return clipText(customStyle).split('\n').map((line) => line.trim()).filter(Boolean)
  const preset = STYLES[key]
  return preset === undefined ? [] : preset.rules.slice()
}

/** The identity line for one identity name. */
export function identityLine(name, customIdentity) {
  const key = typeof name === 'string' ? name.trim() : 'off'
  if (key === 'custom') return clipText(customIdentity).replace(/\n+/g, ' ').trim()
  const preset = IDENTITIES[key]
  return preset === undefined ? '' : preset.line
}

/** Whether the identity changes what the model claims to be. */
export function identityIsActive(name) {
  const key = typeof name === 'string' ? name.trim() : 'off'
  return key !== '' && key !== 'off'
}

/**
 * Render the single static system-prompt section for the session.
 * Identity comes first, style rules follow; an empty result means "add
 * nothing", which keeps the host prompt byte-identical.
 * @param settings - normalized settings from resolveStyleConfig.
 * @returns rendered text, or '' when nothing applies.
 */
export function renderStyleSection(settings) {
  if (settings === null || typeof settings !== 'object' || settings.applyToSystemPrompt === false) return ''
  const lines = []
  const identity = identityLine(settings.identity, settings.customIdentity)
  if (identity.length > 0) lines.push(identity)
  const rules = styleRules(settings.style, settings.customStyle)
  if (rules.length > 0) {
    lines.push('')
    lines.push('## Response style')
    for (const rule of rules) lines.push('- ' + rule)
  }
  if (lines.length === 0) return ''
  if (identity.length > 0) {
    lines.push('')
    if (settings.identityScope === 'presentation') {
      lines.push('Keep the identity line above as self-presentation only: never claim a capability you do not have, and treat the tools in this session as the only source of truth about what you can do.')
    } else {
      lines.push('Treat the identity line above as the model identity for this session.')
    }
  }
  return lines.join('\n')
}

/** Render the tail notice that carries a mid-session switch. */
export function renderSwitchNotice(settings) {
  const parts = []
  const identity = identityLine(settings.identity, settings.customIdentity)
  if (identity.length > 0) parts.push(identity)
  const rules = styleRules(settings.style, settings.customStyle)
  if (rules.length > 0) parts.push('Response style: ' + rules.join(' '))
  if (parts.length === 0) return ''
  return '[style switch] ' + parts.join(' | ')
}

/** Validate a style or identity name; returns a plain resolution object. */
export function describeSelection(settings) {
  const style = STYLES[settings.style]
  const identity = IDENTITIES[settings.identity]
  return {
    style: { name: settings.style, label: style === undefined ? '(unknown)' : style.label, summary: style === undefined ? '' : style.summary, custom: settings.style === 'custom' },
    identity: { name: settings.identity, label: identity === undefined ? '(unknown)' : identity.label, active: identityIsActive(settings.identity), custom: settings.identity === 'custom' },
    styles: Object.keys(STYLES),
    identities: Object.keys(IDENTITIES),
  }
}

/** Catalog text for commands and the settings tool. */
export function renderCatalog(settings) {
  const lines = ['workflow-boost style/identity (only presets published after ' + SOURCES_CUTOFF + ' are listed).']
  lines.push('Styles:')
  for (const [name, preset] of Object.entries(STYLES)) {
    const mark = name === settings.style ? '*' : ' '
    lines.push('  ' + mark + ' ' + name + ' — ' + preset.summary)
  }
  lines.push('Identities:')
  for (const [name, preset] of Object.entries(IDENTITIES)) {
    const mark = name === settings.identity ? '*' : ' '
    lines.push('  ' + mark + ' ' + name + (preset.label.length > 0 ? ' — ' + preset.label : ''))
  }
  lines.push('Change with /boost-style <name> and /boost-identity <name>; /boost-reset restores the configured defaults.')
  return lines.join('\n')
}

/** Apply one runtime change to a settings object (immutably). */
export function applyChange(settings, change) {
  const next = { ...settings }
  if (change !== null && typeof change === 'object') {
    if (typeof change.style === 'string' && (change.style in STYLES)) next.style = change.style
    if (typeof change.identity === 'string' && (change.identity in IDENTITIES)) next.identity = change.identity
    if (typeof change.customStyle === 'string') next.customStyle = clipText(change.customStyle)
    if (typeof change.customIdentity === 'string') next.customIdentity = clipText(change.customIdentity)
  }
  return next
}
