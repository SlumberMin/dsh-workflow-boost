# Changelog

All notable changes to **dsh-workflow-boost** are documented here.
The format loosely follows Keep a Changelog; versions use SemVer.

## [1.3.1] - 2026-11-17

### Fixed
- **Settings page stayed empty on 1.3.0.** The Host settings service projects `.volatile()` fields, but the shipped DSH Web client renders only pages registered by a client companion — it does not auto-render third-party plugin config forms. 1.3.0 shipped the Host half only, so there was no slot to render into.
- Added `client.js` (browser half) plus `dsh.client` and `exports["./client"]` in `package.json`:
  - `settings.section` (order 15): a **Workflow Boost** page in the Settings dialog navigation;
  - `plugins.row.config`: the configuration card on the Plugins page, matching the official plugin pattern.
- The page edits the live row through `ctx.configForms.get('workflow-boost')` and atomic `form.mutate(...)` writes with revision checks, then `loader/volatile-update` makes every module see the new values without a restart. Controls: master switch, response style, self-presentation, custom rules, per-module switches, system-prompt injection and persistence.
- `test/cases/client-settings.mjs`: 5 cases evaluating `client.js` in a VM with a fake ModuleLoader (module id, injected services, row id, both slot registrations, manifest contract).
- Unit suite 280 -> 285; checked sources 64 files; wiring harness 62 assertions.

## [1.3.0] - 2026-11-16

### Added
- **Every module is now editable from the plugin settings page.** The host projects only `.volatile()` fields into its schema-derived form (`packages/settings/settings/src/schema.ts` :: `volatileForm`). 1.2.0 declared a single object-level volatile section (`stylePack`), leaving the other 14 modules invisible. Now every direct scalar field of all 15 sections plus the master `enabled` switch is marked field-level volatile — the same pattern used by the official `bash-local` and `web-deepseek-api` plugins. The form exposes 16 top-level entries / 100 editable fields.
- `lib/live-config.js`: dereferences the resulting stable `.get()` references into one plain snapshot shared by all modules, and refreshes it IN PLACE on `loader/volatile-update` (nested section objects keep their identity, so modules that cached `config.<section>` still see live values). No module read site changed.
- `lib/module-lifecycle.js`: reconciles the mounted module set when a settings-page edit flips an `enabled` switch; parameter-only edits never remount. Reconciliation is idempotent.
- `test/cases/live-config.mjs`: 7 cases for snapshot, in-place refresh, plain-config fallback, lifecycle reconciliation and listener ordering.

### Fixed
- The `loader/volatile-update` refresh listener is now registered BEFORE any module is installed. `stylePack` listens to the same emit event and reads the shared snapshot in its handler; Cordis dispatches in registration order, so registering the refresh afterwards made it re-register its prompt section with stale values.
- `test/verify-config.mjs` is now a real settings-form gate: it mirrors the host's `volatileForm()` projection under the real schemastery package, asserts all 15 sections / >= 80 editable fields, confirms field-level `.get()` references, and checks that `live-config.js` flattens and refreshes them. Verified on 3.19.0 and 3.18.2.

### Changed
- Four array-of-object fields stay ordinary config and are still edited from the profile YAML: `duplicateGuard.whitelist`, `editCheck.checks`, `goalGate.verifyCommands`, `hookBus.hooks`. The generated form cannot reliably add/remove nested rows.
- Unit suite 273 -> 280 assertions; checked sources 59 -> 62 files; wiring harness unchanged at 62; package 70 -> 73 files.

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
