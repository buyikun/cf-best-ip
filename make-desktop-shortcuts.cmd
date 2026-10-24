@echo off
chcp 65001 >nul
rem ===== 在桌面创建 CF 优选的一键运行快捷方式（双击即可）=====
rem 想删除快捷方式：在命令行执行
rem   powershell -NoProfile -ExecutionPolicy Bypass -File "src\make-desktop-shortcuts.ps1" -Remove
setlocal
cd /d "%~dp0"
echo 正在创建桌面快捷方式（快速模式 / 全量模式）...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\make-desktop-shortcuts.ps1" %*
echo.
echo ================================
echo 完成。上面显示"已创建"即成功，去桌面看看。
echo ================================
pause
