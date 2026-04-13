"use strict";

/**
 * BybitFundingEngine — BTC 무기한 선물 펀딩비 모니터링
 *
 * 공개 API 사용 (API 키 불필요)
 * 30분마다 갱신, 펀딩비 기반 파밍 신호 생성
 *
 * 신호 로직:
 *   rate > +0.03%/8h  → SHORT_COLLECT (롱이 숏에게 지불, 숏 유리)
 *   rate < -0.03%/8h  → LONG_COLLECT  (숏이 롱에게 지불, 롱 유리)
 *   |rate| < 0.03%    → NEUTRAL       (수익성 낮음, 대기)
 *
 * APR 계산: rate × 3 × 365 (하루 3회 정산 기준)
 */

const SYMBOL           = "BTCUSDT";
const REFRESH_INTERVAL = 30 * 60 * 1000;   // 30분
const FARM_THRESHOLD   = 0.0003;            // 0.03%/8h = ~33% APR 기준

class BybitFundingEngine {
  constructor() {
    this.state = {
      fundingRate:     null,   // 현재 펀딩비 (소수, e.g. 0.0001)
      apr:             null,   // 연환산 APR (%)
      nextFundingTime: null,   // 다음 정산 시각 (ms timestamp)
      signal:          null,   // "SHORT_COLLECT" | "LONG_COLLECT" | "NEUTRAL"
      indexPrice:      null,   // BTC 인덱스 가격
      markPrice:       null,   // BTC 마크 가격
      lastUpdated:     null,
      error:           null,
    };

    this._fetch();
    this._timer = setInterval(() => this._fetch(), REFRESH_INTERVAL);
  }

  async _fetch() {
    try {
      const res  = await fetch(
        `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${SYMBOL}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const ticker = json?.result?.list?.[0];
      if (!ticker) throw new Error("ticker 없음");

      const rate       = parseFloat(ticker.fundingRate    || "0");
      const nextTime   = parseInt(ticker.nextFundingTime   || "0", 10);
      const indexPx    = parseFloat(ticker.indexPrice      || "0");
      const markPx     = parseFloat(ticker.markPrice       || "0");

      const apr = rate * 3 * 365 * 100;  // % 기준

      let signal;
      if (rate >= FARM_THRESHOLD)        signal = "SHORT_COLLECT";
      else if (rate <= -FARM_THRESHOLD)  signal = "LONG_COLLECT";
      else                               signal = "NEUTRAL";

      this.state = {
        fundingRate:     rate,
        apr:             +apr.toFixed(2),
        nextFundingTime: nextTime,
        signal,
        indexPrice:      indexPx,
        markPrice:       markPx,
        lastUpdated:     Date.now(),
        error:           null,
      };

      console.log(
        `[Funding] ${(rate * 100).toFixed(4)}%/8h | APR ${apr.toFixed(1)}% | ${signal}`
      );
    } catch (e) {
      this.state.error = e.message;
      console.warn(`[Funding] 조회 실패: ${e.message}`);
    }
  }

  /** 다음 정산까지 남은 시간 (분) */
  getMinutesToNext() {
    if (!this.state.nextFundingTime) return null;
    const diff = this.state.nextFundingTime - Date.now();
    return diff > 0 ? Math.floor(diff / 60000) : 0;
  }

  getSummary() {
    const s   = this.state;
    const min = this.getMinutesToNext();
    return {
      rate:       s.fundingRate,
      ratePct:    s.fundingRate != null ? +(s.fundingRate * 100).toFixed(4) : null,
      apr:        s.apr,
      signal:     s.signal,
      indexPrice: s.indexPrice,
      markPrice:  s.markPrice,
      minutesToNext: min,
      nextLabel:  min != null ? `${Math.floor(min / 60)}h ${min % 60}m` : "—",
      lastUpdated: s.lastUpdated,
      error:      s.error,
    };
  }

  stop() { clearInterval(this._timer); }
}

module.exports = { BybitFundingEngine };
