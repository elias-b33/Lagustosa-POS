@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-safe-test.ps1" -Action stop -NoBrowser
pause
