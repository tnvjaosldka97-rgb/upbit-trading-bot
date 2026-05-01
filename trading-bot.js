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

// Trade journal (SQLite-backed, viewed via dashboard)
const { TradeLogger }               = require("./trade-logger");
const { TelegramNotifier }          = require("./telegram-notifier");

// Strategy C — 한국 3사 동일지역 차익 모니터
const { CoinoneAdapter }            = require("./exchange-coinone");
const { StrategyC }                 = require("./strategy-c");

// 0.1% 퀀트 표준 인프라
const { PerformanceTracker }        = require("./lib/performance");
const { RotationEngine }            = require("./rotation-engine");
const { RiskManager }               = require("./risk-manager");
const { Reconciler }                = require("./reconciler");
const { AutoBacktest }              = require("./auto-backtest");
const { Watchdog }                  = require("./watchdog");
const { SimulationValidator }       = require("./simulation-validator");

// 매수/매도 무결성 인프라
const { OrderRouter }               = require("./order-router");
const { PositionLedger }            = require("./position-ledger");
const { PositionWatchdog }          = require("./position-watchdog");

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
// Strategy A: 1h 캔들 기준이지만 5분 주기로 evaluate(시그널 성숙 시 즉시 진입)
const STRATEGY_A_INTERVAL = 5 * 60_000;   // 5min evaluate (was 60min)
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

    // ── Trade journal (sim + live, SQLite) ─────────
    this.tradeLogger = new TradeLogger("./trades.db");

    // ── Telegram notifier (자동 비활성화 if no .env keys) ──
    this.notifier = new TelegramNotifier({
      token:  process.env.TELEGRAM_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    });
    this.tradeLogger.setOnLogged((row) => this._onTradeLogged(row));

    // ── 0.1% 퀀트 인프라 (Performance + Rotation + Risk + Reconciler) ──
    this.perfTracker = new PerformanceTracker();
    this.rotation    = new RotationEngine({
      tracker:  this.perfTracker,
      notifier: this.notifier,
    });
    this.riskManager = new RiskManager({
      totalCapital: INITIAL_KRW,
    });
    this.reconciler  = new Reconciler({
      orderService: this.orderService,
      notifier:     this.notifier,
    });
    this.autoBacktest = new AutoBacktest({
      notifier: this.notifier,
    });
    this.watchdog = new Watchdog({
      bot:      this,
      notifier: this.notifier,
    });
    this.simValidator = new SimulationValidator({
      tracker:  this.perfTracker,
      notifier: this.notifier,
      bot:      this,
    });

    // ── 매수/매도 무결성 (Order routing) ─────────
    this.orderRouter = new OrderRouter({
      orderService: this.orderService,
      notifier:     this.notifier,
    });
    this.positionLedger = new PositionLedger({});
    this.positionWatchdog = new PositionWatchdog({
      ledger:       this.positionLedger,
      orderRouter:  this.orderRouter,
      orderService: this.orderService,
      notifier:     this.notifier,
    });

    // Reconciler에 새 모듈 연결
    this.reconciler.orderRouter = this.orderRouter;
    this.reconciler.ledger = this.positionLedger;

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
      tradeLogger:    this.tradeLogger,
      riskManager:    this.riskManager,
      rotation:       this.rotation,
      initialCapital: CAPITAL_A,
      dryRun:         DRY_RUN,
    });

    // ── Strategy B: New Listing Pattern ─────────────
    this.strategyB = new StrategyB({
      orderService:   this.orderService,
      tradeLogger:    this.tradeLogger,
      riskManager:    this.riskManager,
      rotation:       this.rotation,
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

    // ── Preflight check (LIVE는 강제, DRY_RUN/CALIBRATION은 자가 점검) ──
    const preflightOk = await this._preflight();
    if (!DRY_RUN && BOT_MODE === "LIVE") {
      if (!preflightOk) {
        console.error("[TradingBot] preflight failed -- aborting. Set DRY_RUN=true to run in simulation.");
        process.exit(1);
      }
    } else if (!preflightOk) {
      console.warn("[TradingBot] preflight has FAIL items — DRY_RUN이라 계속 진행하지만 LIVE 전환 전 위 항목 해결 필요");
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

    // Periodic regime refresh + 전환 알림
    this._lastRegime = null;
    this._regimeIntervalId = setInterval(async () => {
      try {
        const r = await this.regimeEngine.detect("KRW-BTC");
        if (r?.regime && this._lastRegime && r.regime !== this._lastRegime) {
          this.notifier?.notifyRegime(this._lastRegime, r.regime);
        }
        if (r?.regime) this._lastRegime = r.regime;
      } catch (e) {
        console.error("[TradingBot] regime refresh error:", e.message);
      }
    }, REGIME_INTERVAL);

    // ── Start Telegram notifier ─────────────────────
    await this.notifier.init();
    this.notifier.setDailySummaryCallback(() => this._sendDailySummary());

    // ── Reconciliation (LIVE 모드일 때만) ──────────
    if (!DRY_RUN) {
      try {
        const recon = await this.reconciler.reconcileOnStartup();
        if (recon.openOrders.length > 0 || recon.balanceMismatch.length > 0) {
          console.warn(`[TradingBot] reconciliation 발견사항: 미체결 ${recon.openOrders.length} / 잔고불일치 ${recon.balanceMismatch.length}`);
        }
      } catch (e) {
        console.error("[TradingBot] reconciliation error:", e.message);
      }
    }

    // ── Start Rotation Engine (매일 자정 알파 회귀 검증) ──
    this.rotation.start();

    // ── Auto Backtest (매주 일요일 03:00 KST) ─────────
    this.autoBacktest.start();

    // ── Watchdog (봇 뻘짓 감지) ───────────────────────
    this.watchdog.start();

    // ── Position Watchdog (단방향 노출 감지) ──────────
    this.positionWatchdog.start();

    // ── Reconciler 매분 자동 동기화 ──────────────────
    this.reconciler.startPeriodic(60_000);

    // ── Simulation Validator (DRY_RUN일 때만 — LIVE 전환 자동 판정) ──
    if (DRY_RUN) {
      this.simValidator.start();
      console.log("[TradingBot] SimulationValidator 시작 — 매시간 LIVE 전환 가능 여부 평가");
    }

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

      // Strategy C — 한국 3사 동일지역 차익 모니터 (시장 중립)
      const coinone = new CoinoneAdapter({});
      this.strategyC = new StrategyC({
        upbit:     restExchanges.upbit,
        bithumb:   restExchanges.bithumb,
        coinone,
        arbLogger: this.arbLogger,
        notifier:  this.notifier,
      });

      console.log("[TradingBot] arbitrage subsystem initialized (6 exchanges + StrategyC KRW3, public data)");
    } catch (e) {
      console.error("[TradingBot] arb init failed:", e.message, e.stack);
      this.arb = null;
      this.arbLogger = null;
      this.strategyC = null;
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

      // 3b) Strategy C (한국 3사 동일지역 차익) — 시장 중립
      try {
        if (this.strategyC) await this.strategyC.start();
      } catch (e) {
        console.error("[TradingBot] StrategyC start failed:", e.message);
      }

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
    try { this.strategyC?.stop(); } catch {}
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

        if (url.pathname === "/api/strategy-c") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.strategyC?.getSummary() || { running: false, reason: "not initialized" }));
          return;
        }

        if (url.pathname === "/api/performance") {
          const strategy = url.searchParams.get("strategy");
          const days     = Number(url.searchParams.get("days")) || 30;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            stats:   this.perfTracker?.computeStats(strategy, days) || null,
            history: this.perfTracker?.getHistory(strategy || "ALL", 90) || [],
          }));
          return;
        }

        if (url.pathname === "/api/rotation") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.rotation?.getSummary() || {}));
          return;
        }

        if (url.pathname === "/api/risk") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.riskManager?.getSummary() || {}));
          return;
        }

        if (url.pathname === "/api/backtest-history") {
          const limit = Number(url.searchParams.get("limit")) || 10;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.autoBacktest?.getRecentRuns(limit) || []));
          return;
        }

        if (url.pathname === "/api/backtest-now") {
          // 수동 트리거 (테스트용)
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "started" }));
          this.autoBacktest?.runBacktest("multi").catch(() => {});
          return;
        }

        if (url.pathname === "/api/watchdog") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.watchdog?.getSummary() || {}));
          return;
        }

        if (url.pathname === "/api/sim-validation") {
          // DRY_RUN 모드에서 LIVE 전환 가능 여부 + 통계
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.simValidator?.getLastReport() || { status: "not started" }));
          return;
        }

        if (url.pathname === "/api/health-deep") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this._buildDeepHealth()));
          return;
        }

        if (url.pathname === "/api/orders") {
          const limit = Number(url.searchParams.get("limit")) || 50;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            summary: this.orderRouter?.getSummary() || { ready: false },
            recent:  this.orderRouter?.getRecentOrders(limit) || [],
            open:    this.orderRouter?.getOpenOrders() || [],
          }));
          return;
        }

        if (url.pathname === "/api/positions") {
          const limit = Number(url.searchParams.get("limit")) || 50;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            summary: this.positionLedger?.getSummary() || { ready: false },
            active:  this.positionLedger?.getActivePositions() || [],
            recent:  this.positionLedger?.getRecent(limit) || [],
            unhedged: this.positionLedger?.getUnhedgedPositions(5) || [],
          }));
          return;
        }

        if (url.pathname === "/api/position-watchdog") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.positionWatchdog?.getSummary() || {}));
          return;
        }

        if (url.pathname === "/api/kill") {
          // 응급 정지 — 신규 진입 즉시 차단
          const reason = url.searchParams.get("reason") || "manual_kill_switch";
          try { this.orderService?.halt(reason); } catch {}
          try { this.notifier?.send?.(`🛑 <b>Kill Switch 발동</b>\n사유: ${reason}\n신규 진입 차단됨.`); } catch {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "halted", reason }));
          return;
        }

        if (url.pathname === "/api/resume") {
          // 정지 해제
          try { this.orderService.halted = false; this.orderService.haltReason = null; } catch {}
          try { this.watchdog?.reset(); } catch {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "resumed" }));
          return;
        }

        if (url.pathname === "/api/trades") {
          const limit = Number(url.searchParams.get("limit")) || 50;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.tradeLogger?.getRecent(limit) || []));
          return;
        }

        if (url.pathname === "/api/trade-stats") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            all:   this.tradeLogger?.getStats() || {},
            A:     this.tradeLogger?.getStats("A") || {},
            B:     this.tradeLogger?.getStats("B") || {},
            daily: this.tradeLogger?.getDailyPnl(30) || [],
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

    // Trade journal (DB-backed, both sim and live)
    const journalRows = this.tradeLogger?.getRecent(20) || [];
    const journalStats = this.tradeLogger?.getStats() || {};
    const journalHtml = journalRows.map(t => {
      const pnlPct = t.pnl_rate != null ? (t.pnl_rate * 100).toFixed(2) + "%" : "-";
      const pnlKrw = t.pnl_krw != null ? Math.round(t.pnl_krw).toLocaleString() : "-";
      const pnlColor = t.pnl_rate == null ? "#8b949e" : t.pnl_rate >= 0 ? "#2ecc71" : "#e74c3c";
      const sideBadge = t.side === "BUY"
        ? `<span class="badge" style="background:#1a4731;color:#2ecc71">BUY</span>`
        : `<span class="badge" style="background:#4a1a1a;color:#e74c3c">SELL</span>`;
      const modeBadge = t.dry_run
        ? `<span class="badge badge-dry">SIM</span>`
        : `<span class="badge badge-live">LIVE</span>`;
      const time = (t.created_at || "").slice(5, 16);
      return `<tr><td>${time}</td><td>${t.strategy}</td><td>${sideBadge} ${modeBadge}</td>` +
        `<td>${t.market}</td><td>${(t.price || 0).toLocaleString()}</td>` +
        `<td>${Math.round(t.budget || 0).toLocaleString()}</td>` +
        `<td style="color:${pnlColor}">${pnlPct}</td>` +
        `<td style="color:${pnlColor}">${pnlKrw}</td>` +
        `<td style="color:#8b949e">${t.reason || ""}</td></tr>`;
    }).join("");

    // Risk/Rotation/Performance/StrategyC 카드용 데이터
    const risk     = this.riskManager?.getSummary() || null;
    const rotation = this.rotation?.getSummary() || {};
    const sc       = this.strategyC?.getSummary() || null;
    const fmtPct = v => v == null ? "-" : (v * 100).toFixed(2) + "%";
    const stratStatusBadge = (key) => {
      const s = rotation[key];
      if (!s) return "";
      return s.active
        ? `<span class="badge badge-bull">${key} ON</span>`
        : `<span class="badge badge-bear">${key} OFF</span>`;
    };

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

