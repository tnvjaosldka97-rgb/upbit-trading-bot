@echo off
chcp 65001 > nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
venv\Scripts\python.exe -X utf8 tools\daily_report.py --all
pause
