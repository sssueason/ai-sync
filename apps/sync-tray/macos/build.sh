#!/usr/bin/env bash
# build.sh — 编译 macOS 菜单栏托盘（SyncTray.app）
#
# 对应 Windows 侧 apps/sync-tray/windows/（PowerShell + WinForms）。
# 与仓库既有做法一致（见 dsh/app/launcher-mac/build.sh）：swiftc 单文件直编 + ad-hoc 签名，不引入 Xcode 工程。
#
# 用法：
#   bash build.sh             # 产出 dist/SyncTray.app
#   bash build.sh --install   # 顺便装到 /Applications
#   bash build.sh --probe     # 编译后直接跑 CLI 探针（打印状态与悬浮文案，不弹 UI）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$HERE/dist"
APP="$DIST/SyncTray.app"

command -v swiftc >/dev/null 2>&1 || { echo "[FAIL] 找不到 swiftc（需要 Xcode Command Line Tools：xcode-select --install）"; exit 2; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "== 编译 SyncTray.swift =="
swiftc -O -o "$APP/Contents/MacOS/SyncTray" "$HERE/SyncTray.swift" -framework AppKit

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>SyncTray</string>
  <key>CFBundleIdentifier</key><string>cn.ai-sync.tray</string>
  <key>CFBundleExecutable</key><string>SyncTray</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "   [WARN] ad-hoc 签名失败（Gatekeeper 首次打开可能要右键→打开）"
echo "   [OK] $APP"

if [ "${1:-}" = "--probe" ]; then
  echo "== CLI 探针（真实状态与悬浮文案）=="
  "$APP/Contents/MacOS/SyncTray" --probe
fi

if [ "${1:-}" = "--install" ]; then
  rm -rf "/Applications/SyncTray.app"
  cp -R "$APP" /Applications/
  echo "   [OK] 已装到 /Applications/SyncTray.app（首次打开：右键→打开，或 xattr -dr com.apple.quarantine）"
fi

echo "== 提示 =="
echo "   打开：open \"$APP\"    菜单栏出现循环双箭头 + 右下角状态角标"
echo "   自启：菜单里勾「随登录自启」（写 ~/Library/LaunchAgents/cn.ai-sync.tray.plist）"
echo "   ⚠️ 本 App 首次编译需在 macOS 上人工验证 —— 请把 --probe 输出回填到机器卡"