<h2>0.1% 퀀트 인프라 — Risk / Rotation / Strategy C</h2>
<div class="grid">
  <div class="card">
    <div class="label">Risk Manager</div>
    <div class="value ${risk && risk.daily.realizedPnl < 0 ? 'red' : 'green'}">
      ${risk ? (risk.daily.realizedPnl >= 0 ? '+' : '') + risk.daily.realizedPnl.toLocaleString() + '원' : 'N/A'}
    </div>
    <div style="font-size:0.72em;color:#8b949e">
      일일: ${risk?.daily.trades || 0}/${risk?.limits.maxDailyTrades || 0}건 · 한도 ${risk?.daily.lossLimitKrw?.toLocaleString() || 0}원<br>
      월간 손실: ${risk?.monthly.loss?.toLocaleString() || 0}원 / ${risk?.monthly.lossLimit?.toLocaleString() || 0}원<br>
      VaR95: ${risk?.var95 != null ? (risk.var95 * 100).toFixed(2) + '%' : 'N/A'} · 연속손실: ${risk?.daily.consecLosses || 0}/${risk?.limits.maxConsecLosses || 0}
    </div>
  </div>
  <div class="card">
    <div class="label">Rotation Engine — 알파 활성 상태</div>
    <div class="value blue">
      ${stratStatusBadge('A')} ${stratStatusBadge('B')} ${stratStatusBadge('C')}
    </div>
    <div style="font-size:0.72em;color:#8b949e">
      A EV: ${fmtPct(rotation.A?.stats?.ev)} · ${rotation.A?.stats?.tradeCount || 0}건<br>
      B EV: ${fmtPct(rotation.B?.stats?.ev)} · ${rotation.B?.stats?.tradeCount || 0}건<br>
      C EV: ${fmtPct(rotation.C?.stats?.ev)} · ${rotation.C?.stats?.tradeCount || 0}건<br>
      매일 자정(KST) 자동 평가 + 비활성/부활
    </div>
  </div>
  <div class="card">
    <div class="label">Strategy C — 한국 3사 차익</div>
    <div class="value ${sc?.running ? 'green' : 'red'}">
      ${sc?.running ? '가동 중' : '정지'}
    </div>
    <div style="font-size:0.72em;color:#8b949e">
      모니터링: ${sc?.coins || 0}개 코인 · 사이클: ${sc?.stats?.cycles || 0}<br>
      검출: ${sc?.stats?.detected || 0} · 지속: ${sc?.stats?.sustained || 0} · 알림: ${sc?.stats?.alerted || 0}<br>
      가동: ${sc?.uptimeHrs || 0}h · 활성기회: ${sc?.activeOpportunities || 0}
    </div>
  </div>
