# dsh-workflow-boost

[![release](https://img.shields.io/github/v/release/SlumberMin/dsh-workflow-boost?label=release)](https://github.com/SlumberMin/dsh-workflow-boost/releases) [![license](https://img.shields.io/github/license/SlumberMin/dsh-workflow-boost)](LICENSE) [![dsh](https://img.shields.io/badge/dsh-0.2.2--rc.1-1d4ed8)](https://github.com/deepseek-ai/deepseek-harness)

> 把 ZCode / Cline / OpenCode / Aider / Claude Code / OpenHands / SWE-agent 在**工作方式**上真正赢过 DeepSeek Harness 的机制，
> 做成一个可安装、可开关、不破坏 DSH KV 缓存纪律的插件。

版本：**1.1.0** · 适配 DSH 0.2.x（源码基线 0.2.2-rc.1）· 纯宿主插件（无客户端代码）

---

## 1. 它解决什么问题

1.0.0 的主题是**从单点机制到闭环**：回合安全（预算/卡死/回滚）、编辑质量（改完立刻检查）、成本与状态（缓存归因/压缩账本/跨 resume 投影）。

1.1.0 补齐**工作流外环**：记忆治理、可配置 hook 总线、压缩前后结构化交接、内置技能、完成前确定性复核。

| 模块 | 借鉴来源 | 对手的机制 | 本插件的实现 | 对前缀缓存的影响 |
|---|---|---|---|---|
| `microcompact` | ZCode | 全量总结前先清旧工具结果 | 压力/剩余预算双阈值触发，保留首条任务上下文与最新 5 组工具结果，用 `surfaceOp replace` 换占位文本，写 `compaction/prune` 影子计价 | 从第一个被清位置起才失效，越老越先清 |
| `focusChain` | Cline | Focus Chain：周期重注入活清单 + n/m 进度 | 每 N 次工具调用注入 user 角色快照（含 Next 行/验收标准），压缩后强制注入一次 | 只在历史尾部追加 |
| `duplicateGuard` | OpenHands / OpenCode | Stuck Detector 五模式 + 连续 3 次相同调用干预 | 先提醒（3）后拦截（5）：同动作同观察、连续错误、A/B 乒乓、独白、压缩死循环；恢复类工具豁免 | 不改提示词 |
| `turnGuard` | Claude Code Stop hook / OpenHands hooks | 回合预算 + 停止前质量检查 | `agent/turn-stopping` 前检查步数/耗时/token 预算，超限 steer 收尾；有 goal 无证据或 todo 未完成时 steer 一次 | 尾部追加一次，可关 |
| `editCheck` | Aider / SWE-agent | 编辑后 lint/test 反射（max_reflections=3） | 写类工具成功后按 glob 跑配置命令，失败输出精简后回灌，最多 3 次 | 尾部追加，默认关闭 |
| `checkpoint` | Cline / Gemini CLI / Claude Code | shadow-git 文件快照与回滚 | 写前备份被改文件，`checkpoint_list/diff/restore` 工具，恢复默认需确认 | 不影响 prompt |
| `goalGate` | ZCode Goal Mode | 目标完成要真实证据 | `goal_verify` 跑多验证命令 + git 证据；enforce 下无新鲜证据拦截 complete；失败多次写原生 goal blocker | 静态段只加一次 |
| `repoMap` | Aider | Repo Map：全仓形状喂给模型 | 正则抽定义 + 个性化引用排序 + 增量索引，token 预算内输出；工作区 realpath 约束 | 模型主动调用才产生 |
| `cacheReport` | Claude Code / Manus / ZCode | 缓存命中率与成本可见 | expected/unexpected miss 归因、压缩账本、contextBreakdown 分项、成本估算 | 只读 |
| `memoryLint` | Claude Code / Cline | AGENTS.md/CLAUDE.md 记忆冲突与腐化 | 只读审计（重复标题/冲突规则/超长/坏链接/TODO）+ `memory_propose` 提案文件，绝不自动改指令 | 只读 |
| `hookBus` | Claude Code hooks（跨家收敛） | 用户配置的生命周期 hook | 六个事件（Pre/PostToolUse、Stop、PreCompact、UserPromptSubmit、SessionStart）映射为 allow/deny/addContext/steer；默认关 | 尾部追加，默认零注入 |
| `handoffNotes` | Anthropic context engineering | 压缩前结构化笔记、压缩后回注 | 压力高时把 goal/todo/最近活动写成 `.dsh` 笔记，压缩后以 notice 注入一次 | 尾部追加一次 |
| `skillPack` | Claude Code / OpenHands skills | 内置技能按需加载 | 通过原生 skills 服务注册 4 个技能（verify/cache/checkpoint/repomap），目录只占少量 token | catalog 固定，正文按需 |
| `reviewGate` | OpenHands Critic / Claude Code review | 完成前复核 diff | `review_diff` 确定性检查：密钥/冲突标记/调试残留/异常大删除 + 人工复核清单；可配 `goalGate.requireReview` | 只读 |

**明确不做的**：重写原生 pruner/compaction、rulesRouter（原生 `dsh-agent-instructions` 已覆盖）、每步动态工具集/系统提示词、并行子代理编排、pre-execute 改写参数。

---

## 2. 安装

### 方式 A：从 GitHub 直接安装（推荐）

插件已发布到 GitHub（`SlumberMin/dsh-workflow-boost`），Release 上带可直装的 tgz：

```powershell
dsh plugin --profile <profile> add https://github.com/SlumberMin/dsh-workflow-boost/releases/download/v1.1.0/dsh-workflow-boost-1.1.0.tgz
```

也可以直接从 Git 源安装：

```powershell
dsh plugin --profile <profile> add github:SlumberMin/dsh-workflow-boost
```

桌面版：打开 `Settings → Plugins`（或 Plugins 页）的安装入口，把上面 **tgz URL** 或 `github:SlumberMin/dsh-workflow-boost` 粘进去即可；装好重启 DSH 生效。

> `<profile>` 换成你的 profile 名（桌面版一般是 `desktop`，普通 `dsh web` 是 `web`）。
> 首次安装建议加一段安全配置（见 §3 配置）：`goalGate.mode: advisory`（配置好 `verifyCommands` 后再切 `enforce`）、`editCheck.enabled: false`、`hookBus.enabled: false`。

### 方式 B：手动放入 profile

把 `dsh-workflow-boost/` 目录放到目标 profile 的 `plugins/` 下（或任意路径并用 `file:` 依赖引用）。profile 的 `package.json` 增加：

```json
{
  "dependencies": {
    "dsh-workflow-boost": "file:./plugins/dsh-workflow-boost"
  }
}
```

在 profile 目录用 DSH 自带 runtime 的 pnpm 安装（桌面版路径形如 `<DSH 安装目录>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`，node 用 `<DSH 安装目录>/resources/runtime/bin/node.cmd`）：

```powershell
cd <profile 目录>
node <DSH runtime pnpm.mjs 路径> install
```

### 启用插件

profile 的 `cordis.patch.yml` 末尾追加（若文件当前只有 `[]`，请整体替换为下面的块）：

```yaml
- insert:
    - id: workflow-boost
      name: dsh-workflow-boost
```

profile 的 `patchReload: live` 时 HMR 自动重载；`startup` 时重启 DSH 生效。

---

## 3. 配置（全部可选）

```yaml
- insert:
    - id: workflow-boost
      name: dsh-workflow-boost
      config:
        enabled: true
        microcompact:
          enabled: true
          triggerRatio: 0.72
          triggerTokens: 0            # 绝对压力 token 上限，0=按比例
          minRemainingTokens: 0       # 0=自动：>200k 留 20k，<=200k 留 20%
          keepRecentGroups: 5
          keepFirstEvents: 2
          minCharsPerResult: 1600
          maxResultsPerPass: 24
          idleMinutes: 60
          placeholder: '[Old tool result content cleared]'
        focusChain:
          enabled: true
          everySteps: 6
          minItems: 1
          includeProgress: true
          includeNextAction: true
          injectAfterCompaction: true
          maxItems: 40
        duplicateGuard:
          enabled: true
          remindAt: 3
          blockAt: 5
          identicalObservationAt: 4
          consecutiveErrorsAt: 3
          monologueAt: 3
          alternatingAt: 6
          whitelist: []
        turnGuard:
          enabled: true
          mode: advisory             # advisory | enforce
          maxSteps: 150
          maxMinutes: 60
          maxTokens: 0
          warnAt: 0.8
          hardStop: false
          finishChecks: true
        editCheck:
          enabled: false             # 默认关闭；开启后每步可能跑命令
          checks:
            - name: tsc
              when: ['**/*.ts', '**/*.tsx']
              command: 'npx tsc --noEmit -p .'
              timeoutMs: 120000
          debounceMs: 15000
          maxPerTurn: 3
          maxReflections: 3
        checkpoint:
          enabled: true
          maxPerTurn: 30
          keepTurns: 20
          maxTotalBytes: 536870912
          maxFileBytes: 5242880
          autoRestore: false
        goalGate:
          enabled: true
          mode: enforce
          verifyCommand: ''          # 空且无 verifyCommands：goal_verify 不再 PASS，enforce 下拒绝启动
          verifyCommands: []         # [{name, command, required, timeoutMs}]
          verifyTimeoutMs: 600000
          requireGitEvidence: true
          freshWithinMs: 1800000
          blockAfterFailures: 3
          useGoalsService: true
          requireReview: false      # true 时完成前必须有新鲜 review_diff
        repoMap:
          enabled: true
          maxFiles: 2500
          maxFileBytes: 262144
          tokenBudget: 1400
          cacheTtlMs: 60000
          timeBudgetMs: 20000
          incremental: true
          personalize: true
        cacheReport:
          enabled: true
          detail: summary            # summary | attribution | ledger | all
          healthThreshold: 90
          inputPricePerMillion: 0.28
          cacheReadPricePerMillion: 0.028
          outputPricePerMillion: 0.42
        memoryLint:
          enabled: true
          maxFiles: 40
          maxFileBytes: 262144
          maxProposals: 100
          injectPending: true
        hookBus:
          enabled: false             # 默认关闭；开启后执行配置的 hook 命令
          timeoutMs: 10000
          hooks: []
          # - name: no-console
          #   event: PreToolUse
          #   matcher: '^bash
```

每个 section 都可单独 `enabled: false`；插件总开关 `config.enabled: false`。

---

## 4. 每个模块怎么用

### microcompact（上下文卫生）
- 触发：每个 agent step 前；压力比 ≥ `triggerRatio` 或剩余窗口 ≤ `minRemainingTokens`（自动口径）或空闲 ≥ `idleMinutes`。
- 动作：从最旧处开始，保留首 `keepFirstEvents` 条、最新 `keepRecentGroups` 组与错误/图片/过短结果；单次最多 `maxResultsPerPass` 条；预计节省 < 256 token 时整体回滚。
- 安全：检测到未闭合 `compaction/start` 时跳过；替换事件带 `sourceEventSeqs`，原文仍在只追加日志可回放。

### focusChain（长任务防漂移）
- 每 `everySteps` 次工具调用把 todo 清单渲染成 user 角色 notice 注入历史；压缩后强制注入一次；同一内容 hash 不重复注入。
- 清单为空不注入；`Next:` 行指出下一项可执行任务。

### duplicateGuard（Stuck Detector）
- 五类模式（阈值全部可配）：同动作同观察 ≥4、同动作连续错误 ≥3、连续 assistant 独白 ≥3、A/B 交替 ≥6、连续压缩失败 ≥2。
- 双阶段：`remindAt` 次先注入提醒，`blockAt` 次后 pre-execute 拒绝下一次相同调用；恢复/报告类工具永远豁免。

### turnGuard（回合护栏）
- 预算：`maxSteps` / `maxMinutes` / `maxTokens`；`warnAt` 处注入一次提醒；超限在 `agent/turn-stopping` 里 steer 一次收尾，`hardStop` 时再 cancel。
- 收尾门禁：有活跃 goal 但本回合无新鲜 `goal_verify` 证据、或 todo 有 in_progress 时 steer 一次（每回合最多一次）。

### editCheck（编辑后验证）
- 写类工具成功后，按 `checks[].when` glob 匹配文件 → 执行 `command`；失败输出 head/tail + 首条错误，≤`maxOutputTokens` 回灌；最多 `maxReflections` 次。
- `debounceMs` 去抖、`maxPerTurn` 限流、超时取消；默认关闭。

### checkpoint（文件快照）
- 写/编辑/删除前把将被改文件备份到 `<workspace>/.dsh/workflow-boost/checkpoints/`，工具：`checkpoint_list` / `checkpoint_diff` / `checkpoint_restore`；恢复默认需用户确认（`autoRestore: false`）。
- 跳过 `.git` / `node_modules` / `dist` / 大文件 / 符号链接；保留 `keepTurns` 与 `maxTotalBytes` LRU 上限。

### goalGate（目标证据闭环）
- `goal_verify` 跑 `verifyCommands`（或旧 `verifyCommand`）并附 git 证据；enforce 模式下没有 `freshWithinMs` 内的通过证据就拒绝 complete。
- `verifyCommand` 为空且无 `verifyCommands` 时：`goal_verify` 返回 FAIL 且不写通过记录；enforce 模式加载即报错（fail-fast，插件禁用该模块并 log）。
- 失败达到 `blockAfterFailures` 次时，若原生 `ctx.goals` 可用则记录 blocker。

### repoMap（仓库形状）
- `repo_map(path?, maxTokens?, focus?)`：工作区 realpath 约束；符号抽取 + 跨文件引用排序（个性化）；`timeBudgetMs` 超时返回部分结果并注明；磁盘增量索引 + 60s 结果缓存。

### cacheReport（缓存账本）
- `cache_report(detail?)`：命中率、与配置单价的估算成本、contextBreakdown 分项、expected vs unexpected miss 归因、压缩账本（prune/summary 前后 token 与估算节省）。
- 投影不可用时明确说明「没有猜数字」。

---

### memoryLint（记忆治理）
- `memory_audit({path?})`：从项目根到 cwd 扫描 AGENTS.md/CLAUDE.md 及 local overlays，检查重复标题、冲突规则（use X vs use Y / always vs never）、超长（建议移入 skills）、失效 @import/相对链接、空文件、TODO；输出 severity/rule/file/line 与建议。
- `memory_propose({text, reason?})`：把用户纠正或新约定追加到 `.dsh/workflow-boost/memory-proposals.jsonl`（去重、截断），下次会话提示确认；**不自动修改 AGENTS.md/CLAUDE.md**。
- 只读、fail-open；有 pending 提案时每 agent 注入一次提示（可关 `injectPending`）。

### hookBus（可配置 hook 总线，默认关）
- 配置 `hooks: [{name, event, matcher?, command, timeoutMs?}]`，事件：PreToolUse / PostToolUse / Stop / PreCompact / UserPromptSubmit / SessionStart。
- 命令从配置读取（模型输入只进 JSON stdin），stdin 含 `hook_event_name/tool_name/tool_input/cwd/session_id`；exit 2 = 阻断（stderr 为理由）；exit 0 + stdout JSON 可返回 `{decision, reason, additionalContext, continue, message}`。
- 映射：PreToolUse→pre-execute deny/allow；PostToolUse→block/additionalContexts；Stop→steer（每回合一次）；PreCompact/UserPromptSubmit→下一次 post-execute 注入一次；SessionStart→side effect。
- 默认关闭；命令来自可信配置，不把模型输入拼进 shell。

### handoffNotes（压缩交接）
- 压力 ≥ `minPressureRatio` 且距上次刷新够久时，把活跃 goal、todo（含状态）、最近工具活动/错误、next actionable 写成 `.dsh/workflow-boost/handoff/<sessionId>.md`，并注入一条短 notice。
- 监听 `compaction/end`，压缩后把渲染后的笔记注入一次（`injectAfterCompaction`），避免"摘要丢状态"。
- 工具 `handoff_note({action: 'read'|'write'|'append', text?})` 可人工读写。

### skillPack（内置技能）
- 通过原生 skills 服务注册 4 个内置技能：`workflow-boost-verify`（goal_verify 流程）、`workflow-boost-cache`（cache_report detail 用法）、`workflow-boost-checkpoint`（快照/回滚流程）、`workflow-boost-repomap`（repo_map 用法）。
- 技能目录只含 name + description（按需加载正文）；skills 服务缺失时仅 log debug，不影响其它模块；`exposeCatalog: false` 可隐藏目录。

### reviewGate（完成前复核）
- `review_diff({base?, paths?, focus?})`：在会话 cwd 跑 `git status/diff`，对新增行做确定性检查——疑似密钥、冲突标记、调试残留（console.log/debugger/print）、异常大删除；输出 findings + 统计 + 人工复核清单，并记录本 agent 的 review 证据。
- `goalGate.requireReview: true` 时，complete 前必须有新鲜 review；有 blocker findings 也会被拦（按 `freshWithinMs`）。
- 这是确定性检查，不是完整代码审查；git 不可用时明确返回不可用，不猜。

## 5. 缓存纪律（为什么不破坏 DSH 最强的地方）

1. 系统提示词只增加一段**静态**文本（goalGate 完成纪律），不随状态变化。
2. focusChain / turnGuard / editCheck 的注入全部走 `additionalContexts` 或 `agent.steer`，追加在可复用前缀之后。
3. microcompact 从最旧处替换、阈值触发，只损失第一个被清位置的缓存。
4. repo_map / cache_report / goal_verify / checkpoint 是工具，模型不调用不产生 prompt 成本。
5. 插件状态用 `sessionProjections`（不可用时回退内存 fold），不写系统提示词、不依赖已弃用的 `session.eventAt()`。

---

## 6. 与 DSH 原生能力的分工

| 插件模块 | 原生对应 | 关系 |
|---|---|---|
| microcompact | compaction-tool-result-pruner + compaction-basic | 时机不同：插件是压缩前的早期粗清理 |
| duplicateGuard | repeat-tool-reminder（advisory 3/5/8） | 互补：插件升级为五模式 + 硬拦截 |
| focusChain | 无（只有 todo 工具） | 补位 |
| turnGuard | 无（官方明确无 turn budget） | 补位 |
| editCheck | 无 | 补位 |
| checkpoint | session-checkpoint-policy（仅崩溃恢复 flush） | 补位：文件级快照/回滚 |
| goalGate | goal + tool-goal + round-driver（无 evaluator） | 补位 |
| repoMap | 无 | 补位 |
| cacheReport | tokenMeter（只有数据） | 补位：归因/账本/成本 |
| memoryLint | 无（原生只加载 AGENTS.md/CLAUDE.md，无冲突审计与提案） | 补位 |
| hookBus | 无（0.2.2-rc.1 尚无 hooks 服务） | 补位（默认关，自带总线） |
| handoffNotes | compaction-basic（只做摘要） | 补位：摘要前的结构化笔记 |
| skillPack | dsh-skill（注册表） | 复用原生服务，只提供内置技能 |
| reviewGate | 无（官方 goal evaluator deferred） | 补位：确定性 diff 复核 |

---

## 7. 验证

在包根目录执行（不依赖 @deepseek-ai/* 已安装，干净 Node 即可）：

```bash
node test/check.mjs          # node --check 全部源码（55 文件）
node test/unit.mjs           # 251 项单测
node test/verify-harness.mjs # 58 项接线断言（fake 宿主，14 个模块）
```

说明：本轮在 DSH 0.2.2-rc.1 的源码/类型层面验证（本地 app.asar 提取 + 接缝审计），没有可用隔离 profile 做真实会话实测；`dsh.verifiedAgainst` 记录的是源码基线版本。真实部署后建议先跑 `node test/verify-harness.mjs`，再在会话里检查 `repo_map` / `cache_report` / `goal_verify` 三个工具。

---

## 8. 已知限制

- microcompact 只在「上下文压力已知」或空闲触发时工作；刚开会话不会误清。
- 压力比口径与原生 compaction 的 `min(W*0.8, W-O-headroom)` 口径不同，`triggerTokens` 可用于绝对口径。
- repo_map 用正则而非 tree-sitter：非常规语法可能漏定义；给的是形状不是精确 AST。
- editCheck 默认关闭；开启后每步可能跑命令，注意去抖与超时。
- checkpoint 只备份被插件观测到的写/编辑/删除；bash 改文件不在覆盖范围（可在 README 建议用 editCheck/goalGate 兜底）。
- goal_verify 的命令是**配置**而非模型输入；配置破坏性命令仍是配置者责任。
- cacheReport 的价格是配置值不是账单；token 估算是启发式。
- 适配 DSH 0.2.x 接缝；升级前先看 CHANGELOG。hooks 兼容层未包含在 1.0.0（等宿主 0.2.2-rc.2+）。
- `duplicateGuard` 的独白/交替模式在真实 loop 中触发频率较低（advisory 为主），resume 后用户边界丢失时退化为整 ring 计数（保守，不误伤）。
- `turnGuard` 的 `maxTokens` 是回合内压力增量近似（默认关闭，不含输出 token）；`hardStop` 的 steer+cancel 顺序需真机复核。
- `checkpoint` 只覆盖插件观测到的写/编辑/删除；`bash`/`pwsh` 直接改文件不在快照范围。
- `cacheReport` 账本优先读 assistant/message usage；仅有流式 attempt usage 的宿主会显示账本不可用，但 `tokenUsage` 投影仍可用。
- 未在本机真实 DSH 会话实测（无隔离 profile）；安装后请先跑 `node test/verify-harness.mjs` 与三个工具冒烟。
- `hookBus`：默认关闭；同一事件多 hook 时首个 block/continue 生效；PreCompact/UserPromptSubmit 的上下文入队后可能顺延到下一次工具调用才注入；事件 payload 形状按 0.2.2-rc.1 源码实现，未真机验证。
- `skillPack`：真实 `dsh-skill` 的 `registerProvider` 要求同步工厂返回 `{name,list,get}`；仅提供 `register` 的服务无法隐藏 catalog；provider rank 低于 runtime 技能，同名时原生优先。
- `memoryLint`：ctx.fs 返回错误时视为最终结果（不绕过沙箱降级 node:fs），workspace 之上的项目根 AGENTS.md 可能被拒；提案文件写在插件自有 `.dsh` 目录、走 node fs。
- `reviewGate`：确定性检查只覆盖常见风险模式，不能替代完整代码审查；依赖 git。
- `handoffNotes`：笔记写入插件自有 `.dsh` 目录；注入为一次性 notice，压缩后仅恢复要点而非完整历史。

---

## 9. 版本变更（1.1.0）

- 新增 5 个模块：`memoryLint`（记忆审计/提案）、`hookBus`（可配置生命周期 hook，默认关）、`handoffNotes`（压缩前结构化笔记/压缩后回注）、`skillPack`（原生 skills 内置技能）、`reviewGate`（完成前确定性 diff 复核）。
- `goalGate` 增加 `requireReview`：可选要求完成前有新鲜 review 证据；review 的 blocker findings 同样拦截。
- 验证规模：单测 159 → 251，接线断言 43 → 58；打包内容仍保证 tgz 与 zip 一致。

## 9.1 版本变更（1.0.0）

- 修复 0.1.1 全部 8 项：阈值 0.72 / MIN_SAVINGS 256 / 最新 5 组 / 短占位文本 / goalGate 空命令 fail-fast / repoMap 越界与排序性能 / verify-harness 进入包内 / 单测干净环境可跑。
- 新增 turnGuard、editCheck、checkpoint 三个模块；duplicateGuard 升级为 Stuck Detector；cacheReport 升级为 cacheAudit。
- microcompact 增加首条保护与剩余预算双阈值；focusChain 增加 Next/验收标准/压缩后存活；goalGate 支持多验证命令与原生 goal blocker；repoMap 增加个性化排序与增量索引。
- 移除 `session.eventAt()` 与 `process.cwd()` 依赖；插件状态走 `sessionProjections`（带内存回退）。
- 打包：tgz 与 zip 内容一致，`SHA256SUMS.txt` 随包更新。

---

## 10. 卸载 / 回滚

1. 从 profile 的 `cordis.patch.yml` 删除 `workflow-boost` insert（HMR 立即卸载）。
2. 彻底移除：删除插件目录与 `package.json` 的 `file:` 依赖，重新 pnpm install。
3. 模块级回滚：`config.enabled: false` 或单独 `<module>.enabled: false`，无需重启。

          #   command: 'node .dsh/hooks/no-console.mjs'
        handoffNotes:
          enabled: true
          minPressureRatio: 0.6
          maxNoteChars: 4000
          refreshEveryTools: 10
          injectAfterCompaction: true
        skillPack:
          enabled: true
          exposeCatalog: true
        reviewGate:
          enabled: true
          maxDiffChars: 12000
          checks:
            secrets: true
            conflictMarkers: true
            debugPrints: true
            largeDeletion: true
```

每个 section 都可单独 `enabled: false`；插件总开关 `config.enabled: false`。

---

## 4. 每个模块怎么用

### microcompact（上下文卫生）
- 触发：每个 agent step 前；压力比 ≥ `triggerRatio` 或剩余窗口 ≤ `minRemainingTokens`（自动口径）或空闲 ≥ `idleMinutes`。
- 动作：从最旧处开始，保留首 `keepFirstEvents` 条、最新 `keepRecentGroups` 组与错误/图片/过短结果；单次最多 `maxResultsPerPass` 条；预计节省 < 256 token 时整体回滚。
- 安全：检测到未闭合 `compaction/start` 时跳过；替换事件带 `sourceEventSeqs`，原文仍在只追加日志可回放。

### focusChain（长任务防漂移）
- 每 `everySteps` 次工具调用把 todo 清单渲染成 user 角色 notice 注入历史；压缩后强制注入一次；同一内容 hash 不重复注入。
- 清单为空不注入；`Next:` 行指出下一项可执行任务。

### duplicateGuard（Stuck Detector）
- 五类模式（阈值全部可配）：同动作同观察 ≥4、同动作连续错误 ≥3、连续 assistant 独白 ≥3、A/B 交替 ≥6、连续压缩失败 ≥2。
- 双阶段：`remindAt` 次先注入提醒，`blockAt` 次后 pre-execute 拒绝下一次相同调用；恢复/报告类工具永远豁免。

### turnGuard（回合护栏）
- 预算：`maxSteps` / `maxMinutes` / `maxTokens`；`warnAt` 处注入一次提醒；超限在 `agent/turn-stopping` 里 steer 一次收尾，`hardStop` 时再 cancel。
- 收尾门禁：有活跃 goal 但本回合无新鲜 `goal_verify` 证据、或 todo 有 in_progress 时 steer 一次（每回合最多一次）。

### editCheck（编辑后验证）
- 写类工具成功后，按 `checks[].when` glob 匹配文件 → 执行 `command`；失败输出 head/tail + 首条错误，≤`maxOutputTokens` 回灌；最多 `maxReflections` 次。
- `debounceMs` 去抖、`maxPerTurn` 限流、超时取消；默认关闭。

### checkpoint（文件快照）
- 写/编辑/删除前把将被改文件备份到 `<workspace>/.dsh/workflow-boost/checkpoints/`，工具：`checkpoint_list` / `checkpoint_diff` / `checkpoint_restore`；恢复默认需用户确认（`autoRestore: false`）。
- 跳过 `.git` / `node_modules` / `dist` / 大文件 / 符号链接；保留 `keepTurns` 与 `maxTotalBytes` LRU 上限。

### goalGate（目标证据闭环）
- `goal_verify` 跑 `verifyCommands`（或旧 `verifyCommand`）并附 git 证据；enforce 模式下没有 `freshWithinMs` 内的通过证据就拒绝 complete。
- `verifyCommand` 为空且无 `verifyCommands` 时：`goal_verify` 返回 FAIL 且不写通过记录；enforce 模式加载即报错（fail-fast，插件禁用该模块并 log）。
- 失败达到 `blockAfterFailures` 次时，若原生 `ctx.goals` 可用则记录 blocker。

### repoMap（仓库形状）
- `repo_map(path?, maxTokens?, focus?)`：工作区 realpath 约束；符号抽取 + 跨文件引用排序（个性化）；`timeBudgetMs` 超时返回部分结果并注明；磁盘增量索引 + 60s 结果缓存。

### cacheReport（缓存账本）
- `cache_report(detail?)`：命中率、与配置单价的估算成本、contextBreakdown 分项、expected vs unexpected miss 归因、压缩账本（prune/summary 前后 token 与估算节省）。
- 投影不可用时明确说明「没有猜数字」。

---

## 5. 缓存纪律（为什么不破坏 DSH 最强的地方）

1. 系统提示词只增加一段**静态**文本（goalGate 完成纪律），不随状态变化。
2. focusChain / turnGuard / editCheck 的注入全部走 `additionalContexts` 或 `agent.steer`，追加在可复用前缀之后。
3. microcompact 从最旧处替换、阈值触发，只损失第一个被清位置的缓存。
4. repo_map / cache_report / goal_verify / checkpoint 是工具，模型不调用不产生 prompt 成本。
5. 插件状态用 `sessionProjections`（不可用时回退内存 fold），不写系统提示词、不依赖已弃用的 `session.eventAt()`。

---

## 6. 与 DSH 原生能力的分工

| 插件模块 | 原生对应 | 关系 |
|---|---|---|
| microcompact | compaction-tool-result-pruner + compaction-basic | 时机不同：插件是压缩前的早期粗清理 |
| duplicateGuard | repeat-tool-reminder（advisory 3/5/8） | 互补：插件升级为五模式 + 硬拦截 |
| focusChain | 无（只有 todo 工具） | 补位 |
| turnGuard | 无（官方明确无 turn budget） | 补位 |
| editCheck | 无 | 补位 |
| checkpoint | session-checkpoint-policy（仅崩溃恢复 flush） | 补位：文件级快照/回滚 |
| goalGate | goal + tool-goal + round-driver（无 evaluator） | 补位 |
| repoMap | 无 | 补位 |
| cacheReport | tokenMeter（只有数据） | 补位：归因/账本/成本 |

---

## 7. 验证

在包根目录执行（不依赖 @deepseek-ai/* 已安装，干净 Node 即可）：

```bash
node test/check.mjs          # node --check 全部源码（40 文件）
node test/unit.mjs           # 159 项单测
node test/verify-harness.mjs # 43 项接线断言（fake 宿主）
```

说明：本轮在 DSH 0.2.2-rc.1 的源码/类型层面验证（本地 app.asar 提取 + 接缝审计），没有可用隔离 profile 做真实会话实测；`dsh.verifiedAgainst` 记录的是源码基线版本。真实部署后建议先跑 `node test/verify-harness.mjs`，再在会话里检查 `repo_map` / `cache_report` / `goal_verify` 三个工具。

---

## 8. 已知限制

- microcompact 只在「上下文压力已知」或空闲触发时工作；刚开会话不会误清。
- 压力比口径与原生 compaction 的 `min(W*0.8, W-O-headroom)` 口径不同，`triggerTokens` 可用于绝对口径。
- repo_map 用正则而非 tree-sitter：非常规语法可能漏定义；给的是形状不是精确 AST。
- editCheck 默认关闭；开启后每步可能跑命令，注意去抖与超时。
- checkpoint 只备份被插件观测到的写/编辑/删除；bash 改文件不在覆盖范围（可在 README 建议用 editCheck/goalGate 兜底）。
- goal_verify 的命令是**配置**而非模型输入；配置破坏性命令仍是配置者责任。
- cacheReport 的价格是配置值不是账单；token 估算是启发式。
- 适配 DSH 0.2.x 接缝；升级前先看 CHANGELOG。hooks 兼容层未包含在 1.0.0（等宿主 0.2.2-rc.2+）。
- `duplicateGuard` 的独白/交替模式在真实 loop 中触发频率较低（advisory 为主），resume 后用户边界丢失时退化为整 ring 计数（保守，不误伤）。
- `turnGuard` 的 `maxTokens` 是回合内压力增量近似（默认关闭，不含输出 token）；`hardStop` 的 steer+cancel 顺序需真机复核。
- `checkpoint` 只覆盖插件观测到的写/编辑/删除；`bash`/`pwsh` 直接改文件不在快照范围。
- `cacheReport` 账本优先读 assistant/message usage；仅有流式 attempt usage 的宿主会显示账本不可用，但 `tokenUsage` 投影仍可用。
- 未在本机真实 DSH 会话实测（无隔离 profile）；安装后请先跑 `node test/verify-harness.mjs` 与三个工具冒烟。

---

## 9. 版本变更（1.0.0）

- 修复 0.1.1 全部 8 项：阈值 0.72 / MIN_SAVINGS 256 / 最新 5 组 / 短占位文本 / goalGate 空命令 fail-fast / repoMap 越界与排序性能 / verify-harness 进入包内 / 单测干净环境可跑。
- 新增 turnGuard、editCheck、checkpoint 三个模块；duplicateGuard 升级为 Stuck Detector；cacheReport 升级为 cacheAudit。
- microcompact 增加首条保护与剩余预算双阈值；focusChain 增加 Next/验收标准/压缩后存活；goalGate 支持多验证命令与原生 goal blocker；repoMap 增加个性化排序与增量索引。
- 移除 `session.eventAt()` 与 `process.cwd()` 依赖；插件状态走 `sessionProjections`（带内存回退）。
- 打包：tgz 与 zip 内容一致，`SHA256SUMS.txt` 随包更新。

---

## 10. 卸载 / 回滚

1. 从 profile 的 `cordis.patch.yml` 删除 `workflow-boost` insert（HMR 立即卸载）。
2. 彻底移除：删除插件目录与 `package.json` 的 `file:` 依赖，重新 pnpm install。
3. 模块级回滚：`config.enabled: false` 或单独 `<module>.enabled: false`，无需重启。
