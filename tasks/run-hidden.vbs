' Launch check-alerts.ps1 fully hidden (window mode 0 = no console flash).
' MessageBox alerts still show, because powershell runs in the user session.
'
' 2026-08-11: path is now derived from this script's own location instead of being
' hardcoded to D:\AI\workspace\stock — the project is portable, so moving/copying the
' folder no longer silently breaks the whole watcher (it used to fail with no visible
' error: the scheduled task still reported success while nothing was ever checked).
Dim fso, scriptDir, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "check-alerts.ps1")
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
