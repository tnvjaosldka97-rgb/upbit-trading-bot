"use strict";

/**
 * TradingBot v9 — Main Orchestrator
 *
 * Core infrastructure for Upbit automated trading system.
 * - Loads dotenv config
 * - Initializes UpbitOrderService, strategies, regime engine, calibration engine
 * - Main loop: 1h interval for Strategy A, 5min for Strategy B
 * - Express dashboard on port 4020 (with fallback to 4021+)
 * - Health check endpoint, status API
 * - Graceful shutdown
 * - BOT_MODE: LIVE or CALIBRATION
 * - DRY_RUN support
 * - Railway deployment support (process.env.PORT)
 */

try { require("dotenv").config(); } catch {}

const http = require("http");
const { UpbitOrderService } = require("./upbit-order-service");
const { RegimeEngine }      = require("./regime-engine");
const { CalibrationEngine } = require("./calibration-engine");
const { StrategyA }         = require("./strategy-a");
const { StrategyB }         = require("./strategy-b");

// Multi-factor signal engines
const { MacroSignalEngine }         = require("./macro-signal-engine");
const { DataAggregationEngine }     = require("./data-aggregation-engine");
const { AlphaEngine }               = require("./alpha-engine");
const { MarketDataService }         = require("./market-data-service");

// Arbitrage subsystem (public data only — no API keys required)
const { createExchange, safeFetch }  = require("./exchange-adapter");
const { ExchangeWebSocketManager }  = require("./exchange-websocket");
const { UpbitWebSocket }            = require("./upbit-websocket");
const { CrossExchangeArb }          = require("./cross-exchange-arb");
const { ArbDataLogger }             = require("./arb-data-logger");
const { ArbExecutor }               = require("./arb-executor");

// ─── Config ───────────────────────────────────────────

const INITIAL_KRW = Number(process.env.INITIAL_CAPITAL || 100_000);
const BOT_MODE    = process.env.BOT_MODE || "CALIBRATION";
const DRY_RUN     = process.env.DRY_RUN !== "false";
const BASE_PORT   = Number(process.env.PORT || 4020);
const ARB_ENABLED        = process.env.ARB_ENABLED !== "false";
const ARB_USD_KRW_FALLBACK = Number(process.env.ARB_USD_KRW || 1480);
const ARB_DB_PATH        = process.env.ARB_DB_PATH || "./arb-data.db";
const ARB_FX_REFRESH_MS  = 5 * 60_000;

// Capital allocation: A 60% / B 40%
const CAPITAL_A = Math.floor(INITIAL_KRW * 0.60);
const CAPITAL_B = Math.floor(INITIAL_KRW * 0.40);

// Loop intervals
const STRATEGY_A_INTERVAL = 60 * 60_000;  // 1h
const STRATEGY_B_INTERVAL = 5 * 60_000;   // 5min (scan)
const REGIME_INTERVAL     = 15 * 60_000;  // 15min regime refresh
const HEALTH_LOG_INTERVAL = 10 * 60_000;  // 10min health log

