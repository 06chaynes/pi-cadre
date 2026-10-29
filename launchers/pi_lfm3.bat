@echo off
REM Quick launcher for Pi configured with local LFM3 on Windows

SET LLAMA_BASE_URL=http://127.0.0.1:8080
SET OPENAI_BASE_URL=http://127.0.0.1:8080/v1
SET OPENAI_API_KEY=none

WHERE pi >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: pi executable not found in PATH.
    echo Run: python setup_wizard.py
    pause
    exit /b 1
)

pi --provider llama-cpp --model LiquidAI/LFM3-1.7B-GGUF:Q4_K_M %*
