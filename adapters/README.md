# adapters/ — 声明式接入任意 agent（新增一个 agent 不用改核心代码）

> 本目录是「引擎 vs 应用」的接缝。`tools/sync-converge.mjs` 只认这里的 JSON，**不认识 dsh / opencode / WorkBuddy 这些名字**。
> 新增一个 agent = 加一个 `owners/<id>.json`（可选再加一个 `producers/<id>.json`），不改引擎。

## 两个概念

| 目录 | 回答的问题 | 谁写这些文件 |
|---|---|---|
| `producers/` | **哪些 live 配置文件是本系统渲染出来的？** 每条声明一个命令，该命令用 `--targets-json` 打印它负责的目标清单 | 引擎自带（我们自己的渲染器） |
| `owners/` | **每个目标文件属于哪个应用？它变了要不要重启、怎么重启？** | 你/接入者（新增 agent 主要改这里） |

目标对象的形状（producer 的 `--targets-json` 输出，也是 owners 里 `targets[]` 的形状）：

```json
{ "path": "<绝对路径>", "owner": "dsh|opencode|workbuddy|claudian|vault|<自定义>", "family": "agentFiles|mcp|conventions|<自定义>" }
```

## producer 声明

```json
{ "id": "mcp", "enabled": true, "cmd": ["node", "{engine}/mcp/render/render_mcp.mjs", "--targets-json"] }
```

- `{engine}`：引擎根目录（当前 = 本仓根；P4 抽仓后 = `~/.ai-sync/engine@<tag>`）。converge 负责替换。
- 命令必须：**只读**（不写盘）、成功时 stdout 恰好一行 JSON `{"renderer":"<id>","targets":[…]}`、退出码 0。
- 现有三个：`agentFiles`（四个指令文件）、`mcp`（MCP live 配置）、`conventions`（§1/§2 canonical 副本）。

## owner 声明（决定"要不要重启"）

```json
{
  "id": "opencode",
  "probe": { "any": ["~/.config/opencode", "opencode --version"] },
  "reload": { "mode": "manual", "hint": "重启 opencode 生效" }
}
```

| `reload.mode` | 语义 | converge 的行为 |
|---|---|---|
| `none` | 不需要动作（例：文档、由 agent 逐请求读取的文件） | 只记录 |
| `hot` | 应用自己 watch 该文件（写下去就生效） | 只记录 |
| `http` | 应用提供分类/重载端点 | `GET classify` → 需要时 `POST request`（引擎侧自带的 owner 卡当前没有用这个模式的实例；模式本身保留） |
| `command` | 需要跑一条命令才会重载/重启 | 记录 + 通知；`--apply-commands` 时才执行 |
| `manual` | 交互式会话，**不能**自动重启（杀了会丢用户工作） | 通知 + 全队状态里点名 |

`http` 模式的完整字段（示例；字段含义与 `adapters/owners/dsh.json` 当年那份相同，该卡已于 2026-09-26 随 dsh 转桌面端撤除）：

```json
"reload": {
  "mode": "http",
  "guardBase": "http://127.0.0.1:3080",              // 可被 instance.json 的同名项覆盖
  "classify": "/restart/classify?path={path}",        // {path} 会被 URL 编码
  "request": "/restart/request",                      // POST {reason, kind, force:false}
  "kind": "sync-converge",
  "hint": "patch 层由 HMR 热重载；插件集合变更由 restart-guard 空闲后自动重启"
}
```

- `probe.any` 里任一条成立即视为"该应用在本机"（路径存在，或命令能在 PATH 里找到）。都不成立 ⇒ 该 owner 的目标**不计入待办**（这台机器没装它）。
- owner 也可以直接写 `"targets": [ … ]`（静态列表），用于"配置文件由应用自己写、我们没有渲染器"的场景。

## 本目录现有内容

| 文件 | 说明 |
|---|---|
| `producers/agentFiles.json` | 四个 agent 指令文件（dsh / opencode / WorkBuddy / vault） |
| `producers/mcp.json` | MCP live 配置（dsh profile patch / opencode jsonc / WorkBuddy mcp.json） |
| `producers/conventions.json` | conventions §1/§2 的 canonical 副本 |
| `owners/opencode.json` · `owners/workbuddy.json` | `manual`（交互式，只通知） |
| `owners/claudian.json` | 默认关闭（Obsidian 内，需手动重载） |
| `owners/vault.json` | `none`（vault 内的指令文件由 agent 自行读取） |
