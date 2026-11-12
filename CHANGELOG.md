# Changelog

All notable changes to **dsh-workflow-boost** are documented here.
The format loosely follows Keep a Changelog; versions use SemVer.

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
