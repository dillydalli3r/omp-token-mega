@echo off
rem ===========================================================================
rem  omp-token-mega - automatic installer for oh-my-pi (omp) on Windows
rem
rem    install.bat            install from github:dillydalli3r/omp-token-mega
rem    install.bat local      install this working copy (link; needs symlink rights)
rem    install.bat force      reinstall / upgrade over an existing install
rem    install.bat nopause    never wait for a keypress when finished
rem    install.bat help       usage
rem ===========================================================================
setlocal EnableExtensions

set "PKG=@dillydalli3r/omp-token-mega"
set "SPEC=github:dillydalli3r/omp-token-mega"

rem project root = directory holding this script, without the trailing backslash
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "MODE=repo"
set "FORCE="
set "NOPAUSE="

rem keep the window open only when launched by double-click: Explorer runs the script
rem through "cmd /c <path>", while a command typed into an open console leaves the command
rem line as the bare cmd.exe path. Compared as variables, never echoed - a path may contain
rem characters the command line would re-parse. "nopause" is honored at the end.
set "PAUSE_END="
set "CL=%CMDCMDLINE:"=%"
if not "%CL%"=="%CL:/c=%" set "PAUSE_END=1"

:args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /i "%ARG%"=="local" set "MODE=local" & shift & goto args
if /i "%ARG%"=="link" set "MODE=local" & shift & goto args
if /i "%ARG%"=="force" set "FORCE=--force" & shift & goto args
if /i "%ARG%"=="-f" set "FORCE=--force" & shift & goto args
if /i "%ARG%"=="--force" set "FORCE=--force" & shift & goto args
if /i "%ARG%"=="nopause" set "NOPAUSE=1" & shift & goto args
if /i "%ARG%"=="help" goto usage
if /i "%ARG%"=="-h" goto usage
if /i "%ARG%"=="--help" goto usage
echo Unknown argument: %ARG%
set "RC=2"
goto usage
:args_done

rem omp prints check/cross glyphs; a UTF-8 console renders them
set "OLDCP="
for /f "tokens=2 delims=:" %%C in ('chcp') do set "OLDCP=%%C"
chcp 65001 >nul 2>nul

echo omp-token-mega installer
echo ------------------------------------------------------------
echo.

rem --- preflight: omp itself, then the package manager omp installs with ------
set "OMP_EXE="
for /f "delims=" %%P in ('where omp 2^>nul') do if not defined OMP_EXE set "OMP_EXE=%%P"
if not defined OMP_EXE goto no_omp
echo   omp    : %OMP_EXE%

set "BUN_EXE="
for /f "delims=" %%P in ('where bun 2^>nul') do if not defined BUN_EXE set "BUN_EXE=%%P"
if not defined BUN_EXE goto no_bun
echo   bun    : %BUN_EXE%
echo.

rem --- install ---------------------------------------------------------------
set "TARGET=%SPEC%"
set "WHAT=%SPEC%"
if /i "%MODE%"=="local" set "TARGET=%ROOT%"
if /i "%MODE%"=="local" set "WHAT=working copy %ROOT%"

rem omp's local install is a symlink and has no rollback: a link this shell cannot
rem create would leave no plugin installed at all. Probe first, refuse if it fails.
if /i not "%MODE%"=="local" goto do_install
set "PROBE=%TEMP%\omp-token-mega-link-probe"
set "PROBETARGET=%TEMP%\omp-token-mega-link-probe-target"
rmdir /s /q "%PROBE%" >nul 2>nul
rmdir /s /q "%PROBETARGET%" >nul 2>nul
mkdir "%PROBE%" >nul 2>nul
mkdir "%PROBETARGET%" >nul 2>nul
mklink /d "%PROBE%\link" "%PROBETARGET%" >nul 2>nul
set "LINKED=%errorlevel%"
rmdir "%PROBE%\link" >nul 2>nul
rmdir /s /q "%PROBE%" >nul 2>nul
rmdir /s /q "%PROBETARGET%" >nul 2>nul
if not "%LINKED%"=="0" goto no_symlink
echo   symlink: ok, the working copy can be linked
echo.

:do_install
if defined FORCE set "WHAT=%WHAT% --force"
echo   installing %WHAT%
echo.
call omp plugin install "%TARGET%" %FORCE%
if errorlevel 1 goto install_failed
echo.

rem --- verify: listed by omp, and its settings resolve on disk --------------
echo   verifying
call omp plugin list 2>&1 | findstr /i /c:"omp-token-mega"
if errorlevel 1 goto verify_failed
call omp plugin config list "%PKG%" >nul 2>&1
if errorlevel 1 goto verify_failed

echo.
echo   [ok] %PKG% installed and enabled
echo.
echo   Next:
echo     - start a new omp session: extension modules are imported at session start
echo     - /mega            opens the menu - report, status, settings, preset, audit,
echo                        tune, cache, lithos, account, reset
echo     - /mega report     every section at once, as plain text
echo     - /mega tune       the cost and time profile for this model, and how to apply it
echo     - /mega config     all settings with the layer that supplied each
echo     - omp plugin config list %PKG%
echo.
set "RC=0"
goto finish

rem --- failures --------------------------------------------------------------
:no_omp
echo   [XX] omp is not on PATH. This plugin runs inside oh-my-pi only.
echo        Install oh-my-pi, open a new terminal so PATH is refreshed, run again.
set "RC=1"
goto finish

:no_bun
echo   [XX] bun is not on PATH - omp installs plugins by running "bun install".
echo        Install Bun, open a new terminal so PATH is refreshed, run again:
echo          powershell -c "irm bun.sh/install.ps1 ^| iex"
set "RC=1"
goto finish

:no_symlink
echo   [XX] This shell cannot create symlinks, and omp's local install IS a symlink.
echo        A failed link leaves no plugin installed, so nothing was changed here.
echo        Turn on Developer Mode - Settings - System - For developers - or run
echo        this from an elevated terminal, then re-run install.bat local.
echo        To install the published package instead, run: install.bat
set "RC=1"
goto finish

:install_failed
echo.
echo   [XX] Install failed - omp's own error is printed above.
if /i "%MODE%"=="local" echo        local mode creates a symlink: enable Developer Mode under
if /i "%MODE%"=="local" echo        Settings - System - For developers, or run this as Administrator.
if /i not "%MODE%"=="local" echo        Check that this machine can reach github.com, then re-run.
if /i not "%MODE%"=="local" echo        A failed install rolls back; the previous state is intact.
if /i not "%MODE%"=="local" echo        Diagnostics: omp plugin doctor --fix
set "RC=1"
goto finish

:verify_failed
echo.
echo   [XX] Install finished but omp does not list the plugin. Repair with:
echo          omp plugin doctor --fix
set "RC=1"
goto finish

rem --- usage -----------------------------------------------------------------
:usage
if not defined RC set "RC=0"
echo omp-token-mega installer for oh-my-pi
echo.
echo   install.bat            install from %SPEC%
echo   install.bat local      install this working copy - a link, needs symlink rights
echo   install.bat force      reinstall or upgrade over an existing install
echo   install.bat nopause    do not wait for a keypress when finished
echo   install.bat help       this text
goto finish

:finish
if defined NOPAUSE set "PAUSE_END="
if defined OLDCP chcp %OLDCP% >nul 2>nul
if defined PAUSE_END pause
endlocal & exit /b %RC%
