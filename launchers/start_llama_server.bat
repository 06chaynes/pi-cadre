@echo off
REM High-Performance llama-server launcher for Windows (CUDA/Vulkan/CPU)
setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set PROJECT_DIR=%SCRIPT_DIR%..

IF EXIST "%PROJECT_DIR%\lfm3_config.env" (
    FOR /F "tokens=1,2 delims==" %%G IN (%PROJECT_DIR%\lfm3_config.env) DO (
        SET %%G=%%H
    )
)

IF "%PORT%"=="" SET PORT=8080
IF "%HOST%"=="" SET HOST=127.0.0.1
IF "%MODEL_ID%"=="" SET MODEL_ID=LiquidAI/LFM3-1.7B-GGUF:Q4_K_M
IF "%PARALLEL_SLOTS%"=="" SET PARALLEL_SLOTS=16
IF "%N_GPU_LAYERS%"=="" SET N_GPU_LAYERS=99
IF "%CTX_SIZE%"=="" SET CTX_SIZE=32768

:parse_args
IF "%~1"=="" GOTO done_args
IF /I "%~1"=="-c" (
    SET CTX_SIZE=%~2
    SHIFT & SHIFT
    GOTO parse_args
)
IF /I "%~1"=="--ctx-size" (
    SET CTX_SIZE=%~2
    SHIFT & SHIFT
    GOTO parse_args
)
IF /I "%~1"=="-np" (
    SET PARALLEL_SLOTS=%~2
    SHIFT & SHIFT
    GOTO parse_args
)
IF /I "%~1"=="--parallel" (
    SET PARALLEL_SLOTS=%~2
    SHIFT & SHIFT
    GOTO parse_args
)
IF /I "%~1"=="-p" (
    SET PORT=%~2
    SHIFT & SHIFT
    GOTO parse_args
)
IF /I "%~1"=="-h" (
    echo Usage: %~nx0 [-c CTX_SIZE] [-np PARALLEL_SLOTS] [-p PORT]
    echo   -c,  --ctx-size  Total KV cache pool (e.g. 32768, 65536, 131072, 262144)
    echo   -np, --parallel  Number of concurrent parallel slots (default: 16)
    exit /b 0
)
SHIFT
GOTO parse_args

:done_args
SET /A PER_SLOT_CTX=%CTX_SIZE% / %PARALLEL_SLOTS%

echo ==========================================================
echo  Starting llama-server with LFM3-1.7B-GGUF (Windows)
echo  Host:            %HOST%:%PORT%
echo  Model:           %MODEL_ID%
echo  Parallel Slots:  %PARALLEL_SLOTS% slots
echo  GPU Offload:     %N_GPU_LAYERS% layers
echo  Context Pool:    %CTX_SIZE% tokens
echo  Slot Capacity:   ~%PER_SLOT_CTX% tokens/slot
echo  Model Max Train: 262,144 tokens (256k)
echo ==========================================================

WHERE llama-server >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: llama-server executable not found in PATH.
    echo Please install llama.cpp or run: python setup_wizard.py
    pause
    exit /b 1
)

llama-server.exe -hf "%MODEL_ID%" --host %HOST% --port %PORT% --ctx-size %CTX_SIZE% --parallel %PARALLEL_SLOTS% -ngl %N_GPU_LAYERS% --jinja
