@echo off
rem Starts whatBooksNext. Double-click this file, or run it from a Command Prompt.
rem It checks Node.js, installs and builds on first run (or after an update), then opens the app
rem in your browser at http://localhost:4818 . Keep the window open while you use the app;
rem closing it stops the app.
setlocal
cd /d "%~dp0"
title whatBooksNext

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed, or Windows can't find it yet.
  echo  - Not installed? Get the "LTS" version from https://nodejs.org ^(see INSTALL.md^).
  echo  - Just installed it? Close this window and double-click this file again.
  echo    If that doesn't help, restart the PC.
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
