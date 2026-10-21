@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在用浏览器打开 FocusBoard 预览...
echo （浏览器版没有托盘和系统通知，数据存在浏览器本地）
echo.
start "" "%~dp0src\index.html"
timeout /t 2 >nul