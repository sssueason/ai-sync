# 一次性迁移（migrations）

> 解决的问题：**拉下来的改动 ≠ 已生效**。总有一部分改动必须在**每一端各跑一次**（改本机 live 配置、
> 重编托盘、重注册调度、跑一次定向清理…）。以前靠人挨台机器手做，于是没人能一眼看出"哪端没跟上"。

## 分工（三处，各管一段）
| 东西 | 放在哪 | 怎么分发 |
|---|---|---|
| **迁移定义** | 实例 `sync/migrations/`（`MANIFEST.json` + `<id>.mjs`） | 实例仓 git → 各端自动 pull |
| **执行器** | 引擎 `tools/sync-migrate.mjs` | 引擎仓 → 各端更新引擎 |
| **执行结果** | `sync/state/migrations-<machine>.json` | 机器本地，**永不入 git** |

由 `tools/sync-tick.mjs` 每轮调用一次（`--json`）。**只执行 `danger: "safe"`**；`manual` 只登记为待人工。

## 模块契约
```js
export const meta = { id, danger: 'safe' | 'manual', platforms: ['win32','darwin','linux'], reason, ref }
export function check(ctx) -> { ok, detail?, skip? }   // 幂等判据
export function apply(ctx) -> { changed?, detail? }    // 只在 check 不通过时调用；必须可重入
// ctx = { instance, machine, home, dryRun, log(msg) }
```
- `check()` **每轮都跑**（便宜）⇒ 能发现"后来被改回去了"，不是"跑过就不再管"；
- `check()` 返回 `{ skip: true }` = **本机不适用**（例如没装对应工具）⇒ 记为跳过、不算失败、也不报错；
  工具后来装上了，下一轮自然就会应用；
- 同一 id 连续失败 **3 次**后标记 `blocked` 并停止重试（改好后 `--only <id>` 重试）；
- 清单与模块的 `id` 必须一致 —— 不一致直接算失败（防"清单说 A、执行的是 B"）。

## 加一条迁移
1. 新建 `sync/migrations/<id>.mjs`，导出 `meta` + `check`（safe 还要 `apply`）；
2. 在 `MANIFEST.json` 的 `migrations[]` 里登记同一条（`id` / `file` / `danger` / `platforms` / `reason`）；
3. 先 `--dry-run` 看计划，再让它跟着 tick 走。

## 红线：**不可逆动作不许进 `safe`**
删数据、跨端/云端删除（并集语义下会被顶回）、改机器清单/路径的**语义**、发布、写源树
⇒ 一律 `danger: "manual"`，脚本**永不代劳**，只出"待人工"（状态文件 + tick 日志行 + `sync-status` 断言）。

## 手工命令
```bash
node tools/sync-migrate.mjs --list                 # 清单与各条状态
node tools/sync-migrate.mjs --dry-run              # 只打印计划，不写状态、不动文件
node tools/sync-migrate.mjs --only <id>            # 只跑一条
```

## 示例
见 [`examples/migrations/`](../examples/migrations/)（一条 safe 迁移：幂等地把某个机器本地配置文件里的
一个字段改成期望值，改前留备份，`check` 用"读回该字段"判定）。