class TradingBot {
  constructor() {
    // ── Order execution engine ──────────────────────
    this.orderService = new UpbitOrderService({
      accessKey: process.env.UPBIT_ACCESS_KEY,
      secretKey: process.env.UPBIT_SECRET_KEY,
    });

    // ── Regime detection ────────────────────────────
    this.regimeEngine = new RegimeEngine();

    // ── Kelly calibration ───────────────────────────
    this.calibEngine = new CalibrationEngine({
      rollingWindow: 200,
      minTrades:     20,
    });

    // ── Multi-factor signal engines ───────────────
    this.mds           = new MarketDataService();
    this.macroEngine   = new MacroSignalEngine(this.mds);
    this.dataAggEngine = new DataAggregationEngine();
    this.alphaEngine   = new AlphaEngine();

    // ── Strategy A: 1h Swing (BTC) ─────────────────
    this.strategyA = new StrategyA({
      orderService:   this.orderService,
      regimeEngine:   this.regimeEngine,
      calibEngine:    this.calibEngine,
      macroEngine:    this.macroEngine,
      dataAggEngine:  this.dataAggEngine,
      alphaEngine:    this.alphaEngine,
      initialCapital: CAPITAL_A,
      dryRun:         DRY_RUN,
    });

    // ── Strategy B: New Listing Pattern ─────────────
    this.strategyB = new StrategyB({
      orderService:   this.orderService,
      initialCapital: CAPITAL_B,
      dryRun:         DRY_RUN,
    });

    // ── WebSocket for real-time price (optional) ────
    this._ws = null;
    this._initWebSocket();

    // ── Arbitrage subsystem (public data — no keys) ─
    this.arb         = null;
    this.arbLogger   = null;
    this.arbMultiWs  = null;
    this.arbUpbitWs  = null;
    this.arbUsdKrw   = ARB_USD_KRW_FALLBACK;
    this._fxIntervalId = null;
    if (ARB_ENABLED) this._initArbSubsystem();

    // ── State tracking ──────────────────────────────
    this._startedAt       = null;
    this._regimeIntervalId = null;
    this._healthIntervalId = null;
    this._server           = null;
    this._shutdownCalled   = false;

    // Daily circuit breaker
    this._dailyStats = {
      date:        "",
      realizedPnl: 0,
      tradeCount:  0,
      consLosses:  0,
    };
    this.MAX_DAILY_LOSS   = INITIAL_KRW * 0.006;
    this.MAX_DAILY_TRADES = 8;
    this.MAX_CONS_LOSSES  = 3;
  }

  // ─── Startup ────────────────────────────────────────

  async start() {
    this._startedAt = Date.now();

    console.log("==================================================");
    console.log("  ATS v9 — Upbit Automated Trading System");
    console.log(`  Mode:       ${BOT_MODE}`);
    console.log(`  Capital:    ${INITIAL_KRW.toLocaleString()} KRW`);
    console.log(`  DRY_RUN:    ${DRY_RUN ? "ON (simulation)" : "OFF (LIVE!)"}`);
    console.log(`  API Keys:   ${this.orderService.getSummary().hasApiKeys ? "connected" : "missing"}`);
    console.log(`  Strategy A: ${CAPITAL_A.toLocaleString()} KRW (1h swing BTC)`);
    console.log(`  Strategy B: ${CAPITAL_B.toLocaleString()} KRW (new listings)`);
    console.log("==================================================");

    // ── Preflight check (live mode) ────────────────
    if (!DRY_RUN && BOT_MODE === "LIVE") {
      const ok = await this._preflight();
      if (!ok) {
        console.error("[TradingBot] preflight failed -- aborting. Set DRY_RUN=true to run in simulation.");
        process.exit(1);
      }
    }

    // ── Start dashboard ────────────────────────────
    await this._startDashboard();

    // ── Start regime engine (initial detect) ───────
    try {
      const regime = await this.regimeEngine.detect("KRW-BTC");
      console.log(`[TradingBot] initial regime: ${regime.regime} (confidence: ${regime.confidence})`);
    } catch (e) {
      console.error("[TradingBot] initial regime detect failed:", e.message);
    }

    // Periodic regime refresh
    this._regimeIntervalId = setInterval(async () => {
      try {
        await this.regimeEngine.detect("KRW-BTC");
      } catch (e) {
        console.error("[TradingBot] regime refresh error:", e.message);
      }
    }, REGIME_INTERVAL);

    // ── Start calibration engine ───────────────────
    this.calibEngine.start(60_000);
    console.log("[TradingBot] calibration engine started (1min interval)");

    // ── Start multi-factor signal engines ──────────
    this.macroEngine.start();
    console.log("[TradingBot] MacroSignalEngine started (kimchi/funding/feargreed)");
    this.dataAggEngine.start();
    console.log("[TradingBot] DataAggregationEngine started (OI/LS/taker/listings/news)");

    // ── Start Strategy A (1h interval) ─────────────
    this.strategyA.start(STRATEGY_A_INTERVAL);
    console.log(`[TradingBot] Strategy A started (${STRATEGY_A_INTERVAL / 60_000}min interval)`);

    // ── Start Strategy B (5min scan) ───────────────
    await this.strategyB.start();
    console.log(`[TradingBot] Strategy B started (${STRATEGY_B_INTERVAL / 1000}s scan interval)`);

    // ── Position recovery (live mode) ──────────────
    if (!DRY_RUN && this.orderService.getSummary().hasApiKeys) {
      const recovered = await this.orderService
        .reconcilePosition(["KRW-BTC"])
        .catch(e => { console.error("[TradingBot] recovery failed:", e.message); return null; });
      if (recovered) {
        console.log(`[TradingBot] recovered position: ${recovered.market} qty:${recovered.quantity}`);
      }
    }

    // ── Start Arbitrage Subsystem ──────────────────
    if (ARB_ENABLED) await this._startArbSubsystem();

    // ── Health logging ─────────────────────────────
    this._healthIntervalId = setInterval(() => this._logHealth(), HEALTH_LOG_INTERVAL);

    // ── Graceful shutdown ──────────────────────────
    process.on("SIGINT",  () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));

