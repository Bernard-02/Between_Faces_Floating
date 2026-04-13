@echo off
REM Start a tiny local web server and open the tool in your browser.
REM Requires Python 3 in PATH.

cd /d "%~dp0"
set PORT=8000
set URL=http://localhost:%PORT%/

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 not found in PATH. Please install Python 3 first.
  pause
  exit /b 1
)

echo Serving on %URL%
echo Press Ctrl+C to stop.

start "" "%URL%"
python -m http.server %PORT%
