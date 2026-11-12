# dsh-workflow-boost 1.0.0 实现契约（所有实现者必读）

本文件是并行实现的接口契约。只改你名下文件；接口/配置/测试脚手架由 Lead 维护，需要变更先发消息。

## 0. 目标与来源

- 规格：工作区根目录 `dsh-workflow-boost-0.2.0-优化提示词.md`（0.1.1 修复 + P0/P1 规格）。
- 本版本号 1.0.0；宿主 DSH 0.2.2-rc.1（源码级验证，本机没有隔离 profile 跑真实会话）。
- 设计红线：静态系统提示词段、历史尾部追加、最旧处替换、阈值触发、fail-open、不重复原生能力。

## 1. 文件归属（只改你名下文件）

| 归属 | 文件 |
|---|---|
| Lead | `index.js`、`lib/config.js`、`lib/defaults.js`、`lib/shared.js`、`lib/session-state.js`、`test/harness.mjs`、`test/unit.mjs`、`test/run-case.mjs`、`test/check.mjs`、`test/verify-harness.mjs`、README/INSTALL、打包 |
| impl-microcompact | `lib/microcompact.js`、`lib/focus-chain.js`、`lib/pure/microcompact-plan.js`、`lib/pure/focus-render.js`、`test/cases/microcompact.mjs`、`test/cases/focus-chain.mjs` |
| impl-loop | `lib/turn-guard.js`、`lib/duplicate-guard.js`、`lib/pure/turn-guard-core.js`、`lib/pure/stuck-core.js`、`test/cases/turn-guard.mjs`、`test/cases/duplicate-guard.mjs` |
| impl-quality | `lib/edit-check.js`、`lib/checkpoint.js`、`lib/pure/edit-check-core.js`、`lib/pure/checkpoint-core.js`、`test/cases/edit-check.mjs`、`test/cases/checkpoint.mjs` |
| impl-goal-cache | `lib/goal-gate.js`、`lib/cache-report.js`、`lib/pure/goal-policy.js`、`lib/pure/cache-core.js`、`test/cases/goal-gate.mjs`、`test/cases/cache-report.mjs` |
| impl-repomap | `lib/repo-map.js`、`lib/pure/repo-map-core.js`、`test/cases/repo-map.mjs`、1.1.0: `lib/skill-pack.js`、`lib/pure/skill-core.js`、`test/cases/skill-pack.mjs` |
| impl-quality (1.1.0) | `lib/memory-lint.js`、`lib/pure/memory-core.js`、`test/cases/memory-lint.mjs` |
| impl-loop (1.1.0) | `lib/hook-bus.js`、`lib/pure/hook-core.js`、`test/cases/hook-bus.mjs` |
| impl-microcompact (1.1.0) | `lib/handoff-notes.js`、`lib/pure/handoff-core.js`、`test/cases/handoff-notes.mjs` |
| impl-goal-cache (1.1.0) | `lib/review-gate.js`、`lib/pure/review-core.js`、`test/cases/review-gate.mjs`、`lib/goal-gate.js`（requireReview） |

## 2. 模块契约

每个模块导出：

```js
export function install(ctx, config, state) {
  return () => { /* disposer，可选 */ }
}
```

- `config` 是 row 配置（section 可能缺省），用 `sectionDefaults('section', config)` 取带默认值的配置（来自 `lib/defaults.js`）。
- `state` = `{ ctx, startedAt, version, sessions: Map, sessionState, log(level, message) }`。
- `state.sessionState.stateOf(session)` 返回折叠状态：`{ compactionOpen, todos, toolRing, toolCount, errorCount, monologue, turn, step, mutatedInTurn, lastMutationSeq, lastCompactionStartSeq, lastPruneSeq, lastSummarySeq, lastModelSelectionSeq, lastEndSeedSeq }`（详见 lib/session-state.js）。
- `state.sessionState.onEvent((session, event, nextState) => {})` 观察每个已提交会话事件。
- 所有回调/异步代码包 try/catch，失败只 `state.log('warn', ...)`，绝不 throw 到宿主。
- 宿主能力一律用 `loadHost('@deepseek-ai/...')` 动态 import（lib/shared.js）；禁止静态 import `/*（否则干净环境单测直接失败）。唯一例外是 `lib/config.js`（Lead 维护，仅 index 使用）。

## 3. 纯函数要求（重要）

- 决策/渲染/状态机等纯逻辑放 `lib/pure/<name>-core.js`，不得 import 任何 `/* 包；可用 node 内置模块，但优先纯字符串。
- 单元测试只 import 纯模块 + `lib/shared.js` + `lib/defaults.js` + `lib/session-state.js`，这些文件必须在干净环境可加载。
- 纯函数要能在无 Cordis、无 DOM、无宿主的 Node 里直接调用。

## 4. 可用宿主接缝（0.2.2-rc.1 源码审计结论）

事件（`ctx.on(name, listener)`）：

- `agent/pre-step`（waterfall，payload 含 agent/turn/step/messages）：必须 `next()`；可拒绝或替换本步消息。
- `agent/turn-stopping`（serial，payload 含 agent/turn/signal）：可 `agent.steer({ content: [...], source: { kind, form: 'notice' } })` 保持轮次打开。
- `tools/pre-execute`（waterfall，exec 含 name/arguments/agent）：返回 `{ kind: 'deny', reason }` 或 `{ kind: 'ask', reason }` 或 `next()`；不能改写参数。
- `tools/post-execute`（waterfall，exec/result）：返回 `{ kind: 'accept', additionalContexts: [...] }` 或 `{ kind: 'block', feedback }`。
- `tools/result`（emit，只观察）、`session/event`（emit，(session, event)）、`agent/request-error`（waterfall）、`fs/write-intent|fs/edit-intent|fs/delete-intent`（waterfall，是否生效未实测，必须 capability 探测 + fail-open）、`goal/changed`（emit）。

服务（`ctx.get(name)`，全部可能缺失）：`tools`、`systemPrompt`、`tokenMeter`、`sessionProjections`、`workingDirectory`、`goals`、`subagents`、`skills`、`commands`、`compaction`、`fs`。

禁止：`session.eventAt()/snapshotEvents()/ownEvents()`（官方 deprecated）；`process.cwd()` 兜底（用 ctx.get('workingDirectory').get(session)）；每步改系统提示词或工具集。

## 5. 测试契约

- 每个 owner 写自己的 `test/cases/<name>.mjs`：`import { test, assert, assertEqual } from '../harness.mjs'`，覆盖验收要点，至少 4 个用例。
- 单跑：`node test/run-case.mjs test/cases/<name>.mjs`
- 全量：`node test/unit.mjs`（占位文件已建，所有人完成后才会全绿）
- 语法：`node test/check.mjs`
- 测试不得依赖 @deepseek-ai/*。

## 6. 完成标准

- 你的 case 全过；`node test/check.mjs` 通过；fake ctx 抛错时 install 不 throw。
- 不留 TODO/空实现；注释写“为什么”。
- 完成后 send_message 给 lead：文件清单 + 测试数 + 未决风险（≤15 行）。
