' Launch check-alerts.ps1 fully hidden (window mode 0 = no console flash).
' MessageBox alerts still show, because powershell runs in the user session.
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\AI\workspace\stock\tasks\check-alerts.ps1", 0, False
