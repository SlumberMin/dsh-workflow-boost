/**
 * skillPack pure core - the static built-in skill catalog plus the adapters
 * that translate it into the two shapes the native skills service accepts.
 *
 * Why static data lives here:
 *  - a skill body must be byte-identical on every run so loading it never
 *    changes a prompt prefix by accident (KV-cache discipline);
 *  - the module must stay importable (and unit-testable) in a clean Node
 *    environment with no @deepseek-ai packages installed;
 *  - the catalog is tiny and trusted, so it is frozen at import time instead
 *    of being read from disk at runtime.
 *
 * Adapter split (verified against @deepseek-ai/dsh-skill 0.2.2-rc.1):
 *  - registerProvider(create): create is a SYNCHRONOUS factory receiving a
 *    lifecycle control and returning a provider { name, list(), get() };
 *    list() returns candidates (name, description, source, provider,
 *    invocation, rank, locator) and get(candidate) returns a definition
 *    (name, description, content, source, provider, invocation).
 *  - register(skill): runtime registration taking name/description/content/
 *    source (provider and invocation receive host defaults).
 * Both paths require source to be a STRING, not the catalog's { kind } object;
 * SKILL_SOURCE_STRING is that display string.
 */
import { DEFAULTS } from '../defaults.js'

/** Source marker carried by every catalog entry (spec shape). */
export const SKILL_SOURCE = Object.freeze({ kind: 'dsh-workflow-boost' })
/** String form required by the host skill registry. */
export const SKILL_SOURCE_STRING = 'dsh-workflow-boost'
/** Provider name registered through skills.registerProvider(). */
export const SKILL_PROVIDER_NAME = 'dsh-workflow-boost'
/** Bundled-provider rank; runtime skills (250) outrank bundled entries (600). */
export const SKILL_RANK = 600
/** Catalog descriptions are model-facing one-liners. */
export const MAX_DESCRIPTION_CHARS = 200
/** Skill bodies are loaded on demand; keep them focused. */
export const MIN_INSTRUCTIONS_CHARS = 300
export const MAX_INSTRUCTIONS_CHARS = 1200

/** Mirror of the row defaults; lib/defaults.js stays the single source of truth. */
export const DEFAULT_SETTINGS = DEFAULTS.skillPack

/** Tools each skill body must mention, so "load skill" actually teaches the call. */
export const REQUIRED_TOOLS = Object.freeze({
  'workflow-boost-verify': Object.freeze(['goal_verify', 'update_goal']),
  'workflow-boost-cache': Object.freeze(['cache_report']),
  'workflow-boost-checkpoint': Object.freeze(['checkpoint_list', 'checkpoint_diff', 'checkpoint_restore']),
  'workflow-boost-repomap': Object.freeze(['repo_map']),
})

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * The four built-in skills. Each description states WHEN to use the skill;
 * each body is a short markdown playbook for the plugin tool it teaches.
 * Instructions stay between MIN/MAX_INSTRUCTIONS_CHARS (validated below).
 */
