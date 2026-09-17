' sync-tray.vbs — 无窗口拉起托盘（双击不闪黑框）
' 说明：wscript.exe 是 GUI 宿主，本身没有控制台窗口；PowerShell 侧再加 -WindowStyle Hidden 双保险。
Option Explicit
Dim sh, fso, here, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "pwsh -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & here & "\sync-tray.ps1"""
sh.Run cmd, 0, False