    console.log("[TradingBot] all systems running");
  }

  // ─── Arbitrage Subsystem Init (public data only) ────

  async _fetchUsdKrw() {
    // Upbit KRW-USDT = actual KRW per USD (USDT ≈ 1 USD)
    try {
      const res = await safeFetch("https://api.upbit.com/v1/ticker?markets=KRW-USDT");
      const data = await res.json();
      const rate = Number(data?.[0]?.trade_price);
      if (rate > 800 && rate < 3000) return rate;
    } catch (e) {
      console.error("[TradingBot] USD/KRW fetch failed:", e.message);
    }
    return null;
  }

  _initArbSubsystem() {
    try {
      // 6 REST adapters (no keys — public getTicker only)
      const restExchanges = {
        upbit:   createExchange("upbit",   {}),
        binance: createExchange("binance", {}),
        bybit:   createExchange("bybit",   {}),
        okx:     createExchange("okx",     {}),
        gate:    createExchange("gate",    {}),
        bithumb: createExchange("bithumb", {}),
      };
      this._arbExchanges = restExchanges;

      // WS managers (public streams, no keys)
      this.arbMultiWs = new ExchangeWebSocketManager();
      this.arbUpbitWs = new UpbitWebSocket({
        markets:        ["KRW-BTC","KRW-ETH","KRW-XRP","KRW-SOL","KRW-DOGE","KRW-ADA","KRW-AVAX","KRW-DOT","KRW-LINK"],
        subscribeTypes: ["ticker"],
      });

      // Cross-exchange spread detector (WS + REST dual mode)
      this.arb = new CrossExchangeArb({
        exchanges: restExchanges,
        usdKrw:    this.arbUsdKrw,
        multiExWs: this.arbMultiWs,
        upbitWs:   this.arbUpbitWs,
      });

      // Data logger (persistent SQLite)
      this.arbLogger = new ArbDataLogger({
        dbPath:    ARB_DB_PATH,
        exchanges: restExchanges,
        usdKrw:    this.arbUsdKrw,
      });

      // Executor (DRY_RUN default; controlled via env)
      this.arbExecutor = new ArbExecutor({
        exchanges:  restExchanges,
        dataLogger: this.arbLogger,
        usdKrw:     this.arbUsdKrw,
      });

      // Wire spread events → logger + executor
      // Logger dedup: max 1 event per coin+pair per 10s (bounded via pruning)
      const lastLogged = new Map();
      const LOG_DEDUP_MS = 10_000;
      this.arb.on("opportunity", (opp) => {
        const now = Date.now();
        const key = `${opp.symbol || opp.coin}-${opp.buyExchange}-${opp.sellExchange}`;
        const prev = lastLogged.get(key) || 0;
        if (now - prev >= LOG_DEDUP_MS) {
          lastLogged.set(key, now);
          try { this.arbLogger.logSpreadEvent(opp); } catch (e) {
            console.error("[TradingBot] logSpreadEvent error:", e.message);
          }
          // Periodic prune: drop entries older than 60s (bounds Map size)
          if (lastLogged.size > 500) {
            const cutoff = now - 60_000;
            for (const [k, t] of lastLogged) if (t < cutoff) lastLogged.delete(k);
          }
        }

        // Executor: evaluate every opportunity (has own persistence + cooldown gates)
        this.arbExecutor.execute(opp).catch(e => {
          console.error("[TradingBot] arbExecutor.execute error:", e.message);
        });
      });

      console.log("[TradingBot] arbitrage subsystem initialized (6 exchanges, public data)");
    } catch (e) {
      console.error("[TradingBot] arb init failed:", e.message, e.stack);
      this.arb = null;
      this.arbLogger = null;
    }
  }

  async _startArbSubsystem() {
    if (!this.arb) return;
    try {
      // 1) Fetch real USD/KRW rate BEFORE starting (critical for spread math)
      const rate = await this._fetchUsdKrw();
      if (rate) {
        this.arbUsdKrw = rate;
        this.arb.setUsdKrw(rate);
        this.arbLogger.setUsdKrw(rate);
        console.log(`[TradingBot] USD/KRW = ${rate} (live from Upbit)`);
      } else {
        console.warn(`[TradingBot] USD/KRW fetch failed — using fallback ${this.arbUsdKrw}`);
      }

      // 2) Start WS streams
      this.arbMultiWs.start(["BTC","ETH","XRP","SOL","DOGE","ADA","AVAX","DOT","LINK"]);
      this.arbUpbitWs.connect();

      // 3) Start detectors
      await this.arb.start();
      await this.arbLogger.start();

      // 4) Sanity check: logger actually ready?
      if (this.arbLogger._ready) {
        console.log("[TradingBot] ArbDataLogger ready — DB persistence active");
      } else {
        console.error("[TradingBot] ArbDataLogger NOT ready — DB persistence DISABLED");
      }

      // 5) Periodic FX refresh
      this._fxIntervalId = setInterval(async () => {
        const r = await this._fetchUsdKrw();
        if (r && Math.abs(r - this.arbUsdKrw) / this.arbUsdKrw > 0.001) {
          console.log(`[TradingBot] USD/KRW updated: ${this.arbUsdKrw} → ${r}`);
          this.arbUsdKrw = r;
          this.arb.setUsdKrw(r);
          this.arbLogger.setUsdKrw(r);
          this.arbExecutor?.setUsdKrw(r);
        }
      }, ARB_FX_REFRESH_MS);

      console.log("[TradingBot] arbitrage subsystem running");
    } catch (e) {
      console.error("[TradingBot] arb start failed:", e.message, e.stack);
    }
  }

  _stopArbSubsystem() {
    if (this._fxIntervalId) { clearInterval(this._fxIntervalId); this._fxIntervalId = null; }
    try { this.arb?.stop(); } catch {}
    try { this.arbLogger?.stop(); } catch {}
    try { this.arbMultiWs?.stop(); } catch {}
    try { this.arbUpbitWs?.disconnect(); } catch {}
  }

  // ─── WebSocket Init (optional, ws package) ──────────

  _initWebSocket() {
    try {
      const WebSocket = require("ws");
      const wsUrl = "wss://api.upbit.com/websocket/v1";
      const ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        console.log("[TradingBot] WebSocket connected");
        // Subscribe to BTC ticker
        ws.send(JSON.stringify([
          { ticket: "ats-v9-ws" },
          { type: "ticker", codes: ["KRW-BTC"] },
        ]));
      });

      ws.on("message", (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === "ticker" && data.code) {
            const price = data.trade_price;
            // Feed to Strategy A
            if (data.code === "KRW-BTC") {
              this.strategyA.onPriceUpdate(price);
            }
            // Feed to Strategy B (any subscribed market)
            this.strategyB.onPriceUpdate(data.code, price);
          }
        } catch {}
      });

      ws.on("error", (err) => {
        console.error("[TradingBot] WebSocket error:", err.message);
      });

      ws.on("close", () => {
        console.warn("[TradingBot] WebSocket disconnected -- reconnecting in 5s");
        setTimeout(() => this._initWebSocket(), 5000);
      });

      this._ws = ws;
    } catch {
      // ws package not available -- polling only
      console.log("[TradingBot] ws package not available -- using REST polling only");
    }
  }

  // ─── Dashboard (Express-like HTTP server) ───────────

  async _startDashboard() {
    const server = http.createServer((req, res) => {
      try {
        // CORS
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET");

        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this._getHealth()));
          return;
        }

        if (url.pathname === "/api/status") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this._getFullStatus()));
          return;
        }

        if (url.pathname === "/api/regime") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.regimeEngine.getSummary()));
          return;
        }

        if (url.pathname === "/api/calibration") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.calibEngine.getSummary()));
          return;
        }

        if (url.pathname === "/api/strategy-a") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.strategyA.getSummary()));
          return;
        }

        if (url.pathname === "/api/strategy-b") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.strategyB.getSummary()));
          return;
        }

        if (url.pathname === "/api/arb") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            enabled:  ARB_ENABLED,
            running:  !!this.arb,
            ws:       this.arbMultiWs?.getSummary?.() || null,
            arb:      this.arb?._stats || null,
            logger:   this.arbLogger?._stats || null,
          }));
          return;
        }

        // Default: HTML dashboard
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(this._renderDashboard());
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });

    // Try ports starting from BASE_PORT
    const port = await this._listen(server, BASE_PORT);
    this._server = server;
    console.log(`[TradingBot] dashboard running on http://0.0.0.0:${port}`);
  }

  _listen(server, port, maxRetries = 5) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryPort = (p) => {
        server.once("error", (err) => {
          if (err.code === "EADDRINUSE" && attempts < maxRetries) {
            attempts++;
            console.warn(`[TradingBot] port ${p} in use, trying ${p + 1}`);
            tryPort(p + 1);
          } else {
            reject(err);
          }
        });
        server.listen(p, "0.0.0.0", () => resolve(p));
      };
      tryPort(port);
    });
  }

  // ─── Dashboard HTML ─────────────────────────────────

  _renderDashboard() {
    const status   = this._getFullStatus();
    const regime   = status.regime;
    const stratA   = status.strategyA;
    const stratB   = status.strategyB;
    const calib    = status.calibration;
    const health   = status.health;

    const positionsHtml = (stratA.position
      ? `<tr><td>${stratA.position.market}</td><td>${stratA.position.entryPrice?.toLocaleString()}</td>` +
        `<td>${stratA.position.targetPrice?.toLocaleString()}</td>` +
        `<td>${stratA.position.stopPrice?.toLocaleString()}</td>` +
        `<td>${stratA.position.regime}</td></tr>`
      : ""
    ) + (stratB.positions || []).map(p =>
      `<tr><td>${p.market}</td><td>${p.entryPrice?.toLocaleString()}</td>` +
      `<td>${p.targetPrice?.toLocaleString()}</td>` +
      `<td>${p.stopPrice?.toLocaleString()}</td><td>listing</td></tr>`
    ).join("");

    const historyHtml = [...(stratA.history || []), ...(stratB.history || [])]
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
      .slice(0, 15)
      .map(h =>
        `<tr><td>${h.market}</td><td>${h.entryPrice?.toLocaleString()}</td>` +
        `<td>${h.exitPrice?.toLocaleString()}</td>` +
        `<td style="color:${h.pnlRate >= 0 ? '#2ecc71' : '#e74c3c'}">${(h.pnlRate * 100).toFixed(2)}%</td>` +
        `<td>${h.reason}</td></tr>`
      ).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ATS v9 Dashboard</title>
<meta http-equiv="refresh" content="30">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 16px; }
  h1 { color: #58a6ff; margin-bottom: 8px; font-size: 1.4em; }
  h2 { color: #8b949e; margin: 16px 0 8px; font-size: 1.1em; border-bottom: 1px solid #21262d; padding-bottom: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; }
  .card .label { color: #8b949e; font-size: 0.8em; text-transform: uppercase; }
  .card .value { font-size: 1.3em; font-weight: bold; margin-top: 2px; }
  .green { color: #2ecc71; }
  .red { color: #e74c3c; }
  .yellow { color: #f39c12; }
  .blue { color: #58a6ff; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.85em; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 600; }
  .badge-bull { background: #1a4731; color: #2ecc71; }
  .badge-bear { background: #4a1a1a; color: #e74c3c; }
  .badge-range { background: #3a3a1a; color: #f39c12; }
  .badge-live { background: #1a3a4a; color: #58a6ff; }
  .badge-dry { background: #2a2a2a; color: #8b949e; }
  .footer { margin-top: 20px; color: #484f58; font-size: 0.75em; text-align: center; }
</style>
</head>
<body>
<h1>ATS v9 Dashboard
  <span class="badge ${DRY_RUN ? 'badge-dry' : 'badge-live'}">${DRY_RUN ? 'DRY RUN' : 'LIVE'}</span>
  <span class="badge ${BOT_MODE === 'LIVE' ? 'badge-live' : 'badge-range'}">${BOT_MODE}</span>
</h1>

<div class="grid">
  <div class="card">
    <div class="label">Market Regime</div>
    <div class="value">
      <span class="badge ${regime.regime?.includes('BULL') ? 'badge-bull' : regime.regime?.includes('BEAR') ? 'badge-bear' : 'badge-range'}">
        ${regime.regime || 'N/A'}
      </span>
      <span style="font-size:0.7em; color:#8b949e"> confidence: ${regime.confidence || 0}</span>
    </div>
  </div>
  <div class="card">
    <div class="label">Bot Health</div>
    <div class="value ${health.healthy ? 'green' : 'red'}">${health.healthy ? 'HEALTHY' : 'UNHEALTHY'}</div>
    <div style="font-size:0.75em; color:#8b949e">uptime: ${health.uptimeHours}h | orders halted: ${health.orderEngineHalted ? 'YES' : 'no'}</div>
  </div>
  <div class="card">
    <div class="label">Strategy A (1h Swing BTC)</div>
    <div class="value ${stratA.pnlRate >= 0 ? 'green' : 'red'}">${stratA.pnlRate >= 0 ? '+' : ''}${stratA.pnlRate}%</div>
    <div style="font-size:0.75em; color:#8b949e">W:${stratA.wins} L:${stratA.losses} | WR:${stratA.winRate || 'N/A'}%</div>
  </div>
  <div class="card">
    <div class="label">Strategy B (New Listings)</div>
    <div class="value ${stratB.pnlRate >= 0 ? 'green' : 'red'}">${stratB.pnlRate >= 0 ? '+' : ''}${stratB.pnlRate}%</div>
    <div style="font-size:0.75em; color:#8b949e">W:${stratB.wins} L:${stratB.losses} | WR:${stratB.winRate || 'N/A'}% | monitoring: ${stratB.monitoringCount}</div>
  </div>
  <div class="card">
    <div class="label">Total P&L</div>
    <div class="value ${(stratA.realizedPnl + stratB.realizedPnl) >= 0 ? 'green' : 'red'}">
      ${((stratA.realizedPnl + stratB.realizedPnl) >= 0 ? '+' : '')}${(stratA.realizedPnl + stratB.realizedPnl).toLocaleString()} KRW
    </div>
  </div>
  <div class="card">
    <div class="label">Calibration</div>
    <div class="value blue">${calib.mode}</div>
    <div style="font-size:0.75em; color:#8b949e">
      trades: ${calib.totalTrades} | kelly: ${calib.halfKelly ? (calib.halfKelly * 100).toFixed(1) + '%' : 'N/A'} | EV: ${calib.expectedValue ? (calib.expectedValue * 100).toFixed(3) + '%' : 'N/A'}
    </div>
  </div>
</div>

<h2>Active Positions</h2>
<table>
<tr><th>Market</th><th>Entry</th><th>Target</th><th>Stop</th><th>Type</th></tr>
${positionsHtml || '<tr><td colspan="5" style="color:#484f58">No active positions</td></tr>'}
</table>

<h2>Recent Trades</h2>
<table>
<tr><th>Market</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr>
${historyHtml || '<tr><td colspan="5" style="color:#484f58">No trades yet</td></tr>'}
</table>

<h2>New Listing Detections</h2>
<table>
<tr><th>Market</th><th>Detected</th><th>Status</th><th>P&L</th></tr>
${(stratB.detections || []).slice(0, 10).map(d =>
  `<tr><td>${d.market}</td><td>${d.detectedAt ? new Date(d.detectedAt).toLocaleTimeString() : 'N/A'}</td>` +
  `<td>${d.status}</td><td>${d.finalPnl != null ? d.finalPnl + '%' : '-'}</td></tr>`
).join('') || '<tr><td colspan="4" style="color:#484f58">No detections</td></tr>'}
</table>

<div class="footer">
  ATS v9 | Auto-refresh 30s | Started: ${new Date(this._startedAt).toISOString()} |
  <a href="/api/status" style="color:#58a6ff">JSON API</a>
</div>
</body>
</html>`;
  }

  // ─── Status & Health ────────────────────────────────

  _getHealth() {
    const uptime = Date.now() - (this._startedAt || Date.now());
    return {
      healthy:           !this.orderService.halted && !this._isCircuitBroken(),
      uptimeMs:          uptime,
      uptimeHours:       +(uptime / 3_600_000).toFixed(1),
      orderEngineHalted: this.orderService.halted,
      haltReason:        this.orderService.haltReason,
      mode:              BOT_MODE,
      dryRun:            DRY_RUN,
      timestamp:         new Date().toISOString(),
    };
  }

  _getFullStatus() {
    return {
      health:      this._getHealth(),
      regime:      this.regimeEngine.getSummary(),
      calibration: this.calibEngine.getSummary(),
      strategyA:   this.strategyA.getSummary(),
      strategyB:   this.strategyB.getSummary(),
      orderEngine: this.orderService.getSummary(),
      config: {
        initialCapital: INITIAL_KRW,
        capitalA:       CAPITAL_A,
        capitalB:       CAPITAL_B,
        botMode:        BOT_MODE,
        dryRun:         DRY_RUN,
      },
    };
  }

  _logHealth() {
    const h = this._getHealth();
    const a = this.strategyA.getSummary();
    const b = this.strategyB.getSummary();
    const r = this.regimeEngine.getSummary();
    console.log(
      `[TradingBot] health -- ${h.healthy ? "OK" : "UNHEALTHY"} | ` +
      `uptime: ${h.uptimeHours}h | regime: ${r.regime} | ` +
      `A: ${a.pnlRate}% (${a.totalTrades} trades) | ` +
      `B: ${b.pnlRate}% (${b.totalTrades} trades) | ` +
      `positions: A=${a.position ? 1 : 0} B=${(b.positions || []).length}`
    );
  }

  // ─── Circuit Breaker ────────────────────────────────

  _isCircuitBroken() {
    const today = new Date().toLocaleDateString("ko-KR");
    if (this._dailyStats.date !== today) {
      this._dailyStats = { date: today, realizedPnl: 0, tradeCount: 0, consLosses: 0 };
    }
    const s = this._dailyStats;
    if (s.realizedPnl < -this.MAX_DAILY_LOSS) return true;
    if (s.tradeCount >= this.MAX_DAILY_TRADES) return true;
    if (s.consLosses >= this.MAX_CONS_LOSSES) return true;
    return false;
  }

  // ─── Preflight Check ───────────────────────────────

  async _preflight() {
    console.log("[TradingBot] preflight check...");
    const checks = [];

    // API keys
    checks.push({ name: "API keys", ok: this.orderService.getSummary().hasApiKeys });

    // Account balance
    let krw = 0;
    try {
      krw = await this.orderService.getBalance("KRW");
      checks.push({ name: `KRW balance (${krw.toLocaleString()})`, ok: krw >= 5000 });
    } catch (e) {
      checks.push({ name: "KRW balance", ok: false, reason: e.message });
    }

    // Capital check
    checks.push({
      name: `balance >= 50% of INITIAL_CAPITAL (${INITIAL_KRW.toLocaleString()})`,
      ok: krw >= INITIAL_KRW * 0.5,
    });

    // Upbit API
    try {
      const res = await safeFetch("https://api.upbit.com/v1/ticker?markets=KRW-BTC");
      checks.push({ name: "Upbit API response", ok: res.ok });
    } catch (e) {
      console.warn("[TradingBot] healthCheck:", e.message);
      checks.push({ name: "Upbit API response", ok: false });
    }

    let allOk = true;
    console.log("[TradingBot] --- preflight results ---");
    for (const c of checks) {
      const mark = c.ok ? "PASS" : "FAIL";
      console.log(`[TradingBot]   [${mark}] ${c.name}${c.reason ? ` -- ${c.reason}` : ""}`);
      if (!c.ok) allOk = false;
    }
    console.log("[TradingBot] ----------------------------");

    return allOk;
  }

  // ─── Shutdown ───────────────────────────────────────

  async shutdown(signal) {
    if (this._shutdownCalled) return;
    this._shutdownCalled = true;

    console.log(`\n[TradingBot] shutdown (${signal})`);

    // Stop intervals
    if (this._regimeIntervalId)  clearInterval(this._regimeIntervalId);
    if (this._healthIntervalId)  clearInterval(this._healthIntervalId);

    // Stop engines
    this.calibEngine.stop();
    try { this.macroEngine.stop(); } catch {}
    try { this.dataAggEngine.stop(); } catch {}
    this.strategyA.stop();
    this.strategyB.stop();

    // Stop arbitrage subsystem
    this._stopArbSubsystem();

    // Close WebSocket
    if (this._ws) {
      try { this._ws.close(); } catch {}
    }

    // Close HTTP server
    if (this._server) {
      this._server.close();
    }

    // Emergency position close (live mode)
    if (!DRY_RUN && this.orderService.getSummary().hasApiKeys) {
      console.log("[TradingBot] closing live positions...");
      try {
        const accounts = await this.orderService.getAccounts();
        for (const acc of accounts) {
          if (acc.currency === "KRW") continue;
          const bal = Number(acc.balance);
          if (bal > 0.00001) {
            const market = `KRW-${acc.currency}`;
            await this.orderService.cancelAllOpenOrders(market).catch(() => {});
            await this.orderService.marketSell(market, bal)
              .catch(e => console.error(`[TradingBot] failed to close ${market}:`, e.message));
          }
        }
      } catch (e) {
        console.error("[TradingBot] position close error:", e.message);
      }
    }

    console.log("[TradingBot] shutdown complete");
    process.exit(0);
  }
}

// ─── Global Error Handlers ────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("[TradingBot] uncaught exception:", err.message, err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error("[TradingBot] unhandled rejection:", reason);
});

// ─── Entry Point ──────────────────────────────────────

const bot = new TradingBot();
bot.start().catch((e) => {
  console.error("[TradingBot] startup failed:", e.message);
  process.exit(1);
});