export const SKILL_CATALOG = deepFreeze([
  {
    name: 'workflow-boost-verify',
    description: 'Use before marking a tracked goal complete or when the user asks whether the work is really done: runs goal_verify and requires fresh, reproducible evidence before update_goal complete is accepted.',
    instructions: [
      '# Verify a goal before claiming completion',
      '',
      'Use this skill when the current work is tracked as a goal and you are about to call update_goal with complete, or when the user asks whether the work is really done.',
      '',
      '1. Call the plugin tool goal_verify. It runs the configured verification checks (goalGate.verifyCommands / verifyCommand) and returns structured evidence: per-check name, exit code, duration and an output summary.',
      '2. Read the report. Required checks must all pass; a missing command, a timeout or a crash is a failure, not a pass.',
      '3. Only a fresh PASS authorizes update_goal with complete. Git/file evidence, when configured, is supporting evidence only; tests remain the primary source of truth.',
      '4. On failure: fix the cause, run goal_verify again, and never claim success from memory. After blockAfterFailures failures the plugin records a blocker instead of passing.',
      '5. If no verification command is configured, do not fake evidence: report the missing verifyCommand to the user and only switch goalGate.mode to advisory with their consent.',
      '',
      'Never mark a goal complete because the code "looks right"; the gate exists to require reproducible evidence.',
    ].join('\n'),
    source: SKILL_SOURCE,
  },
  {
    name: 'workflow-boost-cache',
    description: 'Use when the user asks about tokens, cost or cache hit rate, or after a compaction/model switch: cache_report separates expected rebuilds from unexpected prompt-cache misses.',
    instructions: [
      '# Audit prompt-cache health with cache_report',
      '',
      'Use this skill when the user asks about token usage, cost or "why was this request expensive", or after a compaction, a model switch or any change that may have broken the prompt cache.',
      '',
      '1. Call cache_report with detail: "summary" for the quick health view: hit ratio, expected rebuild count and estimated cost.',
      '2. Use detail: "attribution" when the hit ratio dropped. It separates expected rebuilds (compaction, prune, model switch, session resume) from unexpected misses and lists the likely causes: dynamic system-prompt text, tool schema changes, plugin hot reload, timestamps.',
      '3. Use detail: "ledger" for the compression ledger: before/after tokens and estimated savings per compaction or prune.',
      '4. detail: "all" combines the sections; prefer a narrow detail when context is tight.',
      '5. A hit ratio below the configured healthThreshold is a signal to look for dynamic prompt content, not a reason to disable caching. Numbers are estimates; prices come from the cacheReport config.',
      '',
      'Do not call cache_report on every turn - call it when cache health or cost is actually the question.',
    ].join('\n'),
    source: SKILL_SOURCE,
  },
  {
    name: 'workflow-boost-checkpoint',
    description: 'Use when an edit went wrong or the user wants to undo/compare changes: checkpoint_list finds restore points, checkpoint_diff shows the diff and checkpoint_restore restores a point or selected paths.',
    instructions: [
      '# Inspect and restore file checkpoints',
      '',
      'Use this skill when an edit went wrong, the user asks to undo changes, or you need to compare a file before and after a risky change.',
      '',
      'The plugin snapshots touched files before write/edit/delete intents under <workspace>/.dsh/workflow-boost/checkpoints/. Tools:',
      '- checkpoint_list: lists restorable points for the session (turn/seq, file count, size, time). Call it first to find the id.',
      '- checkpoint_diff({ id, path }): bounded text diff for one file in a checkpoint (default limit 100 lines).',
      '- checkpoint_restore({ id, paths? }): restores the whole checkpoint or only selected paths. By default the tool asks the user for confirmation (autoRestore: false); never bypass that confirmation.',
      '',
      'Rules: prefer a narrow paths subset; never restore a point that is older than unrelated user work without asking; if a restore fails on Windows because a file is locked, report the exact path instead of retrying blindly. Checkpoints cover workspace files only - never .git, node_modules, dist/build/out, .dsh, files larger than 5MB or symlinks.',
    ].join('\n'),
    source: SKILL_SOURCE,
  },
  {
    name: 'workflow-boost-repomap',
    description: 'Use at the start of work in a large or unfamiliar repo, or to find where a concept is defined: repo_map renders the most important files and symbols within a token budget.',
    instructions: [
      '# Map an unfamiliar repository with repo_map',
      '',
      'Use this skill at the start of work in a large or unfamiliar codebase, before planning changes that span several files, or when you need to know where a concept is defined.',
      '',
      '1. Call repo_map with no arguments to map the session workspace under the configured token budget.',
      '2. Use focus: "<text>" to keep only files or symbols containing that text when the map is too broad (for example focus: "auth").',
      '3. Use maxTokens to grow or shrink the map (200..20000). Without conversation files the plugin already widens the budget automatically.',
      '4. Files you read or mention are ranked higher (Aider-style personalization), so read the relevant file first and call repo_map again only if the shape is unclear.',
      '5. Paths are resolved inside the workspace with realpath: ../ escapes, absolute paths outside the workspace, C:/Windows, /etc and symlink escapes are refused. Do not fight a refusal - call repo_map from the workspace root and narrow with focus instead.',
      '6. The result is a shape, not an AST: open the file with read or grep before editing. Do not call repo_map repeatedly in a row; results are cached and the disk index is incremental.',
    ].join('\n'),
    source: SKILL_SOURCE,
  },
])

