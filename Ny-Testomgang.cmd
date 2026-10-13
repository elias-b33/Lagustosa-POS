@echo off
echo Detta startar en tom testomgang. Tidigare testomgangar sparas.
pause
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-safe-test.ps1" -Action new-session
pause
