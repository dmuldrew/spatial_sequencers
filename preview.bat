@echo off
rem Spatial Sequencers - local preview (Windows)
rem Double-click this file, or run it from a terminal in the repo root.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "pyrosync\node_modules\d3" (
  echo Installing PyroSync dependencies ^(first run only^)...
  pushd pyrosync
  call npm install --omit=dev --no-audit --no-fund
  popd
)

node preview.js %*
endlocal
