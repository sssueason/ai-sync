# sync-tray.ps1 — 同步状态托盘图标（Windows）：🔄 + 右下角状态角标 + 悬浮显示待办
#
# 用户要求（2026-09-17）：
#   · 图标用"循环双箭头"（🔄 语义），**不强依赖 emoji 字体**：这里用矢量弧线+箭头画出来，
#     任何机器都渲染得出来（emoji 在 GDI+ 下不可靠，DirectWrite 才有彩色 emoji）。
#   · 右下角角标 = 状态：绿实心圆=正常 · 黄三角=有警告 · 红方块叉=有失败。
#     角标**形状+颜色双编码**（色觉异常也能分辨）；数字放 tooltip，不塞进 16px 的图标里。
#   · 鼠标悬浮 → tooltip 两行：`同步正常 · 21:26（0 分钟前）` + `待办 2：重启 opencode；重启 WorkBuddy`
#   · 右键菜单：简报 / 立即同步 / 打开日志 / 随登录自启（勾选）/ 退出
#
# 用法：
#   pwsh -File sync-tray.ps1                 # 常驻托盘（无窗口）
#   pwsh -File sync-tray.ps1 -Probe          # **不弹 UI**，打印真实 tooltip/菜单/状态后退出（可测性）
#   pwsh -File sync-tray.ps1 -InstallAutostart / -UninstallAutostart
#
# 设计取舍：刷新只跑 `sync-status.mjs --json --no-fetch`（本地为主，不为了刷新去联网）；
# 气泡只在**状态跳变**时弹一次（否则每 2 分钟骚扰一次，人会直接关掉通知）。
param(
  [ValidateSet('run', 'probe', 'install-autostart', 'uninstall-autostart', 'promote-icon', 'open-console', 'update-engine')][string]$Action = 'run',
  [switch]$PromoteIcon,
  [switch]$OpenConsole,
  [string]$ConsolePage = '',
  [switch]$DryRun,
  # 常用动作也给开关形式（脚本/测试/文档里更顺手）：-Probe / -InstallAutostart / -UninstallAutostart
  [switch]$Probe,
  [switch]$InstallAutostart,
  [switch]$UninstallAutostart,
  [switch]$UpdateEngine,
  [int]$RefreshSeconds = 120,
  [string]$Engine = '',
  [string]$Instance = ''
)
if ($Probe) { $Action = 'probe' }
if ($InstallAutostart) { $Action = 'install-autostart' }
if ($UninstallAutostart) { $Action = 'uninstall-autostart' }
if ($PromoteIcon) { $Action = 'promote-icon' }
if ($OpenConsole) { $Action = 'open-console' }
if ($UpdateEngine) { $Action = 'update-engine' }
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# DestroyIcon：Bitmap.GetHicon() 拿到的句柄由我们负责释放。常驻托盘每 2 分钟刷新一次图标，
# 不释放就是每天几百个 GDI 句柄泄漏（实测会累积到任务管理器里数不清的句柄）。
Add-Type -Namespace AiSync -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr hIcon);'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$engineRoot = if ($Engine) { $Engine } elseif ($env:AI_SYNC_ENGINE) { $env:AI_SYNC_ENGINE } else { Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here)) }
<#
  实例根解析（2026-09-18 修，某台机器实测缺陷）：原先只有 `-Instance` → `$env:AI_SYNC_INSTANCE` → 引擎根，
  而自启入口 sync-tray.vbs 当时不传 `-Instance` ⇒ 拆分布局下退化成**引擎根**（那里没有 sync/instance.json）
  ⇒ 托盘 state=fail、interval 显示默认 5（配置是 20）、tip 报 4 个假问题 —— **机器好好的，图标红着骗人**。
  现在按可信度依次找：
    1) -Instance 参数（vbs 现在会传：它由托盘自己创建的自启快捷方式带进来）
    2) $env:AI_SYNC_INSTANCE（官方读取顺序第二档）
    3) ~/.ai-sync/instance（约定的独立实例位置；要有 sync/instance.json 才认）
    4) **计划任务命令文件**里的 --instance（= 调度器实际在用的那个，最可信）
    5) 引擎根（原地布局时它就是正确值）
