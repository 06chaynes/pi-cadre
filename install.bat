@echo off
REM Runs setup_wizard.py with Python on Windows.

WHERE python >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: Python was not found in your PATH.
    echo Please install Python 3.9+ from https://python.org or via Microsoft Store.
    pause
    exit /b 1
)

python "%~dp0setup_wizard.py" %*
