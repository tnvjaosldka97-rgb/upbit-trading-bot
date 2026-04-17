"use strict";

/**
 * Strategy A v3 — 1h Swing Strategy (BTC only)
 *
 * Signal fusion: RSI + MACD + Bollinger Band squeeze
 * Entry: RSI oversold in non-bear regime + volume spike
 * Exit: Kelly-calibrated target profit or trailing stop
 * WebSocket real-time stop-loss (receives price updates)
 *
 * Exports: class StrategyA with evaluate(candles, regime, calibration) method
 */

const { safeFetch } = require("./exchange-adapter");
const CFG = require("./config");
const indicators = require("./lib/indicators");
const UPBIT_API = "https://api.upbit.com";

const MARKET         = CFG.A_MARKET;
const RSI_OVERSOLD   = CFG.A_RSI_OVERSOLD;
const RSI_OVERBOUGHT = CFG.A_RSI_OVERBOUGHT;
const ENTRY_THRESHOLD = CFG.A_ENTRY_THRESHOLD;
const DEFAULT_TARGET = CFG.A_DEFAULT_TARGET;
const DEFAULT_STOP   = CFG.A_DEFAULT_STOP;
const PARTIAL_RATE   = CFG.A_PARTIAL_RATE;
const ATR_TRAIL_MULT = CFG.A_ATR_TRAIL_MULT;
const MAX_HOLD_MS    = CFG.A_MAX_HOLD_MS;
const COOLDOWN_MS    = CFG.A_COOLDOWN_MS;

class StrategyA {
  constructor(options = {}) {
    this.orderService  = options.orderService  || null;
    this.regimeEngine  = options.regimeEngine  || null;
    this.calibEngine   = options.calibEngine   || null;
    this.dryRun        = options.dryRun ?? true;
    this.initialCapital = options.initialCapital || 100_000;

    // Simulation state
    this.sim = {
      cash:         this.initialCapital,
      position:     null,
      realizedPnl:  0,
      totalTrades:  0,
      wins: 0, losses: 0,
      history:      [],
      tradeReturns: [],
    };

    this.livePosition   = null;
    this._enteringLock  = false;
    this._lastLossAt    = 0;
    this._intervalId    = null;

    // WebSocket real-time price
    this._wsPrice       = null;
    this._wsActive      = false;
    this._stoppingLive  = false;
  }

  // ─── Lifecycle ──────────────────────────────────────

