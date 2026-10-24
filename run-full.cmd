@echo off
chcp 65001 >nul
rem ===================================================================
rem  CF 优选 IP —— 全量模式（想挖最快节点时用，双击运行）
rem  逻辑：全量预筛 —— 初测 1 轮 —— 前 15 名大冲刺复核 —— 取最快的写入 Cloudflare
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

echo [全量优选] 开始……预计 6-8 分钟，请勿关闭窗口
echo.
"%NODE%" "%ROOT%src\cfip-auto.mjs" %*
set "RC=%ERRORLEVEL%"
echo.
echo ================================================
echo [全量优选] 退出码 %RC%
echo 日志：%ROOT%var\logs\latest.log
echo ================================================
pause
exit /b %RC%
