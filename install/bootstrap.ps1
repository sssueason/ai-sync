# bootstrap.ps1 — 全新机器一键接入（Windows）
#
# 与 install/bootstrap.sh 一一对应（同三件事，薄封装：取引擎 → 取实例（可选）→ 调引擎自带安装器）。
#
# 用法（一行）：
#   irm https://raw.githubusercontent.com/<owner>/ai-sync/main/install/bootstrap.ps1 | iex
#   国内网络用 gh-proxy 前缀：
#   irm https://gh-proxy.com/https://raw.githubusercontent.com/<owner>/ai-sync/main/install/bootstrap.ps1 | iex
#
# 可覆盖的环境变量：AI_SYNC_ENGINE_URL / AI_SYNC_INSTANCE_URL / AI_SYNC_ENGINE / AI_SYNC_INSTANCE / AI_SYNC_INTERVAL
param(
  [string]$EngineUrl = $env:AI_SYNC_ENGINE_URL,
  [string]$InstanceUrl = $env:AI_SYNC_INSTANCE_URL,
  [string]$EngineDir = $env:AI_SYNC_ENGINE,
  [string]$InstanceDir = $env:AI_SYNC_INSTANCE,
  [int]$Interval = $(if ($env:AI_SYNC_INTERVAL) { [int]$env:AI_SYNC_INTERVAL } else { 5 })
)
$ErrorActionPreference = 'Continue'
if (-not $EngineUrl) { $EngineUrl = 'https://github.com/sssueason/ai-sync.git' }
if (-not $EngineDir) { $EngineDir = Join-Path $env:USERPROFILE '.ai-sync\engine' }
if (-not $InstanceDir) { $InstanceDir = Join-Path $env:USERPROFILE '.ai-sync\instance' }
function Say($m) { Write-Host "   $m" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Say '[FAIL] 没找到 node（引擎只用 node 内置模块，但必须有 node ≥18）'; exit 2 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Say '[FAIL] 没找到 git'; exit 2 }

# 1. 引擎
if (Test-Path (Join-Path $EngineDir '.git')) {
  Say '引擎已存在 → git pull'
  git -C $EngineDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Say '[WARN] 引擎更新失败（离线？）→ 用现有版本继续' }
} else {
  Say "克隆引擎 → $EngineDir"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $EngineDir) | Out-Null
  git clone --depth 1 $EngineUrl $EngineDir
}

# 2. 实例（可选）
if ($InstanceUrl) {
  if (Test-Path (Join-Path $InstanceDir '.git')) {
    Say '实例已存在 → git pull'
    git -C $InstanceDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Say '[WARN] 实例更新失败 → 用现有版本继续' }
  } else {
    Say "克隆实例 → $InstanceDir"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstanceDir) | Out-Null
    git clone $InstanceUrl $InstanceDir
  }
} else {
  Say '未提供 AI_SYNC_INSTANCE_URL → 单机本地模式（实例配置放在引擎目录下）'
  $InstanceDir = $EngineDir
  $cfg = Join-Path $InstanceDir 'sync\instance.json'
  if (-not (Test-Path $cfg)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cfg) | Out-Null
    Copy-Item (Join-Path $EngineDir 'instance.example.json') $cfg
    Say '已生成默认 sync/instance.json（请按需改 tick/console）'
  }
}

# 3. 安装器：注册调度（幂等）+ 状态表
Say "注册调度（每 $Interval 分钟）"
node (Join-Path $EngineDir 'install\install.mjs') --instance $InstanceDir --register --interval $Interval
if ($LASTEXITCODE -ne 0) { Say '[WARN] 调度注册失败（见上面的原因；可手动重跑这条命令）' }

Say '状态表'
node (Join-Path $EngineDir 'tools\sync-status.mjs') --instance $InstanceDir

Write-Host @"

   完成。接下来：
     · 起控制台：node "$EngineDir\apps\sync-console\server.mjs" --instance "$InstanceDir"   → http://127.0.0.1:7788/
     · 托盘图标：双击 "$EngineDir\apps\sync-tray\windows\sync-tray.vbs"（菜单里可勾随登录自启）
     · 装机向导与排障：$EngineDir\docs\SETUP.md 与 docs\TROUBLESHOOTING.md
"@
