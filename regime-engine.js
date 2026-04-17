"use strict";

/**
 * RegimeEngine v2 — Multi-timeframe regime detection
 *
 * Upbit REST API candle data (1h, 4h, daily) 기반
 * 5-국면 분류: BULL_STRONG, BULL_WEAK, RANGE, BEAR_WEAK, BEAR_STRONG
 *
 * 사용 지표: SMA20/50/200, RSI14, ATR14, Volume Ratio, ADX
 */

const { safeFetch } = require("./exchange-adapter");
const UPBIT_API = "https://api.upbit.com";

class RegimeEngine {
  constructor(options = {}) {
    this.cacheTTL = options.cacheTTL || 60_000; // 1분 캐시
    this._cache = new Map();

    // 히스테리시스: 잦은 전환 방지
    this._pendingRegime = null;
    this._pendingCount  = 0;
    this.HYSTERESIS_COUNT = 2;

    // 마지막 확정 국면
    this._lastRegime = "RANGE";
    this._lastConfidence = 0;
  }

  // ─── Public API ─────────────────────────────────────

  /**
   * detect(market) -> { regime, confidence, details }
   *
   * @param {string} market - e.g. "KRW-BTC"
   * @returns {Promise<{regime: string, confidence: number, details: object}>}
   */
  async detect(market) {
    const cacheKey = `${market}_regime`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return cached.value;
    }

