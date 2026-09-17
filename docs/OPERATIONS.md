# OPERATIONS — 日常操作路径

> 目标：**日常零命令行**。你只需要看图标；菜单里能点的事都点得到；这篇解释每个东西在做什么。

---

## 1. 一天里会发生什么（你不用做任何事）

| 时间 | 发生什么 |
|---|---|
| 每 5 分钟（可调） | **tick**：拉取 → 渲染 live 配置 → **收敛**（判断谁该重载）→ 推送 → 写状态 |
| 每天 22:00（可调） | **镜像**：本机权威目录 ↔ 云端镜像（seed / tree-sync） |
| 每天 1–2 次 | **重活**：本地巡检 + 清单对账 + 镜像全量 + 心跳（`daily.ps1`） |
| 有变更时 | 需要热更的应用自己热更；需要重启的由应用**空闲后**自动重启；交互式应用只提示 |
| 状态跳变时 | 图标角标变色 + 一条系统通知（**只在跳变时弹一次**，不会每 5 分钟骚扰） |

## 2. 图标（Windows 托盘 / macOS 菜单栏）

**图标本体 = 循环双箭头**；**右下角角标 = 状态**：

| 角标 | 含义 | 你要做什么 |
|---|---|---|
| 🟢 绿实心圆 | 正常，无待办 | 什么都不用做 |
| 🟡 黄三角 | 有提醒（多为"某应用配置已更新，需重启"） | 悬浮看文案；重启对应应用即可 |
| 🔴 红方块叉 | 有失败（tick 过期 / git 冲突 / guard 异常…） | 悬浮看第一行，或打开「简报…」看断言表 |

**鼠标悬浮**给你两行（这是刻意压缩过的，一眼能看完）：

```
同步正常 · 21:26（0 分钟前）
待办 2：重启 opencode 生效；重启 WorkBuddy 生效
```

> Windows 11 提示：如果任务栏上看不到图标，它多半在「显示隐藏的图标」︿ 里（系统对新图标默认如此）。
> 一条命令固定到可见区：pwsh -File <引擎根>\apps\sync-tray\windows\sync-tray.ps1 -PromoteIcon（之后重启一次 explorer.exe）。

**右键菜单**：

| 项 | 做什么 |
|---|---|
| 简报… | 弹窗：完整断言表 + 全队 + 待办（等同于 `sync-status.mjs` 的输出） |
| 立即同步 | 立刻跑一轮 tick（不等下一个 5 分钟） |
| 打开日志 | 打开最近一天的 tick 日志 |
| 随登录自启 | 勾选/取消托盘自身的登录自启 |
| 退出 | 关掉图标（后台同步**照常**，调度在系统任务里） |

macOS 的菜单栏版（`apps/sync-tray/macos/`）能力面相同；「打开控制台」在托盘/菜单栏里指向下面第 3 节。

## 3. 控制台（想在浏览器里看/改的时候）

```bash
node <引擎根>/apps/sync-console/server.mjs      # 默认 http://127.0.0.1:7788/
node <引擎根>/apps/sync-console/server.mjs --stop
```

| 页 | 用途 |
|---|---|
| 状态 | 断言表（每条都写"期望/实际"）+ 全队表 + 待办 |
| 首次向导 | 同步空间选择与校验、节拍、自启开关（**保存即生效**，调度会自动重排） |
| 设置 | 适配器开关（哪些应用参与收敛）+ 配置只读预览 |
| 初始化对齐 | 「计划（只报告）」/「执行对齐」两个按钮 + 输出 |
| 日志 | tick / daily / converge 最近 120 行 |

> 默认只绑 `127.0.0.1`。要局域网访问必须显式改 `console.bind` **并**设 `console.token`。

## 4. 三种异常的处理路径

### A. 图标变黄：某应用"配置已更新，需重启"

**含义**：共享源改了，本机 live 配置已经重渲染好，但那个应用只在启动时读配置 —— 引擎**不会**替你杀它。

**处置**：重启那个应用（opencode / WorkBuddy / Obsidian…）。下次 tick 后待办自动消失。

> dsh 不需要你做什么：`cordis.patch.yml`（MCP 配置）由 HMR 热重载，指令文件逐请求生效；只有**插件集合**变更才需要重启，而那由 restart-guard **空闲后自己重启**（见下条）。

### B. 图标变红：tick 过期 / git 冲突

1. 悬浮看第一行，或「简报…」看断言表里哪条 `FAIL`；
2. 打开日志（菜单「打开日志」）看最后几行的 `rc=`；
3. 对照 `TROUBLESHOOTING.md` 的症状表。

### C. 手动 pull 时看到 `exit 4` / `[SKIP] 另一个同步进程正持锁`

**这不是故障**：5 分钟 tick 正在同一批仓库上干活，你的手动 pull 让路了。重跑一次或等下一轮即可。
（设计如此：两个进程同时 fetch/pull 会把 `.git/FETCH_HEAD` 写乱，git 会报 `Cannot rebase onto multiple branches`。）

## 5. 状态是怎么"跨机器互见"的

- 每台机器把自己的一行状态（最后同步时间 / 各仓 ahead-behind / 待办 / rc）推到实例仓的 **`sync-state` 分支**（`state/<机器>.json`）。
- 你的托盘/控制台读这个分支 ⇒ 在任何一台机器上都能看到**全队**。
- 为什么用独立分支：如果写进 `master`，每台机器每天会产生上百个"纯状态"提交，把真正的改动淹没。分支上只有状态文件，主线历史保持干净。
- 看原始数据：
  ```bash
  git ls-tree -r --name-only origin/sync-state
  git show origin/sync-state:state/<机器>.json
  ```

