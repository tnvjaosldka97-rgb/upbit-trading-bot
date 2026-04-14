@echo off
title ATS v9 - Global Arbitrage System
echo ══════════════════════════════════════════
echo  ATS v9 — Global Multi-Exchange Arb Bot
echo  6 Exchanges: Upbit/Bithumb/Binance/Bybit/OKX/Gate
echo  Mode: Simulation (Data Accumulation until 4/24)
echo ══════════════════════════════════════════
echo.
node --max-old-space-size=512 trading-bot.js
pause
