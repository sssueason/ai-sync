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
  [ValidateSet('run', 'probe', 'install-autostart', 'uninstall-autostart', 'promote-icon', 'open-console')][string]$Action = 'run',
  [switch]$PromoteIcon,
  [switch]$OpenConsole,
  [string]$ConsolePage = '',
  [switch]$DryRun,
  # 常用动作也给开关形式（脚本/测试/文档里更顺手）：-Probe / -InstallAutostart / -UninstallAutostart
  [switch]$Probe,
  [switch]$InstallAutostart,
  [switch]$UninstallAutostart,
  [int]$RefreshSeconds = 120,
  [string]$Engine = '',
  [string]$Instance = ''
)
if ($Probe) { $Action = 'probe' }
if ($InstallAutostart) { $Action = 'install-autostart' }
if ($UninstallAutostart) { $Action = 'uninstall-autostart' }
if ($PromoteIcon) { $Action = 'promote-icon' }
if ($OpenConsole) { $Action = 'open-console' }
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# DestroyIcon：Bitmap.GetHicon() 拿到的句柄由我们负责释放。常驻托盘每 2 分钟刷新一次图标，
# 不释放就是每天几百个 GDI 句柄泄漏（实测会累积到任务管理器里数不清的句柄）。
Add-Type -Namespace AiSync -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr hIcon);'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$engineRoot = if ($Engine) { $Engine } elseif ($env:AI_SYNC_ENGINE) { $env:AI_SYNC_ENGINE } else { Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here)) }
$instanceRoot = if ($Instance) { $Instance } elseif ($env:AI_SYNC_INSTANCE) { $env:AI_SYNC_INSTANCE } else { $engineRoot }
$statusTool = Join-Path $engineRoot 'tools/sync-status.mjs'
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
  $env:AI_SYNC_INSTANCE = $instanceRoot; $env:AI_SYNC_ENGINE = $engineRoot
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
  $line2 = if ($n -gt 0) {
    # 待办可能来自**对端**（本机图标也会因此变琥珀色）⇒ 必须标出机器名，否则用户会去本机找一个不存在的配置
    $me = [string]$b.raw.machine
    $items = ($b.actions | Select-Object -First 3 | ForEach-Object {
        $src = [string]$_.source
        if ($src -and $src -ne $me) { "[$src] $($_.text)" } else { "$($_.text)" }
      }) -join '；'
    "待办 $n：$items"
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

function Show-Brief([object]$b) {
  if (-not $b.ok) { [System.Windows.Forms.MessageBox]::Show($b.error, '同步状态') | Out-Null; return }
  $lines = @()
  $lines += "判定：$($b.state.ToUpper())    最后同步：$($b.lastSyncAt)（$($b.agoMin) 分钟前）    间隔：$($b.interval) 分钟"
  $lines += ''
  foreach ($c in $b.raw.checks) { $lines += ("[{0}] {1}  ← 期望 {2} / 实际 {3}" -f $c.level, $c.name, $c.expected, $c.actual) }
  if ($b.machines.Count) { $lines += ''; $lines += '--- 全队 ---'; foreach ($m in $b.machines) { $lines += ("{0}  {1}  {2} 分钟前  rc={3}  待办={4}" -f $m.machine, $m.at, $m.ageMin, $m.rc, @($m.actions).Count) } }
  if ($b.actions.Count) { $lines += ''; $lines += '--- 待办 ---'; foreach ($a in $b.actions) { $lines += ("· [{0}] {1}" -f $a.source, $a.text) } }
  [System.Windows.Forms.MessageBox]::Show(($lines -join "`n"), '同步简报') | Out-Null
}

function Invoke-Tick {
  # 2026-09-17（P5 后修正）：优先调**引擎的** node tick（跨平台单实现）。
  # 原先只认实例里的 sync/sync-lite.ps1 ⇒ 迁移到引擎后这里会调错东西，全新装机更是直接"找不到"。
  $nodeTick = Join-Path $engineRoot 'tools/sync-tick.mjs'
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
    $srv = Join-Path $engineRoot 'apps/sync-console/server.mjs'
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
  $s.Arguments = "`"$vbs`""
  $s.WorkingDirectory = $here
  $s.WindowStyle = 7
  $s.Description = 'ai-sync 同步状态托盘'
  $s.Save()
  Write-Host "  [OK] 已设置随登录自启：$lnk"
}

# ---------------------------------------------------------------- 三种入口

if ($Action -eq 'install-autostart') { Set-Autostart $true; exit 0 }
if ($Action -eq 'uninstall-autostart') { Set-Autostart $false; exit 0 }
if ($Action -eq 'promote-icon') { Set-IconPromoted; exit 0 }
if ($Action -eq 'open-console') { Open-Console $ConsolePage -DryRun:$DryRun; exit 0 }

if ($Action -eq 'probe') {
  $b = Get-Brief
  Write-Output ("state={0}  ok={1}" -f $b.state, $b.ok)
  Write-Output ("lastSyncAt={0}  agoMin={1}  interval={2}" -f $b.lastSyncAt, $b.agoMin, $b.interval)
  Write-Output ("actions={0}" -f $b.actions.Count)
  Write-Output "tip:"
  Get-Tooltip $b | ForEach-Object { "  |$_" }
  Write-Output "menu: 简报… / 打开控制台（调度台） / 适配器设置… / 立即同步 / 日志（可视） / 原始日志文件… / 随登录自启(勾选) / 状态变化时气泡提醒(勾选，默认关) / 退出"
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

$miBrief = $menu.Items.Add('简报…')
$miConsole = $menu.Items.Add('打开控制台（调度台）')
$miAdapters = $menu.Items.Add('适配器设置…')
$miSync = $menu.Items.Add('立即同步')
$miLogView = $menu.Items.Add('日志（可视）')
$miLog = $menu.Items.Add('原始日志文件…')
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

$miBrief.add_Click({ Show-Brief (Get-Brief) })
$miConsole.add_Click({ Open-Console '' })
$miAdapters.add_Click({ Open-Console '#settings' })
$miLogView.add_Click({ Open-Console '#logs' })
$miSync.add_Click({ Invoke-Tick; Start-Sleep -Seconds 8; Update-Tray })
$miLog.add_Click({
    $f = (Get-ChildItem -Path $logDir -Filter 'tick-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
    if ($f -and (Test-Path $f)) { Start-Process notepad.exe $f } else { Start-Process explorer.exe $logDir }
  })
$miAuto.add_Click({ Set-Autostart $miAuto.Checked })
$miBalloon.add_Click({
    if ($miBalloon.Checked) { Set-Content -Path $balloonFlag -Value 'on' -Encoding UTF8 -NoNewline }
    else { Remove-Item -LiteralPath $balloonFlag -Force -ErrorAction SilentlyContinue }
  })
$miExit.add_Click({ $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() })

Update-Tray          # 先设 Icon/Text，再让图标可见：这样 Explorer 记录的 InitialTooltip 才是真 tooltip
$notify.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(30, $RefreshSeconds) * 1000
$timer.add_Tick({ Update-Tray -AllowBalloon })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$notify.Dispose()
