#!/usr/bin/env bash
# bootstrap.sh — 全新机器一键接入（macOS / Linux）
#
# 它做三件事，别的什么都不做（**薄**，避免和引擎里的安装器形成两份真相）：
#   1. 取引擎（git clone / pull）到 $AI_SYNC_ENGINE（默认 ~/.ai-sync/engine）
#   2. 取你的**私有实例仓**到 $AI_SYNC_INSTANCE（默认 ~/.ai-sync/instance）—— 可选；没有就单机本地模式
#   3. 调引擎自带的安装器：注册调度 + 跑一次状态表
#
# 用法（一行）：
#   curl -fsSL https://raw.githubusercontent.com/<owner>/ai-sync/main/install/bootstrap.sh | bash
#   国内网络用 gh-proxy 前缀：
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/<owner>/ai-sync/main/install/bootstrap.sh | bash
#
# 可覆盖的环境变量：
#   AI_SYNC_ENGINE_URL     引擎仓地址（默认见下）
#   AI_SYNC_INSTANCE_URL   你的私有实例仓地址（留空 = 单机本地模式）
#   AI_SYNC_ENGINE         引擎目录（默认 ~/.ai-sync/engine）
#   AI_SYNC_INSTANCE       实例目录（默认 ~/.ai-sync/instance；无实例仓时 = 引擎目录）
#   AI_SYNC_INTERVAL        tick 间隔分钟（默认 5）
set -euo pipefail

ENGINE_URL="${AI_SYNC_ENGINE_URL:-https://github.com/sssueason/ai-sync.git}"
ENGINE_DIR="${AI_SYNC_ENGINE:-$HOME/.ai-sync/engine}"
INSTANCE_URL="${AI_SYNC_INSTANCE_URL:-}"
INSTANCE_DIR="${AI_SYNC_INSTANCE:-$HOME/.ai-sync/instance}"
INTERVAL="${AI_SYNC_INTERVAL:-5}"

say() { printf '%s\n' "   $*"; }

command -v node >/dev/null 2>&1 || { say "[FAIL] 没找到 node（引擎只用 node 内置模块，但必须有 node ≥18）"; exit 2; }
command -v git  >/dev/null 2>&1 || { say "[FAIL] 没找到 git"; exit 2; }

# 1. 引擎
if [ -d "$ENGINE_DIR/.git" ]; then
  say "引擎已存在 → git pull"
  git -C "$ENGINE_DIR" pull --ff-only || say "[WARN] 引擎更新失败（离线？）→ 用现有版本继续"
else
  say "克隆引擎 → $ENGINE_DIR"
  mkdir -p "$(dirname "$ENGINE_DIR")"
  git clone --depth 1 "$ENGINE_URL" "$ENGINE_DIR"
fi

# 2. 实例（可选）
if [ -n "$INSTANCE_URL" ]; then
  if [ -d "$INSTANCE_DIR/.git" ]; then
    say "实例已存在 → git pull"
    git -C "$INSTANCE_DIR" pull --ff-only || say "[WARN] 实例更新失败 → 用现有版本继续"
  else
    say "克隆实例 → $INSTANCE_DIR"
    mkdir -p "$(dirname "$INSTANCE_DIR")"
    git clone "$INSTANCE_URL" "$INSTANCE_DIR"
  fi
else
  say "未提供 AI_SYNC_INSTANCE_URL → 单机本地模式（实例配置放在引擎目录下）"
  INSTANCE_DIR="$ENGINE_DIR"
  [ -f "$INSTANCE_DIR/sync/instance.json" ] || { mkdir -p "$INSTANCE_DIR/sync"; cp "$ENGINE_DIR/instance.example.json" "$INSTANCE_DIR/sync/instance.json"; say "已生成默认 sync/instance.json（请按需改 tick/console）"; }
fi

# 3. 安装器：注册调度（幂等）+ 状态表
say "注册调度（每 $INTERVAL 分钟）"
node "$ENGINE_DIR/install/install.mjs" --instance "$INSTANCE_DIR" --register --interval "$INTERVAL" || say "[WARN] 调度注册失败（见上面的原因；可手动重跑这条命令）"

say "状态表"
node "$ENGINE_DIR/tools/sync-status.mjs" --instance "$INSTANCE_DIR" || true

cat <<EOF

   完成。接下来：
     · 起图标：node "$ENGINE_DIR/apps/sync-console/server.mjs" --instance "$INSTANCE_DIR"   → http://127.0.0.1:7788/
     · macOS 菜单栏图标：bash "$ENGINE_DIR/apps/sync-tray/macos/build.sh" --install
     · 装机向导与排障：$ENGINE_DIR/docs/SETUP.md 与 docs/TROUBLESHOOTING.md
EOF
