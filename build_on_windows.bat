@echo off
setlocal EnableExtensions
REM ============================================================================
REM  filo - build ON a Windows PC (double-click this file).
REM
REM  Produces, in the dist folder:
REM    filo-Setup-<version>.exe       installer (NSIS)
REM    filo-<version>-win-x64.zip     portable version
REM
REM  The Mac can build Windows too (build_windows.command); this script is for
REM  building on Windows itself: no Wine needed for the installer.
REM  The result is not signed: SmartScreen warns on first launch.
REM
REM  Plain ASCII on purpose: the Windows console reads .bat files in an old
REM  code page, and accented letters come out garbled.
REM ============================================================================

cd /d "%~dp0"
title filo - Windows build
echo.
echo   filo - build for Windows (x64)
echo   ------------------------------

REM -- 1. Node.js -------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed.
  echo   Install the LTS version from https://nodejs.org then run this file again.
  goto :fail
)
for /f "usebackq delims=" %%v in (`node -p "process.versions.node"`) do set NODEV=%%v
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"
if errorlevel 1 (
  echo   Node.js %NODEV% is too old: 20.19 or newer is needed, 22 LTS recommended.
  echo   Install it from https://nodejs.org then run this file again.
  goto :fail
)
echo   [1/3] Node.js %NODEV%
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set VER=%%v

REM -- 2. Dependencies --------------------------------------------------------
REM  The tool itself is checked, not the folder: an interrupted install leaves
REM  a node_modules that exists and cannot build.
if exist "node_modules\.bin\electron-builder.cmd" (
  echo   [2/3] Dependencies ready
) else (
  echo   [2/3] Installing dependencies - the first time takes a few minutes...
  call npm ci
  if errorlevel 1 call npm install
  if not exist "node_modules\.bin\electron-builder.cmd" (
    echo   The dependencies could not be installed. Check the internet connection,
    echo   and do not build from a network share: copy the folder to a local disk.
    goto :fail
  )
)

REM -- 3. Build ---------------------------------------------------------------
echo   [3/3] Building filo %VER%...
REM  No certificate: do not let electron-builder go looking for one.
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --config electron-builder.yml --win nsis zip --x64
if errorlevel 1 goto :buildfail

echo.
echo   Done.
echo     Installer : dist\filo-Setup-%VER%.exe
echo     Portable  : dist\filo-%VER%-win-x64.zip
if exist "dist\win-unpacked\resources\filo-engine.exe" (echo   Rust engine: included.) else (echo   Rust engine: NOT included - the reason is on the [engine] lines above. filo works with its built-in engine.)
if exist "dist\win-unpacked\resources\syncthing\syncthing.exe" (echo   SYNCTHING: included.) else (echo   SYNCTHING: NOT included - see the [direct] lines above.)
echo   Not signed: on first launch SmartScreen warns - "More info" then "Run anyway".
start "" "%~dp0dist"
goto :end

:buildfail
echo.
echo   The build failed - the reason is in the lines above.
echo   If they mention "symbolic link" or "privilege": turn on Developer Mode
echo   (Settings, System, For developers) and run this file again.

:fail
echo.
pause
exit /b 1

:end
echo.
pause
exit /b 0
