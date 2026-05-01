"use strict";

/**
 * StrategyPairs — Pairs Trading (BTC-ETH-XRP mean reversion)
 *
 * 0.1% 퀀트 클래식 알파 — 통계적 차익(statistical arbitrage):
 *   1. 상관관계 높은 두 코인 (BTC-ETH ~0.85, BTC-XRP ~0.65)
 *   2. ratio (price_A / price_B)가 historical mean ± 2σ 벗어나면 mean reversion 베팅
 *   3. 시장 중립 (delta-neutral) — 시장 폭락해도 수익 가능
 *
 * 진입:
 *   ratio > mean + 2σ → A overvalued → SHORT A + LONG B
 *   ratio < mean - 2σ → A undervalued → LONG A + SHORT B
 *
 * 청산:
 *   ratio가 mean에 도달 (±0.5σ 이내)
 *   또는 손절: 3σ 추가 벗어남
 *
 * 단순화 (현물 시장 한계):
 *   - 실제 short은 perpetual 필요 (Upbit 현물만 사용 시 불가)
 *   - 우리 봇: SIM 모드에서 통계 측정 → 실제 진입은 Bybit perp 추가 시 가능
 *   - 지금은 모니터링 + 데이터 누적 단계
 */

const { EventEmitter } = require("events");

const UPBIT_BASE = "https://api.upbit.com";

const PAIRS = [
  { name: "BTC-ETH",  a: "KRW-BTC", b: "KRW-ETH",  zEnter: 2.0, zExit: 0.5, zStop: 3.0 },
  { name: "BTC-XRP",  a: "KRW-BTC", b: "KRW-XRP",  zEnter: 2.0, zExit: 0.5, zStop: 3.0 },
  { name: "ETH-XRP",  a: "KRW-ETH", b: "KRW-XRP",  zEnter: 2.0, zExit: 0.5, zStop: 3.0 },
  { name: "BTC-SOL",  a: "KRW-BTC", b: "KRW-SOL",  zEnter: 2.2, zExit: 0.5, zStop: 3.5 },
  { name: "BTC-DOGE", a: "KRW-BTC", b: "KRW-DOGE", zEnter: 2.5, zExit: 0.5, zStop: 3.5 },
];

const POLL_INTERVAL_MS  = 60_000;
const HISTORY_WINDOW    = 200; // 200 캔들 (1h봉 기준 ~8일)
const SIGNAL_DEDUP_MS   = 30 * 60_000;

