@echo off
rem Local Claude launcher - runs from the folder you start it in.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-claude.ps1" %*
