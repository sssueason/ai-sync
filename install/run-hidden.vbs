' run-hidden.vbs - hidden process runner for Windows Task Scheduler.
'
' Why this exists: if a task action is node.exe / pwsh.exe running as Interactive, Windows creates a
' console window, so a black box flashes on screen on every run (user report 2026-09-17: "sync and
' tick keep popping up windows"). wscript.exe itself has no console, and WshShell.Run(cmd, 0, True)
' (0 = SW_HIDE, True = wait for it) starts the child with no window at all.
'
' Exit code fidelity: WScript.Quit hands the child's exit code back to Task Scheduler, so the task's
' "Last Run Result" stays a real signal rather than a constant 0. A constant 0 would be a false green:
' a failed tick would still look healthy in every audit.
'
' The command is READ FROM A FILE rather than passed as an argument: a Task Scheduler argument is a
' raw string, and nesting quotes inside it gets merged by the WSH command-line parser (adjacent quotes
' are dropped). A file holds one full command line, so there is no escaping to get wrong.
' The command file is UTF-16LE (written by install.mjs) and is opened with TristateTrue (-1) on
' purpose: the default ANSI read would turn a non-ASCII path (e.g. C:\Users\<CJK>) into question
' marks and the child would never start (observed 2026-09-17).
'
' No error dialog: every failure path below is caught with On Error Resume Next. An unhandled
' VBScript error raises a modal "Windows Script Host" message box, which would be exactly the popup
' this script exists to avoid.
'
' IMPORTANT: keep this file PURE ASCII. wscript reads .vbs using the ANSI code page, so non-ASCII
' bytes in a comment can be mis-decoded and swallow newlines, which silently comments out the code
' below and changes the exit code (observed 2026-09-17: returned 3 instead of the child's code).
' sync-doctor.mjs asserts this file stays ASCII-only.
'
' Exit codes: 87 no argument, 2 command file missing, 5 command file unreadable,
'             3 command file empty, 4 could not start the command, otherwise the child's own code.
'
' Usage: wscript.exe run-hidden.vbs "<command-file>"
'   The command file lives at <instance>/sync/state/*-cmd.txt
Option Explicit
Dim fso, sh, cmdFile, cmd, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 1 Then WScript.Quit 87
cmdFile = WScript.Arguments(0)
If Not fso.FileExists(cmdFile) Then WScript.Quit 2
On Error Resume Next
cmd = fso.OpenTextFile(cmdFile, 1, False, -1).ReadAll
If Err.Number <> 0 Then
  Err.Clear
  WScript.Quit 5
End If
On Error GoTo 0
cmd = Trim(Replace(Replace(cmd, vbCr, " "), vbLf, " "))
If Len(cmd) = 0 Then WScript.Quit 3
On Error Resume Next
rc = sh.Run(cmd, 0, True)
If Err.Number <> 0 Then
  Err.Clear
  rc = 4
End If
On Error GoTo 0
WScript.Quit rc
