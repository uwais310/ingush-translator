@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org , install it, then run this file again.
  pause
  exit /b 1
)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo A file named .env was created. Paste your Gemini key after GEMINI_API_KEY= , save the file and close Notepad.
  notepad ".env"
)
node server.js
pause
