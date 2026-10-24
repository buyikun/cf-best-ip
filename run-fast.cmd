@echo off
chcp 65001 >nul
rem ===================================================================
rem  CF 优选 IP —— 快速模式（日常用，双击运行）
rem  逻辑：先体检 DNS 里正在用的 IP —— 达标就收工；
rem        不达标才按序实测，凑够就停 —— 取最快 3 个写入 Cloudflare
rem ===================================================================
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

rem ---------- 自动定位 Node.js（不写死路径）----------
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo.
  echo   [错误] 没有检测到 Node.js，无法运行。
  echo.
  echo   请先安装 Node.js（免费，装 LTS 版即可）：
  echo       https://nodejs.org/zh-cn/download
  echo   安装完成后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo [快速优选] 开始……达标则几秒收工，不达标最多几分钟
echo.
"%NODE%" "%ROOT%src\cfip-fast.mjs" %*
set "RC=%ERRORLEVEL%"
echo.
echo ================================================
echo [快速优选] 退出码 %RC%
echo 日志：%ROOT%var\logs\latest.log
echo ================================================
pause
exit /b %RC%
