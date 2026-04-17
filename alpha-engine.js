"use strict";

const CFG = require("./config");

/**
 * AlphaEngine — 체결강도 + 김치프리미엄 + 변동성 적응 + 분할진입 + 성과 추적
 *
 * 신규상장 (Strategy B) 전용 알파 엔진.
 * 탑 0.1% 퀀트 트레이더가 실전에서 사용하는 핵심 모듈:
 *
 * 1) Tape Reading (체결강도 분석)
 *    - 매수/매도 압력 비율, 대형체결 비율, 체결속도, 모멘텀
 *    - 신규상장 초기 FOMO 강도를 정량화
 *
 * 2) Kimchi Premium (김치프리미엄)
 *    - 업비트 vs 바이낸스 가격차로 과열/저평가 판단
 *    - 8%+ 프리미엄 = 진입 억제, 2% 미만 = 적극 진입
 *
 * 3) Volatility-Adaptive Parameters (변동성 적응형 파라미터)
 *    - ATR 기반 동적 손절/목표/트레일링 계산
 *    - 고변동성 → 넓은 스탑 (조기 손절 방지)
 *    - 저변동성 → 타이트 스탑 (리스크 최소화)
 *
 * 4) Phased Entry (분할 진입)
 *    - 체결강도에 따라 분할 진입 비율 결정
 *    - STRONG_BUY: 60%+40%, BUY: 60%+40%, NEUTRAL: 40%+60%
 *
 * 5) Alpha Performance Tracker (알파 성과 추적)
 *    - 신호별 수익률 추적 → 자기 학습
 *    - Tape 정확도, 김치프리미엄 엣지 측정
 */

// ── 상수 ─────────────────────────────────────────────────
const TAPE_TRADE_COUNT    = 100;   // 체결강도 분석 체결 수
const CANDLE_COUNT        = 50;    // 변동성 분석 캔들 수
const CANDLE_MINUTES      = 5;     // 5분봉

// 변동성 적응형 파라미터 기본값
const BASE_STOP    = -0.08;   // -8%
const BASE_TARGET  =  0.30;   // +30%
const BASE_PARTIAL =  0.15;   // +15%
const BASE_TRAIL   =  0.15;   // 15%

// 클램프 범위
const STOP_MIN     = -0.15;   // 최대 -15%
const STOP_MAX     = -0.05;   // 최소 -5%
const TARGET_MIN   =  0.15;   // +15%
const TARGET_MAX   =  0.50;   // +50%
const PARTIAL_MIN  =  0.08;   // +8%
const PARTIAL_MAX  =  0.25;   // +25%

// 김치 프리미엄 임계값
const KIMCHI_OVERHEATED  = 0.08;   // 8% 이상 → 과열
const KIMCHI_UNDERVALUED = 0.02;   // 2% 미만 → 저평가

// 체결강도 임계값
const TAPE_STRONG_BUY_PRESSURE = 0.65;
const TAPE_BUY_PRESSURE        = 0.55;
const TAPE_AVOID_PRESSURE      = 0.35;
const TAPE_HIGH_VELOCITY       = 30;   // 분당 30건 이상 = 고속

// API 타임아웃
const API_TIMEOUT = 4000;

class AlphaEngine {
  constructor() {
    // 성과 추적 데이터
    this._entries = [];    // { market, entryPrice, tapeSignal, kimchiPremium, qualityScore, ts }
    this._exits   = [];    // { market, exitPrice, pnlRate, reason, ts }
    this._matched = [];    // 매칭된 진입-청산 쌍

    // 캐시 (API 호출 최소화)
    this._tapeCache   = new Map();  // market → { data, ts }
    this._volCache    = new Map();  // market → { data, ts }
    this._cacheTTL    = 10_000;     // 10초 캐시

    // USD/KRW 환율 (외부 주입 또는 폴백)
    this._usdKrw = CFG.DEFAULT_USD_KRW;
  }

  /**
   * USD/KRW 환율 설정 (MacroSignalEngine에서 주입)
   */
  setUsdKrw(rate) {
    if (rate && rate > 0) this._usdKrw = rate;
  }

  // ═══════════════════════════════════════════════════════════
  // 1. Tape Reading — 체결강도 분석
  // ═══════════════════════════════════════════════════════════

