# TROUBLESHOOTING — 症状 → 根因 → 处置

> 全部来自**真机踩过的坑**（带日期）。先按症状查表；查到之后按"处置"做，别猜。

---

## 速查表

| 症状 | 根因 | 处置 |
|---|---|---|
| `fatal: Cannot rebase onto multiple branches` | 两个同步进程同时 fetch/pull，把 `.git/FETCH_HEAD` 写成交错多行 | 已修：`sync/_load.ps1` 用命名互斥体串起来；看到 `[SKIP] 另一个同步进程正持锁` 就是它在让路，**不是故障** |
| tick 日志 `repo=X integrate=FAIL rc=1` 但仓库没坏 | 同上（旧版本才会发生） | 已修；若重现，检查是否有第三方脚本也在 pull（编辑器插件、云盘客户端） |
| `dsh` 里改了 patch 却不生效 | 本机 patch 层不是 live（`patchReload: startup`） | `sync-status.mjs` 会报 `patch 层为 live → FAIL`；对照 `profile-boot.ts` 的 `patchReload` 语义修 profile 清单 |
| 改了 `mcp/servers.json` 但工具没变 | 渲染器没跑 / 渲染器 FAIL | 看 tick 日志的 `render … 退出码 N`；手动跑一次 `node <引擎根>/mcp/render/render_mcp.mjs` |
| 渲染器打印 `[FAIL] … 找不到小节` | 目标文件的**小节标题**与渲染器期望不逐字一致 | 标题必须与渲染器里的常量逐字相同（含全角标点）；改标题或改渲染器常量，**别只改一边** |
| 渲染产物里的指针指向一个不存在的文件 | 布局不同（拆分 vs 合并布局）被硬编码 | 已修：渲染器按"同级副本是否存在"选文案；若再遇到，说明有新布局没被覆盖 |
| `--audit` 报 `0 target(s) drifted` 但内容其实是旧的 | **假绿**：渲染器找不到小节就跳过，`expected == actual` | 已修（收集 `failures` + exit 2）；写新渲染器时**必须**让失败路径非零退出 |
| 计划任务 `LastTaskResult` 一直是 `267011` | 从未运行过（`267011` = never run）；AtLogOn 且当天没有新的交互式登录 | 正常。想看它跑没跑：`Start-ScheduledTask -TaskName ai-sync-daily` |
| 任务注册报 `Duration:P99999999DT23H59M59S` | 传了 `-RepetitionDuration ([TimeSpan]::MaxValue)` | 别传该参数（Win10+ 省略即"无限重复"） |
| `StartWhenAvailable` 在两台机器上不一样 | 注册时机/脚本版本不同 | 不影响正确性；要一致就用同一份 `sync-lite.ps1 -InstallTask` 重装一次 |
| tick 里 `[FAIL] 未找到 node` | 计划任务的环境 PATH ≠ 你的终端 PATH | 把 node 装成系统级；或在任务动作里显式设置 PATH |
| 托盘 tooltip 显示乱码 / JSON 解析失败 | Windows 控制台代码页（GBK）解码了 UTF-8 输出 | 已修：托盘走"node 写 UTF-8 文件 → PowerShell 按 UTF-8 读"，绕开控制台代码页。自己写脚本时**别用管道传中文 JSON** |
| 托盘图标不出现 | 进程被 `Stop-Process` 杀了 / 自启项没装 | 双击 `sync-tray.vbs`；菜单勾「随登录自启」；`Get-CimInstance Win32_Process` 找 `sync-tray` |
| 托盘 GDI 句柄一直涨 | `Bitmap.GetHicon()` 没释放 | 已修（`DestroyIcon` + 旧图标 Dispose）。自写 WinForms 托盘时注意 |
| `sync-status` 报 `tick 间隔与配置一致 → FAIL` | 配置改了但平台调度还没重排 | 等下一轮 tick（它每轮开头会对账），或手动 `sync-schedule.mjs --reconcile` |
| 全队表里看不到别的机器 | 对方还没推过状态 / 分支还不存在 | 让对方跑一次 tick；首次推送前 `sync-state` 分支不存在是正常的 |
| `sync-state` 分支越来越长 | 每 15 分钟一个状态提交（该分支设计如此） | 目前**未做压缩**；介意就 `git push origin --delete sync-state` 让它重建（会丢历史，不影响功能） |
| 镜像里出现 `xxx.local-<机器>-<日期>.docx` | 两台机器改了同一份二进制文件 | 正常保护机制：**没丢数据**。人工比对后删掉多余那份 |
| 镜像里多出一些文件（对账报 `extra`） | 有人直接在同步空间里编辑/放了文件 | 见 `SYNC-SPACE.md` §3；要收回就 `reconcile-mu2.ps1 -PromoteExtra`（单向提升，不覆盖） |
| `seed` 在 macOS 上没跑 | robocopy → rsync 未移植 | `align` 会**明确打印注记**（不是静默跳过）；需要就自己写 rsync 版 |
| 手动 pull 返回 `exit 4` | 拿不到并发锁（tick 正在跑） | 重跑或等下一轮，**不是故障** |

## 两条排查主线

```bash
# 1) 全局状态（退出码 0 = 全 PASS，2 = 有 FAIL）
node <引擎根>/tools/sync-status.mjs

# 2) 最近几轮干了什么
Get-Content <实例根>/sync/logs/tick-<机器>.log -Tail 5     # Windows
tail -5 <实例根>/sync/logs/tick-$(date +%Y%m%d).log     # macOS
```

日志行格式（每轮一行摘要；**失败明细在摘要行之后另起行**）：

```
tick <机器> <时间> 拉取=N 提交=N 推送=N 整合失败=N 耗时=Ns rc=N | <渲染器末行 ×3> [| 收敛：…] [| 清理：…]
[注] <状态变化，如"抢占陈旧锁">
[FAIL] <仓库 id>: 整合失败        ← rc≥1 时才有；明细就在这里
```

- `rc=0` = 正常；`rc≥1` = 有失败，**证据是紧随其后的 `[FAIL]` 行**（2026-09-18 起才写进持久日志：
  在那之前它们只走 stdout，而计划任务用 `run-hidden.vbs` 把 stdout 藏掉 ⇒ 日志里只剩 `rc=1`、毫无线索）。
- `整合失败=N` = N 个仓库的 `pull --rebase` 整合没成（真冲突已 `rebase --abort` 复原、本地提交保留），
  需人工看后面的 `[FAIL]` 行。该字段 2026-09-18 之前叫 `让路=` —— 那名字是误导：它只在整合失败时自增，
  而"让路"本是下面锁冲突行的既有语义。
- `lock=busy（另一同步进程持锁，本轮让路）` = 让路，**不是故障**（该行仍写 `让路=1`、rc=0）。
- `[FAIL] render <名字> 退出码 N（末行输出：…）` = 渲染器失败，括号里是它自己的诊断行（同样另起行写入日志）。

## 报告问题时请带上

1. `sync-status.mjs` 的完整输出（含断言表）；
2. tick 日志最后 5 行；
3. `sync-schedule.mjs` 的输出；
4. 平台：Windows/macOS、node 版本、`$PSVersionTable.PSVersion`（Windows）。

这四样齐了，绝大多数问题一眼可判。
