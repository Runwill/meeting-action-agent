@echo off
setlocal
title Meeting Action Agent Launcher
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 goto NO_NPM

if not exist "node_modules\" goto NO_MODULES

where curl.exe >nul 2>nul
if errorlevel 1 goto START_SERVICES

curl.exe -s --max-time 2 "http://localhost:5174/" >nul 2>nul
if not errorlevel 1 goto ALREADY_RUNNING

:START_SERVICES
echo Starting the web app and Agent API...
start "Meeting Action Agent Services" cmd.exe /k "cd /d ""%~dp0"" && npm run demo"

echo Waiting for http://localhost:5174/ ...
set WAIT_COUNT=0

:WAIT_FOR_SERVER
timeout /t 1 /nobreak >nul
curl.exe -s --max-time 2 "http://localhost:5174/" >nul 2>nul
if not errorlevel 1 goto SERVER_READY
set /a WAIT_COUNT=WAIT_COUNT+1
if %WAIT_COUNT% LSS 20 goto WAIT_FOR_SERVER
goto START_FAILED

:SERVER_READY
start "" "http://localhost:5174/"
echo.
echo Demo opened: http://localhost:5174/
echo Keep the "Meeting Action Agent Services" window open.
echo Close that window when you want to stop the app.
echo.
pause
exit /b 0

:ALREADY_RUNNING
start "" "http://localhost:5174/"
echo.
echo The app is already running.
echo Demo opened: http://localhost:5174/
echo.
pause
exit /b 0

:NO_NPM
echo.
echo ERROR: npm was not found. Install Node.js first.
echo.
pause
exit /b 1

:NO_MODULES
echo.
echo ERROR: Project dependencies are not installed.
echo Run "npm install" in this project folder first.
echo.
pause
exit /b 1

:START_FAILED
echo.
echo ERROR: The app did not start within 20 seconds.
echo Check the "Meeting Action Agent Services" window for details.
echo.
pause
exit /b 1
