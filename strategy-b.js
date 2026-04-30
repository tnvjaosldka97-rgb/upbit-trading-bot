"use strict";

/**
 * Strategy B v2 — New Listing Pattern
 *
 * Scans for newly listed coins on Upbit.
 * Pattern: detect pump within first 24h of listing.
 * Quick scalp: enter on volume breakout, exit within 30min-2h.
 * Conservative: small position, tight stop.
 *
 * Exports: class StrategyB with scan() and evaluate(market, candles) methods
 */

const { safeFetch } = require("./exchange-adapter");
const CFG = require("./config");
const UPBIT_API = "https://api.upbit.com";

const SCAN_INTERVAL_MS     = CFG.B_SCAN_INTERVAL_MS;
const MANAGE_INTERVAL_MS   = CFG.B_MANAGE_INTERVAL_MS;
const TARGET_RATE          = CFG.B_TARGET_RATE;
const PARTIAL_AT           = CFG.B_PARTIAL_AT;
const STOP_RATE            = CFG.B_STOP_RATE;
const TRAIL_PCT            = CFG.B_TRAIL_PCT;
const MAX_HOLD_MS          = CFG.B_MAX_HOLD_MS;
const BUDGET_PCT           = CFG.B_BUDGET_PCT;
const MAX_LISTING_AGE_MS   = CFG.B_MAX_LISTING_AGE_MS;
const MIN_VOLUME_SPIKE     = CFG.B_MIN_VOLUME_SPIKE;
const MIN_PRICE_MOVE       = CFG.B_MIN_PRICE_MOVE;

// Stablecoin blacklist
const STABLECOINS = new Set(["USDT", "USDC", "DAI", "BUSD", "TUSD", "FDUSD", "PYUSD", "USDD", "FRAX"]);

class StrategyB {
  constructor(options = {}) {
    this.orderService   = options.orderService   || null;
    this.tradeLogger    = options.tradeLogger    || null;
    this.riskManager    = options.riskManager    || null;
    this.rotation       = options.rotation       || null;
    this.dryRun         = options.dryRun ?? true;
    this.initialCapital = options.initialCapital || 100_000;

    // Known markets (for detecting new listings)
    this.knownMarkets   = new Set();
    this.actedListings  = new Set();

    // Simulation state
    this.sim = {
      cash:         this.initialCapital,
      positions:    new Map(),
      realizedPnl:  0,
      totalTrades:  0,
      wins: 0, losses: 0,
      history:      [],
      tradeReturns: [],
    };

    this.livePositions = new Map();
    this.detections    = [];

    this._scanId    = null;
    this._manageId  = null;
    this._wsActive  = false;
  }

  // ─── Lifecycle ──────────────────────────────────────

  async start() {
    // Load initial market list
    const markets = await this._fetchMarketList();
    markets.forEach(m => this.knownMarkets.add(m));
    console.log(`[StrategyB] started -- monitoring ${this.knownMarkets.size} existing markets`);

    // Scan for new listings
    this._scanId = setInterval(
      () => this.scan().catch(e => console.error("[StrategyB] scan error:", e.message)),
      SCAN_INTERVAL_MS
    );

    // Manage open positions
    this._manageId = setInterval(
      () => this._manageAll().catch(e => console.error("[StrategyB] manage error:", e.message)),
      MANAGE_INTERVAL_MS
    );
  }

  stop() {
    if (this._scanId)   { clearInterval(this._scanId);   this._scanId = null; }
    if (this._manageId) { clearInterval(this._manageId); this._manageId = null; }
  }

  /**
   * Receive real-time price update from WebSocket.
   * Called from trading-bot.js for each subscribed market.
   */
  onPriceUpdate(market, price) {
    this._wsActive = true;
    const pos = this.sim.positions.get(market);
    if (pos) this._checkPositionExit(pos, market, price);
  }

  // ─── scan() — Detect newly listed coins ─────────────

