import z from '@deepseek-ai/schemastery'
import { DEFAULTS } from './defaults.js'

const d = DEFAULTS

/**
 * Row configuration. Every section accepts `enabled: false`; a section's own
 * defaults are applied so an empty row config enables the whole toolkit.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Master switch for the whole plugin.'),

  microcompact: z.object({
    enabled: z.boolean().default(d.microcompact.enabled).description('Clear stale tool results under context pressure (ZCode).'),
    triggerRatio: z.number().min(0.3).max(0.95).default(d.microcompact.triggerRatio)
      .description('Context-pressure ratio (0-1) at which stale tool results are cleared.'),
    triggerTokens: z.number().min(0).default(d.microcompact.triggerTokens)
      .description('Absolute pressure-token ceiling; 0 derives it from triggerRatio.'),
    minRemainingTokens: z.number().min(0).default(d.microcompact.minRemainingTokens)
      .description('Trigger when remaining window tokens fall below this; 0 = auto (20k above a 200k window, else 20%).'),
    keepRecentGroups: z.number().min(0).max(50).default(d.microcompact.keepRecentGroups)
      .description('Keep this many newest assistant-turn groups (assistant message plus its tool results) intact.'),
    keepRecentToolResults: z.number().min(0).max(50).optional()
      .description('DEPRECATED: use keepRecentGroups. Kept only for backward-compatible config loading.'),
    keepFirstEvents: z.number().min(0).max(20).default(d.microcompact.keepFirstEvents)
      .description('Never clear the first N tool results (protects the original task context).'),
    minCharsPerResult: z.number().min(64).default(d.microcompact.minCharsPerResult)
      .description('Only clear tool results longer than this many characters.'),
    maxResultsPerPass: z.number().min(1).max(200).default(d.microcompact.maxResultsPerPass)
      .description('Upper bound of tool results cleared in one pass.'),
    idleMinutes: z.number().min(0).default(d.microcompact.idleMinutes)
      .description('Also microcompact after this many idle minutes (0 disables idle triggering).'),
    placeholder: z.string().default(d.microcompact.placeholder)
      .description('Replacement text for cleared tool results.'),
  }).description('Microcompact module.'),

  focusChain: z.object({
    enabled: z.boolean().default(d.focusChain.enabled).description('Periodically re-inject the live task list in history (Cline).'),
    everySteps: z.number().min(2).max(100).default(d.focusChain.everySteps)
      .description('Inject the task list at most once every this many tool calls.'),
    minItems: z.number().min(1).default(d.focusChain.minItems).description('Only inject when the task list has at least this many items.'),
    includeProgress: z.boolean().default(d.focusChain.includeProgress).description('Render n/m progress in the reminder.'),
    includeNextAction: z.boolean().default(d.focusChain.includeNextAction).description('Render the next actionable item explicitly.'),
    injectAfterCompaction: z.boolean().default(d.focusChain.injectAfterCompaction)
      .description('Always inject the task list after a compaction checkpoint.'),
    maxItems: z.number().min(1).max(200).default(d.focusChain.maxItems).description('Maximum items rendered in one snapshot.'),
    maxItemChars: z.number().min(40).max(1000).default(d.focusChain.maxItemChars).description('Maximum characters of one todo content rendered.'),
  }).description('Focus chain module.'),

  duplicateGuard: z.object({
    enabled: z.boolean().default(d.duplicateGuard.enabled).description('Detect and interrupt stuck loops (OpenHands Stuck Detector; the OpenCode rule is the first pattern).'),
    remindAt: z.number().min(2).max(20).default(d.duplicateGuard.remindAt)
      .description('Inject an advisory reminder after this many identical calls.'),
    blockAt: z.number().min(2).max(50).default(d.duplicateGuard.blockAt)
      .description('Deny the next identical call after this many identical calls.'),
    identicalObservationAt: z.number().min(2).max(20).default(d.duplicateGuard.identicalObservationAt)
      .description('Same action producing the same observation this many times is a loop.'),
    consecutiveErrorsAt: z.number().min(2).max(20).default(d.duplicateGuard.consecutiveErrorsAt)
      .description('Same action failing this many times in a row is a loop.'),
    monologueAt: z.number().min(2).max(20).default(d.duplicateGuard.monologueAt)
      .description('This many assistant messages without tool use triggers an advisory.'),
    alternatingAt: z.number().min(3).max(30).default(d.duplicateGuard.alternatingAt)
      .description('A-B-A-B alternation reaching this many rounds is a loop.'),
    contextOverflowAt: z.number().min(2).max(10).default(d.duplicateGuard.contextOverflowAt)
      .description('Repeated context-overflow failures before advising a compaction or a human.'),
    whitelist: z.array(z.string()).default([]).description('Tool names that are never treated as a loop.'),
  }).description('Stuck detector module (upgraded duplicate guard).'),

  turnGuard: z.object({
    enabled: z.boolean().default(d.turnGuard.enabled).description('Bound runaway turns and gate turn close (Claude Code Stop hook).'),
    mode: z.union([z.const('advisory'), z.const('enforce')]).default(d.turnGuard.mode)
      .description('advisory: warn and steer once; enforce: also cancel after the steer.'),
    maxSteps: z.number().min(1).max(5000).default(d.turnGuard.maxSteps).description('Maximum steps in one turn.'),
    maxMinutes: z.number().min(0).max(1440).default(d.turnGuard.maxMinutes).description('Maximum wall-clock minutes in one turn (0 disables).'),
    maxTokens: z.number().min(0).default(d.turnGuard.maxTokens).description('Maximum tokens in one turn (0 disables).'),
    warnAt: z.number().min(0.1).max(0.95).default(d.turnGuard.warnAt).description('Budget fraction at which one advisory is injected.'),
    hardStop: z.boolean().default(d.turnGuard.hardStop).description('Cancel the turn after the final steer.'),
    finishChecks: z.boolean().default(d.turnGuard.finishChecks)
      .description('Before a turn closes, steer once when an active goal lacks fresh evidence or a todo is in progress.'),
  }).description('Turn guard module.'),

  editCheck: z.object({
    enabled: z.boolean().default(d.editCheck.enabled).description('Run configured lint/typecheck/test commands after edits (Aider reflexion).'),
    checks: z.array(z.object({
      name: z.string().min(1).description('Human-readable check name.'),
      when: z.array(z.string()).default([]).description('Glob patterns relative to the workspace; empty means always.'),
      command: z.string().min(1).description('Shell command; the model never supplies it.'),
      timeoutMs: z.number().min(1000).max(1800000).default(d.editCheck.timeoutMs).description('Per-run timeout.'),
      maxOutputTokens: z.number().min(100).max(8000).default(d.editCheck.maxOutputTokens).description('Output budget fed back to the model.'),
    })).default([]).description('Checks executed after a successful write/edit call.'),
    debounceMs: z.number().min(0).max(600000).default(d.editCheck.debounceMs).description('Minimum interval between runs of the same check.'),
    maxPerTurn: z.number().min(1).max(20).default(d.editCheck.maxPerTurn).description('Maximum checks per turn.'),
    maxReflections: z.number().min(1).max(10).default(d.editCheck.maxReflections).description('Maximum failure feedback messages before advising a human.'),
    maxOutputTokens: z.number().min(100).max(8000).default(d.editCheck.maxOutputTokens).description('Default output budget per check.'),
    reportSuccess: z.boolean().default(d.editCheck.reportSuccess).description('Inject a one-line success notice (default off to save tokens).'),
  }).description('Edit check module.'),

  checkpoint: z.object({
    enabled: z.boolean().default(d.checkpoint.enabled).description('Snapshot touched files before writes and offer restore (Cline/Gemini/Claude Code checkpoints).'),
    maxPerTurn: z.number().min(1).max(200).default(d.checkpoint.maxPerTurn).description('Maximum snapshot points per turn.'),
    keepTurns: z.number().min(1).max(200).default(d.checkpoint.keepTurns).description('Number of recent turns kept on disk.'),
    maxTotalBytes: z.number().min(1048576).default(d.checkpoint.maxTotalBytes).description('Disk budget for snapshots (LRU eviction).'),
    maxFileBytes: z.number().min(1024).default(d.checkpoint.maxFileBytes).description('Files larger than this are not snapshotted.'),
    autoRestore: z.boolean().default(d.checkpoint.autoRestore).description('Allow checkpoint_restore without asking the user.'),
  }).description('File checkpoint module.'),

  goalGate: z.object({
    enabled: z.boolean().default(d.goalGate.enabled).description('Require real evidence before a goal is marked complete (ZCode Goal Mode).'),
    mode: z.union([z.const('advisory'), z.const('enforce')]).default(d.goalGate.mode)
      .description('advisory: prompt + goal_verify tool only; enforce: also deny completion without fresh evidence.'),
    verifyCommand: z.string().default(d.goalGate.verifyCommand)
      .description('Legacy single verification command. Empty with no verifyCommands means evidence-only and is rejected in enforce mode.'),
    verifyCommands: z.array(z.object({
      name: z.string().min(1).description('Check name shown in the report.'),
      command: z.string().min(1).description('Shell command; trusted configuration, never model input.'),
      required: z.boolean().default(true).description('A failing required check blocks completion.'),
      timeoutMs: z.number().min(1000).max(1800000).default(d.goalGate.verifyTimeoutMs).description('Per-command timeout.'),
    })).default([]).description('Ordered verification checks; the first configured form wins.'),
    verifyTimeoutMs: z.number().min(1000).max(1800000).default(d.goalGate.verifyTimeoutMs)
      .description('Timeout for the legacy verification command.'),
    requireGitEvidence: z.boolean().default(d.goalGate.requireGitEvidence)
      .description('Include git status/diff evidence in goal_verify reports.'),
    freshWithinMs: z.number().min(60000).default(d.goalGate.freshWithinMs)
      .description('A passing goal_verify is fresh enough for a completion attempt for this long.'),
    blockAfterFailures: z.number().min(1).max(20).default(d.goalGate.blockAfterFailures)
      .description('Record a durable goal blocker after this many failed verification passes.'),
    useGoalsService: z.boolean().default(d.goalGate.useGoalsService)
      .description('Use the native ctx.goals service for blockers when available.'),
    requireReview: z.boolean().default(d.goalGate.requireReview)
      .description('Require a fresh review_diff pass before completion (uses the review gate evidence).'),
  }).description('Goal evidence gate module.'),

  repoMap: z.object({
    enabled: z.boolean().default(d.repoMap.enabled).description('Whole-repository outline tool (Aider).'),
    maxFiles: z.number().min(10).max(20000).default(d.repoMap.maxFiles)
      .description('Maximum files scanned when building the map.'),
    maxFileBytes: z.number().min(1024).max(2000000).default(d.repoMap.maxFileBytes)
      .description('Skip files larger than this many bytes.'),
    tokenBudget: z.number().min(200).max(20000).default(d.repoMap.tokenBudget)
      .description('Approximate token budget for the rendered map.'),
    cacheTtlMs: z.number().min(0).max(3600000).default(d.repoMap.cacheTtlMs)
      .description('Cache lifetime of one map result per root and options.'),
    timeBudgetMs: z.number().min(1000).max(120000).default(d.repoMap.timeBudgetMs)
      .description('Wall-clock budget for one repo_map call; partial results are returned when exceeded.'),
    incremental: z.boolean().default(d.repoMap.incremental)
      .description('Reuse a symbol index on disk and re-scan only changed files.'),
    personalize: z.boolean().default(d.repoMap.personalize)
      .description('Rank files mentioned in the current conversation higher (Aider personalization).'),
  }).description('Repo map module.'),

  memoryLint: z.object({
    enabled: z.boolean().default(d.memoryLint.enabled).description('Audit AGENTS.md/CLAUDE.md instruction files and record memory proposals (Claude Code / Cline).'),
    maxFiles: z.number().min(1).max(200).default(d.memoryLint.maxFiles).description('Maximum instruction files audited per call.'),
    maxFileBytes: z.number().min(1024).max(2000000).default(d.memoryLint.maxFileBytes).description('Skip instruction files larger than this.'),
    maxProposals: z.number().min(1).max(1000).default(d.memoryLint.maxProposals).description('Retained memory proposals.'),
    injectPending: z.boolean().default(d.memoryLint.injectPending).description('Inject a one-time notice when proposals are pending.'),
  }).description('Memory lint module.'),

  hookBus: z.object({
    enabled: z.boolean().default(d.hookBus.enabled).description('Run user-configured lifecycle hook commands (Claude Code compatible events). Off by default.'),
    timeoutMs: z.number().min(500).max(120000).default(d.hookBus.timeoutMs).description('Default per-hook timeout.'),
    hooks: z.array(z.object({
      name: z.string().min(1).description('Hook label used in logs.'),
      event: z.union([
        z.const('PreToolUse'), z.const('PostToolUse'), z.const('Stop'),
        z.const('PreCompact'), z.const('UserPromptSubmit'), z.const('SessionStart'),
      ]).description('Lifecycle event to hook.'),
      matcher: z.string().default('').description('Regular expression matched against the tool name (PreToolUse/PostToolUse only).'),
      command: z.string().min(1).description('Trusted shell command; the model never supplies it.'),
      timeoutMs: z.number().min(500).max(120000).optional().description('Per-hook timeout override.'),
    })).default([]).description('Hook definitions.'),
  }).description('Hook bus module.'),

  handoffNotes: z.object({
    enabled: z.boolean().default(d.handoffNotes.enabled).description('Write structured notes before compaction and inject them afterwards (Anthropic structured note-taking).'),
    minPressureRatio: z.number().min(0.3).max(0.95).default(d.handoffNotes.minPressureRatio).description('Pressure ratio above which notes are refreshed.'),
    maxNoteChars: z.number().min(200).max(20000).default(d.handoffNotes.maxNoteChars).description('Maximum rendered note characters.'),
    refreshEveryTools: z.number().min(1).max(200).default(d.handoffNotes.refreshEveryTools).description('Refresh the note at most once every this many tool calls.'),
    injectAfterCompaction: z.boolean().default(d.handoffNotes.injectAfterCompaction).description('Inject the notes as a notice after a compaction checkpoint.'),
  }).description('Handoff notes module.'),

  skillPack: z.object({
    enabled: z.boolean().default(d.skillPack.enabled).description('Register the plugin built-in skills through the native skills service when available.'),
    exposeCatalog: z.boolean().default(d.skillPack.exposeCatalog).description('Expose the built-in catalog entries (name + description only).'),
  }).description('Built-in skills module.'),

  reviewGate: z.object({
    enabled: z.boolean().default(d.reviewGate.enabled).description('Deterministic pre-completion diff review tool (secrets, conflict markers, debug prints, large deletions).'),
    maxDiffChars: z.number().min(1000).max(60000).default(d.reviewGate.maxDiffChars).description('Maximum diff characters analysed and rendered.'),
    checks: z.object({
      secrets: z.boolean().default(true).description('Flag secret-looking additions.'),
      conflictMarkers: z.boolean().default(true).description('Flag unresolved merge conflict markers.'),
      debugPrints: z.boolean().default(true).description('Flag debug prints and breakpoints added to source.'),
      largeDeletion: z.boolean().default(true).description('Flag unusually large deletions.'),
    }).description('Deterministic checks.'),
  }).description('Review gate module.'),

  cacheReport: z.object({
    enabled: z.boolean().default(d.cacheReport.enabled).description('Cache-hit ratio, miss attribution and cost ledger (ZCode/OpenCode/Claude Code).'),
    detail: z.union([z.const('summary'), z.const('attribution'), z.const('ledger'), z.const('all')])
      .default(d.cacheReport.detail).description('Default detail level for cache_report.'),
    healthThreshold: z.number().min(0).max(100).default(d.cacheReport.healthThreshold)
      .description('Cache hit ratio percentage below which a warning block is rendered.'),
    inputPricePerMillion: z.number().min(0).default(d.cacheReport.inputPricePerMillion)
      .description('Uncached input price per 1M tokens for the cost estimate.'),
    cacheReadPricePerMillion: z.number().min(0).default(d.cacheReport.cacheReadPricePerMillion)
      .description('Cache-read price per 1M tokens for the cost estimate.'),
    outputPricePerMillion: z.number().min(0).default(d.cacheReport.outputPricePerMillion)
      .description('Output price per 1M tokens for the cost estimate.'),
  }).description('Cache report module.'),
})