#>
$instanceRoot = ''
$instanceSource = ''
if ($Instance) { $instanceRoot = $Instance; $instanceSource = '-Instance 参数' }
elseif ($env:AI_SYNC_INSTANCE) { $instanceRoot = $env:AI_SYNC_INSTANCE; $instanceSource = 'AI_SYNC_INSTANCE 环境变量' }
else {
  $conv = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-sync/instance'
  if (Test-Path (Join-Path $conv 'sync/instance.json')) { $instanceRoot = $conv; $instanceSource = '~/.ai-sync/instance' }
}
if (-not $instanceRoot) {
  foreach ($t in (Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'ai-sync-*' })) {
    $arg = [string](($t.Actions | Select-Object -First 1).Arguments)
    $m = [regex]::Match($arg, '([A-Za-z]:\\[^"]*-cmd\.txt)')
    if (-not $m.Success -or -not (Test-Path $m.Groups[1].Value)) { continue }
    $line = [string](Get-Content -Raw -Encoding Unicode $m.Groups[1].Value -ErrorAction SilentlyContinue)
    $mi = [regex]::Match($line, '--instance\s+"?([^"]+?)"?(?:\s|$)')
    if ($mi.Success -and (Test-Path (Join-Path $mi.Groups[1].Value.Trim() 'sync/instance.json'))) {
      $instanceRoot = $mi.Groups[1].Value.Trim()
      $instanceSource = "计划任务 $($t.TaskName) 的命令文件"
      break
    }
  }
}
if (-not $instanceRoot) { $instanceRoot = $engineRoot; $instanceSource = '引擎根（原地布局）' }
$instanceHasCfg = Test-Path (Join-Path $instanceRoot 'sync/instance.json')
# 优先用**已安装的引擎**（拆分部署）跑状态查询、tick 与控制台：
# 原地布局下实例里那份只是副本，用它去查「引擎是否落后」永远得到"不适用"（2026-09-17 实测盲点）；
# 顺带这也是 P5 收尾的方向（托盘最终只从引擎目录起，实例只提供配置）。
$installedEngine = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-sync/engine'
# 显式 -Engine 优先（测试与多布局场景必须能指定）；否则优先**已安装引擎**；再否则引擎根。
# 2026-09-18 实测：不判 -Engine 会让 "-Engine <临时 clone>" 被静默忽略，测试全打到真实引擎上。
$engineForRun = if ($Engine) { $Engine } elseif (Test-Path (Join-Path $installedEngine 'tools/sync-tick.mjs')) { $installedEngine } else { $engineRoot }
$statusTool = Join-Path $engineForRun 'tools/sync-status.mjs'
$logDir = Join-Path $instanceRoot 'sync/logs'
$stateFile = Join-Path $logDir '.tray-last-state.json'
# 气泡提醒默认**关**（用户 2026-09-17：「保持静默」）：只有这个文件存在才弹，菜单里可勾选开关。
$balloonFlag = Join-Path $logDir '.tray-balloon'

function Get-Brief {
  if (-not (Test-Path $statusTool)) { return [pscustomobject]@{ ok = $false; error = "缺 $statusTool" } }
  # ⚠️ 为什么走文件而不是管道（2026-09-17 实测）：Windows 上原生命令输出按 [Console]::OutputEncoding
  # 解码；在 Start-Job / 无控制台（wscript 拉起托盘）等上下文里会按 GBK 解码 ⇒ 中文用户名/路径变乱码
  # 并把 JSON 破坏成 `Bad JSON escape sequence`。
  # 写 UTF-8 文件再按 UTF-8 读，完全不经过控制台代码页 ⇒ 这类问题根治。
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-sync-brief-{0}.json" -f $PID)
  $env:AI_SYNC_INSTANCE = $instanceRoot; $env:AI_SYNC_ENGINE = $engineForRun
  & node $statusTool --instance $instanceRoot --out $tmp --no-fetch --quiet 2>$null | Out-Null
  if (-not (Test-Path $tmp)) { return [pscustomobject]@{ ok = $false; error = "sync-status 未产出 $tmp（退出码 $LASTEXITCODE）" } }
  $json = Get-Content -Raw -Encoding UTF8 $tmp
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  try { $b = $json | ConvertFrom-Json } catch { return [pscustomobject]@{ ok = $false; error = "JSON 解析失败（$($_.Exception.GetType().Name): $($_.Exception.Message)）首段: $($json.Substring(0, [Math]::Min(60, $json.Length)))" } }
  # sync-status 在有 FAIL 时退出码为 2，但 JSON 仍有效 ⇒ 只认 JSON
  [pscustomobject]@{ ok = $true; state = $b.state; at = $b.at; lastSyncAt = $b.lastSyncAt; agoMin = $b.lastSyncAgoMin; actions = @($b.actions); problems = @($b.problems); machines = @($b.machines); interval = $b.intervalMinutes; raw = $b }
}