  /**
   * 실시간 체결 테이프 분석
   * @param {string} market - 마켓 코드 (예: KRW-BTC)
   * @returns {{ buyPressure, avgTradeSize, largeTradeRatio, velocityScore, momentum, tradeCount, signal }}
   */
  async analyzeTape(market) {
    // 캐시 확인
    const cached = this._tapeCache.get(market);
    if (cached && Date.now() - cached.ts < this._cacheTTL) {
      return cached.data;
    }

    const defaultResult = {
      buyPressure: 0.5, avgTradeSize: 0, largeTradeRatio: 0,
      velocityScore: 0, momentum: 0, tradeCount: 0, signal: "NEUTRAL",
    };

    try {
      const res = await fetch(
        `https://api.upbit.com/v1/trades/ticks?market=${market}&count=${TAPE_TRADE_COUNT}`,
        { signal: AbortSignal.timeout(API_TIMEOUT) }
      );
      if (!res.ok) return defaultResult;
      const trades = await res.json();
      if (!Array.isArray(trades) || trades.length < 5) return defaultResult;

      // ── 매수/매도 압력 (거래량 기반) ──────────────────────
      let buyVolume = 0, totalVolume = 0;
      let totalKrw = 0;
      const sizes = [];

      for (const t of trades) {
        const vol  = Math.abs(parseFloat(t.trade_volume) || 0);
        const price = parseFloat(t.trade_price) || 0;
        const krw  = vol * price;

        totalVolume += vol;
        totalKrw    += krw;
        sizes.push(krw);

        // ask_bid: "ASK" = 매도체결(매수자 주도), "BID" = 매수체결(매도자 주도)
        // 업비트 API: ask_bid === "ASK" → 매수 주도 체결
        if (t.ask_bid === "ASK") buyVolume += vol;
      }

      const buyPressure   = totalVolume > 0 ? buyVolume / totalVolume : 0.5;
      const avgTradeSize  = sizes.length > 0 ? totalKrw / sizes.length : 0;

      // ── 대형 체결 비율 (평균의 2배 초과) ─────────────────
      const threshold = avgTradeSize * 2;
      const largeKrw  = sizes.filter(s => s > threshold).reduce((a, b) => a + b, 0);
      const largeTradeRatio = totalKrw > 0 ? largeKrw / totalKrw : 0;

      // ── 체결 속도 (분당 체결 건수) ─────────────────────────
      // 최근 체결과 가장 오래된 체결의 시간차로 계산
      const newest = trades[0];
      const oldest = trades[trades.length - 1];
      const newestTs = new Date(`${newest.trade_date_utc}T${newest.trade_time_utc}Z`).getTime();
      const oldestTs = new Date(`${oldest.trade_date_utc}T${oldest.trade_time_utc}Z`).getTime();
      const spanMin  = Math.max((newestTs - oldestTs) / 60_000, 0.1);
      const velocityScore = trades.length / spanMin;

      // ── 모멘텀 (최근 vs 과거 가격 변화) ───────────────────
      const recentPrice = parseFloat(trades[0].trade_price) || 0;
      const oldPrice    = parseFloat(trades[trades.length - 1].trade_price) || 0;
      const momentum    = oldPrice > 0 ? (recentPrice - oldPrice) / oldPrice : 0;

      // ── 신호 결정 ──────────────────────────────────────────
      let signal = "NEUTRAL";
      if (buyPressure < TAPE_AVOID_PRESSURE) {
        signal = "AVOID";
      } else if (buyPressure > TAPE_STRONG_BUY_PRESSURE && velocityScore >= TAPE_HIGH_VELOCITY) {
        signal = "STRONG_BUY";
      } else if (buyPressure > TAPE_STRONG_BUY_PRESSURE) {
        // 매수 압력 높지만 속도 보통 → BUY
        signal = "BUY";
      } else if (buyPressure > TAPE_BUY_PRESSURE) {
        signal = "BUY";
      }

      const result = {
        buyPressure:     +buyPressure.toFixed(4),
        avgTradeSize:    Math.round(avgTradeSize),
        largeTradeRatio: +largeTradeRatio.toFixed(4),
        velocityScore:   +velocityScore.toFixed(1),
        momentum:        +momentum.toFixed(6),
        tradeCount:      trades.length,
        signal,
      };

      // 캐시 저장
      this._tapeCache.set(market, { data: result, ts: Date.now() });
      return result;

    } catch (e) {
      console.warn(`[Alpha] 체결강도 분석 실패 (${market}): ${e.message}`);
      return defaultResult;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 2. Kimchi Premium — 김치프리미엄
  // ═══════════════════════════════════════════════════════════

  /**
   * 신규상장 코인의 김치프리미엄 계산
   * @param {string} market - 업비트 마켓 코드 (예: KRW-XRP)
   * @param {number} [usdKrw] - USD/KRW 환율 (없으면 내부 캐시 사용)
   * @returns {{ premium: number|null, signal: string }}
   */
  async getKimchiPremium(market, usdKrw) {
    const rate = usdKrw || this._usdKrw;
    const symbol = market.replace("KRW-", "");

    try {
      // 업비트 + 바이낸스 병렬 조회
      const [upbitRes, binanceRes] = await Promise.allSettled([
        fetch(
          `https://api.upbit.com/v1/ticker?markets=${market}`,
          { signal: AbortSignal.timeout(API_TIMEOUT) }
        ).then(r => r.ok ? r.json() : null),
        fetch(
          `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`,
          { signal: AbortSignal.timeout(API_TIMEOUT) }
        ).then(r => r.ok ? r.json() : null),
      ]);

      const upbitData   = upbitRes.status === "fulfilled" ? upbitRes.value : null;
      const binanceData = binanceRes.status === "fulfilled" ? binanceRes.value : null;

      if (!upbitData?.[0]?.trade_price || !binanceData?.price) {
        // 바이낸스 미상장 = 김치프리미엄 계산 불가 → 중립
        return { premium: null, signal: "UNKNOWN" };
      }

      const upbitKrw   = upbitData[0].trade_price;
      const binanceKrw = parseFloat(binanceData.price) * rate;
      const premium    = (upbitKrw - binanceKrw) / binanceKrw;

      let signal;
      if (premium >= KIMCHI_OVERHEATED) {
        signal = "OVERHEATED";     // 과열 → 진입 억제
      } else if (premium < KIMCHI_UNDERVALUED) {
        signal = "UNDERVALUED";    // 저평가 → 적극 진입
      } else {
        signal = "NORMAL";
      }

      return {
        premium: +premium.toFixed(4),
        signal,
      };

    } catch (e) {
      console.warn(`[Alpha] 김치프리미엄 조회 실패 (${market}): ${e.message}`);
      return { premium: null, signal: "UNKNOWN" };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 3. Volatility-Adaptive Parameters — 변동성 적응형 파라미터
  // ═══════════════════════════════════════════════════════════

  /**
   * ATR 기반 변동성 적응형 손절/목표/트레일 계산
   * @param {string} market - 마켓 코드
   * @returns {{ stopRate, targetRate, partialAt, trailPct, volatility, volRatio }}
   */
  async getAdaptiveParams(market) {
    // 캐시 확인
    const cached = this._volCache.get(market);
    if (cached && Date.now() - cached.ts < this._cacheTTL) {
      return cached.data;
    }

    // 기본값 (API 실패 시)
    const defaults = {
      stopRate:   BASE_STOP,
      targetRate: BASE_TARGET,
      partialAt:  BASE_PARTIAL,
      trailPct:   BASE_TRAIL,
      volatility: 0,
      volRatio:   1.0,
    };

    try {
      const res = await fetch(
        `https://api.upbit.com/v1/candles/minutes/${CANDLE_MINUTES}?market=${market}&count=${CANDLE_COUNT}`,
        { signal: AbortSignal.timeout(API_TIMEOUT) }
      );
      if (!res.ok) return defaults;
      const candles = await res.json();
      if (!Array.isArray(candles) || candles.length < 10) return defaults;

      // ── ATR 계산 (Average True Range) ──────────────────────
      const trueRanges = [];
      for (let i = 0; i < candles.length - 1; i++) {
        const curr = candles[i];
        const prev = candles[i + 1];
        const high  = curr.high_price;
        const low   = curr.low_price;
        const prevClose = prev.trade_price;

        const tr = Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose)
        );
        trueRanges.push(tr);
      }

      if (trueRanges.length === 0) return defaults;

      // ATR = 최근 TR들의 평균
      const atr = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;

      // 중간가 기준 변동성 비율
      const midPrice   = candles[0].trade_price;
      const volatility = midPrice > 0 ? atr / midPrice : 0;

      // ── 중앙값 변동성 계산 (정렬 후 중간값) ────────────────
      const sortedTR = [...trueRanges].sort((a, b) => a - b);
      const medianTR = sortedTR[Math.floor(sortedTR.length / 2)];
      const medianVol = midPrice > 0 ? medianTR / midPrice : volatility;

      // 변동성 비율 (현재 vs 중앙값)
      const volRatio = medianVol > 0 ? volatility / medianVol : 1.0;

      // ── 적응형 파라미터 계산 ───────────────────────────────
      // 변동성이 높으면 → 넓은 스탑/목표, 낮으면 → 좁은 스탑/목표
      let stopRate   = BASE_STOP * volRatio;
      let targetRate = BASE_TARGET * volRatio;
      let partialAt  = BASE_PARTIAL * volRatio;
      let trailPct   = BASE_TRAIL * Math.max(0.7, Math.min(1.5, volRatio));

      // 클램프 (안전 범위 내 제한)
      stopRate   = Math.max(STOP_MIN, Math.min(STOP_MAX, stopRate));
      targetRate = Math.max(TARGET_MIN, Math.min(TARGET_MAX, targetRate));
      partialAt  = Math.max(PARTIAL_MIN, Math.min(PARTIAL_MAX, partialAt));
      trailPct   = Math.max(0.08, Math.min(0.25, trailPct));

      const result = {
        stopRate:   +stopRate.toFixed(4),
        targetRate: +targetRate.toFixed(4),
        partialAt:  +partialAt.toFixed(4),
        trailPct:   +trailPct.toFixed(4),
        volatility: +volatility.toFixed(6),
        volRatio:   +volRatio.toFixed(3),
      };

      // 캐시 저장
      this._volCache.set(market, { data: result, ts: Date.now() });
      return result;

    } catch (e) {
      console.warn(`[Alpha] 변동성 분석 실패 (${market}): ${e.message}`);
      return defaults;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 4. Phased Entry — 분할 진입
  // ═══════════════════════════════════════════════════════════

  /**
   * 체결강도 기반 분할 진입 계획 생성
   * @param {number} totalBudget - 총 예산 (KRW)
   * @param {string} tapeSignal - "STRONG_BUY"|"BUY"|"NEUTRAL"|"AVOID"
   * @returns {Array<{ phase, pct, triggerPct, budget }>}
   */
  getEntryPhases(totalBudget, tapeSignal) {
    if (tapeSignal === "AVOID") {
      // 진입 스킵
      return [];
    }

    if (tapeSignal === "NEUTRAL") {
      // 보수적 진입: 40% 즉시, 60% 확인 후
      return [
        { phase: 1, pct: 0.40, triggerPct: 0,    budget: Math.floor(totalBudget * 0.40) },
        { phase: 2, pct: 0.60, triggerPct: 0.05,  budget: Math.floor(totalBudget * 0.60) },
      ];
    }

    // BUY / STRONG_BUY: 적극 진입
    return [
      { phase: 1, pct: 0.60, triggerPct: 0,    budget: Math.floor(totalBudget * 0.60) },
      { phase: 2, pct: 0.40, triggerPct: 0.03,  budget: Math.floor(totalBudget * 0.40) },
    ];
  }

  // ═══════════════════════════════════════════════════════════
  // 5. Alpha Performance Tracker — 성과 추적
  // ═══════════════════════════════════════════════════════════

  /**
   * 진입 기록
   */
  recordEntry({ market, entryPrice, tapeSignal, kimchiPremium, qualityScore }) {
    this._entries.push({
      market,
      entryPrice,
      tapeSignal:     tapeSignal || "UNKNOWN",
      kimchiPremium:  kimchiPremium ?? null,
      qualityScore:   qualityScore ?? 0,
      ts:             Date.now(),
    });

    // 최대 500건 보관
    if (this._entries.length > 500) this._entries.shift();
  }

  /**
   * 청산 기록 + 진입과 자동 매칭
   */
  recordExit({ market, exitPrice, pnlRate, reason }) {
    const exitData = {
      market,
      exitPrice,
      pnlRate:  pnlRate ?? 0,
      reason:   reason || "unknown",
      ts:       Date.now(),
    };
    this._exits.push(exitData);
    if (this._exits.length > 500) this._exits.shift();

    // 가장 최근 매칭되지 않은 진입 찾기
    const entryIdx = this._entries.findIndex(e =>
      e.market === market && !e._matched
    );
    if (entryIdx >= 0) {
      const entry = this._entries[entryIdx];
      entry._matched = true;
      this._matched.push({
        market,
        entryPrice:    entry.entryPrice,
        exitPrice,
        pnlRate,
        reason,
        tapeSignal:    entry.tapeSignal,
        kimchiPremium: entry.kimchiPremium,
        qualityScore:  entry.qualityScore,
        entryTs:       entry.ts,
        exitTs:        exitData.ts,
        holdMs:        exitData.ts - entry.ts,
      });
      if (this._matched.length > 500) this._matched.shift();
    }
  }

  /**
   * 알파 통계 반환
   */
  getAlphaStats() {
    const trades = this._matched;
    if (trades.length === 0) {
      return {
        totalTrades:   0,
        avgPnl:        0,
        winRate:       0,
        avgEntryTiming: 0,
        tapeAccuracy:  null,
        kimchiEdge:    null,
        bestStrategy:  null,
      };
    }

    // 기본 통계
    const totalTrades = trades.length;
    const wins    = trades.filter(t => t.pnlRate > 0).length;
    const winRate = wins / totalTrades;
    const avgPnl  = trades.reduce((s, t) => s + t.pnlRate, 0) / totalTrades;

    // 평균 진입 타이밍 (보유 시간 기준, 분)
    const avgEntryTiming = trades.reduce((s, t) => s + (t.holdMs || 0), 0) / totalTrades / 60_000;

    // ── Tape 정확도: STRONG_BUY 신호의 수익률 ────────────
    const strongBuys    = trades.filter(t => t.tapeSignal === "STRONG_BUY");
    const strongBuyWins = strongBuys.filter(t => t.pnlRate > 0).length;
    const tapeAccuracy  = strongBuys.length >= 3
      ? +(strongBuyWins / strongBuys.length * 100).toFixed(1)
      : null;

    // ── 김치프리미엄 엣지: 저프리미엄 vs 고프리미엄 PnL 차이 ─
    const lowKimchi  = trades.filter(t => t.kimchiPremium != null && t.kimchiPremium < KIMCHI_UNDERVALUED);
    const highKimchi = trades.filter(t => t.kimchiPremium != null && t.kimchiPremium >= KIMCHI_OVERHEATED);
    const avgLowPnl  = lowKimchi.length  > 0 ? lowKimchi.reduce((s, t) => s + t.pnlRate, 0) / lowKimchi.length : 0;
    const avgHighPnl = highKimchi.length > 0 ? highKimchi.reduce((s, t) => s + t.pnlRate, 0) / highKimchi.length : 0;
    const kimchiEdge = (lowKimchi.length >= 2 || highKimchi.length >= 2)
      ? +((avgLowPnl - avgHighPnl) * 100).toFixed(2)
      : null;

    // ── 최고 성과 신호 타입 ──────────────────────────────
    const signalGroups = {};
    for (const t of trades) {
      const sig = t.tapeSignal || "UNKNOWN";
      if (!signalGroups[sig]) signalGroups[sig] = { count: 0, totalPnl: 0 };
      signalGroups[sig].count++;
      signalGroups[sig].totalPnl += t.pnlRate;
    }
    let bestStrategy = null;
    let bestAvg = -Infinity;
    for (const [sig, data] of Object.entries(signalGroups)) {
      const avg = data.count > 0 ? data.totalPnl / data.count : 0;
      if (avg > bestAvg) { bestAvg = avg; bestStrategy = sig; }
    }

    return {
      totalTrades,
      avgPnl:         +(avgPnl * 100).toFixed(2),
      winRate:        +(winRate * 100).toFixed(1),
      avgEntryTiming: +avgEntryTiming.toFixed(1),
      tapeAccuracy,
      kimchiEdge,
      bestStrategy,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 대시보드 요약
  // ═══════════════════════════════════════════════════════════

  getSummary() {
    const stats = this.getAlphaStats();
    return {
      totalTrades:    stats.totalTrades,
      avgPnl:         stats.avgPnl,
      winRate:        stats.winRate,
      avgEntryTiming: stats.avgEntryTiming,
      tapeAccuracy:   stats.tapeAccuracy,
      kimchiEdge:     stats.kimchiEdge,
      bestStrategy:   stats.bestStrategy,
      entriesCount:   this._entries.length,
      exitsCount:     this._exits.length,
      matchedCount:   this._matched.length,
    };
  }
}

module.exports = { AlphaEngine };
