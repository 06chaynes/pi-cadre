@echo off
REM Starts Pi on the local llama-server model selected by MODEL in cadre_config.env (LFM3 for "lfm3", Spark otherwise).
REM Needs this repo installed as a Pi package (setup_wizard.py or pi install); its extension registers the llama-cpp provider.
setlocal
set "PROJECT_DIR=%~dp0.."
if exist "%PROJECT_DIR%\cadre_config.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%G in ("%PROJECT_DIR%\cadre_config.env") do set "%%G=%%H"
)

where pi >nul 2>nul || (
    echo pi not found in PATH. Run: python setup_wizard.py
    exit /b 1
)

if /i "%MODEL%"=="lfm3" (
    pi --provider llama-cpp --model LiquidAI/LFM3-1.7B-GGUF:Q4_K_M %*
) else (
    pi --provider llama-cpp --model XHToken/Spark-X2.6-4B-GGUF:Q4_K_M %*
)