function Get-Tooltip([object]$b) {
  if (-not $b.ok) { return "同步状态不可用`n$($b.error)" }
  $line1 = switch ($b.state) {
    'ok' { "同步正常 · $($b.lastSyncAt)（$(if ($null -ne $b.agoMin) { "$($b.agoMin) 分钟前" } else { '刚刚' })）" }
    'warn' { "同步有提醒 · $($b.lastSyncAt)" }
    default { "同步有失败 · $($b.lastSyncAt)" }
  }
  $n = $b.actions.Count
  $behind = [int]($b.raw.engineBehind ?? 0)
  $line2 = if ($n -gt 0) {
    # 待办可能来自**对端**（本机图标也会因此变琥珀色）⇒ 必须标出机器名，否则用户会去本机找一个不存在的配置
    $me = [string]$b.raw.machine
    $items = ($b.actions | Select-Object -First 3 | ForEach-Object {
        $src = [string]$_.source
        if ($src -and $src -ne $me) { "[$src] $($_.text)" } else { "$($_.text)" }
      }) -join '；'
    "待办 $n：$items"
  } elseif ($behind -gt 0) {
    # 引擎落后 ⇒ 说清楚"能更新"，并指出下一步（否则只看到"有提醒"却不知道提醒什么）
    "引擎可更新（落后 $behind 个提交）→ 双击图标看更新命令"
  } elseif ($b.problems.Count -gt 0) {
    "问题 $($b.problems.Count)：$($b.problems[0])"
  } else {
    $fleet = $b.machines.Count
    "无待办 · $fleet 台机器已知"
  }
  $tip = "$line1`n$line2"
  if ($tip.Length -gt 125) { $tip = $tip.Substring(0, 122) + '…' }   # NotifyIcon.Text 上限 127
  return $tip
}

# ---------------------------------------------------------------- 图标绘制（矢量，不依赖 emoji 字体）

function New-SyncIcon([string]$state) {
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $accent = [System.Drawing.Color]::FromArgb(255, 10, 132, 255)
  $pen = New-Object System.Drawing.Pen($accent, 4)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  # 循环双箭头：两段弧 + 两个箭头
  $rect = New-Object System.Drawing.Rectangle(5, 5, 22, 22)
  $g.DrawArc($pen, $rect, 200, 130)
  $g.DrawArc($pen, $rect, 20, 130)
  $brush = New-Object System.Drawing.SolidBrush($accent)
  $g.FillPolygon($brush, @(
      (New-Object System.Drawing.Point(20, 3)), (New-Object System.Drawing.Point(28, 9)), (New-Object System.Drawing.Point(19, 12))
    ))
  $g.FillPolygon($brush, @(
      (New-Object System.Drawing.Point(12, 29)), (New-Object System.Drawing.Point(4, 23)), (New-Object System.Drawing.Point(13, 20))
    ))
  # 右下角标：形状 + 颜色双编码
  $col = switch ($state) { 'ok' { [System.Drawing.Color]::FromArgb(255, 46, 204, 113) } 'warn' { [System.Drawing.Color]::FromArgb(255, 241, 196, 15) } default { [System.Drawing.Color]::FromArgb(255, 231, 76, 60) } }
  $badge = New-Object System.Drawing.SolidBrush($col)
  switch ($state) {
    'ok' { $g.FillEllipse($badge, 20, 20, 12, 12) }
    'warn' { $g.FillPolygon($badge, @((New-Object System.Drawing.Point(26, 19)), (New-Object System.Drawing.Point(32, 31)), (New-Object System.Drawing.Point(20, 31)))) }
    default {
      $g.FillRectangle($badge, 20, 20, 12, 12)
      $ex = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 2)
      $g.DrawLine($ex, 23, 23, 29, 29); $g.DrawLine($ex, 29, 23, 23, 29)
    }
  }
  $g.Dispose()
  $h = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($h)
  # 复制一份独立图标，避免依赖临时句柄
  $ms = New-Object System.IO.MemoryStream
  $icon.Save($ms)
  $ms.Position = 0
  $final = New-Object System.Drawing.Icon($ms)
  $ms.Dispose(); $bmp.Dispose()
  # 拷贝完成后原始 HICON 就不再需要了 —— 必须显式销毁（见顶部 DestroyIcon 的注释）
  try { [AiSync.Native]::DestroyIcon($h) | Out-Null } catch { }
  return $final
}


