@echo off
setlocal
cd /d "%~dp0"

REM Force UTF-8: Windows defaults to cp1251/cp1252 and mangles Bulgarian text.
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

where python >nul 2>&1
if errorlevel 1 (
  echo [!] Python not found on PATH. Install Python 3.12 and try again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [*] Creating virtual environment...
  python -m venv .venv
)

set PY=.venv\Scripts\python.exe

REM Reinstall only when requirements.txt is newer than the stamp file.
set NEEDS_INSTALL=0
if not exist ".venv\.deps-stamp" set NEEDS_INSTALL=1
if exist ".venv\.deps-stamp" (
  for /f %%i in ('powershell -NoProfile -Command "if((Get-Item requirements.txt).LastWriteTime -gt (Get-Item .venv\.deps-stamp).LastWriteTime){'1'}else{'0'}"') do set NEEDS_INSTALL=%%i
)

if "%NEEDS_INSTALL%"=="1" (
  echo [*] Installing dependencies...
  %PY% -m pip install --upgrade pip >nul
  %PY% -m pip install -r requirements.txt
  if errorlevel 1 ( echo [!] pip install failed. & pause & exit /b 1 )
  echo [*] Installing Chromium for Playwright...
  %PY% -m playwright install chromium
  echo ok > ".venv\.deps-stamp"
)

echo [*] Starting studio at http://127.0.0.1:8000
start "" http://127.0.0.1:8000
%PY% -m uvicorn app.main:app --host 127.0.0.1 --port 8000

endlocal
