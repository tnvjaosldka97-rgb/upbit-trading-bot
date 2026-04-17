"use strict";

const { safeFetch } = require("./exchange-adapter");

/**
 * MacroSignalEngine — 구조적 알파 (Structural Alpha)
 *
 * 기술적 분석이 아닌 시장 구조적 비효율에서 엣지 추출.
 * 공개 API만 사용, 인증 불필요.
 *
 * 세 가지 진짜 알파:
 * 1) 김치 프리미엄: 업비트 vs 바이낸스 가격차
 *    - 극단 디스카운트 = 저평가 진입 기회
 *    - 극단 프리미엄   = 과열, 진입 억제
 *
 * 2) 펀딩비 역발상: 무기한 선물 포지션 쏠림
 *    - 극단 양수 = 롱 과밀 → 역발상으로 매수 억제
 *    - 극단 음수 = 숏 과밀 → 숏 스퀴즈 가능
 *
 * 3) 공포탐욕 역발상:
 *    - 극단 공포 (< 20) = 패닉 과매도 → 반등 기회
 *    - 극단 탐욕 (> 80) = 과열   → 진입 억제
 */
class MacroSignalEngine {
  constructor(marketDataService) {
    this.mds = marketDataService;

    // 임계값
    this.KIMCHI_OVERPRICED     =  0.025;   // +2.5% 이상 → 업비트 과열
    this.KIMCHI_UNDERPRICED    = -0.005;   // -0.5% 이하 → 저평가 기회
    this.FUNDING_CROWDED_LONG  =  0.0005;  // 0.05%/8h 초과 → 롱 과밀
    this.FUNDING_CROWDED_SHORT = -0.0003;  // -0.03%/8h 미만 → 숏 과밀
    this.FEAR_EXTREME          =  20;
    this.GREED_EXTREME         =  80;

    this.state = {
      binancePrices:  new Map(),   // symbol → USDT price
      kimchiPremiums: new Map(),   // market → premium rate
      fundingRates:   new Map(),   // symbol → rate/8h
      fearGreed:      null,
      lastUpdated:    { kimchi: 0, funding: 0, fearGreed: 0 },
    };

    this.intervalId = null;
  }

  start() {
    console.log("[MacroSignal] 시작 — 김치 프리미엄 / 펀딩비 / 공포탐욕");
    this.refresh();
    this.intervalId = setInterval(() => this.refresh(), 5 * 60_000);
  }

  stop() {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }

  async refresh() {
    await Promise.allSettled([
      this.refreshBinancePrices(),
      this.refreshFundingRates(),
      this.refreshFearGreed(),
    ]);
    this.computeKimchiPremiums();
  }

  async refreshBinancePrices() {
    const symbols = [
      "BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT","ADAUSDT",
      "DOGEUSDT","AVAXUSDT","DOTUSDT","LINKUSDT","MATICUSDT",
    ];
    try {
      const res = await safeFetch(
        `https://api.binance.com/api/v3/ticker/price?symbols=${JSON.stringify(symbols)}`,
      );
      if (!res.ok) return;
      for (const item of await res.json()) {
        this.state.binancePrices.set(item.symbol.replace("USDT", ""), Number(item.price));
      }
    } catch (e) { console.warn("[MacroSignal] refreshBinancePrices:", e.message); }

    // 환율도 함께 갱신 (FX 데이터 없을 때 폴백용)
    try {
      const res = await safeFetch("https://open.er-api.com/v6/latest/USD", { timeout: 8000 });
      if (res.ok) {
        const data = await res.json();
        if (data?.rates?.KRW) this._cachedUsdKrw = data.rates.KRW;
      }
    } catch (e) { console.warn("[MacroSignal] refreshFxRate:", e.message); }
  }

  computeKimchiPremiums() {
    const fxUsd = this.mds.state.fxUsd;
    // FX 데이터 없으면 환율 API로 직접 폴백 (캐시된 값 사용)
    const usdKrw = fxUsd?.basePrice
      ? Number(fxUsd.basePrice)
      : (this._cachedUsdKrw || require("./config").DEFAULT_USD_KRW);
    if (!usdKrw) return;

    for (const [symbol, binanceUsd] of this.state.binancePrices.entries()) {
      const market = `KRW-${symbol}`;
      const ctx    = this.mds.state.contexts.get(market);
      if (!ctx) continue;
      const upbitKrw  = this.mds.getCurrentPrice(ctx);
      const binanceKrw = binanceUsd * usdKrw;
      if (!upbitKrw || !binanceKrw) continue;
      this.state.kimchiPremiums.set(market, (upbitKrw - binanceKrw) / binanceKrw);
    }
    this.state.lastUpdated.kimchi = Date.now();
  }