function Invoke-Tick {
  # 2026-09-17（P5 后修正）：优先调**引擎的** node tick（跨平台单实现）。
  # 原先只认实例里的 sync/sync-lite.ps1 ⇒ 迁移到引擎后这里会调错东西，全新装机更是直接"找不到"。
  $nodeTick = Join-Path $engineForRun 'tools/sync-tick.mjs'
  $pwsh = (Get-Process -Id $PID).Path
  if (Test-Path $nodeTick) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { [System.Windows.Forms.MessageBox]::Show('找不到 node（引擎 tick 需要它）', '立即同步') | Out-Null; return }
    Start-Process -FilePath $node -ArgumentList @($nodeTick, '--instance', $instanceRoot, '--no-jitter') -WindowStyle Hidden
    return
  }
  $tick = Join-Path $instanceRoot 'sync/sync-lite.ps1'
  if (-not (Test-Path $tick)) { [System.Windows.Forms.MessageBox]::Show("找不到 $nodeTick 也找不到 $tick", '立即同步') | Out-Null; return }
  Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-File', $tick, '-NoJitter') -WindowStyle Hidden
}

<# Win11 默认把**新出现的**托盘图标放进隐藏区（"显示隐藏的图标" 的 ︿ 后面）⇒
   症状是"进程在跑、状态文件在更新，但用户看不见图标"（2026-09-17 实测踩到）。
   本函数把该图标提升为「始终显示」：改的是每用户外观设置，可逆（IsPromoted=0 回默认）。
   判据：HKCU\Control Panel\NotifyIconSettings\<id> 的 InitialTooltip 含「同步」，
   或 ExecutablePath 是 pwsh 且 tooltip 为空（首次注册时可能还没记上）。 #>
function Set-IconPromoted {
  $base = 'HKCU:\Control Panel\NotifyIconSettings'
  if (-not (Test-Path $base)) { Write-Host '  [--] 没有该注册表项（Win10 或本机不用此机制）；手动：设置 → 个性化 → 任务栏 → 其他系统托盘图标'; return }
  $hits = 0
  foreach ($k in Get-ChildItem $base) {
    $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    $tip = [string]$p.InitialTooltip
    $exe = [string]$p.ExecutablePath
    $isOurs = ($tip -like '*同步*') -or ($exe -like '*pwsh*' -and [string]::IsNullOrWhiteSpace($tip))
    if (-not $isOurs) { continue }
    if ($p.IsPromoted -eq 1) { Write-Host "  [OK] 已是「始终显示」：$($k.PSChildName)"; $hits++; continue }
    Set-ItemProperty -Path $k.PSPath -Name IsPromoted -Value 1 -Type DWord
    Write-Host "  [OK] 已设为「始终显示」：$($k.PSChildName)"
    $hits++
  }
  if ($hits -eq 0) { Write-Host '  [--] 没找到本图标的注册项（先把托盘跑起来一次再执行）' }
  else { Write-Host '  提示：该设置通常要重启一次 explorer.exe 才在任务栏生效（也可手动把它从隐藏区拖出来）' }
}

<# 打开控制台（"调度台"）：没在跑就先拉起引擎的控制台服务，然后开浏览器到指定页。
   端口取 instance.json 的 console.port（默认 7788）；判活用一个 1 秒超时的 HTTP 请求，不阻塞托盘。 #>
