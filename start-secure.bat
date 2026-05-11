@echo off
setlocal enabledelayedexpansion

:: Victor Hugo - Secure Remote Access with Cloudflare
:: Run: start-secure.bat

title Victor Hugo - Secure Remote Access

echo.
echo ========================================
echo   Victor Hugo - Secure Remote Access
echo   (Cloudflare Tunnel)
echo ========================================
echo.

:: Set project root
set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"

:: Status indicators
set "STEP=[*]"
set "OK=[+]"
set "ERR=[!]"

:: ==========================================
:: CHECK NODE.JS
:: ==========================================
echo %STEP% Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo %ERR% Node.js is not installed!
    echo     Please install from https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo %OK% Node.js found: %NODE_VERSION%

:: ==========================================
:: CHECK/INSTALL CLOUDFLARED
:: ==========================================
echo %STEP% Checking cloudflared...
set "CLOUDFLARED_PATH=%PROJECT_ROOT%cloudflared.exe"

where cloudflared >nul 2>&1
if %errorlevel% equ 0 (
    set "CLOUDFLARED=cloudflared"
    echo %OK% cloudflared is installed globally
    goto :cloudflared_ready
)

if exist "%CLOUDFLARED_PATH%" (
    set "CLOUDFLARED=%CLOUDFLARED_PATH%"
    echo %OK% Found local cloudflared.exe
    goto :cloudflared_ready
)

echo %STEP% Downloading cloudflared...
powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%CLOUDFLARED_PATH%' -UseBasicParsing"

if exist "%CLOUDFLARED_PATH%" (
    set "CLOUDFLARED=%CLOUDFLARED_PATH%"
    echo %OK% cloudflared downloaded successfully
) else (
    echo %ERR% Failed to download cloudflared!
    echo     Please install manually: winget install Cloudflare.cloudflared
    pause
    exit /b 1
)

:cloudflared_ready

:: ==========================================
:: FIND AVAILABLE PORTS
:: ==========================================
echo %STEP% Finding available ports...

set "SERVER_PORT=3000"
for /l %%p in (3000,1,3020) do (
    netstat -ano | findstr ":%%p" | findstr "LISTENING" >nul 2>&1
    if !errorlevel! neq 0 (
        set "SERVER_PORT=%%p"
        goto :found_server_port
    )
)
:found_server_port
echo %OK% Server will use port %SERVER_PORT%

set "CLIENT_PORT=5173"
for /l %%p in (5173,1,5183) do (
    netstat -ano | findstr ":%%p" | findstr "LISTENING" >nul 2>&1
    if !errorlevel! neq 0 (
        set "CLIENT_PORT=%%p"
        goto :found_client_port
    )
)
:found_client_port
echo %OK% Client will use port %CLIENT_PORT%

:: ==========================================
:: INSTALL DEPENDENCIES IF NEEDED
:: ==========================================
if not exist "%PROJECT_ROOT%server\node_modules" (
    echo %STEP% Installing server dependencies...
    cd /d "%PROJECT_ROOT%server"
    call npm install
    if %errorlevel% neq 0 (
        echo %ERR% Failed to install server dependencies!
        pause
        exit /b 1
    )
    echo %OK% Server dependencies installed
)

if not exist "%PROJECT_ROOT%client\node_modules" (
    echo %STEP% Installing client dependencies...
    cd /d "%PROJECT_ROOT%client"
    call npm install
    if %errorlevel% neq 0 (
        echo %ERR% Failed to install client dependencies!
        pause
        exit /b 1
    )
    echo %OK% Client dependencies installed
)

cd /d "%PROJECT_ROOT%"

:: ==========================================
:: START SERVER
:: ==========================================
echo %STEP% Starting server on port %SERVER_PORT%...
start "VictorHugo-Server" cmd /k "cd /d ""%PROJECT_ROOT%server"" && set PORT=%SERVER_PORT% && npm run dev"

echo     Waiting for server...
set "SERVER_READY=0"
for /l %%i in (1,1,15) do (
    timeout /t 1 >nul
    powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:%SERVER_PORT%/api/health' -UseBasicParsing -TimeoutSec 1 -ErrorAction SilentlyContinue; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
    if !errorlevel! equ 0 (
        set "SERVER_READY=1"
        goto :server_ok
    )
    echo     Waiting... %%i/15
)
:server_ok
if %SERVER_READY% equ 0 (
    echo %ERR% Server failed to start!
    pause
    exit /b 1
)
echo %OK% Server is running on port %SERVER_PORT%

:: ==========================================
:: START CLIENT
:: ==========================================
echo %STEP% Building client...
cd /d "%PROJECT_ROOT%client"
set VITE_API_PORT=%SERVER_PORT%
call npm run build
if %errorlevel% neq 0 (
    echo %ERR% Failed to build client!
    pause
    exit /b 1
)
echo %OK% Client built successfully

start "VictorHugo-Client" cmd /k "cd /d ""%PROJECT_ROOT%client"" && set VITE_API_PORT=%SERVER_PORT% && node server.cjs %CLIENT_PORT%"

echo     Waiting for client...
set "CLIENT_READY=0"
for /l %%i in (1,1,10) do (
    timeout /t 1 >nul
    netstat -ano | findstr ":%CLIENT_PORT%" | findstr "LISTENING" >nul 2>&1
    if !errorlevel! equ 0 (
        set "CLIENT_READY=1"
        goto :client_ok
    )
    echo     Waiting... %%i/10
)
:client_ok
if %CLIENT_READY% equ 0 (
    echo %ERR% Client failed to start!
    pause
    exit /b 1
)
echo %OK% Client is running on port %CLIENT_PORT%

:: ==========================================
:: START CLOUDFLARE TUNNEL (IPv4 FIX)
:: ==========================================
echo.
echo ========================================
echo   Starting Cloudflare Tunnel
echo ========================================
echo.
echo   Press Ctrl+C to stop everything.
echo.
echo ----------------------------------------
echo.

:: FORCE IPv4 to avoid Windows localhost IPv6 issue
%CLOUDFLARED% tunnel --url http://127.0.0.1:%CLIENT_PORT%

:: ==========================================
:: CLEANUP
:: ==========================================
echo.
echo %STEP% Shutting down...

taskkill /FI "WINDOWTITLE eq VictorHugo-Server*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq VictorHugo-Client*" /F >nul 2>&1

echo %OK% Stopped
echo.
pause