  async refreshFundingRates() {
    try {
      // Binance 무기한 선물 펀딩비 — 공개 API, 인증 불필요
      const res = await safeFetch("https://fapi.binance.com/fapi/v1/premiumIndex");
      if (!res.ok) return;
      for (const item of await res.json()) {
        if (!item.symbol?.endsWith("USDT")) continue;
        this.state.fundingRates.set(
          item.symbol.replace("USDT", ""),
          Number(item.lastFundingRate || 0),
        );
      }
      this.state.lastUpdated.funding = Date.now();
    } catch (e) { console.warn("[MacroSignal] refreshFundingRates:", e.message); }
  }

  async refreshFearGreed() {
    try {
      const res  = await safeFetch("https://api.alternative.me/fng/?limit=1", { timeout: 8000 });
      if (!res.ok) return;
      const data = await res.json();
      const item = data?.data?.[0];
      if (item) {
        this.state.fearGreed = {
          value:          Number(item.value),
          classification: item.value_classification,
          timestamp:      Number(item.timestamp) * 1000,
        };
      }
      this.state.lastUpdated.fearGreed = Date.now();
    } catch (e) { console.warn("[MacroSignal] refreshFearGreed:", e.message); }
  }

  /**
   * 특정 마켓의 매크로 신호 반환
   * macroScore: -30 ~ +30 (양수 = 매수 우호)
   */
  getSignals(marketCode) {
    const symbol  = marketCode.split("-")[1];
    const kimchi  = this.state.kimchiPremiums.get(marketCode) ?? null;
    const funding = this.state.fundingRates.get(symbol) ?? null;
    const fg      = this.state.fearGreed;

    let score = 0;
    const flags = [];

    // ── 김치 프리미엄 ──────────────────────────────
    if (kimchi !== null) {
      if (kimchi > this.KIMCHI_OVERPRICED) {
        flags.push("KIMCHI_OVERPRICED");
        score -= 20;
      } else if (kimchi < this.KIMCHI_UNDERPRICED) {
        flags.push("KIMCHI_UNDERPRICED");
        score += 15;
      } else {
        score += Math.max(-8, Math.min(8, -kimchi * 300));
      }
    }

    // ── 펀딩비 역발상 ──────────────────────────────
    if (funding !== null) {
      if (funding > this.FUNDING_CROWDED_LONG) {
        flags.push("FUNDING_CROWDED_LONG");
        score -= 12;
      } else if (funding < this.FUNDING_CROWDED_SHORT) {
        flags.push("FUNDING_CROWDED_SHORT");
        score += 8;
      } else {
        score += Math.max(-5, Math.min(5, -funding * 8000));
      }
    }

    // ── 공포탐욕 역발상 ────────────────────────────
    if (fg?.value != null) {
      if (fg.value <= this.FEAR_EXTREME) {
        flags.push("EXTREME_FEAR_BUY");
        score += 12;
      } else if (fg.value >= this.GREED_EXTREME) {
        flags.push("EXTREME_GREED_CAUTION");
        score -= 10;
      } else {
        score += Math.max(-5, Math.min(5, (50 - fg.value) * 0.15));
      }
    }

    return {
      kimchiPremium:  kimchi,
      fundingRate:    funding,
      fearGreedValue: fg?.value ?? null,
      fearGreedClass: fg?.classification ?? null,
      flags,
      macroScore:     Math.max(-30, Math.min(30, Math.round(score * 10) / 10)),
      freshAt: {
        kimchi:    this.state.lastUpdated.kimchi,
        funding:   this.state.lastUpdated.funding,
        fearGreed: this.state.lastUpdated.fearGreed,
      },
    };
  }

  getSummary() {
    return {
      kimchiPremiums:   Object.fromEntries(this.state.kimchiPremiums),
      fearGreed:        this.state.fearGreed,
      fundingRateCount: this.state.fundingRates.size,
      lastUpdated:      this.state.lastUpdated,
    };
  }
}

module.exports = { MacroSignalEngine };
