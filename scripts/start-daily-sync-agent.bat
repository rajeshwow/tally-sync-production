@echo off
setlocal

cd /d "%~dp0.."

echo ==========================================
echo FlexLoud Tally Sync Agent Starting
echo Folder: %CD%
echo Mode: API + single scheduler process
echo ==========================================

echo Building latest source...
call npm run build

if errorlevel 1 (
  echo Build failed. Agent not started.
  exit /b 1
)

echo Starting API agent on configured PORT...
node dist\index.js

endlocal
