"use strict";

/**
 * StrategyFunding — Funding Rate 차익 (Cash & Carry)
 *
 * 0.1% 퀀트 클래식 알파 — 무위험 차익(거의):
 *   1. perpetual futures funding rate 조회 (Bybit, Binance, OKX)
 *   2. funding 양수 = perp 가격 > spot 가격 = long 포지션이 short에게 funding 지불
 *   3. 동시 실행: SHORT perp + LONG spot (동일 자산)
 *      → delta-neutral (가격 방향 무관)
 *      → 8시간마다 funding 수령 (연 환산 5~50%+)
 *
 * 모니터링 (이번 모듈):
 *   - Bybit/Binance/OKX BTC/ETH funding rate
 *   - Upbit spot 가격
 *   - 베이시스 = (perp - spot) / spot
 *   - 연 환산 funding APR
 *   - 진입 임계: funding > 0.01% (8시간) = 연 11%+
 *
 * LIVE 진입 (추후):
 *   - Bybit/Binance perpetual API 키 + USDT 자본 필요
 *   - Upbit spot 자본 필요
 *   - 환율 변동 hedge 필요 (USD/KRW)
 */

const { EventEmitter } = require("events");

const BYBIT_BASE   = "https://api.bybit.com";
const BINANCE_BASE = "https://fapi.binance.com";
const OKX_BASE     = "https://www.okx.com";
const UPBIT_BASE   = "https://api.upbit.com";

const POLL_INTERVAL_MS  = 5 * 60_000;  // 5분 (funding 8h 단위라 자주 폴링 X)
const MIN_FUNDING_APR   = 0.10;         // 연 10% 이상만 알림
const ALERT_DEDUP_MS    = 60 * 60_000;  // 1시간

const COINS = ["BTC", "ETH", "XRP", "SOL", "DOGE"];

class StrategyFunding extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.notifier  = opts.notifier  || null;
    this.arbLogger = opts.arbLogger || null;

    this._intervalId = null;
    this._running    = false;
    this._lastAlerts = new Map();
    this._stats = {
      cycles:    0,
      detected:  0,
      alerted:   0,
      startedAt: null,
    };
    this._latestRates = new Map();
  }

  async start() {
    if (this._running) return;
    console.log("[StrategyFunding] 시작 — perp funding vs spot 베이시스 모니터");
    this._stats.startedAt = Date.now();
    this._running = true;

    this._cycle().catch(e => console.error("[StrategyFunding] initial:", e.message));
    this._intervalId = setInterval(() => {
      this._cycle().catch(e => console.error("[StrategyFunding] cycle:", e.message));
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = null;
    this._running = false;
  }

  // ── 거래소별 funding rate 조회 ──────────────────

  async _fetchBybitFunding(coin) {
    try {
      const url = `${BYBIT_BASE}/v5/market/tickers?category=linear&symbol=${coin}USDT`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      const t = data?.result?.list?.[0];
      if (!t) return null;
      return {
        exchange: "bybit",
        symbol:   `${coin}USDT`,
        perpPrice: parseFloat(t.lastPrice),
        funding:  parseFloat(t.fundingRate),
        nextFundingTime: parseInt(t.nextFundingTime),
      };
    } catch { return null; }
  }

  async _fetchBinanceFunding(coin) {
    try {
      const url = `${BINANCE_BASE}/fapi/v1/premiumIndex?symbol=${coin}USDT`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        exchange: "binance",
        symbol:   `${coin}USDT`,
        perpPrice: parseFloat(data.markPrice),
        funding:  parseFloat(data.lastFundingRate),
        nextFundingTime: data.nextFundingTime,
      };
    } catch { return null; }
  }

  async _fetchOkxFunding(coin) {
    try {
      const url = `${OKX_BASE}/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      const t = data?.data?.[0];
      if (!t) return null;
      return {
        exchange: "okx",
        symbol:   `${coin}-USDT-SWAP`,
        funding:  parseFloat(t.fundingRate),
        nextFundingTime: parseInt(t.nextFundingTime),
      };
    } catch { return null; }
  }

  async _fetchUpbitSpot(coin) {
    try {
      const url = `${UPBIT_BASE}/v1/ticker?markets=KRW-${coin}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      return data[0]?.trade_price || null;
    } catch { return null; }
  }

  // ── 메인 사이클 ────────────────────────────────

  async _cycle() {
    this._stats.cycles++;

    for (const coin of COINS) {
      try {
        const [bybit, binance, okx, upbitKrw] = await Promise.all([
          this._fetchBybitFunding(coin),
          this._fetchBinanceFunding(coin),
          this._fetchOkxFunding(coin),
          this._fetchUpbitSpot(coin),
        ]);

        const rates = [bybit, binance, okx].filter(Boolean);
        if (rates.length === 0) continue;

        // 가장 높은 funding rate 찾기
        const top = rates.sort((a, b) => b.funding - a.funding)[0];
        const fundingApr = top.funding * 3 * 365; // 8h × 3 = 일일 × 365

        this._latestRates.set(coin, {
          coin,
          rates: rates.map(r => ({ exchange: r.exchange, funding: r.funding, apr: r.funding * 3 * 365 })),
          topExchange: top.exchange,
          topFundingPct: +(top.funding * 100).toFixed(4),
          topAprPct: +(fundingApr * 100).toFixed(2),
          upbitKrw,
          updatedAt: Date.now(),
        });

        // 진입 임계 — APR 10%+
        if (fundingApr >= MIN_FUNDING_APR) {
          this._stats.detected++;

          const key = `${coin}-${top.exchange}`;
          const lastTs = this._lastAlerts.get(key) || 0;
          if (Date.now() - lastTs < ALERT_DEDUP_MS) continue;
          this._lastAlerts.set(key, Date.now());

          this._stats.alerted++;
          const msg = `💰 [Funding] ${coin} ${top.exchange} ${(top.funding * 100).toFixed(4)}% (8h) = APR ${(fundingApr * 100).toFixed(1)}%`;
          console.log(msg);

          if (this.arbLogger?.logSpreadEvent) {
            try {
              this.arbLogger.logSpreadEvent({
                symbol:        `${coin}_PERP`,
                buyExchange:   "upbit_spot",
                sellExchange:  `${top.exchange}_perp`,
                buyPrice:      upbitKrw || 0,
                sellPrice:     top.perpPrice || 0,
                spreadPct:     fundingApr * 100,
                netSpreadPct:  fundingApr * 100,
                source:        "strategy-funding",
              });
            } catch {}
          }

          if (this.notifier?.send) {
            this.notifier.send(
              `💰 <b>Funding Rate 차익 기회</b>\n` +
              `코인: <b>${coin}</b>\n` +
              `거래소: ${top.exchange}\n` +
              `Funding: ${(top.funding * 100).toFixed(4)}% (8h)\n` +
              `<b>APR: ${(fundingApr * 100).toFixed(1)}%</b>\n` +
              `→ SHORT perp ${top.exchange} + LONG spot Upbit (delta-neutral)`
            );
          }

          this.emit("opportunity", { coin, top, fundingApr });
        }
      } catch (e) {
        // silent
      }
    }
  }

  getSummary() {
    return {
      running:    this._running,
      stats:      { ...this._stats },
      uptimeHrs:  this._stats.startedAt
        ? +((Date.now() - this._stats.startedAt) / 3_600_000).toFixed(2)
        : 0,
      latestRates: [...this._latestRates.values()].sort((a, b) => b.topAprPct - a.topAprPct),
    };
  }
}

module.exports = { StrategyFunding };
