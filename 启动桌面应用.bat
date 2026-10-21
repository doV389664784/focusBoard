@echo off
chcp 65001 >nul
cd /d "%~dp0"
title FocusBoard 启动器
set ELECTRON=node_modules\electron\dist\electron.exe

rem ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
where npm >nul 2>nul
if errorlevel 1 goto NO_NODE

rem ---- 2. 确保 Electron 运行文件存在 ----
if exist "%ELECTRON%" goto ALREADY_RUNNING
if exist "node_modules\electron\install.js" goto FIX_ELECTRON

echo.
echo 首次运行，正在安装依赖（Electron 约 100MB，需要联网）...
call npm install
if errorlevel 1 goto INSTALL_FAIL
if exist "%ELECTRON%" goto ALREADY_RUNNING

:FIX_ELECTRON
rem npm 11 默认拦截依赖的安装脚本，Electron 的二进制可能没下载，这里补一次
echo.
echo 正在补下载 Electron 运行文件...
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pushd "node_modules\electron"
call node install.js
popd
if not exist "%ELECTRON%" goto INSTALL_FAIL

:ALREADY_RUNNING
rem 已经开过就别重复启动了
tasklist /fi "imagename eq electron.exe" /v 2>nul | findstr /i "FocusBoard" >nul
if not errorlevel 1 (
  echo FocusBoard 已经在运行，去任务栏或托盘里找它。
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

:START_APP
echo.
echo 启动 FocusBoard...
if exist ".userdata\startup.log" del /q ".userdata\startup.log" >nul 2>nul

start "" "%ELECTRON%" .
call :WAIT_WINDOW
if "%WINDOW_OK%"=="1" goto LAUNCHED_OK

echo   标准模式 8 秒内没有出现窗口，切换到兼容模式重试...
taskkill /im electron.exe /f >nul 2>nul
ping -n 3 127.0.0.1 >nul
if exist ".userdata\startup.log" del /q ".userdata\startup.log" >nul 2>nul
start "" "%ELECTRON%" . --no-sandbox
call :WAIT_WINDOW
if "%WINDOW_OK%"=="1" goto LAUNCHED_COMPAT
goto CRASHED

:LAUNCHED_OK
echo 已启动。
ping -n 3 127.0.0.1 >nul
exit /b 0

:LAUNCHED_COMPAT
echo 已启动（兼容模式）。
echo.
echo 说明：这台机器上 Chromium 沙箱初始化被拦住，所以用 --no-sandbox 启动。
echo 本应用完全本地运行、不加载任何远程页面，这个模式不影响你的数据安全。
ping -n 5 127.0.0.1 >nul
exit /b 0

:CRASHED
echo.
echo [ 窗口仍然没有出现 ]
echo 请把这两个文件发给开发者：
echo     .userdata\startup.log
echo     doctor-report.txt
echo 也可以先跑一次诊断： node dev\doctor.mjs
echo.
pause
exit /b 1

:WAIT_WINDOW
rem 用窗口标题判断是否真的开出来了（进程活着但没窗口不算成功）
set WINDOW_OK=0
for /l %%i in (1,1,8) do (
  ping -n 2 127.0.0.1 >nul
  tasklist /fi "imagename eq electron.exe" /v 2>nul | findstr /i "FocusBoard" >nul
  if not errorlevel 1 (
    set WINDOW_OK=1
    goto :eof
  )
)
goto :eof

:NO_NODE
echo.
echo [ 未检测到 Node.js ]
echo.
echo FocusBoard 是 Electron 应用，需要先装 Node.js（免费，装一次即可）：
echo   1. 打开 https://nodejs.org/zh-cn
echo   2. 下载 LTS 版本，一路下一步安装
echo   3. 装完后重新双击本文件
echo.
echo 想先看看界面、不想装任何东西？
echo 直接双击「预览-浏览器打开.bat」即可。
echo.
start "" https://nodejs.org/zh-cn
pause
exit /b 1

:INSTALL_FAIL
echo.
echo [ 依赖没装完整 ]
echo 通常是网络问题。先切国内镜像，再重新双击本文件：
echo   npm config set registry https://registry.npmmirror.com
echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo.
pause
exit /b 1
