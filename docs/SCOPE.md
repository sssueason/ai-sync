# SCOPE — 操作空间范围（我会动什么、不碰什么）

> 这篇是"权限边界说明书"。装之前读一遍，就不会有"它怎么把我别的东西改了"的疑问。

---

## 1. 五个空间，各归谁管

| 空间 | 位置 | 谁写它 | 你能手改吗 |
|---|---|---|---|
| **引擎** | `<引擎根>`（默认 `~/.ai-sync/engine`） | 你 clone / 更新 | 可以，但会被下次更新覆盖；改行为请改配置 |
| **实例配置** | `<实例根>/sync/instance.json`、`machines/<机器>.json` | 你（或控制台向导） | **可以**（这是给你改的） |
| **机器标识** | `<实例根>/sync/local.machine` | 你 | 可以；不进 git |
| **状态** | `<实例根>/sync/state/`（本地明细）+ `sync-state` 分支 | 引擎 | **不要**（会被覆盖，且不影响同步正确性） |
| **数据（µ1）** | `machines/<机器>.json` 里 `mu1[].path` 指向的 git 仓 | 你 + git | 可以 |
| **数据（µ2）** | 你的权威目录（`mu2.sets[].source`） / 云端镜像（`dest`） | 权威目录：你；镜像：引擎 | 权威目录**可以**；**镜像不要** |

## 2. 引擎会写哪些文件（穷举）

| 路径 | 什么时候 | 备注 |
|---|---|---|
| `<实例>/sync/state/local-<机器>.json` | 每次 converge | 本机明细（哪些目标变了、分类结果、待办） |
| `<实例>/sync/state/.last-state-<机器>.json`、`.last-state-push-<机器>` | 每次状态推送 | 用于"内容没变就别推"的判断 |
| `<实例>/sync/logs/*.log` | 每次 tick / daily | 每轮一行摘要 |
| `<实例>/sync/state/.console.pid` | 起控制台时 | 供 `--stop` |
| 各 live 配置（见下） | 每次渲染（**只在内容变了时**） | 渲染器产物 |
| 云端镜像目录 | 每天 22:00（或你设的间隔） | seed；只新增/更新，不删你镜像里的其它文件 |
| `sync-state` 分支的 `state/<机器>.json` | 每次状态推送 | 跨机器可见的那一行 |

## 3. "live 配置"具体是哪些（也就是引擎会重写的文件）

这些路径由适配器（`adapters/producers/*.json` + `owners/*.json`）声明，**不是硬编码**。默认三组：

| 来源（单一源） | 会被重写的目标 |
|---|---|
| `agents/injection-block.md` | `~/.dsh/AGENTS.md`、`~/.config/opencode/MEMORY-POINTER.md`、`~/.workbuddy/USER.md`、`<vault>/AGENTS.md` |
| `mcp/servers.json` | `~/.dsh/profiles/*/cordis.patch.yml`（**标记块内**）、`~/.config/opencode/opencode.jsonc`（**只动 `mcp` 段**）、`~/.workbuddy/mcp.json` |
| `docs/conventions.md` §1/§2 | `~/.config/opencode/CN-MIRROR.md`、`~/.config/opencode/top-expert.md`、`~/.dsh/AGENTS.md` 的对应小节 |

**重写的粒度都是"受管标记块"或"指定小节"**，块外的你自己的内容会被保留。

> ⚠️ 反过来的坑（实测）：受管块**之后**的内容被当作"用户内容"刻意保留 —— 所以别把临时笔记写在标记块后面，它会一直粘着（要从各端 live 文件里手工删）。改内容请改**单一源**。

## 4. 绝不触碰

- 任何不在上表里的文件（引擎不遍历你的磁盘去"顺手改点什么"）。
- **原始科研数据**：`.dcm` / `.gz` / `.bam` / `.tif` / `.raw` / `.fcs` —— 永不进任何同步集。
- **凭据**：`*.pem` / `*.key` / `.credentials*` / `config.local.json` —— 不进 git、不进镜像。
- `.git` 目录 —— 永不进第三方云盘。
- 云端镜像里**别人的**文件（seed 只写自己 set 的 `target` 子目录）。
- 交互式应用的进程：**永远不会**被杀（引擎不会替你重启 TUI）。

## 5. 什么时候引擎"什么都不做"

| 情况 | 行为 |
|---|---|
| 内容没变 | 渲染器打印 `0 target(s) written`；converge `changed=0`；不请求重启；日志行**不加噪声** |
| 应用没在跑 | converge 记 pending（良性），不报错；应用下次启动自然读到新配置 |
| 另一个同步进程持锁 | tick 让路：日志写 `lock=busy`，rc 仍 0（活由持锁进程干了） |
| 没有变更可分类 | 不猜、不硬编码：走适配器声明的 `manual`（通知）或 `none`（只记录） |
| 离线 | git 操作按既有 rc 报错；状态推送只 WARN（下轮重试） |

## 6. 备份与回滚

- 引擎是 git 仓：`git -C <引擎根> checkout <上一个 tag>` 即回滚引擎。
- 实例是 git 仓：配置改动都有历史。
- 数据（µ1）本来就在 git 里。
- 数据（µ2）：镜像冲突**从不删除**，败者落 `.local-<机器>-<日期>` 侧车 —— 最坏情况是多出文件，而不是丢文件。
- 卸载步骤见 `README.md` 末节。
