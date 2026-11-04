@echo off
REM Starts llama-server using cadre_config.env (see that file for MODEL values). Flags override the config;
REM arguments after -- go to llama-server.
setlocal
REM shift also moves %0, so the script's path and name are kept before the flags are read.
set "SELF=%~f0"
set "SELF_NAME=%~nx0"
REM The arguments as written: what follows " -- " goes to llama-server unchanged. Taking them one at a time (%1, %2)
REM would split values at = , and ; and re-quote them. The space at each end lets a first or last "--" match " -- ".
set "SPACE= "
set ALL= %*%SPACE%
REM A dual-mode server window receives the arguments after -- from the script that started it, in the environment.
if not defined CADRE_DUAL_EXTRA set "EXTRA_ARGS="
set "CADRE_DUAL_EXTRA="
set "PROJECT_DIR=%~dp0.."
if exist "%PROJECT_DIR%\cadre_config.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%G in ("%PROJECT_DIR%\cadre_config.env") do set "%%G=%%H"
)

:args
if "%~1"=="" goto run
if "%~1"=="--" goto extra
if "%~1"=="-h" goto help
if "%~1"=="--help" goto help
set "FLAG="
if "%~1"=="-m" set "FLAG=MODEL"
if "%~1"=="--model" set "FLAG=MODEL"
if "%~1"=="-c" set "FLAG=CTX_SIZE"
if "%~1"=="--ctx-size" set "FLAG=CTX_SIZE"
if "%~1"=="-np" set "FLAG=PARALLEL_SLOTS"
if "%~1"=="--parallel" set "FLAG=PARALLEL_SLOTS"
if "%~1"=="-p" set "FLAG=PORT"
if "%~1"=="--port" set "FLAG=PORT"
if "%~1"=="-ngl" set "FLAG=N_GPU_LAYERS"
if "%~1"=="--gpu-layers" set "FLAG=N_GPU_LAYERS"
if not defined FLAG (
    call :usage >&2
    exit /b 1
)
set "%FLAG%=%~2"
shift
shift
goto args

:extra
set EXTRA_ARGS=%ALL:* -- = %
goto run

:help
call :usage
exit /b 0

:usage
echo Usage: %SELF_NAME% [-m dual^|spark^|lfm3^|reranker^|HF_ID^|PATH.gguf] [-c CTX_SIZE] [-np PARALLEL_SLOTS] [-p PORT] [-ngl GPU_LAYERS] [-- llama-server args]
exit /b 0

:run
where llama-server >nul 2>nul || (
    >&2 echo llama-server not found in PATH. Install llama.cpp or run: python setup_wizard.py
    exit /b 1
)
if not defined MODEL set MODEL=dual

if /i "%MODEL%"=="dual" goto dual

set "DEFAULTS=8080 32768 8"
set "ID=%MODEL%"
set "MODE_ARGS="
if /i "%MODEL%"=="reranker" (
    set "DEFAULTS=8082 8192 1"
    set "ID=ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF"
    if defined RERANKER_MODEL set "ID=%RERANKER_MODEL%"
    set "MODE_ARGS= --embedding --pooling rank --reranking -ub 8192 -b 8192"
)
if /i "%MODEL%"=="lfm3" (
    set "DEFAULTS=8081 65536 4"
    set "ID=LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"
    if defined LFM3_MODEL set "ID=%LFM3_MODEL%"
)
if /i "%MODEL%"=="spark" (
    set "DEFAULTS=8080 131072 4"
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

llama-server %SOURCE% --host %HOST% --port %PORT% --ctx-size %CTX_SIZE% --parallel %PARALLEL_SLOTS% -ngl %N_GPU_LAYERS% --jinja%MODE_ARGS%%EXTRA_ARGS%
exit /b

REM Dual mode starts each server in its own window, at its own defaults (port, context, slots), with -ngl and the
REM arguments after --. "call" keeps the script's path quoted for the window's cmd.
:dual
set "CADRE_DUAL_EXTRA=1"
start "Spark-X2.6-4B" cmd /k call "%SELF%" -m spark -c "" -np "" -p "" -ngl "%N_GPU_LAYERS%"
start "LFM3-1.7B" cmd /k call "%SELF%" -m lfm3 -c "" -np "" -p "" -ngl "%N_GPU_LAYERS%"
exit /b 0
