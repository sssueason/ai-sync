# ai-sync — 多端自动同步与"配置生效"引擎

**一句话**：把 N 台机器（Windows / macOS / Linux，任意 git 托管）的**共享文件**与**各家 agent 的配置**自动对齐 ——
后台按你设的节拍拉取/推送，配置改完**自动生效**（该热更的热更、该重启的空闲后重启、不能自动的明确告诉你），
托盘/菜单栏随时能看到"有没有事、最后同步时间、要我做什么"。

> 本仓是**引擎**（通用代码，不含任何个人路径/仓库/主机名）。
> 你的**实例**（机器清单、路径、令牌、集合）另存一处：默认 `<实例根>/sync/instance.json` + `sync/machines/<机器>.json`。
> 引擎升级不会动你的实例；一台机器可以只跑引擎 + 一份很小的实例配置。

---

## 它解决什么问题

| 痛点 | ai-sync 的做法 |
|---|---|
| 改了一处共享配置，另外几台要手动 pull、还要手动重启才生效 | 后台 tick（默认 5 分钟，可调）自动 pull → 渲染 → **收敛**（判断谁该重载）→ push |
| "到底同步上没有"没人知道 | 托盘/菜单栏图标 + 悬浮待办 + 全队状态表（跨机器互见，靠 `sync-state` 分支） |
| 把机器 A 的配置抄到机器 B，抄漏了、路径写错了 | **单一源 + 渲染器**：共享源改一处，各端 live 配置由渲染器生成 |
| 首次接入一台机器要敲一堆命令、还容易漏步 | 控制台**向导** + `align`（先看后做）+ 安装器（P4 落地） |
| 自动重启打断正在跑的会话 | 重启**只**走应用自己的空闲门控（dsh 的 restart-guard）；交互式应用只通知不重启 |

## 架构（三层）

```
        ┌── 引擎（本仓，公开、零个人数据）───────────────────────────┐
        │  tools/sync-converge.mjs   变更 → 分类 → 登记/通知           │
        │  tools/sync-status.mjs     全队状态 + 断言表                 │
        │  tools/sync-state.mjs      跨端状态（sync-state 分支）       │
        │  tools/sync-schedule.mjs   配置的节拍 → 平台调度（自愈重排） │
        │  tools/sync-align.mjs      初始化对齐（先看后做）            │
        │  adapters/{producers,owners}/*.json   声明式接入任意 agent   │
        │  apps/sync-tray/*          托盘/菜单栏图标                   │
        │  apps/sync-console/*       本地控制台（向导/仪表盘）         │
        └──────────────────────────────────────────────────────────────┘
                    ↑ 读实例配置、调平台调度、写状态分支
        ┌── 实例（私有，你的数据）────────────────────────────────────┐
        │  sync/instance.json        节拍 / 控制台 / 适配器开关        │
        │  sync/machines/<机器>.json 该机路径与集合（**唯一**的绝对路径）│
        │  sync/local.machine        机器标识（不入 git）              │
        │  mcp/servers.json 等       你的共享源（渲染器的输入）        │
        └──────────────────────────────────────────────────────────────┘
                    ↑ 由 tick/计划任务驱动
        ┌── 平台调度 ─────────────────────────────────────────────────┐
        │  Windows  计划任务 ai-sync-tick（每 N 分钟）                │
        │  macOS    launchd ai-sync.tick（StartInterval N*60）    │
        └──────────────────────────────────────────────────────────────┘
```

## 快速开始（三条路，按你的情况选一条）

| 你的情况 | 看哪篇 |
|---|---|
| 全新机器，从零接进来 | [`docs/SETUP.md`](docs/SETUP.md) |
| 已有机器，想加一台 | [`docs/SETUP.md`](docs/SETUP.md) §B |
| 只有一台机器，不用跨端 | [`docs/SETUP.md`](docs/SETUP.md) §C（单机本地模式） |

装完后的日常只有一句话：**看图标**。图标是循环双箭头 🔄，右下角一个状态角标（绿圆=正常 / 黄三角=提醒 / 红方块=失败），鼠标悬浮给你两行：最后同步时间 + 待办事项。详见 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)。

**同步空间（可选）** 怎么设、为什么不能在里面直接改文件： [`docs/SYNC-SPACE.md`](docs/SYNC-SPACE.md)。
**初始化对齐**（首次让两边收敛）： [`docs/ALIGN.md`](docs/ALIGN.md)。
**什么会被同步、什么绝不会**： [`docs/SCOPE.md`](docs/SCOPE.md)。
**出问题了**： [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。
**接入一个新 agent**（加一个 JSON 就行）： [`adapters/README.md`](adapters/README.md)。

## 设计原则（为什么这么写）

1. **单一源 + 渲染器**：live 配置（各 agent 的 MCP/指令文件）永远由渲染器生成，不手改。机器专属值放 `machines/<机器>.json`，不进 git。
2. **判定权归应用自己**：要不要重启由应用回答（dsh 直接转发 `restart-guard` 的 `/restart/classify`）。引擎不猜、不硬编码分类表 —— 否则就是第二套真相。
3. **假绿防线**：任何"找不到 / 跳过 / 降级 / 不可判定"分支都必须留信号（非零退出、计入 rc、或写进状态被 status 报出来）。**恒真的检查不算控制**。
4. **先看后做**：会改动本地数据的动作（镜像合并）默认只报告；`--apply` 才动手，且动手前把计划原样打印。
5. **不打断用户**：自动重启一律走空闲门控；交互式应用（TUI）只通知。
6. **零第三方依赖**：只有 node 内置模块 + 平台自带的 PowerShell/bash/launchd/计划任务。

## 平台要求

| | 要求 |
|---|---|
| Windows | PowerShell 7（`pwsh`）+ node ≥ 18 + git |
| macOS | node ≥ 18 + git +（用 .ps1 工具链时需要 `pwsh`）+ Xcode CLT（编菜单栏 App 用） |
| Linux | node ≥ 18 + git（引擎工具是 node，可跑；调度需自备 systemd/cron，本仓未提供安装器） |

## 卸载

1. 停调度：Windows `schtasks /delete /tn ai-sync-tick /f`（另有 `ai-sync-daily` / `ai-sync-daily`）；macOS `launchctl bootout gui/$(id -u)/ai-sync.tick`
2. 停 UI：托盘菜单「退出」；`node apps/sync-console/server.mjs --stop`
3. 删状态分支（可选）：`git push origin --delete sync-state`
4. 引擎目录可直接删（实例与数据都不在引擎里）。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
