# Changelog

All notable changes to **dsh-workflow-boost** are documented here.
The format loosely follows Keep a Changelog; versions use SemVer.

## [1.2.0] - 2026-11-12

### Added
- `stylePack`: six response styles (default / concise / proactive / explanatory / learning / custom) and a dated identity catalog, rendered as ONE static system-prompt section; `/boost-style`, `/boost-identity`, `/boost-show`, `/boost-reset` commands plus the read-only `boost_settings` tool.
- Live settings-page editing: the `stylePack` config section is declared volatile, so edits apply without remounting the plugin. Optional persistence to `<workspace>/.dsh/workflow-boost/style.json`.
- `test/verify-config.mjs`: an optional repository-level gate that loads `lib/config.js` against the host's real `@deepseek-ai/schemastery`, instead of the fake `z` used by the clean-environment unit suite. Verified against both 3.19.0 and 3.18.2.

### Fixed
- **P0 (plugin could not load on a real host)**: `lib/config.js` used zod-only methods — `.optional()` on two fields (present since 1.0.0) and `.describe()` on three fields. Neither exists in schemastery 3.18.2 or 3.19.0, so constructing `Config` threw immediately. Optional fields now simply omit `.default()`; descriptions use `.description()`.
- **P1 (every tool call could break)**: `tools/post-execute` is a waterfall whose listener signature is `(exec, result, next)` (`packages/core/tools/src/events.ts:41`). stylePack used two parameters, so `next` received the tool result object and `await next()` threw. Now three parameters, and the test drives the real three-argument chain.
- Command registration now follows the real DSH contract: `handler({ agent, rawInput }) -> { kind: 'success' | 'error', text }`.
- `PLUGIN_VERSION` in `lib/defaults.js` was left at `1.0.0` during the 1.1.0 release, so the ready log and `VERSION` export lied; they now report 1.2.0.
- `.volatile()` is guarded: hosts on schemastery < 3.19 still load the plugin (without live settings editing) instead of throwing.
- README: repaired a truncated config YAML block, removed a duplicated 1.0.0 chapter, and documented the stylePack source cutoff and identity boundaries.

### Changed
- Unit suite 251 → 273 assertions; wiring harness 58 → 62; checked sources 55 → 59; stylePack case 22/22. Module count 14 → 15; package 61 → 70 files.

## [1.1.0] - 2026-11-12

### Added
- `memoryLint`: read-only `memory_audit` for AGENTS.md/CLAUDE.md (duplicate headings, conflicting rules, oversize files, broken imports/links, TODO markers) plus `memory_propose` proposals; never edits instruction files.
- `hookBus`: user-configured lifecycle hooks (PreToolUse, PostToolUse, Stop, PreCompact, UserPromptSubmit, SessionStart) with Claude Code style JSON stdin/stdout and exit-code semantics; off by default.
- `handoffNotes`: structured notes (goal, todos, recent activity, next action) refreshed under pressure and re-injected after compaction; `handoff_note` tool.
- `skillPack`: registers four built-in skills through the native skills service (verify / cache / checkpoint / repo-map), catalog-first loading.
- `reviewGate`: deterministic `review_diff` (secrets, conflict markers, debug prints, large deletions, stats, manual checklist) plus `goalGate.requireReview`.
- `goalGate.requireReview` option; `handoffNotes.refreshEveryTools` option.

### Changed
- Unit suite 159 → 251; wiring harness 43 → 58 assertions across 14 modules; package 46 → 61 files.

## [1.0.0] - 2026-11-12

### Added
- `turnGuard`: turn budget and turn-close gate through `agent/turn-stopping`.
- `editCheck`: post-edit lint/typecheck/test reflection (Aider style, off by default).
- `checkpoint`: file-level snapshots with `checkpoint_list` / `checkpoint_diff` / `checkpoint_restore`.
- Cache miss attribution and compression ledger in `cacheReport`.

### Fixed
- All eight 0.1.1 fix-prompt items: trigger ratio 0.72, 256-token savings floor, newest-five-groups retention, short placeholder, goal gate fail-fast on empty verification, repo map workspace boundary + indexed ranking + time budget, in-package verification harness, clean-environment unit tests.
- Removed deprecated `session.eventAt()` usage and the `process.cwd()` fallback; state now uses `sessionProjections` with an in-memory fold fallback.
- Packaging: tgz and zip identical, SHA256SUMS updated, no local paths.

## [0.1.0] - 2026-11-12

### Added
- Initial six modules: microcompact, focusChain, duplicateGuard, goalGate, repoMap, cacheReport.
