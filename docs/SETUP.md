# SETUP — 安装引擎与首次同步

> 每一条都给了**期望输出**与**失败怎么办**。照做即可；不需要读源码。
> 约定：`<实例根>` = 放你配置与数据的目录（默认 `<实例根>`；全新部署建议 `~/.ai-sync/instance`）。
> `<引擎根>` = 本仓的检出目录（默认 `~/.ai-sync/engine`）。

---

> **已经在用的机器**（想换调度实现）看 [MIGRATE.md](MIGRATE.md)，不要照这篇重装。

## A. 全新机器（从零接进已有群）

### A0. 前置检查

```bash
node -v      # 期望 v18+；没有就先装 node
git --version
```

Windows 额外需要 PowerShell 7：`pwsh -v`（没有就 `winget install Microsoft.PowerShell`）。

### A1. 拿到引擎

```bash
git clone <引擎仓地址> ~/.ai-sync/engine      # 国内可用 gh-proxy 前缀，见仓库 README
cd ~/.ai-sync/engine
```

**期望**：目录里有 `tools/`、`adapters/`、`apps/`、`docs/`。

### A2. 拿到实例（你的私有配置仓）

```bash
git clone <你的实例仓地址> ~/.ai-sync/instance
cd ~/.ai-sync/instance
```

**期望**：`sync/instance.json` 与 `sync/machines/<别人的机器>.json` 在。

> 单机、没有实例仓？跳到 §C。

### A3. 声明"我是谁 + 我的路径在哪"

```bash
cp ~/.ai-sync/engine/instance.example.json sync/instance.json     # 若实例仓里还没有
cp <引擎根>/machines.example.json sync/machines/<本机id>.json   # 从模板开始（下面表格逐个字段说明）
echo "<本机id>" > sync/local.machine                              # 机器标识（不入 git）
```

| 改什么 | 说明 |
|---|---|
| `sync/machines/<本机id>.json` 的 `mu1[].path` | 本机的 git 仓路径（**唯一**该出现绝对路径的地方） |
| 同文件的 `mu2` | 云镜像（可整段删掉 = 不参与镜像） |
| `sync/instance.json` 的 `tick.intervalMinutes` | 节拍，默认 5 |
| `sync/instance.json` 的 `console.port` | 控制台端口，默认 7788 |

**期望**：`node <引擎根>/tools/sync-status.mjs` 能跑出表（第一行 `=== 同步状态 · <本机id> …`）。

### A4. 装调度（让它在后台跑）

**两个平台同一条命令**（引擎自带的安装器，是调度的唯一实现）：

```bash
node <引擎根>/install/install.mjs --instance <实例根> --register            # 用 instance.json 里的 tick.intervalMinutes
node <引擎根>/install/install.mjs --instance <实例根> --register --interval 2
```

| 平台 | 它会做什么 | 核对 |
|---|---|---|
| Windows | 建/更新计划任务 `tick.taskName`（默认 `ai-sync-tick`），动作 = `wscript "<引擎根>\install\run-hidden.vbs" "<实例根>\sync\state\tick-cmd.txt"`（命令文件里才是 `node <引擎根>/tools/sync-tick.mjs --instance <实例根>`；这样跑**不冒窗口**且退出码照传，见 `OPERATIONS.md` §8）；同时按 `cloudMirror.schedule` 建/更新 `ai-sync-mirror` | `Get-ScheduledTaskInfo -TaskName ai-sync-tick \| Select LastRunTime,LastTaskResult`（`0` = 正常） |
| macOS | 写 `~/Library/LaunchAgents/<tick.launchdLabel>.plist` 并 `launchctl bootstrap`（镜像调度暂未实现，`--register` 会以 `[--] 镜像调度：…` 明确跳过，不假装成功） | `launchctl print gui/$(id -u)/ai-sync.tick \| head -20` |

**期望**：`[OK] register 成功（ai-sync-tick）`。

> 只报告不安装：`node <引擎根>/install/install.mjs --instance <实例根>`（退出码 `2` = 未安装或间隔不一致）。
> 卸载：`--unregister`。
> 间隔改完**不用重装**：每轮 tick 开头会做一次对账（`sync-schedule.mjs --reconcile`），不一致就自动重排。

macOS / Linux 若不想用安装器，也可以手写 plist / cron 直接调：

