@echo off
REM Starts llama-server using lfm3_config.env (see that file for MODEL values). Flags override the config.
setlocal
set "PROJECT_DIR=%~dp0.."
if exist "%PROJECT_DIR%\lfm3_config.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%G in ("%PROJECT_DIR%\lfm3_config.env") do set "%%G=%%H"
)

:args
if "%~1"=="" goto run
if /i "%~1"=="-m" (set "MODEL=%~2") else if /i "%~1"=="-c" (set "CTX_SIZE=%~2") else if /i "%~1"=="-np" (set "PARALLEL_SLOTS=%~2") else if /i "%~1"=="-p" (set "PORT=%~2") else if /i "%~1"=="-ngl" (set "N_GPU_LAYERS=%~2") else (
    echo Usage: %~nx0 [-m dual^|spark^|lfm3^|HF_ID^|PATH.gguf] [-c CTX_SIZE] [-np PARALLEL_SLOTS] [-p PORT] [-ngl GPU_LAYERS]
    exit /b 1
)
shift
shift
goto args

:run
where llama-server >nul 2>nul || (
    echo llama-server not found in PATH. Install llama.cpp or run: python setup_wizard.py
    exit /b 1
)
if not defined MODEL set MODEL=dual

if /i "%MODEL%"=="dual" (
    start "Spark-X2.6-4B" cmd /k ""%~f0" -m spark -c "" -np "" -p """
    start "LFM3-1.7B" cmd /k ""%~f0" -m lfm3 -c "" -np "" -p """
    exit /b 0
)

set "DEFAULTS=8080 32768 8"
set "ID=%MODEL%"
if /i "%MODEL%"=="lfm3" (
    set "DEFAULTS=8081 32768 16"
    set "ID=LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"
    if defined LFM3_MODEL set "ID=%LFM3_MODEL%"
)
if /i "%MODEL%"=="spark" (
    set "DEFAULTS=8080 65536 8"
    set "ID=XHToken/Spark-X2.6-4B-GGUF:Q4_K_M"
    if defined SPARK_MODEL set "ID=%SPARK_MODEL%"
)
set SOURCE=-hf "%ID%"
if /i "%ID:~-5%"==".gguf" set SOURCE=-m "%ID%"
for /f "tokens=1-3" %%a in ("%DEFAULTS%") do (
    if not defined PORT set PORT=%%a
    if not defined CTX_SIZE set CTX_SIZE=%%b
    if not defined PARALLEL_SLOTS set PARALLEL_SLOTS=%%c
)
if not defined HOST set HOST=127.0.0.1
if not defined N_GPU_LAYERS set N_GPU_LAYERS=99

llama-server %SOURCE% --host %HOST% --port %PORT% --ctx-size %CTX_SIZE% --parallel %PARALLEL_SLOTS% -ngl %N_GPU_LAYERS% --jinja
