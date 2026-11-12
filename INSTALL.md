# 安装 dsh-workflow-boost 1.0.0

本插件是纯宿主插件：没有客户端代码，只需放进 profile 并在 `cordis.patch.yml` 里 insert 一行。

## 前置

- 已安装 DeepSeek Harness 0.2.x（源码基线 0.2.2-rc.1）。
- 能找到 DSH 的 profile 目录（桌面版在 `<DSH_HOME>/profiles/<profile>`，`DSH_HOME` 默认 `~/.dsh`）。
- 用 DSH 自带 runtime 的 node/pnpm（桌面版位于 `<DSH 安装目录>/resources/runtime/`）。

## 步骤

1. 把插件目录放到 profile 下：

```
<profile 目录>/plugins/dsh-workflow-boost/
  index.js  lib/  test/  package.json  cordis.patch.yml  README.md  INSTALL.md
```

2. 在 profile 的 `package.json` 增加依赖：

```json
{
  "dependencies": {
    "dsh-workflow-boost": "file:./plugins/dsh-workflow-boost"
  }
}
```

3. 在 profile 目录安装：

```powershell
cd <profile 目录>
node <DSH 安装目录>/resources/runtime/bin/node.cmd <DSH 安装目录>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs install
```

4. 编辑 profile 的 `cordis.patch.yml`，末尾追加：

```yaml
- insert:
    - id: workflow-boost
      name: dsh-workflow-boost
```

如果文件当前内容是 `[]`，请整体替换为上面的块（`[]` 后直接追加列表项不是合法 YAML）。

5. 生效：
- profile 的 `patchReload: live`：保存即 HMR 重载。
- profile 的 `patchReload: startup`：重启 DSH。

## 自检

在插件目录执行（不需要 @deepseek-ai 包已安装）：

```bash
node test/check.mjs
node test/unit.mjs
node test/verify-harness.mjs
```

启动后插件日志会打印 `dsh-workflow-boost: ready v1.0.0 modules=...`；日志里出现 `module <id> disabled` 表示该模块被配置关闭或无法挂载。

## 回滚

从 `cordis.patch.yml` 删除 `workflow-boost` 条目即可；彻底移除时再删除插件目录和 `package.json` 里的 `file:` 依赖，重新 install。
