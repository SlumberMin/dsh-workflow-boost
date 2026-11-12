/**
 * dsh-workflow-boost 1.2.0 — one plugin that fuses the workflow mechanics other
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

  const enabled = []
  for (const [id, install] of MODULES) {
    const section = config?.[id]
    if (config?.enabled === false || section?.enabled === false) {
      state.log('info', 'module ' + id + ' disabled by config')
      continue
    }
    try {
      ctx.effect(() => {
        let disposer
        try {
          disposer = install(ctx, config ?? {}, state)
        } catch (error) {
          state.log('warn', 'module ' + id + ' failed to install: ' + describe(error))
          return
        }
        return () => {
          try {
            disposer?.()
          } catch (error) {
            state.log('warn', 'module ' + id + ' cleanup failed: ' + describe(error))
          }
        }
      }, 'dsh-workflow-boost: ' + id)
      enabled.push(id)
    } catch (error) {
      state.log('warn', 'module ' + id + ' could not be mounted: ' + describe(error))
    }
  }

  ctx.effect(() => () => {
    try { state.sessionState?.dispose?.() } catch { /* ignore */ }
  }, 'dsh-workflow-boost: session-state')

  const info = enabled.length > 0 ? 'ready v' + VERSION + ' modules=' + enabled.join(',') : 'ready with no active module'
  state.log('info', info)
}

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
