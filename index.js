/**
 * dsh-workflow-boost 1.3.0 — one plugin that fuses the workflow mechanics other
 * coding agents do better into DeepSeek Harness, without breaking its KV-cache
 * discipline.
 *
 * Modules (each independently switchable):
 *   microcompact    — clear stale tool results before a full summary (ZCode)
 *   focusChain      — periodically re-inject the live task list (Cline)
 *   duplicateGuard  — stuck-loop detector: identical calls plus error/alternation/monologue loops (OpenHands)
 *   turnGuard       — turn budget and turn-close gate (Claude Code Stop hook)
 *   editCheck       — run configured lint/typecheck/test after edits (Aider)
 *   checkpoint      — snapshot touched files and offer restore (Cline/Gemini/Claude Code)
 *   goalGate        — make goal completion carry real evidence (ZCode Goal Mode)
 *   repoMap         — whole-repository outline under a token budget (Aider)
 *   cacheReport     — cache-hit attribution, compression ledger, cost per session (ZCode/OpenCode/Claude Code)
 *   memoryLint      — audit AGENTS.md/CLAUDE.md files and record memory proposals (Claude Code/Cline)
 *   hookBus         — run user-configured lifecycle hooks (Claude Code compatible events, off by default)
 *   handoffNotes    — structured notes before compaction, injected afterwards (Anthropic context engineering)
 *   skillPack       — register the plugin built-in skills through the native skills service
 *   reviewGate      — deterministic pre-completion diff review (secrets/conflicts/debug prints/large deletions)
 *   stylePack       — response styles + self-presentation, static prompt section plus /boost-* commands and persistence
 */
import { Config } from './lib/config.js'
import { PLUGIN_VERSION } from './lib/defaults.js'
import { createSessionState } from './lib/session-state.js'
import { install as installMicrocompact } from './lib/microcompact.js'
import { install as installFocusChain } from './lib/focus-chain.js'
import { install as installDuplicateGuard } from './lib/duplicate-guard.js'
import { install as installTurnGuard } from './lib/turn-guard.js'
import { install as installEditCheck } from './lib/edit-check.js'
import { install as installCheckpoint } from './lib/checkpoint.js'
import { install as installGoalGate } from './lib/goal-gate.js'
import { install as installRepoMap } from './lib/repo-map.js'
import { install as installCacheReport } from './lib/cache-report.js'
import { install as installMemoryLint } from './lib/memory-lint.js'
import { install as installHookBus } from './lib/hook-bus.js'
import { install as installHandoffNotes } from './lib/handoff-notes.js'
import { install as installSkillPack } from './lib/skill-pack.js'
import { install as installReviewGate } from './lib/review-gate.js'
import { install as installStylePack } from './lib/style-pack.js'
import { createLiveConfig, refreshLiveConfig } from './lib/live-config.js'
import { createModuleLifecycle } from './lib/module-lifecycle.js'

export const name = 'dsh-workflow-boost'
export { Config }

/** Only tools is hard-required: every other service is looked up lazily so a
 *  partial profile still loads this plugin and simply disables what it cannot do. */
export const inject = ['tools']

const MODULES = [
  ['microcompact', installMicrocompact],
  ['focusChain', installFocusChain],
  ['duplicateGuard', installDuplicateGuard],
  ['turnGuard', installTurnGuard],
  ['editCheck', installEditCheck],
  ['checkpoint', installCheckpoint],
  ['goalGate', installGoalGate],
  ['repoMap', installRepoMap],
  ['cacheReport', installCacheReport],
  ['memoryLint', installMemoryLint],
  ['hookBus', installHookBus],
  ['handoffNotes', installHandoffNotes],
  ['skillPack', installSkillPack],
  ['reviewGate', installReviewGate],
  ['stylePack', installStylePack],
]

export const VERSION = PLUGIN_VERSION

/**
 * Mount the plugin.
 * @param ctx - Cordis plugin context.
 * @param config - validated row configuration.
 */
export function apply(ctx, config) {
  // One plain, mutable snapshot shared by all modules. Volatile field
  // references in `config` are dereferenced here and refreshed in place on
  // loader/volatile-update, so settings-page edits reach every module without
  // touching their read sites.
  const live = createLiveConfig(config)
  const state = {
    ctx,
    startedAt: Date.now(),
    version: VERSION,
    sessions: new Map(),
    sessionState: undefined,
    log(level, message) {
      try {
        const line = 'dsh-workflow-boost: ' + message
        if (level === 'warn') ctx.logger?.warn?.(line)
        else if (level === 'debug') ctx.logger?.debug?.(line)
        else ctx.logger?.info?.(line)
      } catch {
        /* a logging failure must never affect the agent */
      }
    },
  }
  try {
    state.sessionState = createSessionState(ctx, state)
  } catch (error) {
    state.log('warn', 'session-state unavailable: ' + describe(error))
  }

  // Register the refresh listener BEFORE installing modules. stylePack also
  // listens to loader/volatile-update and reads the shared snapshot inside its
  // handler; Cordis dispatches emit listeners in registration order, so the
  // snapshot must be refreshed first or that handler would see stale values.
  let lifecycle
  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('loader/volatile-update', () => {
        try {
          refreshLiveConfig(live, config)
          lifecycle?.reconcile()
        } catch (error) {
          state.log('warn', 'live config refresh failed: ' + describe(error))
        }
      })
    }
  } catch (error) {
    state.log('warn', 'could not listen for volatile config updates: ' + describe(error))
  }

  const installers = new Map(MODULES)
  lifecycle = createModuleLifecycle(MODULES.map(([id]) => id), {
    install: (id) => installers.get(id)?.(ctx, live, state),
    wanted: (id) => live.enabled !== false && live[id]?.enabled !== false,
    log: (level, message) => state.log(level, message),
  })

  ctx.effect(() => () => {
    lifecycle.disposeAll()
    try { state.sessionState?.dispose?.() } catch { /* ignore */ }
  }, 'dsh-workflow-boost: modules')

  const enabled = lifecycle.enabled
  const info = enabled.length > 0 ? 'ready v' + VERSION + ' modules=' + enabled.join(',') : 'ready with no active module'
  state.log('info', info)
}

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
