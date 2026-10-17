@echo off
cd /d "%~dp0"
echo Eleva Admin finns pa http://127.0.0.1:5194/
echo Kontouppgifter finns i %%LOCALAPPDATA%%\LagustosaPOS\eleva-admin\inloggning.txt
echo Detta startar endast den lokala testportalen.
call npm run admin:local
pause