class StrategyPairs extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.notifier  = opts.notifier  || null;
    this.arbLogger = opts.arbLogger || null;

    this._intervalId = null;
    this._running    = false;
    this._priceHistory = new Map();   // market → [closes]
    this._lastSignals  = new Map();   // pair name → ts
    this._stats = {
      cycles:    0,
      signals:   0,
      startedAt: null,
      activeSignals: 0,
    };
  }

  async start() {
    if (this._running) return;
    console.log("[StrategyPairs] 시작 — BTC/ETH/XRP/SOL/DOGE pairs trading 모니터");
    this._stats.startedAt = Date.now();
    this._running = true;

    // 첫 사이클 즉시 + 주기 시작
    this._cycle().catch(e => console.error("[StrategyPairs] initial:", e.message));
    this._intervalId = setInterval(() => {
      this._cycle().catch(e => console.error("[StrategyPairs] cycle:", e.message));
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = null;
    this._running = false;
  }

  async _fetchPrice(market) {
    try {
      const res = await fetch(`${UPBIT_BASE}/v1/ticker?markets=${market}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data[0]?.trade_price || null;
    } catch { return null; }
  }

  async _fetchCandles(market, count = HISTORY_WINDOW) {
    try {
      const res = await fetch(`${UPBIT_BASE}/v1/candles/minutes/60?market=${market}&count=${count}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.reverse().map(c => c.trade_price);
    } catch { return null; }
  }

  _stddev(arr) {
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    return { mean, std: Math.sqrt(variance) };
  }

  async _cycle() {
    this._stats.cycles++;

    // 모든 unique market 가격 + 히스토리 fetch (병렬)
    const markets = [...new Set(PAIRS.flatMap(p => [p.a, p.b]))];
    const histories = await Promise.all(
      markets.map(m => this._fetchCandles(m, HISTORY_WINDOW))
    );

    for (let i = 0; i < markets.length; i++) {
      if (histories[i] && histories[i].length >= 50) {
        this._priceHistory.set(markets[i], histories[i]);
      }
    }

    let activeCount = 0;

    for (const pair of PAIRS) {
      const histA = this._priceHistory.get(pair.a);
      const histB = this._priceHistory.get(pair.b);
      if (!histA || !histB || histA.length < 50 || histB.length < 50) continue;

      // ratio = A / B 시계열
      const len = Math.min(histA.length, histB.length);
      const ratios = [];
      for (let i = 0; i < len; i++) {
        if (histB[i] > 0) ratios.push(histA[i] / histB[i]);
      }
      if (ratios.length < 50) continue;

      const { mean, std } = this._stddev(ratios);
      const currentRatio = ratios[ratios.length - 1];
      const zScore = std > 0 ? (currentRatio - mean) / std : 0;

      // Active signal 카운트
      if (Math.abs(zScore) >= pair.zEnter) activeCount++;

      // 진입 시그널
      if (Math.abs(zScore) >= pair.zEnter) {
        const lastTs = this._lastSignals.get(pair.name) || 0;
        if (Date.now() - lastTs < SIGNAL_DEDUP_MS) continue;
        this._lastSignals.set(pair.name, Date.now());

        this._stats.signals++;
        const direction = zScore > 0 ? "OVERVALUED_A" : "UNDERVALUED_A";
        const action = zScore > 0
          ? `SHORT ${pair.a} + LONG ${pair.b}`
          : `LONG ${pair.a} + SHORT ${pair.b}`;

        const msg = `📊 [Pairs] ${pair.name} z=${zScore.toFixed(2)} (mean ${mean.toFixed(6)} std ${std.toFixed(6)}) — ${action}`;
        console.log(msg);

        // ArbDataLogger에 기록 (spread_events 활용)
        if (this.arbLogger?.logSpreadEvent) {
          try {
            this.arbLogger.logSpreadEvent({
              symbol:        pair.name,
              buyExchange:   "pairs",
              sellExchange:  direction.toLowerCase(),
              buyPrice:      currentRatio,
              sellPrice:     mean,
              spreadPct:     ((currentRatio - mean) / mean) * 100,
              netSpreadPct:  Math.abs(zScore),
              source:        "strategy-pairs",
            });
          } catch {}
        }

        if (this.notifier?.send) {
          this.notifier.send(
            `📊 <b>Pairs Trading 시그널</b>\n` +
            `페어: ${pair.name}\n` +
            `Z-score: <b>${zScore.toFixed(2)}σ</b>\n` +
            `현재 ratio: ${currentRatio.toFixed(6)}\n` +
            `평균: ${mean.toFixed(6)} ± ${std.toFixed(6)}\n` +
            `예상 액션: ${action}\n` +
            `→ 시장 중립 mean reversion (perpetual 추가 시 LIVE 가능)`
          );
        }

        this.emit("signal", { pair: pair.name, zScore, mean, currentRatio, direction });
      }
    }

    this._stats.activeSignals = activeCount;
  }

  getSummary() {
    const ratios = {};
    for (const pair of PAIRS) {
      const histA = this._priceHistory.get(pair.a);
      const histB = this._priceHistory.get(pair.b);
      if (histA && histB && histA.length > 0 && histB[histB.length - 1] > 0) {
        const len = Math.min(histA.length, histB.length);
        const arr = [];
        for (let i = 0; i < len; i++) {
          if (histB[i] > 0) arr.push(histA[i] / histB[i]);
        }
        if (arr.length > 50) {
          const { mean, std } = this._stddev(arr);
          const cur = arr[arr.length - 1];
          ratios[pair.name] = {
            current: +cur.toFixed(6),
            mean: +mean.toFixed(6),
            std: +std.toFixed(6),
            z: +(((cur - mean) / std) || 0).toFixed(2),
          };
        }
      }
    }
    return {
      running:    this._running,
      stats:      { ...this._stats },
      uptimeHrs:  this._stats.startedAt
        ? +((Date.now() - this._stats.startedAt) / 3_600_000).toFixed(2)
        : 0,
      pairs: ratios,
    };
  }
}

module.exports = { StrategyPairs };