/** Resolve the skillPack config section with defaults. */
export function resolveConfig(section) {
  const raw = section !== null && typeof section === 'object' ? section : {}
  const defaults = DEFAULT_SETTINGS
  return {
    enabled: raw.enabled === undefined ? defaults.enabled !== false : raw.enabled !== false,
    exposeCatalog: raw.exposeCatalog === undefined ? defaults.exposeCatalog !== false : raw.exposeCatalog !== false,
  }
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Validate a catalog against the skill-pack contract. Pure so tests can feed
 * broken catalogs; the module uses an empty result as "safe to register".
 * @param catalog - array of { name, description, instructions, source }.
 * @returns array of human-readable problems (empty means valid).
 */
export function validateCatalog(catalog = SKILL_CATALOG) {
  const problems = []
  const list = Array.isArray(catalog) ? catalog : []
  if (list.length === 0) problems.push('catalog is empty')
  const seen = new Set()
  for (const entry of list) {
    const label = entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? entry.name : '<unnamed>'
    if (entry === null || typeof entry !== 'object') {
      problems.push('catalog entry is not an object')
      continue
    }
    if (typeof entry.name !== 'string' || !SKILL_NAME_PATTERN.test(entry.name)) {
      problems.push('invalid kebab-case skill name: ' + String(entry.name))
    } else if (seen.has(entry.name)) {
      problems.push('duplicate skill name: ' + entry.name)
    } else {
      seen.add(entry.name)
    }
    if (typeof entry.description !== 'string' || entry.description.trim().length === 0) {
      problems.push('missing description: ' + label)
    } else if (entry.description.length > MAX_DESCRIPTION_CHARS) {
      problems.push('description longer than ' + MAX_DESCRIPTION_CHARS + ' chars: ' + label)
    } else if (!/\buse\b/iu.test(entry.description)) {
      problems.push('description must state when to use the skill: ' + label)
    }
    if (typeof entry.instructions !== 'string' || entry.instructions.trim().length === 0) {
      problems.push('missing instructions: ' + label)
    } else {
      const length = entry.instructions.length
      if (length < MIN_INSTRUCTIONS_CHARS) problems.push('instructions shorter than ' + MIN_INSTRUCTIONS_CHARS + ' chars: ' + label)
      if (length > MAX_INSTRUCTIONS_CHARS) problems.push('instructions longer than ' + MAX_INSTRUCTIONS_CHARS + ' chars: ' + label)
      const requiredTools = REQUIRED_TOOLS[entry.name]
      if (requiredTools !== undefined) {
        for (const tool of requiredTools) {
          if (!entry.instructions.includes(tool)) problems.push('instructions of ' + label + ' must mention ' + tool)
        }
      }
    }
    const source = entry.source
    if (source === null || typeof source !== 'object' || source.kind !== 'dsh-workflow-boost') {
      problems.push('invalid source marker: ' + label)
    }
  }
  return problems
}

/** Catalog summaries (name + description only): the model-facing index. */
export function skillSummaries(catalog = SKILL_CATALOG) {
  return (Array.isArray(catalog) ? catalog : []).map((entry) => ({ name: entry.name, description: entry.description }))
}

/** Skill names in catalog order. */
export function skillNames(catalog = SKILL_CATALOG) {
  return (Array.isArray(catalog) ? catalog : []).map((entry) => entry.name)
}

/**
 * Host candidate for one catalog entry (registerProvider list() shape).
 * @param entry - catalog entry.
 * @param providerName - provider that owns it (must equal the registered name).
 * @returns candidate object accepted by the native skill registry.
 */
export function buildProviderCandidate(entry, providerName = SKILL_PROVIDER_NAME) {
  return {
    name: entry.name,
    description: entry.description,
    source: SKILL_SOURCE_STRING,
    provider: providerName,
    rank: SKILL_RANK,
    invocation: { modelInvocable: true, userInvocable: true },
    locator: entry.name,
  }
}

/**
 * Host definition for one entry: the on-demand body the model sees after
 * loading the skill (registerProvider get() shape).
 */
export function buildSkillDefinition(entry, providerName = SKILL_PROVIDER_NAME) {
  return {
    name: entry.name,
    description: entry.description,
    content: entry.instructions,
    source: SKILL_SOURCE_STRING,
    provider: providerName,
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/** Runtime registration shape for services that only expose register(skill). */
export function buildRuntimeSkill(entry) {
  return {
    name: entry.name,
    description: entry.description,
    content: entry.instructions,
    source: SKILL_SOURCE_STRING,
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/**
 * Build the provider object for skills.registerProvider(). list() is async
 * because the host awaits provider catalogs; exposeCatalog=false keeps the
 * provider registered but returns no candidates (catalog hidden).
 * @param catalog - catalog to expose.
 * @param options - { providerName, exposeCatalog, control }.
 * @returns { name, list, get } provider object.
 */
export function createSkillProvider(catalog = SKILL_CATALOG, options = {}) {
  const providerName = typeof options.providerName === 'string' && options.providerName.length > 0
    ? options.providerName
    : SKILL_PROVIDER_NAME
  const entries = (Array.isArray(catalog) ? catalog : SKILL_CATALOG).slice()
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  return {
    name: providerName,
    async list() {
      if (options.exposeCatalog === false) return []
      return entries.map((entry) => buildProviderCandidate(entry, providerName))
    },
    async get(candidate) {
      const name = candidate !== null && typeof candidate === 'object'
        ? (typeof candidate.locator === 'string' ? candidate.locator : candidate.name)
        : candidate
      const entry = byName.get(name)
      return entry === undefined ? undefined : buildSkillDefinition(entry, providerName)
    },
  }
}
