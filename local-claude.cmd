@echo off
rem Local Claude launcher - runs from the folder you start it in.
rem Windows does not run PowerShell scripts by default: lifted for this run only, no setting is changed.
set "PSExecutionPolicyPreference=Bypass"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-claude.ps1" %*