  async scan() {
    try {
      const current = await this._fetchMarketList();
      const newKRW  = current.filter(m => m.startsWith("KRW-") && !this.knownMarkets.has(m));

      for (const market of newKRW) {
        const symbol = market.replace("KRW-", "");

        // Skip stablecoins
        if (STABLECOINS.has(symbol)) {
          this.knownMarkets.add(market);
          continue;
        }

        // Skip if already acted on
        if (this.actedListings.has(market)) {
          this.knownMarkets.add(market);
          continue;
        }

        console.log(`[StrategyB] NEW LISTING detected: ${market}`);
        this.actedListings.add(market);
        this.knownMarkets.add(market);

        this.detections.unshift({
          market,
          detectedAt: Date.now(),
          status: "detected",
        });
        this.detections = this.detections.slice(0, 20);

        // Wait 2s for orderbook to stabilize, then evaluate
        await new Promise(r => setTimeout(r, 2000));
        const evalResult = await this.evaluate(market);
        if (evalResult && evalResult.action === "BUY") {
          await this._enter(market, evalResult);
        }
      }

      // Update known markets
      current.forEach(m => this.knownMarkets.add(m));
    } catch (e) {
      console.error("[StrategyB] scan error:", e.message);
    }
  }

  // ─── evaluate(market, candles?) — Assess listing ────

  /**
   * @param {string} market
   * @param {Array|null} candles - optional, fetched if null
   * @returns {{ action: string, reason: string, confidence: number, price: number }}
   */
  async evaluate(market, candles = null) {
    try {
      // Parallel fetch: ticker + orderbook + trades
      const [tickerData, obData, tradesData] = await Promise.all([
        this._fetchTicker(market),
        this._fetchOrderbook(market),
        this._fetchTrades(market, 50),
      ]);

      if (!tickerData) {
        this._updateDetection(market, "skip(no ticker)");
        return { action: "HOLD", reason: "no ticker data", confidence: 0, price: 0 };
      }

      const price     = tickerData.trade_price;
      const openPrice = tickerData.opening_price;
      const volume24h = tickerData.acc_trade_volume_24h;

      // ── Safety checks ──────────────────────────────
      const reasons = [];
      let score = 50; // base score

      // 1) Spread check
      if (obData) {
        const units = obData.orderbook_units || [];
        if (units.length > 0) {
          const bestAsk = units[0].ask_price;
          const bestBid = units[0].bid_price;
          const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
          if (spreadPct > 3.0) {
            this._updateDetection(market, `skip(spread ${spreadPct.toFixed(1)}%)`);
            return { action: "HOLD", reason: `spread too wide: ${spreadPct.toFixed(1)}%`, confidence: 0, price };
          }
          if (spreadPct < 1.0) { score += 5; reasons.push("tight_spread"); }
        }
      }

      // 2) Already pumped check
      if (openPrice > 0) {
        const pumpPct = (price - openPrice) / openPrice;
        if (pumpPct > 0.50) {
          this._updateDetection(market, `skip(pumped +${(pumpPct * 100).toFixed(0)}%)`);
          return { action: "HOLD", reason: `already pumped +${(pumpPct * 100).toFixed(0)}%`, confidence: 0, price };
        }
        if (pumpPct > MIN_PRICE_MOVE) {
          score += 10;
          reasons.push(`early_pump(+${(pumpPct * 100).toFixed(0)}%)`);
        }
      }

      // 3) Volume analysis from recent trades
      if (tradesData && tradesData.length >= 10) {
        const buyTrades  = tradesData.filter(t => t.ask_bid === "BID");
        const buyRatio   = buyTrades.length / tradesData.length;
        if (buyRatio > 0.6) {
          score += 15;
          reasons.push(`buy_pressure(${(buyRatio * 100).toFixed(0)}%)`);
        } else if (buyRatio < 0.35) {
          score -= 15;
          reasons.push(`sell_pressure(${(buyRatio * 100).toFixed(0)}%)`);
        }

        // Trade count validation
        if (tradesData.length < 20) {
          score -= 10;
          reasons.push("low_trades");
        }
      }

      // 4) Candle-based volume check (if candles available)
      if (candles && candles.length >= 5) {
        const recentVol = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
        const baseVol   = candles.slice(0, -3).reduce((s, c) => s + c.volume, 0) / Math.max(candles.length - 3, 1);
        if (baseVol > 0 && recentVol / baseVol >= MIN_VOLUME_SPIKE) {
          score += 15;
          reasons.push(`vol_spike(${(recentVol / baseVol).toFixed(1)}x)`);
        }
      }

      const confidence = Math.min(Math.max(score / 100, 0), 1);

      console.log(
        `[StrategyB] evaluate ${market} -- score:${score} ` +
        `confidence:${confidence.toFixed(2)} [${reasons.join(",")}]`
      );

      if (score >= 55) {
        return {
          action: "BUY",
          reason: reasons.join(", "),
          confidence,
          price,
          score,
        };
      }

      this._updateDetection(market, `hold(score:${score})`);
      return { action: "HOLD", reason: `score ${score} < 55`, confidence, price };

    } catch (e) {
      console.error(`[StrategyB] evaluate error (${market}):`, e.message);
      return { action: "HOLD", reason: e.message, confidence: 0, price: 0 };
    }
  }