function Open-Console([string]$hash = '', [switch]$DryRun) {
  $port = 7788
  try { $port = (Get-Content -Raw -Encoding UTF8 (Join-Path $instanceRoot 'sync/instance.json') | ConvertFrom-Json).console.port ?? 7788 } catch { }
  $url = "http://127.0.0.1:$port/$hash"
  $alive = $false
  try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/status" -TimeoutSec 1 -UseBasicParsing; $alive = $true } catch { }
  Write-Host "  控制台：$url（服务$(if ($alive) { '已在跑' } else { '未在跑，将拉起' })）"
  if ($DryRun) { return }
  if (-not $alive) {
    $srv = Join-Path $engineForRun 'apps/sync-console/server.mjs'
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node -or -not (Test-Path $srv)) { [System.Windows.Forms.MessageBox]::Show("找不到控制台服务：$srv", '打开控制台') | Out-Null; return }
    Start-Process -FilePath $node -ArgumentList @($srv, '--instance', $instanceRoot, '--port', "$port") -WindowStyle Hidden
    Start-Sleep -Seconds 2
  }
  Start-Process $url
}
function Set-Autostart([bool]$on) {
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk = Join-Path $startup 'ai-sync tray.lnk'
  if (-not $on) { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue; Write-Host "  [OK] 已移除自启：$lnk"; return }
  $vbs = Join-Path $here 'sync-tray.vbs'
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = 'wscript.exe'
  $s.Arguments = "`"$vbs`" `"$instanceRoot`""   # 显式把实例根交给 vbs（拆分布局下它自己找不到）
  $s.WorkingDirectory = $here
  $s.WindowStyle = 7
  $s.Description = 'ai-sync 同步状态托盘'
  $s.Save()
  Write-Host "  [OK] 已设置随登录自启：$lnk"
}

<# 有界的 git 调用（**只用于网络类操作**：fetch / pull）。
为什么必须有超时：这是菜单里点一下就跑的代码，而托盘跑在 UI 线程上 —— 没有超时的话，
远端不可达时整个托盘会冻住（2026-09-18 实测：无超时那版卡到 600s 都没返回）。
本地操作（rev-parse / rev-list / diff）不联网、毫秒级，仍用 `& git` 直调。 #>
function Invoke-Git([string[]]$GitArgs, [string]$Repo, [int]$TimeoutSec = 45) {
  # 临时文件放**实例的 state 目录**而不是 $env:TEMP：这台机器上 $env:TEMP 可能是 8.3 别名
  # （实测 Start-Process 的重定向会失败 ⇒ $p.ExitCode 为 null），state 目录一定是真实可写路径。
  $dir = Join-Path $instanceRoot 'sync/state'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp = Join-Path $dir ('.git-run-' + [guid]::NewGuid().ToString('N') + '.out')
  $env:GIT_TERMINAL_PROMPT = '0'      # 绝不弹凭据提示（UI 线程下没人能应答）
  $env:GCM_INTERACTIVE = 'Never'
  try {
    $p = Start-Process -FilePath 'git' -ArgumentList (@('-C', $Repo) + $GitArgs) -NoNewWindow -PassThru -RedirectStandardOutput $tmp -RedirectStandardError "$tmp.err"
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
      try { $p.Kill() } catch { }
      return [pscustomobject]@{ ok = $false; code = 124; out = ''; err = "超时（${TimeoutSec}s 未返回，已终止）" }
    }
    $p.Refresh()
    $out = if (Test-Path $tmp) { [IO.File]::ReadAllText($tmp) } else { '' }
    $err = if (Test-Path "$tmp.err") { [IO.File]::ReadAllText("$tmp.err") } else { '' }
    $code = if ($null -ne $p.ExitCode) { [int]$p.ExitCode } else { -1 }
    return [pscustomobject]@{ ok = ($code -eq 0); code = $code; out = $out.Trim(); err = $err.Trim() }
  } catch {
    return [pscustomobject]@{ ok = $false; code = -1; out = ''; err = $_.Exception.Message }
  } finally {
    Remove-Item $tmp, "$tmp.err" -Force -ErrorAction SilentlyContinue
  }
}

<# 一键更新引擎（右键菜单 / `-UpdateEngine` 共用这一段）。