</div>

<h2>Active Positions</h2>
<table>
<tr><th>Market</th><th>Entry</th><th>Target</th><th>Stop</th><th>Type</th></tr>
${positionsHtml || '<tr><td colspan="5" style="color:#484f58">No active positions</td></tr>'}
</table>

<h2>Recent Trades (in-memory history)</h2>
<table>
<tr><th>Market</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr>
${historyHtml || '<tr><td colspan="5" style="color:#484f58">No trades yet</td></tr>'}
</table>

<h2>Trade Journal — SQLite (sim+live persistent)
  <span style="font-size:0.7em;color:#8b949e">total: ${journalStats.total || 0} | wins: ${journalStats.wins || 0} | losses: ${journalStats.losses || 0} | WR: ${journalStats.winRate ?? "-"}% | total PnL: ${(journalStats.totalPnl || 0).toLocaleString()} KRW</span>
</h2>
<table>
<tr><th>Time</th><th>Strat</th><th>Side</th><th>Market</th><th>Price</th><th>Budget</th><th>PnL%</th><th>PnL KRW</th><th>Reason</th></tr>
${journalHtml || '<tr><td colspan="9" style="color:#484f58">No journal entries yet — trades will appear here once logged</td></tr>'}
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

  _buildDeepHealth() {
    const checks = {};
    const reasons = {};

    // 1. Strategy A
    checks.strategyA = !!this.strategyA?._intervalId;
    if (!checks.strategyA) reasons.strategyA = "interval not running";

    // 2. Strategy B
    checks.strategyB = !!this.strategyB?._scanId;
    if (!checks.strategyB) reasons.strategyB = "scan not running";

    // 3. Strategy C
    const scSummary = this.strategyC?.getSummary();
    checks.strategyC = scSummary?.running === true;
    if (!checks.strategyC) reasons.strategyC = "not running";

    // 4. Arbitrage
    checks.arb = !!this.arb;
    checks.arbLogger = this.arbLogger?._ready === true;
    if (!checks.arbLogger) reasons.arbLogger = "DB not ready";

    // 5. Performance
    checks.performance = this.perfTracker?._ready === true;
    if (!checks.performance) reasons.performance = "tracker DB not ready";

    // 6. Watchdog
    const wd = this.watchdog?.getSummary();
    checks.watchdog = wd && !wd.halted && wd.heartbeatAgeSec < 300;
    if (!checks.watchdog) reasons.watchdog = wd?.halted ? "halted" : `stale heartbeat ${wd?.heartbeatAgeSec}s`;

    // 7. Risk
    const risk = this.riskManager?.getSummary();
    checks.risk = risk && risk.daily.realizedPnl > -risk.daily.lossLimitKrw;
    if (!checks.risk) reasons.risk = "daily loss limit hit";

    // 8. Order engine
    checks.orderEngine = !this.orderService?.halted;
    if (!checks.orderEngine) reasons.orderEngine = this.orderService?.haltReason || "halted";

    // 9. WebSocket
    const wsState = this.arbMultiWs?.getSummary?.();
    const wsConnected = (wsState?.binance?.connected ? 1 : 0) +
                        (wsState?.bybit?.connected ? 1 : 0) +
                        (wsState?.okx?.connected ? 1 : 0) +
                        (wsState?.gate?.connected ? 1 : 0);
    checks.websocket = wsConnected >= 2;
    if (!checks.websocket) reasons.websocket = `only ${wsConnected}/4 exchanges connected`;

    // 10. Memory
    const memMb = process.memoryUsage().rss / 1024 / 1024;
    checks.memory = memMb < 800;
    if (!checks.memory) reasons.memory = `${memMb.toFixed(0)}MB`;

    const total = Object.keys(checks).length;
    const passing = Object.values(checks).filter(Boolean).length;
    const overall = passing === total ? "healthy" : passing >= total - 2 ? "degraded" : "unhealthy";

    return {
      overall,
      passing: `${passing}/${total}`,
      checks,
      reasons,
      memoryMb: Math.round(memMb),
      uptime: this._getHealth(),
      timestamp: new Date().toISOString(),
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
      this._dailyStats = { date: today, realizedPnl: 0, tradeCount: 0, consLosses: 0, notifiedHalt: false };
    }
    const s = this._dailyStats;
    let reason = null;
    if (s.realizedPnl < -this.MAX_DAILY_LOSS) reason = `일일 손실 한도 초과 (${Math.round(s.realizedPnl).toLocaleString()}원 / 한도 ${Math.round(this.MAX_DAILY_LOSS).toLocaleString()}원)`;
    else if (s.tradeCount >= this.MAX_DAILY_TRADES) reason = `일일 최대 거래 횟수 초과 (${s.tradeCount}/${this.MAX_DAILY_TRADES})`;
    else if (s.consLosses >= this.MAX_CONS_LOSSES) reason = `연속 손실 ${s.consLosses}회 — 서킷브레이커`;

    if (reason && !s.notifiedHalt) {
      s.notifiedHalt = true;
      try { this.notifier?.notifyHalt(reason); } catch {}
      console.error(`[TradingBot] ⛔ circuit breaker — ${reason}`);
    }
    return !!reason;
  }

  // ─── Telegram hooks ─────────────────────────────────

  _onTradeLogged(row) {
    // Watchdog에 모든 거래 기록 (sim+live)
    if (row.side === "BUY") {
      try { this.watchdog?.recordTrade(row.market); } catch {}
    }
    try { this.watchdog?.heartbeat(); } catch {}

    if (!this.notifier) return;
    // LIVE 거래만 Telegram 알림 (DRY_RUN 시뮬레이션은 노이즈)
    if (row.dry_run) return;
    try {
      if (row.side === "BUY") {
        const targetRate = row.strategy === "B" ? 0.30 : 0.035;
        const stopRate   = row.strategy === "B" ? -0.08 : -0.015;
        this.notifier.notifyEntry(row.strategy, row.market, row.price, row.budget, targetRate, stopRate);
      } else if (row.side === "SELL") {
        if (row.partial) {
          this.notifier.notifyPartial(row.strategy, row.market, (row.pnl_rate || 0) * 100);
        } else {
          this.notifier.notifyExit(row.strategy, row.market, row.pnl_rate || 0, row.reason || "exit", false);
        }
      }
    } catch (e) {
      console.warn("[TradingBot] notifier hook error:", e.message);
    }
  }

  _sendDailySummary() {
    try {
      const sA = this.strategyA.getSummary();
      const sB = this.strategyB.getSummary();
      const totalAsset = (sA?.totalAsset || 0) + (sB?.totalAsset || 0);
      this.notifier?.dailySummary({
        totalAsset,
        initCap: INITIAL_KRW,
        sA, sB,
      });
    } catch (e) {
      console.warn("[TradingBot] daily summary error:", e.message);
    }
  }

  // ─── Preflight Check ───────────────────────────────

  async _fetchPublicIp() {
    const sources = [
      "https://api.ipify.org?format=json",
      "https://ifconfig.co/json",
      "https://ipinfo.io/json",
    ];
    for (const url of sources) {
      try {
        const res = await safeFetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) continue;
        const data = await res.json();
        return data.ip || data.address || null;
      } catch {}
    }
    return null;
  }

  async _checkClockSkew() {
    try {
      const t0 = Date.now();
      const res = await safeFetch("https://api.upbit.com/v1/ticker?markets=KRW-BTC");
      const t1 = Date.now();
      const serverDate = res.headers?.get?.("date");
      if (!serverDate) return { ok: true, skewMs: null };
      const serverMs = new Date(serverDate).getTime();
      const localMs  = (t0 + t1) / 2;
      const skewMs   = Math.abs(localMs - serverMs);
      return { ok: skewMs < 5_000, skewMs };
    } catch {
      return { ok: false, skewMs: null };
    }
  }

  async _preflight() {
    console.log("[TradingBot] preflight check...");
    const checks = [];

    // 1. Public IP (Upbit IP whitelist 가이드용)
    const publicIp = await this._fetchPublicIp();
    if (publicIp) {
      console.log(`[TradingBot]   현재 공인 IP: ${publicIp}`);
      console.log(`[TradingBot]   → 이 IP를 Upbit "Open API 관리 > IP 허용 등록"에 추가해야 합니다.`);
    } else {
      console.warn("[TradingBot]   공인 IP 조회 실패 (네트워크 문제일 수 있음)");
    }
    checks.push({ name: `Public IP (${publicIp || "unknown"})`, ok: !!publicIp });

    // 2. API keys
    const hasKeys = this.orderService.getSummary().hasApiKeys;
    checks.push({ name: "API keys (.env)", ok: hasKeys });

    // 3. Clock skew (Upbit nonce auth requires sync)
    const clock = await this._checkClockSkew();
    checks.push({
      name: `clock skew (${clock.skewMs != null ? clock.skewMs + "ms" : "unknown"})`,
      ok: clock.ok,
      reason: clock.ok ? null : "5초 이상 어긋남 — NTP 동기화 권장",
    });

    // 4. Account balance (인증된 IP 검증 + 잔고 동시 체크)
    let krw = 0;
    let ipAuthed = true;
    try {
      krw = await this.orderService.getBalance("KRW");
      checks.push({ name: `KRW balance (${krw.toLocaleString()})`, ok: krw >= 5000 });
    } catch (e) {
      const msg = e.message || "";
      ipAuthed = !/인증된 IP|invalid_access_key|authorization/i.test(msg);
      checks.push({
        name: "KRW balance",
        ok: false,
        reason: ipAuthed ? msg : `${msg} ← Upbit IP 화이트리스트 미등록`,
      });
    }

    // 5. Capital
    checks.push({
      name: `balance >= 50% of INITIAL_CAPITAL (${INITIAL_KRW.toLocaleString()})`,
      ok: krw >= INITIAL_KRW * 0.5,
    });

    // 6. Upbit API public
    try {
      const res = await safeFetch("https://api.upbit.com/v1/ticker?markets=KRW-BTC");
      checks.push({ name: "Upbit API public", ok: res.ok });
    } catch (e) {
      checks.push({ name: "Upbit API public", ok: false });
    }

    let allOk = true;
    console.log("[TradingBot] --- preflight results ---");
    for (const c of checks) {
      const mark = c.ok ? "PASS" : "FAIL";
      console.log(`[TradingBot]   [${mark}] ${c.name}${c.reason ? ` -- ${c.reason}` : ""}`);
      if (!c.ok) allOk = false;
    }
    console.log("[TradingBot] ----------------------------");

    if (!allOk && !ipAuthed) {
      console.error("[TradingBot] 가장 자주 발생하는 LIVE 차단 사유: Upbit IP 화이트리스트 미등록");
      console.error("[TradingBot] 해결: https://upbit.com/mypage/open_api_management 에서 위에 표시된 공인 IP를 추가");
    }

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

    // Close trade journal + notifier + 0.1% 인프라
    try { this.tradeLogger?.close(); } catch {}
    try { this.notifier?.stop(); } catch {}
    try { this.rotation?.stop(); } catch {}
    try { this.autoBacktest?.stop(); } catch {}
    try { this.autoBacktest?.close(); } catch {}
    try { this.watchdog?.stop(); } catch {}
    try { this.simValidator?.stop(); } catch {}
    try { this.positionWatchdog?.stop(); } catch {}
    try { this.reconciler?.stopPeriodic(); } catch {}
    try { this.orderRouter?.close(); } catch {}
    try { this.positionLedger?.close(); } catch {}
    try { this.perfTracker?.close(); } catch {}
    try { this.riskManager?.close(); } catch {}
    try { this.reconciler?.close(); } catch {}

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
