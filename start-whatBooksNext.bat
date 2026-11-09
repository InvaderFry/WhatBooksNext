@echo off
rem Starts whatBooksNext. Double-click this file, or run it from a Command Prompt.
rem It checks Node.js, installs and builds on first run (or after an update), then opens the app
rem in your browser at http://localhost:4818 . Keep the window open while you use the app.
setlocal
cd /d "%~dp0"
title whatBooksNext

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Install the current LTS version from https://nodejs.org
  echo ^(choose the "LTS" download^), then double-click this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 24 (
  echo.
  echo whatBooksNext needs Node.js 24 or newer; this PC has
  node -v
  echo Install the current LTS version from https://nodejs.org , then try again.
  echo.
  pause
  exit /b 1
)

node scripts\start.ts %*
if errorlevel 1 pause
endlocal
