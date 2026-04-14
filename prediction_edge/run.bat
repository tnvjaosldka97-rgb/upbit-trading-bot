@echo off
chcp 65001 > nul
title Prediction Edge - Paper Trading
echo ============================================================
echo   Prediction Edge - Paper Trading Mode (DRY_RUN=true)
echo   Start date: %date%
echo   Check results: report.bat
echo ============================================================
echo.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
venv\Scripts\python.exe main.py
pause
