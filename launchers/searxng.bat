@echo off
rem Local SearXNG search for Pi web tools (pi-web-access), in Docker, reachable only from this machine.
rem
rem Usage: launchers\searxng.bat setup^|status^|teardown [--purge]
rem   setup     write the config (once) and start the container, then wait until it answers
rem   status    container state and which search engines answered a test query
rem   teardown  stop and remove the container; --purge also deletes the config directory
rem
rem Environment: SEARXNG_PORT (default 8888), SEARXNG_CONFIG_DIR (default %USERPROFILE%\.config\pi-cadre\searxng),
rem SEARXNG_CONTAINER (default pi-cadre-searxng).
setlocal EnableDelayedExpansion

rem A release at least two weeks old when this script was written; update deliberately.
set "IMAGE=searxng/searxng:2026.10.16-ff8f5ddcc"
if not defined SEARXNG_PORT set "SEARXNG_PORT=8888"
if not defined SEARXNG_CONFIG_DIR set "SEARXNG_CONFIG_DIR=%USERPROFILE%\.config\pi-cadre\searxng"
if not defined SEARXNG_CONTAINER set "SEARXNG_CONTAINER=pi-cadre-searxng"
set "URL=http://127.0.0.1:%SEARXNG_PORT%"

if "%~1"=="setup" goto :setup
if "%~1"=="status" goto :status
if "%~1"=="teardown" goto :teardown
if "%~1"=="" goto :help
if "%~1"=="-h" goto :help
if "%~1"=="--help" goto :help
echo searxng: unknown command '%~1' (setup^|status^|teardown) 1>&2
exit /b 1

:help
for /f "skip=1 tokens=1,* delims= " %%a in ('findstr /b "rem" "%~f0"') do (
  if "%%a"=="rem" echo(%%b
)
exit /b 0

:need_docker
where docker >nul 2>&1 || (echo searxng: docker is not installed ^(https://docs.docker.com/get-docker/^) 1>&2 & exit /b 1)
docker info >nul 2>&1 || (echo searxng: the Docker daemon is not running; start Docker Desktop and retry 1>&2 & exit /b 1)
exit /b 0

:answering
rem Sets ENGINES to the engines that answered a test query, or empty.
set "ENGINES="
for /f "usebackq delims=" %%e in (`powershell -NoProfile -Command "try { $r = Invoke-RestMethod -TimeoutSec 20 '%URL%/search?q=open+source+search&format=json'; ($r.results | ForEach-Object { $_.engines } | Sort-Object -Unique) -join ' ' } catch { '' }"`) do set "ENGINES=%%e"
exit /b 0

:write_config
if exist "%SEARXNG_CONFIG_DIR%\settings.yml" exit /b 0
if not exist "%SEARXNG_CONFIG_DIR%" mkdir "%SEARXNG_CONFIG_DIR%"
for /f "usebackq delims=" %%s in (`powershell -NoProfile -Command "-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })"`) do set "SECRET=%%s"
rem JSON output is what Pi web tools read. The engines below answered in testing; Brave and DuckDuckGo often
rem rate-limit or show a CAPTCHA to frequent automated queries.
(
  echo use_default_settings: true
  echo server:
  echo   secret_key: "!SECRET!"
  echo   limiter: false
  echo   image_proxy: false
  echo search:
  echo   formats:
  echo     - html
  echo     - json
  echo engines:
  echo   - name: bing
  echo     disabled: false
  echo   - name: yahoo
  echo     disabled: false
  echo   - name: mojeek
  echo     disabled: false
  echo   - name: startpage
  echo     disabled: false
) > "%SEARXNG_CONFIG_DIR%\settings.yml"
echo Wrote %SEARXNG_CONFIG_DIR%\settings.yml
exit /b 0

:setup
call :need_docker || exit /b 1
call :write_config
docker ps -a --format "{{.Names}}" | findstr /x "%SEARXNG_CONTAINER%" >nul
if %errorlevel%==0 (
  docker start "%SEARXNG_CONTAINER%" >nul
) else (
  docker run -d --name "%SEARXNG_CONTAINER%" --restart unless-stopped -p "127.0.0.1:%SEARXNG_PORT%:8080" -v "%SEARXNG_CONFIG_DIR%:/etc/searxng" "%IMAGE%" >nul
)
echo Waiting for SearXNG on %URL% ...
for /l %%i in (1,1,60) do (
  call :answering
  if defined ENGINES goto :up
  timeout /t 3 /nobreak >nul
)
echo searxng: SearXNG did not answer; see: docker logs %SEARXNG_CONTAINER% 1>&2
exit /b 1
:up
echo SearXNG is up on %URL% (answering engines: %ENGINES%).
echo.
echo To use it from Pi, install pi-web-access and put this in web-search.json in your Pi agent directory
echo (%%USERPROFILE%%\.pi\agent\web-search.json by default). "provider": "searxng" keeps every search on this instance:
echo.
echo   { "provider": "searxng", "searxngBaseUrl": "%URL%", "workflow": "none" }
exit /b 0

:status
call :need_docker || exit /b 1
set "STATE="
for /f "usebackq delims=" %%s in (`docker ps -a --filter "name=^%SEARXNG_CONTAINER%$" --format "{{.Status}}"`) do set "STATE=%%s"
if not defined STATE (
  echo %SEARXNG_CONTAINER%: not created ^(run: %~nx0 setup^)
  exit /b 0
)
echo %SEARXNG_CONTAINER%: %STATE%
call :answering
if defined ENGINES (echo Answering engines: %ENGINES%) else (echo No engine answered a test query on %URL%)
exit /b 0

:teardown
call :need_docker || exit /b 1
docker ps -a --format "{{.Names}}" | findstr /x "%SEARXNG_CONTAINER%" >nul
if %errorlevel%==0 (
  docker rm -f "%SEARXNG_CONTAINER%" >nul
  echo Removed container %SEARXNG_CONTAINER%
) else (
  echo No container %SEARXNG_CONTAINER%
)
if "%~2"=="--purge" (
  rmdir /s /q "%SEARXNG_CONFIG_DIR%"
  echo Deleted %SEARXNG_CONFIG_DIR%
)
exit /b 0
