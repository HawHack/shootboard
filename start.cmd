@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.13 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist .env (
  call npm run setup
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Open http://localhost:4318 in your browser.
call npm start
pause