  start(intervalMs = 60 * 60_000) {
    this._tick();
    this._intervalId = setInterval(() => this._tick(), intervalMs);
    console.log(`[StrategyA] started -- 1h swing, market: ${MARKET}, interval: ${intervalMs / 60_000}min`);
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  // ─── WebSocket Integration ──────────────────────────

  /**
   * Receive real-time price updates for stop-loss monitoring.
   * Call from trading-bot.js when ws price arrives for KRW-BTC.
   */
  onPriceUpdate(price) {
    this._wsPrice  = price;
    this._wsActive = true;
    this._checkRealTimeExit(price);
  }

  // ─── Core Evaluate Method ───────────────────────────

  /**
   * evaluate(candles, regime, calibration)
   *
   * @param {Array} candles - 1h candles with { open, high, low, close, volume }
   * @param {{ regime: string, confidence: number }} regime - from RegimeEngine
   * @param {{ suggestedPositionPct: number, expectedValue: number }} calibration - from CalibrationEngine
   * @returns {{ action: string, reason: string, confidence: number, stopLoss: number, takeProfit: number } | null}
   */
  evaluate(candles, regime, calibration) {
    if (!candles || candles.length < 50) {
      return { action: "HOLD", reason: "insufficient data", confidence: 0 };
    }

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const price   = closes[closes.length - 1];

    // ── SELL check (existing position) ────────────────
    if (this.sim.position) {
      return this._evaluateExit(price, regime);
    }

    // ── Cooldown check ────────────────────────────────
    if (Date.now() - this._lastLossAt < COOLDOWN_MS) {
      return { action: "HOLD", reason: "loss cooldown active", confidence: 0 };
    }

    // ── BEAR regime hard block ────────────────────────
    const regimeStr = regime?.regime || "RANGE";
    if (regimeStr === "BEAR_STRONG") {
      return { action: "HOLD", reason: "BEAR_STRONG regime block", confidence: 0 };
    }

    // ── Signal Fusion Scoring ─────────────────────────
    let score = 0;
    const reasons = [];

    // 1) RSI14
    const rsi = this._rsi(closes, 14);
    if (rsi < RSI_OVERSOLD) {
      score += 15;
      reasons.push(`RSI_OVERSOLD(${rsi.toFixed(0)})`);
    } else if (rsi > RSI_OVERBOUGHT) {
      score -= 10;
      reasons.push(`RSI_OVERBOUGHT(${rsi.toFixed(0)})`);
    } else if (rsi >= 42 && rsi <= 58) {
      score += 5;
      reasons.push(`RSI_NEUTRAL(${rsi.toFixed(0)})`);
    }

    // 2) MACD(12, 26, 9)
    const macd = this._macd(closes);
    if (macd) {
      if (macd.histogram > 0 && macd.histogram > macd.prevHistogram) {
        score += 12;
        reasons.push("MACD_BULLISH_MOMENTUM");
      } else if (macd.histogram <= 0) {
        score -= 5;
        reasons.push("MACD_NEGATIVE");
      }
    }

    // 3) Bollinger Band squeeze (BB width < 2% = squeeze)
    const bb = this._bollingerBands(closes, 20, 2);
    if (bb) {
      const bbWidth = (bb.upper - bb.lower) / bb.middle;
      if (bbWidth < 0.02 && price > bb.middle) {
        score += 10;
        reasons.push("BB_SQUEEZE_BREAKOUT");
      } else if (bbWidth < 0.02) {
        score += 5;
        reasons.push("BB_SQUEEZE");
      }
      if (price < bb.lower) {
        score += 8;
        reasons.push("BB_OVERSOLD");
      }
    }

    // 4) Volume spike (recent 3 vs prior 20)
    const recentVol = this._mean(volumes.slice(-3));
    const baseVol   = this._mean(volumes.slice(-23, -3));
    if (baseVol > 0 && recentVol > baseVol * 1.5) {
      score += 8;
      reasons.push("VOLUME_SPIKE");
    }

    // 5) Golden cross (MA8 > MA21)
    const ma8  = this._sma(closes, 8);
    const ma21 = this._sma(closes, 21);
    if (ma8 && ma21 && ma8 > ma21) {
      score += 10;
      reasons.push("GOLDEN_CROSS");
    }

    // 6) EMA200 position
    const ema200 = this._ema(closes, 200);
    if (ema200 && price > ema200) {
      score += 8;
      reasons.push("ABOVE_EMA200");
    } else if (ema200) {
      score -= 15;
      reasons.push("BELOW_EMA200");
    }

    // 7) Regime contribution
    const regimeScore = this._regimeScore(regimeStr);
    score += regimeScore;
    if (regimeScore > 0) reasons.push(`REGIME_${regimeStr}`);

    // ── Confidence ────────────────────────────────────
    const confidence = Math.min(Math.max(score / 80, 0), 1);

    // ── Kelly-calibrated targets ──────────────────────
    const atr = this._atr(highs, lows, closes, 14);
    const atrPct = price > 0 ? atr / price : 0;
    const calPct = calibration?.suggestedPositionPct || 0.05;

    const targetRate = atrPct > 0
      ? Math.max(DEFAULT_TARGET, atrPct * 2.5 * (1 + calPct))
      : DEFAULT_TARGET;
    const stopRate = atrPct > 0
      ? Math.min(DEFAULT_STOP, -(atrPct * 1.2))
      : DEFAULT_STOP;

    const takeProfit = Math.round(price * (1 + targetRate));
    const stopLoss   = Math.round(price * (1 + stopRate));

    if (score >= ENTRY_THRESHOLD) {
      console.log(
        `[StrategyA] BUY signal -- ${MARKET} score:${score} ` +
        `confidence:${confidence.toFixed(2)} [${reasons.join(",")}]`
      );
      return {
        action: "BUY",
        reason: reasons.join(", "),
        confidence,
        stopLoss,
        takeProfit,
        score,
        _meta: { rsi, atr, atrPct, targetRate, stopRate, calPct },
      };
    }

    return {
      action: "HOLD",
      reason: `score ${score} < threshold ${ENTRY_THRESHOLD}`,
      confidence,
      stopLoss,
      takeProfit,
      score,
    };
  }

  // ─── Exit Evaluation ────────────────────────────────

  _evaluateExit(price, regime) {
    const pos = this.sim.position;
    if (!pos) return { action: "HOLD", reason: "no position", confidence: 0 };

    const move = (price - pos.entryPrice) / pos.entryPrice;
    const holdTime = Date.now() - pos.openedAt;

    // Regime shift: BULL -> BEAR_STRONG = immediate exit
    const regimeStr = regime?.regime || "RANGE";
    if (pos.regime && (pos.regime.startsWith("BULL")) && regimeStr === "BEAR_STRONG") {
      return {
        action: "SELL",
        reason: "regime shift to BEAR_STRONG",
        confidence: 0.9,
        stopLoss: 0,
        takeProfit: 0,
      };
    }

    // Target hit
    if (price >= pos.targetPrice) {
      return {
        action: "SELL",
        reason: `target hit +${(move * 100).toFixed(2)}%`,
        confidence: 1.0,
        stopLoss: 0,
        takeProfit: 0,
      };
    }

    // Stop hit
    if (price <= pos.stopPrice) {
      return {
        action: "SELL",
        reason: `stop loss ${(move * 100).toFixed(2)}%`,
        confidence: 1.0,
        stopLoss: 0,
        takeProfit: 0,
      };
    }

    // Time stop
    if (holdTime > MAX_HOLD_MS) {
      return {
        action: "SELL",
        reason: `time stop (${(holdTime / 3_600_000).toFixed(1)}h)`,
        confidence: 0.7,
        stopLoss: 0,
        takeProfit: 0,
      };
    }

    return { action: "HOLD", reason: "position active", confidence: 0 };
  }

  // ─── Real-time WebSocket Exit Check ─────────────────

  _checkRealTimeExit(price) {
    if (!this.sim.position) return;
    const pos = this.sim.position;

    // Update peak
    if (price > pos.peakPrice) pos.peakPrice = price;
    const move = (price - pos.entryPrice) / pos.entryPrice;

    // Partial take-profit at +2%
    if (!pos.partialDone && move >= PARTIAL_RATE) {
      const halfBudget = pos.budget * 0.5;
      const halfPnl    = halfBudget * move;
      this.sim.cash        += halfBudget + halfPnl;
      this.sim.realizedPnl += halfPnl;
      pos.budget      *= 0.5;
      pos.quantity    *= 0.5;
      pos.partialDone  = true;
      pos.stopPrice    = pos.entryPrice * 1.001; // move stop to breakeven
      pos.trailActive  = true;
      console.log(`[StrategyA] partial TP +${(move * 100).toFixed(2)}% -- 50% sold, stop -> breakeven`);
    }

    // ATR trailing stop
    if (!pos.trailActive && move >= 0.02) pos.trailActive = true;
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - pos.atrStop);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    // Check exits
    const hitTarget = price >= pos.targetPrice;
    const hitStop   = price <= pos.stopPrice;
    const timeout   = Date.now() - pos.openedAt > MAX_HOLD_MS;

    if (hitTarget || hitStop || timeout) {
      const pnlRate = (price - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      const reason   = hitTarget ? "target" : hitStop ? "stop" : "timeout";
      if (hitStop && pnlRate < 0) this._lastLossAt = Date.now();
      this._closeSimPosition(pos, price, pnlRate, pnlKrw, reason);
    }

    // Live position stop
    if (this.livePosition && !this._stoppingLive && price <= this.livePosition.stopPrice) {
      this._stoppingLive = true;
      this._executeLiveStop(this.livePosition, price)
        .finally(() => { this._stoppingLive = false; });
    }
  }

  // ─── Internal Tick ──────────────────────────────────

  async _tick() {
    try {
      if (Date.now() - this._lastLossAt < COOLDOWN_MS) return;

      // Manage existing position via polling (backup for no-WS)
      if (!this._wsActive && this.sim.position) {
        await this._manageSimPosition();
      }

      // Entry evaluation
      if (!this.sim.position && !this.livePosition && !this._enteringLock) {
        const candles = await this._fetchCandles(MARKET, 200);
        if (!candles) return;

        const regime = this.regimeEngine
          ? await this.regimeEngine.detect(MARKET)
          : { regime: "RANGE", confidence: 0 };
        const calibration = this.calibEngine
          ? this.calibEngine.getResult()
          : null;

        const signal = this.evaluate(candles, regime, calibration);
        if (signal && signal.action === "BUY") {
          await this._enter(MARKET, signal, regime, calibration);
        }
      }
    } catch (e) {
      console.error("[StrategyA] tick error:", e.message);
    }
  }

  // ─── Entry Execution ────────────────────────────────

  async _enter(market, signal, regime, calibration) {
    if (this._enteringLock) return;
    this._enteringLock = true;
    try {
      const price = signal._meta?.rsi ? await this._getPrice(market) : signal.takeProfit / (1 + DEFAULT_TARGET);
      if (!price) return;

      const kellyMult = this.regimeEngine?.getKellyMultiplier?.() ?? 1.0;
      const calPct    = calibration?.suggestedPositionPct || 0.05;
      const budget    = Math.floor(this.sim.cash * Math.min(calPct * kellyMult * 10, 0.95));

      if (budget < 5000) {
        console.warn("[StrategyA] insufficient budget");
        return;
      }

      const atr = signal._meta?.atr || price * 0.01;
      const atrStop = atr > 0 ? (atr / price) * ATR_TRAIL_MULT : 0.015;

      this.sim.position = {
        market,
        entryPrice:  price,
        quantity:    budget / price,
        budget,
        targetPrice: signal.takeProfit || price * (1 + DEFAULT_TARGET),
        stopPrice:   signal.stopLoss   || price * (1 + DEFAULT_STOP),
        atrStop,
        peakPrice:   price,
        trailActive: false,
        partialDone: false,
        openedAt:    Date.now(),
        entryScore:  signal.score,
        regime:      regime?.regime || "RANGE",
      };
      this.sim.cash -= budget;

      console.log(
        `[StrategyA] ENTERED -- ${market} @${price.toLocaleString()} ` +
        `budget:${budget.toLocaleString()} regime:${regime?.regime} ` +
        `target:${this.sim.position.targetPrice.toLocaleString()} ` +
        `stop:${this.sim.position.stopPrice.toLocaleString()}`
      );

      // Live order execution
      if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
        const krw = await this.orderService.getBalance("KRW").catch(() => 0);
        const liveBudget = Math.min(krw * 0.9, this.initialCapital * 0.6 * kellyMult);
        if (liveBudget >= 5000) {
          const res = await this.orderService.smartLimitBuy(market, Math.floor(liveBudget));
          if (res.filled) {
            const ep = res.avgPrice;
            this.livePosition = {
              market, quantity: res.executedVolume,
              entryPrice: ep, budget: liveBudget,
              targetPrice: ep * (1 + (signal._meta?.targetRate || DEFAULT_TARGET)),
              stopPrice:   ep * (1 + (signal._meta?.stopRate || DEFAULT_STOP)),
              atrStop, peakPrice: ep, trailActive: false,
              openedAt: Date.now(),
            };
            const sell = await this.orderService.limitSell(market, res.executedVolume, this.livePosition.targetPrice);
            this.livePosition.limitSellUuid = sell.uuid;
            this.orderService
              .waitForFillOrMarketSell(sell.uuid, market, res.executedVolume)
              .then(() => this._closeLive("TARGET"))
              .catch(e => console.error("[StrategyA] sell monitor:", e.message));
          }
        }
      }
    } catch (e) {
      console.error("[StrategyA] entry error:", e.message);
    } finally {
      this._enteringLock = false;
    }
  }

