"use strict";

/**
 * CalibrationEngine v2 — Kelly criterion auto-calibration
 *
 * Rolling window of last N trades to compute:
 *   - Win rate, avg win, avg loss
 *   - Kelly fraction (f* = (b*p - q) / b)
 *   - Half-Kelly safety (practical position sizing)
 *   - Suggested position percentage
 *
 * Self-contained: no external dependencies (MarketDataService removed).
 * Accepts trade history array directly via calibrate(tradeHistory).
 */

class CalibrationEngine {
  constructor(options = {}) {
    this.ROLLING_WINDOW    = options.rollingWindow    || 200;
    this.MIN_TRADES        = options.minTrades        || 20;
    this.KELLY_DIVISOR     = options.kellyDivisor     || 2;     // half-Kelly
    this.MAX_POSITION_PCT  = options.maxPositionPct   || 0.25;  // max 25%
    this.MIN_POSITION_PCT  = options.minPositionPct   || 0.02;  // min 2%

    // Internal state for periodic auto-calibration
    this._tradeBuffer   = [];
    this._lastResult    = null;
    this._intervalId    = null;
  }

  // ─── Primary API ────────────────────────────────────

  /**
   * calibrate(tradeHistory) -> calibration result
   *
   * @param {Array<{pnlRate: number}>} tradeHistory - array of trades with pnlRate field
   *   pnlRate > 0 = win, pnlRate <= 0 = loss
   * @returns {{
   *   kellyFraction: number,
   *   halfKelly: number,
   *   suggestedPositionPct: number,
   *   winRate: number,
   *   avgWin: number,
   *   avgLoss: number,
   *   payoffRatio: number,
   *   expectedValue: number,
   *   totalTrades: number,
   *   sufficient: boolean,
   *   calibratedAt: string
   * }}
   */
  calibrate(tradeHistory) {
    if (!Array.isArray(tradeHistory) || tradeHistory.length === 0) {
      return this._defaultResult("no trades");
    }

    // Rolling window: use only most recent N trades
    const trades = tradeHistory.slice(-this.ROLLING_WINDOW);
    const sufficient = trades.length >= this.MIN_TRADES;

    const wins   = trades.filter(t => t.pnlRate > 0);
    const losses = trades.filter(t => t.pnlRate <= 0);

    const winRate  = trades.length > 0 ? wins.length / trades.length : 0;
    const avgWin   = wins.length > 0
      ? wins.reduce((s, t) => s + t.pnlRate, 0) / wins.length
      : 0;
    const avgLoss  = losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + t.pnlRate, 0) / losses.length)
      : 0;

    // Payoff ratio (b = avgWin / avgLoss)
    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 10 : 0);

    // Kelly formula: f* = (b * p - q) / b
    const p = winRate;
    const q = 1 - p;
    const b = payoffRatio;
    let kellyFraction = b > 0 ? (b * p - q) / b : 0;

    // Clamp to [0, 1]
    kellyFraction = Math.max(0, Math.min(1, kellyFraction));

    // Half-Kelly for safety
    const halfKelly = kellyFraction / this.KELLY_DIVISOR;

    // Suggested position size (clamped)
    let suggestedPositionPct = halfKelly;
    if (sufficient && kellyFraction > 0) {
      suggestedPositionPct = Math.max(
        this.MIN_POSITION_PCT,
        Math.min(this.MAX_POSITION_PCT, halfKelly)
      );
    } else if (!sufficient) {
      suggestedPositionPct = this.MIN_POSITION_PCT;
    } else {
      // Kelly <= 0: negative edge, do not trade
      suggestedPositionPct = 0;
    }

    // Expected value per trade
    const expectedValue = winRate * avgWin - (1 - winRate) * avgLoss;

    const result = {
      kellyFraction:        Math.round(kellyFraction * 10000) / 10000,
      halfKelly:            Math.round(halfKelly * 10000) / 10000,
      suggestedPositionPct: Math.round(suggestedPositionPct * 10000) / 10000,
      winRate:              Math.round(winRate * 10000) / 10000,
      avgWin:               Math.round(avgWin * 10000) / 10000,
      avgLoss:              Math.round(avgLoss * 10000) / 10000,
      payoffRatio:          Math.round(payoffRatio * 100) / 100,
      expectedValue:        Math.round(expectedValue * 10000) / 10000,
      totalTrades:          trades.length,
      sufficient,
      calibratedAt:         new Date().toISOString(),
    };

    this._lastResult = result;

    if (sufficient) {
      console.log(
        `[CalibrationEngine] calibrated -- ` +
        `winRate: ${(winRate * 100).toFixed(1)}% | ` +
        `payoff: ${payoffRatio.toFixed(2)} | ` +
        `kelly: ${(kellyFraction * 100).toFixed(1)}% | ` +
        `halfKelly: ${(halfKelly * 100).toFixed(1)}% | ` +
        `suggested: ${(suggestedPositionPct * 100).toFixed(1)}% | ` +
        `EV: ${(expectedValue * 100).toFixed(3)}% | ` +
        `trades: ${trades.length}`
      );
    }

    return result;
  }

  // ─── Buffer-based Auto Calibration ──────────────────

  /**
   * Record a completed trade into internal buffer
   */
  recordTrade(trade) {
    if (trade == null || typeof trade.pnlRate !== "number") return;
    this._tradeBuffer.push(trade);
    if (this._tradeBuffer.length > this.ROLLING_WINDOW * 2) {
      this._tradeBuffer = this._tradeBuffer.slice(-this.ROLLING_WINDOW);
    }
  }

  /**
   * Start periodic auto-calibration (every intervalMs)
   */
  start(intervalMs = 60_000) {
    this.calibrate(this._tradeBuffer);
    this._intervalId = setInterval(() => {
      this.calibrate(this._tradeBuffer);
    }, intervalMs);
    console.log(`[CalibrationEngine] started -- interval: ${intervalMs / 1000}s`);
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * Get last calibration result
   */
  getResult() {
    return this._lastResult || this._defaultResult("not calibrated yet");
  }

  getSummary() {
    const r = this._lastResult;
    if (!r) return { mode: "WAITING", totalTrades: this._tradeBuffer.length };
    return {
      mode:             r.sufficient ? "CALIBRATED" : "COLLECTING",
      totalTrades:      r.totalTrades,
      winRate:          r.winRate,
      kellyFraction:    r.kellyFraction,
      halfKelly:        r.halfKelly,
      suggestedPosPct:  r.suggestedPositionPct,
      expectedValue:    r.expectedValue,
      payoffRatio:      r.payoffRatio,
      calibratedAt:     r.calibratedAt,
    };
  }

  // ─── Helpers ────────────────────────────────────────

  _defaultResult(reason) {
    return {
      kellyFraction:        0,
      halfKelly:            0,
      suggestedPositionPct: this.MIN_POSITION_PCT,
      winRate:              0,
      avgWin:               0,
      avgLoss:              0,
      payoffRatio:          0,
      expectedValue:        0,
      totalTrades:          0,
      sufficient:           false,
      calibratedAt:         new Date().toISOString(),
      _reason:              reason,
    };
  }
}

module.exports = { CalibrationEngine };
