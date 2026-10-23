@echo off
rem ===================================================================
rem  CF 优选 IP —— 命令行通用入口
rem  用法：run-cfip.cmd [fast|full] [--dry-run] [--force] [--probe N] ...
rem    run-cfip.cmd                    默认走「快速」方案
rem    run-cfip.cmd full               走「全量」方案
rem    run-cfip.cmd fast --dry-run     只出方案，不写 Cloudflare
rem    run-cfip.cmd fast --skip-health 跳过现状体检，强制重新优选
rem ===================================================================
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
cd /d "%ROOT%"

rem ---------- 自动定位 Node.js ----------
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/zh-cn/download
  exit /b 1
)

set "SCRIPT=cfip-fast.mjs"
if /i "%~1"=="fast" ( shift & set "SCRIPT=cfip-fast.mjs" )
if /i "%~1"=="full" ( shift & set "SCRIPT=cfip-auto.mjs" )
"%NODE%" "%ROOT%src\%SCRIPT%" %*
exit /b %ERRORLEVEL%