  // ─── Entry ──────────────────────────────────────────

  async _enter(market, signal) {
    const price  = signal.price;
    const budget = Math.floor(this.sim.cash * BUDGET_PCT);

    if (budget < 5000) {
      console.warn("[StrategyB] insufficient budget for entry");
      return;
    }

    // Rotation 게이트
    if (this.rotation && !this.rotation.isStrategyActive("B")) {
      console.warn("[StrategyB] BUY blocked — rotation engine deactivated");
      return;
    }

    // Risk Manager 게이트
    if (this.riskManager) {
      const positionsObj = {};
      for (const [m, p] of this.sim.positions) positionsObj[`B_${m}`] = p;
      const check = this.riskManager.checkEntry({
        strategy: "B",
        budgetKrw: budget,
        currentPositions: positionsObj,
      });
      if (!check.allowed) {
        console.warn(`[StrategyB] BUY blocked by RiskManager — ${check.reason}`);
        return;
      }
    }

    const pos = {
      market,
      entryPrice:  price,
      quantity:    budget / price,
      budget,
      targetPrice: price * (1 + TARGET_RATE),
      stopPrice:   price * (1 + STOP_RATE),
      peakPrice:   price,
      partialDone: false,
      trailActive: false,
      openedAt:    Date.now(),
    };

    this.sim.cash -= budget;
    this.sim.positions.set(market, pos);
    this._updateDetection(market, "entered");

    console.log(
      `[StrategyB] ENTERED -- ${market} @${price.toLocaleString()} ` +
      `budget:${budget.toLocaleString()} target:+${(TARGET_RATE * 100)}% ` +
      `stop:${(STOP_RATE * 100)}%`
    );

    this.tradeLogger?.logBuy({
      strategy: "B",
      market,
      price,
      quantity: pos.quantity,
      budget,
      qualityScore: signal.score || null,
      qualityFlags: signal.flags || null,
      dryRun: true,
    });

    // Live order
    if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
      try {
        const krw = await this.orderService.getBalance("KRW").catch(() => 0);
        const liveBudget = Math.min(krw * BUDGET_PCT, this.initialCapital * 0.1);
        if (liveBudget >= 5000) {
          const result = await this.orderService.smartLimitBuy(market, liveBudget);
          if (result.filled) {
            const ep = result.avgPrice;
            const lp = {
              market, quantity: result.executedVolume,
              entryPrice: ep, budget: liveBudget,
              targetPrice: ep * (1 + TARGET_RATE),
              stopPrice:   ep * (1 + STOP_RATE),
              partialDone: false, openedAt: Date.now(),
            };
            const sell = await this.orderService.limitSell(market, result.executedVolume, lp.targetPrice);
            lp.limitSellUuid = sell.uuid;
            this.livePositions.set(market, lp);
            console.log(`[StrategyB] live entry -- ${market} @${ep.toLocaleString()}`);
            this.tradeLogger?.logBuy({
              strategy: "B",
              market,
              price: ep,
              quantity: result.executedVolume,
              budget: liveBudget,
              qualityScore: signal.score || null,
              qualityFlags: signal.flags || null,
              dryRun: false,
            });
          }
        }
      } catch (e) {
        console.error("[StrategyB] live entry failed:", e.message);
      }
    }
  }

  // ─── Position Management ────────────────────────────

  _checkPositionExit(pos, market, price) {
    if (price > pos.peakPrice) pos.peakPrice = price;
    const move = (price - pos.entryPrice) / pos.entryPrice;

    // Partial take-profit
    if (!pos.partialDone && move >= PARTIAL_AT) {
      const half    = pos.budget * 0.5;
      const halfPnl = half * move;
      this.sim.cash        += half + halfPnl;
      this.sim.realizedPnl += halfPnl;
      pos.budget      *= 0.5;
      pos.quantity    *= 0.5;
      pos.stopPrice    = pos.entryPrice * 1.001;
      pos.partialDone  = true;
      pos.trailActive  = true;
      pos.peakPrice    = price;
      console.log(
        `[StrategyB] partial TP +${(move * 100).toFixed(1)}% -- ${market} ` +
        `50% sold, trailing ${(TRAIL_PCT * 100)}% started`
      );
      this._updateDetection(market, `partial(+${(move * 100).toFixed(0)}%)`);
      this.tradeLogger?.logSell({
        strategy: "B",
        market,
        price,
        quantity: pos.quantity, // remaining = original/2 (already halved)
        budget: half,
        reason: "partial",
        pnlRate: move,
        pnlKrw: halfPnl,
        partial: true,
        trail: false,
        dryRun: true,
      });
    }

    // Trailing stop update
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - TRAIL_PCT);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    const hitTarget = !pos.partialDone && price >= pos.targetPrice;
    const hitStop   = price <= pos.stopPrice;
    const timeout   = Date.now() - pos.openedAt > MAX_HOLD_MS;

    if (hitTarget || hitStop || timeout) {
      const pnlRate = (price - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      const reason   = hitTarget ? "target" : hitStop ? "stop" : "timeout";
      this._closeSimPosition(market, price, pnlRate, pnlKrw, reason);
    }
  }

  async _manageAll() {
    for (const [market, pos] of this.sim.positions) {
      if (this._wsActive) continue; // WS handles it in real-time

      const cur = await this._getPrice(market);
      if (!cur) continue;
      this._checkPositionExit(pos, market, cur);
    }

    // Live positions
    for (const [market, pos] of this.livePositions) {
      await this._manageLivePosition(market, pos).catch(() => {});
    }
  }

  async _manageLivePosition(market, pos) {
    const cur = await this._getPrice(market);
    if (!cur) return;

    if (cur > (pos.peakPrice || 0)) pos.peakPrice = cur;

    if (cur <= pos.stopPrice) {
      if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
        if (pos.limitSellUuid) await this.orderService.cancelOrder(pos.limitSellUuid).catch(() => {});
        const bal = await this.orderService.getBalance(market.split("-")[1]).catch(() => 0);
        if (bal > 0.00001) {
          await this.orderService.marketSell(market, bal).catch(e => console.error("[StrategyB]", e.message));
        }
      }
      const pnlRate = (cur - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      this.tradeLogger?.logSell({
        strategy: "B",
        market,
        price: cur,
        quantity: pos.quantity,
        budget: pos.budget,
        reason: "stop",
        pnlRate,
        pnlKrw,
        partial: pos.partialDone || false,
        trail: false,
        dryRun: false,
      });
      this.livePositions.delete(market);
      console.log(
        `[StrategyB] live stop -- ${market} ` +
        `${pnlRate >= 0 ? "+" : ""}${(pnlRate * 100).toFixed(2)}%`
      );
    }
  }

  _closeSimPosition(market, exitPrice, pnlRate, pnlKrw, reason) {
    const pos = this.sim.positions.get(market);
    if (!pos) return;

    this.sim.cash += pos.budget * (1 + pnlRate);
    this.sim.realizedPnl += pnlKrw;
    this.sim.totalTrades++;
    if (pnlKrw >= 0) this.sim.wins++; else this.sim.losses++;
    this.sim.tradeReturns.push(pnlRate);
    if (this.sim.tradeReturns.length > 100) this.sim.tradeReturns.shift();

    this.sim.history.unshift({
      market, entryPrice: pos.entryPrice, exitPrice,
      pnlRate: +pnlRate.toFixed(4), reason,
      partialDone: pos.partialDone, closedAt: Date.now(),
    });
    this.sim.history = this.sim.history.slice(0, 30);
    this.sim.positions.delete(market);

    const det = this.detections.find(d => d.market === market);
    if (det) { det.status = `closed(${reason})`; det.finalPnl = +(pnlRate * 100).toFixed(1); }

    console.log(
      `[StrategyB] closed (${reason}) -- ${market} ` +
      `${pnlRate >= 0 ? "+" : ""}${(pnlRate * 100).toFixed(1)}%`
    );

    this.tradeLogger?.logSell({
      strategy: "B",
      market,
      price: exitPrice,
      quantity: pos.quantity,
      budget: pos.budget,
      reason,
      pnlRate,
      pnlKrw,
      partial: pos.partialDone || false,
      trail: pos.trailActive || false,
      dryRun: true,
    });
    this.riskManager?.recordTrade({ pnlKrw, isLoss: pnlRate < 0 });
  }

  // ─── Data Fetching ──────────────────────────────────

  async _fetchMarketList() {
    try {
      const res = await safeFetch(`${UPBIT_API}/v1/market/all?isDetails=false`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data.map(m => m.market) : [];
    } catch (e) { console.warn("[StrategyB] _fetchMarketList:", e.message); return []; }
  }

  async _fetchTicker(market) {
    try {
      const res = await safeFetch(`${UPBIT_API}/v1/ticker?markets=${market}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data[0] || null;
    } catch (e) { console.warn("[StrategyB] _fetchTicker:", e.message); return null; }
  }

  async _fetchOrderbook(market) {
    try {
      const res = await safeFetch(`${UPBIT_API}/v1/orderbook?markets=${market}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data[0] || null;
    } catch (e) { console.warn("[StrategyB] _fetchOrderbook:", e.message); return null; }
  }

  async _fetchTrades(market, count = 50) {
    try {
      const res = await safeFetch(`${UPBIT_API}/v1/trades/ticks?market=${market}&count=${count}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { console.warn("[StrategyB] _fetchTrades:", e.message); return null; }
  }

  async _getPrice(market) {
    try {
      const res  = await safeFetch(`${UPBIT_API}/v1/ticker?markets=${market}`);
      const data = await res.json();
      return data[0]?.trade_price || null;
    } catch (e) { console.warn("[StrategyB] _getPrice:", e.message); return null; }
  }

  _updateDetection(market, status) {
    const det = this.detections.find(d => d.market === market);
    if (det) det.status = status;
  }

  // ─── Dashboard Summary ──────────────────────────────

  getSummary() {
    const init  = this.initialCapital;
    const inPos = Array.from(this.sim.positions.values()).reduce((s, p) => s + p.budget, 0);
    const total = this.sim.cash + inPos;

    return {
      name: "B -- New Listing v2",
      pnlRate:     +((total - init) / init * 100).toFixed(3),
      totalAsset:  Math.round(total),
      realizedPnl: Math.round(this.sim.realizedPnl),
      totalTrades: this.sim.totalTrades,
      wins: this.sim.wins, losses: this.sim.losses,
      winRate: this.sim.totalTrades > 0
        ? +(this.sim.wins / this.sim.totalTrades * 100).toFixed(1) : null,
      positions: Array.from(this.sim.positions.values()).map(p => ({
        market:      p.market,
        entryPrice:  Math.round(p.entryPrice),
        targetPrice: Math.round(p.targetPrice),
        stopPrice:   Math.round(p.stopPrice),
        peakPrice:   Math.round(p.peakPrice),
        openedAt:    p.openedAt,
        partialDone: p.partialDone,
        trailActive: p.trailActive,
      })),
      livePositions:   Array.from(this.livePositions.values()),
      monitoringCount: this.knownMarkets.size,
      detections:      this.detections.slice(0, 10),
      history:         this.sim.history.slice(0, 8),
      wsActive:        this._wsActive,
    };
  }
}

module.exports = { StrategyB };
