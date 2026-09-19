#!/usr/bin/env node
/**
 * lib/notify.mjs —— 通知与告警去重的**单一源**
 *
 * 为什么抽出来：sync-heartbeat-alert.mjs 里那份 NotifyIcon/osascript 实现是"同一处逻辑"，
 * 备份审计若各自再抄一份，就会出现"改一处忘一处"的经典分叉（ops-playbook：同一处规则只留一份实现）。
 * 本模块只做两件事：弹通知、决定"该不该弹"（状态变化去重 + 最久 N 小时重弹一次）。
 */
import { spawn } from 'node:child_process';

/** 弹一条本机通知（best-effort：失败不影响判据本身） */
export function notify(title, body) {
  const t = String(title).replace(/'/g, "''");
  const b = String(body).replace(/'/g, "''").slice(0, 240);
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Warning; $n.Visible=$true; $n.ShowBalloonTip(15000,'${t}','${b}',[System.Windows.Forms.ToolTipIcon]::Warning); Start-Sleep -Seconds 8; $n.Dispose()`;
      spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `display notification "${b}" with title "${t}" sound name "Basso"`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      console.log(`[ALERT] ${title}: ${b}`);
    }
    return true;
  } catch { return false; }
}
