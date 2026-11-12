/**
 * Plain runtime defaults for every module. Kept free of host imports so unit
 * tests (and the pure planning modules) can load this file in a clean
 * environment. lib/config.js is the authoritative row schema and imports these
 * values; modules resolve their own section with the same defaults.
 */
export const PLUGIN_VERSION = '1.2.0'

export const DEFAULTS = Object.freeze({
  microcompact: Object.freeze({
    enabled: true,
    triggerRatio: 0.72,
    triggerTokens: 0,
    minRemainingTokens: 0,
    keepRecentGroups: 5,
    keepFirstEvents: 2,
    minCharsPerResult: 1600,
    maxResultsPerPass: 24,
    idleMinutes: 60,
    placeholder: '[Old tool result content cleared]',
  }),
  focusChain: Object.freeze({
    enabled: true,
    everySteps: 6,
    minItems: 1,
    includeProgress: true,
    includeNextAction: true,
    injectAfterCompaction: true,
    maxItems: 40,
    maxItemChars: 160,
  }),
  duplicateGuard: Object.freeze({
    enabled: true,
    remindAt: 3,
    blockAt: 5,
    identicalObservationAt: 4,
    consecutiveErrorsAt: 3,
    monologueAt: 3,
    alternatingAt: 6,
    contextOverflowAt: 2,
    whitelist: Object.freeze([]),
  }),
  turnGuard: Object.freeze({
    enabled: true,
    mode: 'advisory',
    maxSteps: 150,
    maxMinutes: 60,
    maxTokens: 0,
    warnAt: 0.8,
    hardStop: false,
    finishChecks: true,
  }),
  editCheck: Object.freeze({
    enabled: false,
    checks: Object.freeze([]),
    timeoutMs: 120000,
    debounceMs: 15000,
    maxPerTurn: 3,
    maxReflections: 3,
    maxOutputTokens: 1200,
    reportSuccess: false,
  }),
  checkpoint: Object.freeze({
    enabled: true,
    maxPerTurn: 30,
    keepTurns: 20,
    maxTotalBytes: 536870912,
    maxFileBytes: 5242880,
    autoRestore: false,
  }),
  memoryLint: Object.freeze({
    enabled: true,
    maxFiles: 40,
    maxFileBytes: 262144,
    maxProposals: 100,
    injectPending: true,
  }),
  hookBus: Object.freeze({
    enabled: false,
    timeoutMs: 10000,
    hooks: Object.freeze([]),
  }),
  handoffNotes: Object.freeze({
    enabled: true,
    minPressureRatio: 0.6,
    maxNoteChars: 4000,
    refreshEveryTools: 10,
    injectAfterCompaction: true,
  }),
  skillPack: Object.freeze({
    enabled: true,
    exposeCatalog: true,
  }),
  reviewGate: Object.freeze({
    enabled: true,
    maxDiffChars: 12000,
    checks: Object.freeze({ secrets: true, conflictMarkers: true, debugPrints: true, largeDeletion: true }),
  }),
  goalGate: Object.freeze({
    enabled: true,
    mode: 'enforce',
    verifyCommand: '',
    verifyCommands: Object.freeze([]),
    verifyTimeoutMs: 600000,
    requireGitEvidence: true,
    freshWithinMs: 1800000,
    blockAfterFailures: 3,
    useGoalsService: true,
    requireReview: false,
  }),
  repoMap: Object.freeze({
    enabled: true,
    maxFiles: 2500,
    maxFileBytes: 262144,
    tokenBudget: 1400,
    cacheTtlMs: 60000,
    timeBudgetMs: 20000,
    incremental: true,
    personalize: true,
  }),
  stylePack: Object.freeze({
    enabled: true,
    style: 'default',
    identity: 'off',
    customStyle: '',
    customIdentity: '',
    applyToSystemPrompt: true,
    persist: true,
    identityScope: 'presentation',
    warnOnIdentity: true,
  }),
  cacheReport: Object.freeze({
    enabled: true,
    detail: 'summary',
    healthThreshold: 90,
    inputPricePerMillion: 0.28,
    cacheReadPricePerMillion: 0.028,
    outputPricePerMillion: 0.42,
  }),
})

export function sectionDefaults(id, config) {
  const base = DEFAULTS[id] ?? {}
  const raw = config?.[id]
  const merged = { ...base }
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) if (value !== undefined) merged[key] = value
  }
  if (config?.enabled === false) merged.enabled = false
  return merged
}
