@echo off
title SR Kupang School Portal Server
cd /d "%~dp0"

echo Starting SR Kupang School Portal...
echo Keep this window open while the portal is in use.
echo.

call npm.cmd start

echo.
echo The portal server has stopped or could not start.
echo Check the message above, then press any key to close this window.
pause >nul
