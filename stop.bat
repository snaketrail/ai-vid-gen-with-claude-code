@echo off
REM Stop only THIS project's server (port 8000).
REM Never use a blanket "taskkill /IM python.exe": ComfyUI is also Python and
REM would be killed too.
powershell -NoProfile -Command ^
  "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('Stopping studio server PID ' + $_.OwningProcess); Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
echo Done.