为什么要有它：引擎装在每台机器**各自的 clone** 里，且**刻意不自动更新** —— 自动更新会在计划任务/launchd
运行途中替换正在执行的代码。但"手动"不该等于"记得住那条命令"：这里把 fetch → 判定落后 → pull --ff-only
→ 按"改了哪一片"决定要不要重注册调度/重启托盘，一次做完，并把结果原样告诉用户（失败照实说，不装成功）。

安全边界：只用 `--ff-only`（本地有分叉或未提交改动就失败并如实报告，绝不 --force、绝不丢弃本地改动）。 #>
function Update-Engine([switch]$DryRun) {
  $eng = $engineForRun
  $r = [ordered]@{ ok = $false; dryRun = [bool]$DryRun; engine = $eng; branch = ''; before = ''; after = ''; pulled = 0; steps = @(); changed = @(); restartTray = $false; error = '' }
  if (-not (Test-Path (Join-Path $eng '.git'))) { $r.error = "引擎目录不是 git 仓：$eng"; return [pscustomobject]$r }
  $r.branch = (& git -C $eng rev-parse --abbrev-ref HEAD 2>$null | Out-String).Trim()
  if (-not $r.branch -or $r.branch -eq 'HEAD') { $r.error = '引擎处于游离 HEAD（不在分支上），不自动更新'; return [pscustomobject]$r }
  $r.before = (& git -C $eng rev-parse --short HEAD 2>$null | Out-String).Trim()
  $f = Invoke-Git @('-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20', 'fetch', '--quiet', 'origin', $r.branch) $eng 45
  if (-not $f.ok) { $r.error = "git fetch 失败（exit $($f.code)）：$(if ($f.err) { $f.err } else { $f.out })"; return [pscustomobject]$r }
  $behind = (& git -C $eng rev-list --count "HEAD..origin/$($r.branch)" 2>$null | Out-String).Trim()
  if ($behind -and $behind -ne '0') {
    if ($DryRun) {
      $r.pulled = [int]$behind
      $r.steps += "（dry-run）将拉取 $behind 个提交"
      $r.changed = @((& git -C $eng diff --name-only 'HEAD' "origin/$($r.branch)" 2>$null) -split "`r?`n" | Where-Object { $_ })
    } else {
      $pl = Invoke-Git @('-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20', 'pull', '--ff-only') $eng 90
      if (-not $pl.ok) { $r.error = "git pull --ff-only 失败（本地有分叉或未提交改动？）：$(if ($pl.err) { $pl.err } else { $pl.out })"; return [pscustomobject]$r }
      $r.pulled = [int]$behind
      $r.steps += "拉取 $behind 个提交"
      $r.changed = @((& git -C $eng diff --name-only "$($r.before)" HEAD 2>$null) -split "`r?`n" | Where-Object { $_ })
    }
  } else {
    $r.steps += '已是最新，无需拉取'
  }
  $r.after = (& git -C $eng rev-parse --short HEAD 2>$null | Out-String).Trim()
  $hit = { param($re) [bool](@($r.changed) | Where-Object { $_ -match $re }) }
  # 后续动作与 OPERATIONS §10 的表逐条对应
  if (& $hit '^install/') {
    if ($DryRun) { $r.steps += '（dry-run）安装器有变 → 将重注册调度' }
    else {
      $inst = Join-Path $eng 'install/install.mjs'
      if (Test-Path $inst) {
        $out = (& node $inst --instance $instanceRoot --register 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { $r.error = "重注册失败：$out"; return [pscustomobject]$r }
        $r.steps += '安装器有变 → 已重注册调度'
      } else { $r.steps += '安装器有变但找不到 install/install.mjs（跳过重注册）' }
    }
  }
  if (& $hit '^apps/sync-tray/') {
    $r.restartTray = $true
    $r.steps += $(if ($DryRun) { '（dry-run）托盘自身有更新 → 将重启托盘' } else { '托盘自身有更新 → 已重启托盘' })
  }
  if ($r.pulled -gt 0 -and -not (& $hit '^install/') -and -not (& $hit '^apps/sync-tray/')) {
    $r.steps += '工具/适配器/文档有更新 → 下一轮 tick 自动生效'
  }
  $r.ok = $true
  return [pscustomobject]$r
}

function Show-EngineUpdate([switch]$DryRun) {
  $r = Update-Engine -DryRun:$DryRun
  $lines = @()
  if (-not $r.ok) {
    $lines += '更新失败（未做任何改动）'
    $lines += ''
    $lines += $r.error
  } else {
    $lines += $(if ($r.pulled -gt 0) { "引擎已更新：$($r.before) → $($r.after)" } else { "引擎已是最新：$($r.after)" })
    $lines += "分支：$($r.branch)    目录：$($r.engine)"
    $lines += ''
    foreach ($s in $r.steps) { $lines += "· $s" }
    if ($r.pulled -gt 0 -and @($r.changed).Count) { $lines += ''; $lines += "本次涉及（前 5）：$((@($r.changed) | Select-Object -First 5) -join '、')" }
    if ($r.restartTray -and -not $DryRun) { $lines += ''; $lines += '托盘已用新代码重启（图标可能闪一下）。' }
  }
  [System.Windows.Forms.MessageBox]::Show(($lines -join "`n"), '更新引擎') | Out-Null
  if ($r.ok -and $r.restartTray -and -not $DryRun) {
    # 托盘自身更新：拉起新实例再退出自己（新实例接管图标）
    Start-Process -FilePath 'wscript.exe' -ArgumentList ("`"$here\sync-tray.vbs`" `"$instanceRoot`"") | Out-Null
    Start-Sleep -Seconds 2
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  } else {
    Update-Tray
  }
}

# ---------------------------------------------------------------- 三种入口

if ($Action -eq 'install-autostart') { Set-Autostart $true; exit 0 }
if ($Action -eq 'uninstall-autostart') { Set-Autostart $false; exit 0 }
if ($Action -eq 'promote-icon') { Set-IconPromoted; exit 0 }
if ($Action -eq 'open-console') { Open-Console $ConsolePage -DryRun:$DryRun; exit 0 }

if ($Action -eq 'update-engine') {
  # 无 UI（可测）：打印结论，退出码 0=成功 / 1=失败
  $r = Update-Engine -DryRun:$DryRun
  Write-Output ("engine={0}  branch={1}" -f $r.engine, $r.branch)
  Write-Output ("before={0}  after={1}  pulled={2}{3}" -f $r.before, $r.after, $r.pulled, $(if ($r.dryRun) { '  (dry-run)' } else { '' }))
  foreach ($s in $r.steps) { Write-Output ("  · " + $s) }
  if (@($r.changed).Count) { Write-Output ("  changed({0}): {1}" -f @($r.changed).Count, ((@($r.changed) | Select-Object -First 6) -join ', ')) }
  if ($r.ok) { Write-Output 'RESULT: OK' } else { Write-Output ("RESULT: FAIL - " + $r.error) }
  exit $(if ($r.ok) { 0 } else { 1 })
}

if ($Action -eq 'probe') {
  # 先把路径解析摊开（诊断托盘"红着骗人"的第一步：实例根找对了没有）
  Write-Output ("engineRoot={0}" -f $engineRoot)
  Write-Output ("engineForRun={0}" -f $engineForRun)
  Write-Output ("instanceRoot={0}  （来源：{1}{2}）" -f $instanceRoot, $instanceSource, $(if ($instanceHasCfg) { '' } else { '；**缺 sync/instance.json**' }))
  $b = Get-Brief
  Write-Output ("state={0}  ok={1}" -f $b.state, $b.ok)
  Write-Output ("lastSyncAt={0}  agoMin={1}  interval={2}" -f $b.lastSyncAt, $b.agoMin, $b.interval)
  Write-Output ("actions={0}" -f $b.actions.Count)
  Write-Output "tip:"
  Get-Tooltip $b | ForEach-Object { "  |$_" }
  Write-Output "menu: 打开控制台 / 立即同步一次 / 检查并更新引擎（落后时显示落后几提交）/ — / 随登录自启(勾选) / 状态变化时气泡提醒(勾选，默认关) / — / 退出（双击图标 = 打开控制台）"
  foreach ($st in @('ok', 'warn', 'fail')) {
    $i = New-SyncIcon $st
    Write-Output ("icon[{0}] = {1}x{2} ({3} bytes)" -f $st, $i.Width, $i.Height, ($i.ToBitmap().GetPixel(26, 26).ToArgb()))
    $i.Dispose()
  }
  exit 0
}

# ---------------------------------------------------------------- 常驻托盘

$notify = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip

# 菜单刻意保持短：简报 / 适配器 / 日志 都是控制台里的页，不再各占一项（用户 2026-09-17 反馈"都调用拉起控制台就没有必要单列"）。
$miConsole = $menu.Items.Add('打开控制台')
$miSync = $menu.Items.Add('立即同步一次')
$miUpdate = $menu.Items.Add('检查并更新引擎')
$menu.Items.Add('-') | Out-Null
$miAuto = $menu.Items.Add('随登录自启')
$miAuto.CheckOnClick = $true
$miAuto.Checked = Test-Path (Join-Path ([Environment]::GetFolderPath('Startup')) 'ai-sync tray.lnk')
$miBalloon = $menu.Items.Add('状态变化时气泡提醒')
$miBalloon.CheckOnClick = $true
$miBalloon.Checked = Test-Path $balloonFlag
$menu.Items.Add('-') | Out-Null
$miExit = $menu.Items.Add('退出')

$script:lastState = ''
$script:curIcon = $null
function Update-Tray([switch]$AllowBalloon) {
  $b = Get-Brief
  $st = if (-not $b.ok) { 'fail' } else { $b.state }
  $newIcon = New-SyncIcon $st
  if ($script:curIcon) { try { $script:curIcon.Dispose() } catch { } }
  $script:curIcon = $newIcon
  $notify.Icon = $newIcon
  $notify.Text = Get-Tooltip $b
  # 动态标签：落后就直说落后几个提交（与 tooltip 同一判据），没落后就显示当前版本
  $behindNow = [int]($b.raw.engineBehind ?? 0)
  $miUpdate.Text = if ($behindNow -gt 0) { "更新引擎（落后 $behindNow 个提交）" } elseif ($b.raw.engineRev) { "检查并更新引擎（当前 $($b.raw.engineRev)）" } else { '检查并更新引擎' }
  $notify.ContextMenuStrip = $menu
  # 气泡只在**开关打开**且状态跳变时弹一次（默认关：用户要求静默；否则每轮刷新都弹 = 骚扰）
  $prev = ''
  if (Test-Path $stateFile) { $prev = (Get-Content -Raw $stateFile -ErrorAction SilentlyContinue) }
  if ($AllowBalloon -and (Test-Path $balloonFlag) -and $st -ne 'ok' -and $st -ne $prev) {
    $notify.BalloonTipTitle = 'ai-sync 同步'
    $notify.BalloonTipText = (Get-Tooltip $b)
    $notify.BalloonTipIcon = if ($st -eq 'fail') { [System.Windows.Forms.ToolTipIcon]::Error } else { [System.Windows.Forms.ToolTipIcon]::Warning }
    $notify.ShowBalloonTip(8000)
  }
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
  Set-Content -Path $stateFile -Value $st -Encoding UTF8 -NoNewline
  $script:lastState = $st
}

$miConsole.add_Click({ Open-Console '' })
$miSync.add_Click({ Invoke-Tick; Start-Sleep -Seconds 8; Update-Tray })
$miUpdate.add_Click({ Show-EngineUpdate })
$miAuto.add_Click({ Set-Autostart $miAuto.Checked })
$miBalloon.add_Click({
    if ($miBalloon.Checked) { Set-Content -Path $balloonFlag -Value 'on' -Encoding UTF8 -NoNewline }
    else { Remove-Item -LiteralPath $balloonFlag -Force -ErrorAction SilentlyContinue }
  })
$miExit.add_Click({ $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() })
# 双击图标也开控制台（一般人右键才看菜单；双击是"打开"的通用手势）
$notify.add_DoubleClick({ Open-Console '' })

Update-Tray          # 先设 Icon/Text，再让图标可见：这样 Explorer 记录的 InitialTooltip 才是真 tooltip
$notify.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(30, $RefreshSeconds) * 1000
$timer.add_Tick({ Update-Tray -AllowBalloon })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$notify.Dispose()