```bash
# launchd（等价于安装器做的事）
# ProgramArguments: [<node 路径>, <引擎根>/tools/sync-tick.mjs, --instance, <实例根>]
# StartInterval: 300        RunAtLoad: true
# cron
*/5 * * * * /usr/bin/env node <引擎根>/tools/sync-tick.mjs --instance <实例根>
```



### A5. 首次同步

```bash
node <引擎根>/tools/sync-align.mjs          # 只看（默认），不改任何文件
```

**期望**：最后一行 `待处理 0 项 → 已经对齐` 或 `待处理 N 项 → 确认后跑：… --apply`。

```bash
node <引擎根>/tools/sync-align.mjs --apply  # 确认后执行
```

**期望**：`镜像执行: 待推=… 待拉=… 冲突=…` + `seed: rc=0`。
有冲突不许慌：**不删不覆盖**，败者另存为 `<名>.local-<机器>-<日期>`（见 ALIGN.md）。

### A6. 起图标（可选但推荐）

Windows：双击 `apps/sync-tray/windows/sync-tray.vbs`（无窗口常驻）；自启勾菜单里的「随登录自启」。

> ⚠️ **Windows 11 会把新出现的托盘图标默认塞进隐藏区**（「显示隐藏的图标」︿ 后面）——
> 症状是"进程在跑、状态文件在更新，但任务栏上看不见"。一条命令把它提升为「始终显示」：
> ```powershell
> pwsh -File <引擎根>\apps\sync-tray\windows\sync-tray.ps1 -PromoteIcon
> ```
> 该设置通常要重启一次 `explorer.exe` 才生效（也可以手动把它从隐藏区拖出来固定）。
> 等价的手工路径：设置 → 个性化 → 任务栏 → 其他系统托盘图标。

macOS：`bash apps/sync-tray/macos/build.sh --install`，然后打开 `SyncTray.app`。

**期望**：出现 🔄 图标，右下角绿圆；悬浮显示"同步正常 · HH:MM（N 分钟前）"。

### A7. 验收

```bash
node <引擎根>/tools/sync-status.mjs     # 退出码 0 = 全 PASS
```

再打开控制台：`node <引擎根>/apps/sync-console/server.mjs` → 浏览器 `http://127.0.0.1:7788/`。
**期望**：状态页全 PASS，全队表里能看到**其他机器**（首次接入时别人还没推状态 → 表里只有自己，属正常）。

---

## B. 已有机器，加一台

与 §A 相同的 A1–A3；差别只有两点：

1. **别人要先知道你在**：在 `sync/instance.json` 里登记机器 id（或直接在 `sync/machines/<新机id>.json` 提交进实例仓）。
2. **第一次由你先跑**：`node <引擎根>/tools/sync-align.mjs --plan` 看清之后再 `--apply`。

加完在任意一台机器上 `node <引擎根>/tools/sync-status.mjs`，全队表里应出现新机器（`sync-state` 分支，见 OPERATIONS.md）。

---

## C. 单机本地模式（没有实例仓）

不想建 git 仓、只想本机对齐：

1. 跳过 A2；把 `sync/instance.json`、`sync/machines/<本机id>.json` 直接建在**引擎根**下（`<引擎根>/sync/…`）。
2. `sync-state` 分支相关的跨端功能会自动降级：`sync-status.mjs` 会显示 `实例仓：本地`，状态只在本机可见（**不会报错，也不会假装有跨端**）。

---

## 常见失败与处置

| 症状 | 原因 | 处置 |
|---|---|---|
| `[FAIL] 未找到 node → 跳过 converge` | PATH 里没有 node（计划任务的环境与你的终端不同） | 把 node 装成系统级，或在任务里显式给它 PATH |
| `tick` 日志里 `rc=3` | converge 判定出真问题（guard 在监听但不可用 / 变更无法分类） | 日志行末尾会写明原因；对照 TROUBLESHOOTING.md |
| `sync-status` 报 `tick 间隔与配置一致 → FAIL` | 配置文件改了但调度还没重排 | 跑一次 `sync-schedule.mjs --reconcile`（或等下一轮 tick） |
| 全队表里没有别的机器 | 别人的状态还没推到 `sync-state` 分支 | 让对方跑一次 tick；首台推之前这个分支不存在是正常的 |
| `[SKIP] 另一个同步进程正持锁` | 手动 pull 与 5 分钟 tick 撞上了 | 正常现象（rc=0）；重跑或等下一轮。见 OPERATIONS.md 的"让路"一节 |
