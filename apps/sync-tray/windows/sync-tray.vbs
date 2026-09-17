' sync-tray.vbs - launch the tray with no window (so a double-click does not flash a console).
'
' Why: wscript.exe is a GUI host with no console of its own, and the PowerShell side adds
' -WindowStyle Hidden as a second layer. Keep this file PURE ASCII (wscript reads .vbs with the
' ANSI code page; non-ASCII bytes in a comment can swallow newlines and comment out the code).
'
' 2026-09-18: accepts an optional first argument = the INSTANCE root, and passes it through as
' -Instance. Before this, the shortcut launched the tray with no instance at all, so in the split
' layout (engine and instance in different directories) the tray fell back to the ENGINE root,
' found no sync\instance.json there, and showed a red icon with four bogus problems while the
' machine was actually fine. The shortcut is created by the tray itself, which already knows the
' instance root, so it can hand it over explicitly. The tray script has its own discovery chain
' as a fallback for shortcuts created before this change.
Option Explicit
Dim sh, fso, here, cmd, extra
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
extra = ""
If WScript.Arguments.Count >= 1 Then
  If Len(Trim(WScript.Arguments(0))) > 0 Then extra = " -Instance """ & WScript.Arguments(0) & """"
End If
cmd = "pwsh -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & here & "\sync-tray.ps1""" & extra
sh.Run cmd, 0, False
