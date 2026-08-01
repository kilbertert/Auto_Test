@echo off
setlocal
chcp 65001 >nul
title Auto-Test AI Automation

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-windows.ps1" %*
set "RESULT=%ERRORLEVEL%"

if not "%~1"=="" goto :exit
echo.
if not "%RESULT%"=="0" echo Auto-Test exited with code %RESULT%.
if "%AUTO_TEST_NO_PAUSE%"=="1" goto :exit
pause

:exit
exit /b %RESULT%