    try {
      const [candles1h, candles4h, candlesDaily] = await Promise.all([
        this._fetchCandles(market, 60, 200),
        this._fetchCandles(market, 240, 200),
        this._fetchCandlesDay(market, 200),
      ]);

      const tf1h    = this._analyzeTimeframe(candles1h, "1h");
      const tf4h    = this._analyzeTimeframe(candles4h, "4h");
      const tfDaily = this._analyzeTimeframe(candlesDaily, "daily");

      const compositeScore = this._fuseScores(tf1h, tf4h, tfDaily);
      const rawRegime = this._classifyRegime(compositeScore);

      // 히스테리시스 적용
      const regime = this._applyHysteresis(rawRegime);
      const confidence = Math.min(Math.abs(compositeScore) / 100, 1.0);

      const result = {
        regime,
        confidence: Math.round(confidence * 100) / 100,
        details: {
          compositeScore: Math.round(compositeScore * 100) / 100,
          rawRegime,
          timeframes: {
            "1h":    { score: tf1h.score, trend: tf1h.trend, rsi: tf1h.rsi, adx: tf1h.adx, volRatio: tf1h.volRatio },
            "4h":    { score: tf4h.score, trend: tf4h.trend, rsi: tf4h.rsi, adx: tf4h.adx, volRatio: tf4h.volRatio },
            daily:   { score: tfDaily.score, trend: tfDaily.trend, rsi: tfDaily.rsi, adx: tfDaily.adx, volRatio: tfDaily.volRatio },
          },
          timestamp: new Date().toISOString(),
        },
      };

      this._lastRegime = regime;
      this._lastConfidence = result.confidence;
      this._cache.set(cacheKey, { ts: Date.now(), value: result });

      console.log(
        `[RegimeEngine] ${market} -> ${regime} (confidence: ${result.confidence}, ` +
        `score: ${result.details.compositeScore})`
      );
      return result;

    } catch (err) {
      console.error(`[RegimeEngine] detect error (${market}):`, err.message);
      return {
        regime: this._lastRegime || "RANGE",
        confidence: 0,
        details: { error: err.message, timestamp: new Date().toISOString() },
      };
    }
  }

  /**
   * Convenience getters matching v1 interface
   */
  getRegime()    { return this._lastRegime; }
  getConfidence(){ return this._lastConfidence; }

  isBullish() {
    return this._lastRegime === "BULL_STRONG" || this._lastRegime === "BULL_WEAK";
  }
  isBearish() {
    return this._lastRegime === "BEAR_STRONG" || this._lastRegime === "BEAR_WEAK";
  }

  getKellyMultiplier() {
    switch (this._lastRegime) {
      case "BULL_STRONG": return 1.5;
      case "BULL_WEAK":   return 1.2;
      case "RANGE":       return 1.0;
      case "BEAR_WEAK":   return 0.5;
      case "BEAR_STRONG": return 0.0;
      default:            return 1.0;
    }
  }

  getScoreContribution() {
    switch (this._lastRegime) {
      case "BULL_STRONG": return 30;
      case "BULL_WEAK":   return 15;
      case "RANGE":       return 0;
      case "BEAR_WEAK":   return -15;
      case "BEAR_STRONG": return -999;
      default:            return 0;
    }
  }

  getSummary() {
    return {
      regime:          this._lastRegime,
      confidence:      this._lastConfidence,
      kellyMultiplier: this.getKellyMultiplier(),
      scoreContrib:    this.getScoreContribution(),
      pendingRegime:   this._pendingRegime,
    };
  }

  // ─── Candle Fetching ────────────────────────────────

  async _fetchCandles(market, minutes, count) {
    const url = `${UPBIT_API}/v1/candles/minutes/${minutes}?market=${market}&count=${count}`;
    const res = await safeFetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`candle fetch ${minutes}m failed: ${res.status}`);
    const data = await res.json();
    return data.reverse(); // chronological
  }

  async _fetchCandlesDay(market, count) {
    const url = `${UPBIT_API}/v1/candles/days?market=${market}&count=${count}`;
    const res = await safeFetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`candle fetch daily failed: ${res.status}`);
    const data = await res.json();
    return data.reverse();
  }

  // ─── Timeframe Analysis ─────────────────────────────

  _analyzeTimeframe(candles, label) {
    if (!candles || candles.length < 50) {
      return { score: 0, trend: "UNKNOWN", rsi: 50, adx: 0, volRatio: 1, label };
    }

    const closes  = candles.map(c => c.trade_price);
    const highs   = candles.map(c => c.high_price);
    const lows    = candles.map(c => c.low_price);
    const volumes = candles.map(c => c.candle_acc_trade_volume);

    const sma20  = this._sma(closes, 20);
    const sma50  = this._sma(closes, 50);
    const sma200 = candles.length >= 200 ? this._sma(closes, 200) : sma50;
    const lastClose = closes[closes.length - 1];

    const rsi = this._rsi(closes, 14);
    const atr = this._atr(highs, lows, closes, 14);
    const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;

    const volRecent = this._mean(volumes.slice(-5));
    const volPrior  = this._mean(volumes.slice(-25, -5));
    const volRatio  = volPrior > 0 ? volRecent / volPrior : 1;

    const adx = this._adx(highs, lows, closes, 14);

    // ─── Score Calculation ────────────────────────────
    let score = 0;

    // SMA alignment
    if (lastClose > sma20) score += 10; else score -= 10;
    if (sma20 > sma50) score += 15; else score -= 15;
    if (sma50 > sma200) score += 20; else score -= 20;

    // Price vs SMA200 distance
    if (sma200 > 0) {
      const distPct = ((lastClose - sma200) / sma200) * 100;
      score += Math.max(-25, Math.min(25, distPct * 2));
    }

    // RSI
    if (rsi > 70) score += 10;
    else if (rsi > 55) score += 5;
    else if (rsi < 30) score -= 10;
    else if (rsi < 45) score -= 5;

    // ADX trend strength amplifier
    if (adx > 25) {
      score = score * 1.3;
    } else if (adx < 15) {
      score = score * 0.5;
    }

    // Volume ratio amplifier
    if (volRatio > 1.5) {
      score = score * 1.2;
    }

    let trend;
    if (sma20 > sma50 && sma50 > sma200) trend = "UP";
    else if (sma20 < sma50 && sma50 < sma200) trend = "DOWN";
    else trend = "MIXED";

    return {
      score: Math.round(score * 100) / 100,
      trend,
      rsi: Math.round(rsi * 100) / 100,
      adx: Math.round(adx * 100) / 100,
      atrPct: Math.round(atrPct * 100) / 100,
      volRatio: Math.round(volRatio * 100) / 100,
      label,
    };
  }

  // ─── Score Fusion ───────────────────────────────────

  _fuseScores(tf1h, tf4h, tfDaily) {
    return tfDaily.score * 0.5 + tf4h.score * 0.3 + tf1h.score * 0.2;
  }

  _classifyRegime(score) {
    if (score >= 50)  return "BULL_STRONG";
    if (score >= 15)  return "BULL_WEAK";
    if (score > -15)  return "RANGE";
    if (score > -50)  return "BEAR_WEAK";
    return "BEAR_STRONG";
  }

  _applyHysteresis(rawRegime) {
    const prev = this._lastRegime;
    if (rawRegime === prev) {
      this._pendingRegime = null;
      this._pendingCount  = 0;
      return prev;
    }

    if (rawRegime === this._pendingRegime) {
      this._pendingCount++;
      if (this._pendingCount >= this.HYSTERESIS_COUNT) {
        this._pendingRegime = null;
        this._pendingCount  = 0;
        console.log(`[RegimeEngine] regime transition: ${prev} -> ${rawRegime}`);
        return rawRegime;
      }
    } else {
      this._pendingRegime = rawRegime;
      this._pendingCount  = 1;
    }

    return prev;
  }

  // ─── Technical Indicators ──────────────────────────

  _sma(values, period) {
    if (values.length < period) return values[values.length - 1] || 0;
    const slice = values.slice(-period);
    return slice.reduce((s, v) => s + v, 0) / period;
  }

  _mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  _rsi(closes, period) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  _atr(highs, lows, closes, period) {
    if (highs.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < highs.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }
    const slice = trs.slice(-period);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  }

  _adx(highs, lows, closes, period) {
    if (highs.length < period * 2) return 0;

    const plusDMs = [];
    const minusDMs = [];
    const trs = [];

    for (let i = 1; i < highs.length; i++) {
      const upMove   = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];
      plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }

    if (trs.length < period) return 0;

    let atr     = this._mean(trs.slice(0, period));
    let plusDM   = this._mean(plusDMs.slice(0, period));
    let minusDM  = this._mean(minusDMs.slice(0, period));
    const dxValues = [];

    for (let i = period; i < trs.length; i++) {
      atr     = atr - (atr / period) + trs[i];
      plusDM  = plusDM - (plusDM / period) + plusDMs[i];
      minusDM = minusDM - (minusDM / period) + minusDMs[i];

      const plusDI  = atr > 0 ? (plusDM / atr) * 100 : 0;
      const minusDI = atr > 0 ? (minusDM / atr) * 100 : 0;
      const diSum   = plusDI + minusDI;
      const dx      = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
      dxValues.push(dx);
    }

    if (dxValues.length < period) return this._mean(dxValues) || 0;

    let adx = this._mean(dxValues.slice(0, period));
    for (let i = period; i < dxValues.length; i++) {
      adx = (adx * (period - 1) + dxValues[i]) / period;
    }
    return adx;
  }
}

module.exports = { RegimeEngine };
