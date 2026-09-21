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
if errorlevel 1 goto CHECK_API_WITHOUT_WEB

curl.exe -s --max-time 2 "http://localhost:8788/api/health" >nul 2>nul
if not errorlevel 1 goto ALREADY_RUNNING
goto START_API_ONLY

:CHECK_API_WITHOUT_WEB
curl.exe -s --max-time 2 "http://localhost:8788/api/health" >nul 2>nul
if not errorlevel 1 goto START_WEB_ONLY
goto START_SERVICES

:START_SERVICES
echo Starting the web app and Agent API...
powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -WorkingDirectory '%~dp0' -FilePath 'npm.cmd' -ArgumentList @('run','demo')"
goto WAIT_FOR_SERVICES

:START_API_ONLY
echo The web app is running, but the Agent API is not. Starting the Agent API...
powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -WorkingDirectory '%~dp0' -FilePath 'npm.cmd' -ArgumentList @('exec','--','tsx','watch','server/index.ts')"
goto WAIT_FOR_SERVICES

:START_WEB_ONLY
echo The Agent API is running, but the web app is not. Starting the web app...
powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -WorkingDirectory '%~dp0' -FilePath 'npm.cmd' -ArgumentList @('exec','--','vite','--port','5174','--strictPort')"
goto WAIT_FOR_SERVICES

:WAIT_FOR_SERVICES
echo Waiting for the web app and Agent API...
set WAIT_COUNT=0

:WAIT_FOR_SERVER
timeout /t 1 /nobreak >nul
curl.exe -s --max-time 2 "http://localhost:5174/" >nul 2>nul
if errorlevel 1 goto WAIT_AGAIN
curl.exe -s --max-time 2 "http://localhost:8788/api/health" >nul 2>nul
if not errorlevel 1 goto SERVER_READY

:WAIT_AGAIN
set /a WAIT_COUNT=WAIT_COUNT+1
if %WAIT_COUNT% LSS 20 goto WAIT_FOR_SERVER
goto START_FAILED

:SERVER_READY
start "" "http://localhost:5174/"
echo.
echo Demo opened: http://localhost:5174/
exit /b 0

:ALREADY_RUNNING
start "" "http://localhost:5174/"
echo.
echo The web app and Agent API are already running.
echo Demo opened: http://localhost:5174/
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
echo ERROR: The web app or Agent API did not start within 20 seconds.
echo Check the service window for details.
echo.
pause
exit /b 1
