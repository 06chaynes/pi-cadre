@echo off
REM Starts Pi on the local llama-server model selected by MODEL in lfm3_config.env (LFM3 for "lfm3", Spark otherwise).
REM Run setup_wizard.py first; it registers the llama-cpp provider and the extension with Pi.
setlocal
set "PROJECT_DIR=%~dp0.."
if exist "%PROJECT_DIR%\lfm3_config.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%G in ("%PROJECT_DIR%\lfm3_config.env") do set "%%G=%%H"
)

where pi >nul 2>nul || (
    echo pi not found in PATH. Run: python setup_wizard.py
    exit /b 1
)

if /i "%MODEL%"=="lfm3" (
    set LLAMA_BASE_URL=http://127.0.0.1:8081
    pi --provider llama-cpp --model LiquidAI/LFM3-1.7B-GGUF:Q4_K_M %*
) else (
    set LLAMA_BASE_URL=http://127.0.0.1:8080
    pi --provider llama-cpp --model XHToken/Spark-X2.6-4B-GGUF:Q4_K_M %*
)
