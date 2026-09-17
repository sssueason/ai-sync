# MIGRATE — 把**已有机器**从"实例内的 tick"切到"引擎 tick"

> 适用：机器上已经在跑同步（`sync-lite.ps1` / `mac-sync.sh tick`），想把调度换成引擎自带的
> `tools/sync-tick.mjs`（跨平台、单实现）。**全新机器请看 [`SETUP.md`](SETUP.md)，不用这篇。**
>
> 这篇的原则：**先并存、后切换、留回退**。任何时候都能一条命令退回原状。

---

## 0. 迁移前后有什么区别

| | 迁移前 | 迁移后 |
|---|---|---|
| 谁跑 tick | 实例仓里的 `sync/sync-lite.ps1`（Windows）/ `sync/mac/mac-sync.sh tick`（macOS） | 引擎仓的 `tools/sync-tick.mjs`（node，两平台同一份） |
| 调度 | 你原来的任务名 / launchd label | 任务/Agent 名由 `instance.json` 的 `tick.taskName` / `tick.launchdLabel` 决定（默认 `ai-sync-tick` / `ai-sync.tick`） |
| 渲染清单、收敛、状态 | 调实例里的 `tools/*.mjs` | 调引擎里的同一批工具 |
| 实例仓里的引擎副本 | 必需 | **暂时仍然保留**（见 §5） |

**注意**：迁移**不动**你的数据、不动实例仓的工作树、不动重活（`daily.ps1` / 22:00 那趟）。

## 1. 装引擎（不碰任何现有调度）

```bash
git clone --depth 1 https://gh-proxy.com/https://github.com/sssueason/ai-sync.git ~/.ai-sync/engine
node ~/.ai-sync/engine/tools/sync-status.mjs --instance <实例根>
```

**期望**：最后是 `=== 同步状态 · <机器> · … 判定 OK ===`，退出码 `0`。
（这一步只读；若这里就报 FAIL，先解决它再继续——不要带着问题切调度。）

## 2. 让调度指向引擎

先用**报告模式**看现状（只读，退出码 `2` = 未安装/不一致）：

```bash
node ~/.ai-sync/engine/install/install.mjs --instance <实例根>
```

再注册（Windows 建计划任务 / macOS 写 plist 并 bootstrap）：

```bash
node ~/.ai-sync/engine/install/install.mjs --instance <实例根> --register
```

**期望**：`[OK] register 成功（ai-sync-tick）`。

## 3. 停用旧调度（**保留，不删**）

| 平台 | 命令 |
|---|---|
| Windows | `schtasks /change /tn <旧任务名> /disable` |
| macOS | `launchctl bootout gui/$(id -u)/<旧 label>`（plist 留着不删） |

## 4. 验证（三条都要看）

```bash
node ~/.ai-sync/engine/tools/sync-status.mjs --instance <实例根>   # 期望 exit 0
```

1. **调度真的在跑**：Windows `Get-ScheduledTaskInfo -TaskName ai-sync-tick`（`LastTaskResult=0`，`NextRunTime` 在滚动）；macOS `launchctl print gui/$(id -u)/ai-sync.tick | head -20`
2. **日志是引擎写的**：`<实例根>/sync/logs/tick-<机器>.log` 末尾出现新的一行（格式与旧 tick 一致，含 `rc=0`）
3. **连续两轮都正常**：等 5–10 分钟，看日志多出两行且都 `rc=0`

## 5. 现在还**不要**做的事

- **不要删实例仓里的引擎副本**（`tools/sync-*.mjs`、`mcp/render/`、`adapters/`、`apps/`）。
  同群的其它机器可能还在用它们；等**全群都迁移完**再统一删，否则会直接打断别人的同步。
- 不要让新旧两套调度**同时启用**：它们各自持自己的锁（OS 互斥体 vs 文件锁），同时跑仍有
  `.git/FETCH_HEAD` 竞态风险。**旧的一定要停用**。

## 6. 回退（任何一步之后都能退）

| 平台 | 命令 |
|---|---|
| Windows | `node ~/.ai-sync/engine/install/install.mjs --instance <实例根> --unregister` → `schtasks /change /tn <旧任务名> /enable` |
| macOS | 同上 `--unregister` → `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<旧 label>.plist` |

再把 `instance.json` 的 `tick.taskName` / `tick.launchdLabel` 改回原来的值（如果你改过）。

> 建议动手前先导出旧定义备查：
> Windows `schtasks /query /tn <旧任务名> /xml ONE > old-task.xml`；
> macOS `cp ~/Library/LaunchAgents/<旧 label>.plist ~/<旧 label>.plist.bak`。

## 7. 迁移后仍由**实例**负责的部分（别误删）

`sync/sync.ps1`（手动 pull/push/doctor）、`sync/daily.ps1`（重活）、`sync/tree-sync.ps1`、`sync/seed-mu2.ps1`、
`sync/write-heartbeat.ps1`、`sync/mac/mac-sync.sh`、`docs/`、`machines/*.json`、`mcp/servers.json`、
`agents/injection-block.md`、`docs/conventions.md` —— 这些是**实例侧**的东西，引擎仓里没有，也不该有。
