@echo off
rem Starts the Local Claude installer window (install.ps1 next to this file).
rem Options are passed on, for example:  install.cmd -Dir "D:\Apps\LocalClaude"
rem
rem Windows does not run PowerShell scripts by default. The two lines below lift that limit for
rem this one run and for the programs it starts. Nothing is changed in the PC's settings.
set "PSExecutionPolicyPreference=Bypass"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
