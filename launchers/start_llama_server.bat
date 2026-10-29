@echo off
REM High-Performance llama-server launcher for Windows (CUDA/Vulkan/CPU)

IF "%PORT%"=="" SET PORT=8080
IF "%HOST%"=="" SET HOST=127.0.0.1
IF "%MODEL_ID%"=="" SET MODEL_ID=LiquidAI/LFM3-1.7B-GGUF:Q4_K_M
IF "%PARALLEL_SLOTS%"=="" SET PARALLEL_SLOTS=16
IF "%N_GPU_LAYERS%"=="" SET N_GPU_LAYERS=99
IF "%CTX_SIZE%"=="" SET CTX_SIZE=32768

echo ==========================================================
echo  Starting llama-server with LFM3-1.7B-GGUF (Windows)
echo  Host:           %HOST%:%PORT%
echo  Model:          %MODEL_ID%
echo  Parallel Slots: %PARALLEL_SLOTS%
echo  GPU Offload:    %N_GPU_LAYERS% layers
echo  Context Window: %CTX_SIZE% tokens
echo ==========================================================

WHERE llama-server >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: llama-server executable not found in PATH.
    echo Please install llama.cpp or run: python setup_wizard.py
    pause
    exit /b 1
)

llama-server.exe -hf "%MODEL_ID%" --host %HOST% --port %PORT% --ctx-size %CTX_SIZE% --parallel %PARALLEL_SLOTS% -ngl %N_GPU_LAYERS% --jinja
