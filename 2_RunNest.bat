@echo off
cd /d "%~dp0"
node "%~dp0nest.js" "%USERPROFILE%\Desktop\nest_input.json" "%USERPROFILE%\Desktop\nest_result.json"
if errorlevel 1 (
  echo.
  echo Something went wrong. Is Node.js installed? Did you run 1_ExportForNest.jsx first?
)
echo.
echo Done. Now run 3_ApplyNest.jsx in Illustrator.
pause
