# 幂等应用（apply）

> 解决的问题：`git pull` 只改文件 —— 它**不重编、不重注册、不动本机状态**。以前每次都要人挨台机器手做，
> 于是"补丁已发布"≠"已生效"。`apply` 把这类动作变成"各端自己收敛，且只做该做的"。

## 与 tick 的分工（**别登记 tick 已经在做的事**）
`sync-tick` 每轮已经在做：pull/commit/push、渲染各程序配置、日志裁剪、文本卫生门禁、一次性迁移。
⇒ 这些**不进** apply 规格 —— 重复登记等于造第二套机制，比不做更糟。

`apply` 只负责**tick 不做、且能用 `verify` 判定**的动作，例如：
- **平台调度对账**：`sync/instance.json` 里的 tick 间隔 / 镜像时刻与平台任务（计划任务 / launchd）不一致时重注册；
- **需要重编的产物**：例如 macOS 托盘（源码变了才有必要重编；Windows 侧是解释执行的 `.ps1`，无需构建）。

## 规格格式（实例 `sync/apply-spec.json`）
```json
{
  "version": 1,
  "units": [
    {
      "id": "schedule",
      "platforms": ["win32", "darwin", "linux"],
      "when":     { "files": ["sync/instance.json"] },
      "verify":   { "kind": "cmd", "argv": ["{node}", "{engine}/install/install.mjs", "--instance", "{instance}"], "okExit": [0] },
      "run":      { "argv": ["{node}", "{engine}/install/install.mjs", "--instance", "{instance}", "--register"] },
      "timeoutSec": 240,
      "reason": "调度与配置不一致时重注册；install.mjs 的报告模式在'未安装或间隔不一致'时返回非零"
    }
  ]
}
```
- 占位符：`{engine}` / `{instance}` / `{node}`；
- `verify` 支持两种：`{kind:'cmd', argv, okExit}`（退出码即判据）与
  `{kind:'artifact-newer', artifact, sources}`（产物比源码旧就算未生效）；
- `when.files` 支持具体文件或 `dir/**`（内容哈希）。

## 判定模型（Test → Set → Test）
1. `when.files` 的内容哈希没变 **且** 上次是 ok ⇒ 跳过（省掉反复调用）；
2. 否则先跑 **verify（Test）**：通过 ⇒ 记 ok（**verify 才是真值，哈希只是触发器**）；
3. 不通过 ⇒ 跑 **run（Set）**，再 verify 一次；仍不通过 ⇒ 记失败，连续 3 次 ⇒ `blocked` 停止重试。

其它语义：平台不匹配 ⇒ 跳过（不算失败）；缺文件/缺工具 ⇒ **如实报失败**（不许假装通过）；
`--dry-run` 不写状态、不执行。状态落 `sync/state/apply-<machine>.json`（机器本地，永不入 git）。

## 写一条 unit 的注意
- `run` 必须**幂等、非破坏**（删数据/跨端删除/发布一类一律走迁移的 `manual` 类，见 `MIGRATIONS.md`）；
- **没有可靠 `verify` 的动作别登记**：判不出"是否真的生效"就不是控制，只是一次盲执行
  （宁可先给那个动作补一个 check 原语）。

## 手工命令
```bash
node tools/sync-apply.mjs --list                    # 各 unit 状态
node tools/sync-apply.mjs --dry-run                 # 只打印计划
node tools/sync-apply.mjs --only <id> [--force]     # 只跑一条 / 强制重做
```

## 示例
见 [`examples/apply-spec.json`](../examples/apply-spec.json)。