  async _executeLiveStop(pos, price) {
    console.warn(
      `[StrategyA] live stop triggered -- ${pos.market} ` +
      `price:${price.toLocaleString()} <= stop:${pos.stopPrice.toLocaleString()}`
    );
    if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
      if (pos.limitSellUuid) {
        await this.orderService.cancelOrder(pos.limitSellUuid).catch(() => {});
      }
      const bal = await this.orderService.getBalance(pos.market.split("-")[1]).catch(() => 0);
      if (bal > 0.00001) {
        await this.orderService.marketSell(pos.market, bal)
          .catch(e => console.error("[StrategyA] stop sell failed:", e.message));
      }
    }
    this._closeLive("STOP");
  }

  _closeLive(reason) {
    if (!this.livePosition) return;
    console.log(`[StrategyA] live position closed (${reason}) -- ${this.livePosition.market}`);
    this.livePosition = null;
  }

  // ─── Sim Position Management (polling fallback) ─────

  async _manageSimPosition() {
    const pos = this.sim.position;
    if (!pos) return;

    const cur = await this._getPrice(pos.market);
    if (!cur) return;

    if (cur > pos.peakPrice) pos.peakPrice = cur;
    const move = (cur - pos.entryPrice) / pos.entryPrice;

    if (!pos.trailActive && move >= 0.02) pos.trailActive = true;
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - pos.atrStop);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    const hitTarget = cur >= pos.targetPrice;
    const hitStop   = cur <= pos.stopPrice;
    const timeout   = Date.now() - pos.openedAt > MAX_HOLD_MS;

    if (hitTarget || hitStop || timeout) {
      const pnlRate = (cur - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      const reason   = hitTarget ? "target" : hitStop ? "stop" : "timeout";
      if (hitStop && pnlRate < 0) this._lastLossAt = Date.now();
      this._closeSimPosition(pos, cur, pnlRate, pnlKrw, reason);
    }
  }

  _closeSimPosition(pos, exitPrice, pnlRate, pnlKrw, reason) {
    this.sim.cash += pos.budget * (1 + pnlRate);
    this.sim.realizedPnl += pnlKrw;
    this.sim.totalTrades++;
    if (pnlKrw >= 0) this.sim.wins++; else this.sim.losses++;
    this.sim.tradeReturns.push(pnlRate);
    if (this.sim.tradeReturns.length > 100) this.sim.tradeReturns.shift();
    this.sim.history.unshift({
      market: pos.market, entryPrice: pos.entryPrice, exitPrice,
      pnlRate: +pnlRate.toFixed(4), reason,
      entryScore: pos.entryScore, regime: pos.regime,
      closedAt: Date.now(),
    });
    this.sim.history = this.sim.history.slice(0, 30);
    this.sim.position = null;

    console.log(
      `[StrategyA] closed (${reason}) -- ${pos.market} ` +
      `${pnlRate >= 0 ? "+" : ""}${(pnlRate * 100).toFixed(2)}% ` +
      `(${Math.round(pnlKrw).toLocaleString()} KRW)`
    );

    // Record for CalibrationEngine
    if (this.calibEngine) {
      this.calibEngine.recordTrade({ pnlRate, market: pos.market, reason });
    }
  }

  // ─── Data Fetching ──────────────────────────────────

  async _fetchCandles(market, count) {
    try {
      const res = await safeFetch(
        `${UPBIT_API}/v1/candles/minutes/60?market=${market}&count=${count}`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.reverse().map(c => ({
        time:   new Date(c.candle_date_time_utc).getTime(),
        open:   c.opening_price,
        high:   c.high_price,
        low:    c.low_price,
        close:  c.trade_price,
        volume: c.candle_acc_trade_volume,
      }));
    } catch (e) {
      console.error("[StrategyA] fetch candles error:", e.message);
      return null;
    }
  }

  async _getPrice(market) {
    if (this._wsPrice && market === MARKET) return this._wsPrice;
    try {
      const res  = await safeFetch(`${UPBIT_API}/v1/ticker?markets=${market}`);
      const data = await res.json();
      return data[0]?.trade_price || null;
    } catch (e) { console.warn("[StrategyA] _getPrice:", e.message); return null; }
  }

  // ─── Technical Indicators (delegated to lib/indicators.js) ──

  _sma(arr, n)     { return indicators.sma(arr, n); }
  _ema(arr, n)     { return indicators.ema(arr, n); }
  _emaArr(arr, n)  { return indicators.emaArr(arr, n); }
  _rsi(closes, p)  { return indicators.rsi(closes, p); }
  _macd(closes, fast, slow, sig) { return indicators.macd(closes, fast, slow, sig); }
  _bollingerBands(closes, period, mult) { return indicators.bollingerBands(closes, period, mult); }
  _atr(highs, lows, closes, period) { return indicators.atr(highs, lows, closes, period); }
  _mean(arr)       { return indicators.mean(arr); }

  _regimeScore(regime) {
    switch (regime) {
      case "BULL_STRONG": return 25;
      case "BULL_WEAK":   return 15;
      case "RANGE":       return 0;
      case "BEAR_WEAK":   return -10;
      case "BEAR_STRONG": return -999;
      default:            return 0;
    }
  }

  // ─── Dashboard Summary ──────────────────────────────

  getSummary() {
    const pos  = this.sim.position;
    const init = this.initialCapital;
    const inPos = pos ? pos.budget : 0;
    const total = this.sim.cash + inPos;
    return {
      name: "A -- 1h Swing v3 (BTC)",
      pnlRate:     +((total - init) / init * 100).toFixed(3),
      totalAsset:  Math.round(total),
      realizedPnl: Math.round(this.sim.realizedPnl),
      totalTrades: this.sim.totalTrades,
      wins: this.sim.wins, losses: this.sim.losses,
      winRate: this.sim.totalTrades > 0
        ? +(this.sim.wins / this.sim.totalTrades * 100).toFixed(1) : null,
      position: pos ? {
        market:      pos.market,
        entryPrice:  Math.round(pos.entryPrice),
        targetPrice: Math.round(pos.targetPrice),
        stopPrice:   Math.round(pos.stopPrice),
        peakPrice:   Math.round(pos.peakPrice),
        trailActive: pos.trailActive,
        openedAt:    pos.openedAt,
        entryScore:  pos.entryScore,
        regime:      pos.regime,
      } : null,
      livePosition: this.livePosition ? {
        market:     this.livePosition.market,
        entryPrice: Math.round(this.livePosition.entryPrice),
        stopPrice:  Math.round(this.livePosition.stopPrice),
      } : null,
      history:      this.sim.history.slice(0, 8),
      wsActive:     this._wsActive,
    };
  }
}

module.exports = { StrategyA };
