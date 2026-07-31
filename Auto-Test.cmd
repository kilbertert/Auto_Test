@echo off
setlocal
chcp 65001 >nul
title Auto-Test AI 自动化测试

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-windows.ps1" %*
set RESULT=%ERRORLEVEL%

if "%~1"=="" (
  echo.
  if not "%RESULT%"=="0" echo Auto-Test 已退出，错误码：%RESULT%
  pause
)

exit /b %RESULT%
