@echo off
setlocal

title SR Kupang Portal Server
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Node.js is not installed or is not available in PATH.
  echo Install Node.js, then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing portal dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo ERROR: Dependency installation failed.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo Starting SR Kupang Portal...
echo Keep this window open while using the portal.
echo Press Ctrl+C to stop the server.
echo.

call npm.cmd start
set "PORTAL_EXIT_CODE=%ERRORLEVEL%"

if not "%PORTAL_EXIT_CODE%"=="0" (
  echo.
  echo The portal server stopped with error code %PORTAL_EXIT_CODE%.
  pause
)

exit /b %PORTAL_EXIT_CODE%
