@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Auto-Test AI 自动化测试

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未检测到 Node.js 24。
  echo 请先访问 https://nodejs.org/ 安装 Node.js 24，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

for /f "delims=." %%V in ('node -p "process.versions.node"') do set NODE_MAJOR=%%V
if %NODE_MAJOR% LSS 24 (
  echo.
  echo 当前 Node.js 版本过低，需要 Node.js 24 或更高版本。
  echo 请访问 https://nodejs.org/ 完成升级。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\tsx.cmd" (
  echo.
  echo 首次使用，正在安装 Auto-Test 依赖……
  call npm ci
  if errorlevel 1 goto failed
)

node -e "const fs=require('fs'); const p=require('@playwright/test').chromium.executablePath(); process.exit(fs.existsSync(p)?0:1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo 首次使用，正在安装浏览器……
  call npx playwright install chromium
  if errorlevel 1 goto failed
)

if "%~1"=="" (
  call npm run easy
) else (
  call npm run easy -- %*
)
set RESULT=%ERRORLEVEL%
echo.
if not "%RESULT%"=="0" echo Auto-Test 已退出，错误码：%RESULT%
if "%~1"=="" pause
exit /b %RESULT%

:failed
echo.
echo 自动准备失败，请检查网络、Node.js 和 npm 后重试。
pause
exit /b 1