## 6. 什么时候需要命令行

只有这些场景（其余都在图标/控制台里）：

| 场景 | 命令 |
|---|---|
| 换同步空间根目录 | 改 `machines/<机器>.json` → `sync-align.mjs --plan` → `--apply` |
| 新机器接进来 | `SETUP.md` §A（一次性） |
| 排查 | `sync-status.mjs`（表）/ `sync-schedule.mjs`（调度对不对） |
| 暂停自动同步 | Windows `schtasks /change /tn ai-sync-tick /disable`；macOS `launchctl bootout gui/$(id -u)/ai-sync.tick` |

## 7. 不要做的事

- **不要手改 live 配置**（`~/.dsh/profiles/*/cordis.patch.yml`、`~/.config/opencode/*`、`~/.workbuddy/*`）：它们是渲染器产物，下次渲染就被覆盖（或在受管块之外残留 —— 渲染器会刻意保留块外内容，反而更难清）。
- **不要在同步空间（云端镜像）里编辑文件**，见 `SYNC-SPACE.md` §3。
- **不要在两台机器上同时编辑同一份二进制文档**（docx/pptx/pdf）：没有合并语义，只会产生侧车副本。
- **不要手改 `sync/state/` 下的文件**：那是状态，不是配置。

## 8. 静默运行与可调节拍

两件事要一起看，因为它们互相牵制：**节拍是可调的**，而**每一次自动运行都不许冒窗口**。

### 8.1 可调项（都在 `sync/instance.json`；控制台「设置」页可直接改，保存即生效）

| 想要什么 | 配置键 | 生效方式 |
|---|---|---|
| tick 间隔 | `tick.intervalMinutes`（默认 5） | 保存后立即重排平台调度；就算当时没生效，下一轮 tick 开头也会自愈 |
| 跨端状态推送间隔 | `tick.statePushMinutes`（默认 15） | 同上 |
| 云盘镜像时刻 | `cloudMirror.schedule.times`（默认 `["22:00"]`，可写多个）/ `{mode:"interval",intervalMinutes:N}` | 保存后立即重排 `ai-sync-mirror` 任务 |
| 关掉镜像 | `cloudMirror.enabled=false` | 保存时**主动卸下**镜像任务（不留一个不会触发的空任务） |

**适配器（producers/owners）没有各自的节拍**：它们每轮 tick 各跑一次，`tick.intervalMinutes` 就是它们唯一的节拍源。
（"每个适配器单独定时"是另一个特性，目前不存在 —— 别去 descriptor 里找 `interval`，找不到。）

对账入口：`node tools/sync-schedule.mjs`（只报告）/ `--reconcile`（重排）。`sync-status.mjs` 断言
「tick 间隔与配置一致」+「镜像调度与配置一致」，不一致即 FAIL。`cloudMirror.schedule` 曾经是**死旋钮**
（改了没有任何东西消费它 —— 实际跑的是手搓的计划任务），这两条断言就是防它复发。

### 8.2 为什么没有黑框（Windows）

计划任务的动作**不是** `node.exe` / `pwsh.exe`，而是：

```
wscript.exe "<引擎根>\install\run-hidden.vbs" "<实例根>\sync\state\tick-cmd.txt"
```

- 交互式身份下直接跑控制台程序会**创建控制台窗口**（每 5 分钟闪一次）。`wscript` 没有控制台，
  `run-hidden.vbs` 再用 `WshShell.Run(cmd, 0, True)`（SW_HIDE）拉真正的子进程 ⇒ 屏幕上不出现。
- **退出码保真**：`WScript.Quit <子进程码>` 原样交回任务计划 ⇒「上次运行结果」不是恒 0。
  恒 0 就是假绿：tick 失败时巡检也看不出来。
- 命令**写在文件里**而不是任务参数里：任务参数是原始字符串，内嵌引号会被 WSH 的命令行解析合并。
  命令文件必须是 **UTF-16LE 带 BOM**：按 ANSI 读会把非 ASCII 路径（用户名含中文）变成问号；
  缺 BOM 会被读成空。写入由 `install.mjs` 的 `writeCmdFile()` 一处负责。
- `run-hidden.vbs` 必须**保持纯 ASCII**：wscript 按 ANSI 代码页读 `.vbs`，中文注释会被误解码并吞掉换行，
  把下面的代码整段注释掉（实测退出码 7 → 3，静默失效）。`sync-doctor.mjs` 有断言 + 真跑一次探测。

Windows 仍会给该子进程分配一个**隐藏的** conhost（`可见=False`）。2026-09-17 用 `EnumWindows`
枚举 `ConsoleWindowClass` 做对照实测：旧写法新窗口 `可见=True`（会闪），新写法 `可见=False`（不闪）。

### 8.3 凭据提示在隐藏窗口下 = 隐形挂死

tick 的 git 调用固定带 `GIT_TERMINAL_PROMPT=0` 与 `GCM_INTERACTIVE=Never`：隐藏窗口里没人看得见
凭据提示，一旦弹出就是挂到超时为止。宁可快速失败（错误进 stderr / 日志行），也不要隐形等待。
