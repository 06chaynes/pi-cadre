@echo off
REM Ollama launcher for Windows

echo Starting Ollama...
WHERE ollama >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: ollama executable not found in PATH.
    pause
    exit /b 1
)

start /b ollama serve
timeout /t 2 /nobreak >nul
echo Pulling latest LFM3 model if not present...
ollama pull lfm3:latest
echo Ollama is ready and serving lfm3:latest on http://127.0.0.1:11434
