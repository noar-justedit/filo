@echo off
rem Windows: publishes this folder to GitHub. Double-click it.
rem The work is done by push_github.ps1 (see the explanations at its top).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push_github.ps1"
