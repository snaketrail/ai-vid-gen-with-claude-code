@echo off
REM Stop only THIS project's server (port 8000). Never use a blanket
REM "taskkill /IM python.exe": ComfyUI is also Python and would be killed too.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do (
  echo Stopping studio server PID %%p
  taskkill /F /PID %%p >nul 2>&1
)
