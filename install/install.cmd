@echo off
rem Starts the Local Claude installer window (install.ps1 next to this file).
rem Options are passed on, for example:  install.cmd -Dir "D:\Apps\LocalClaude"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
