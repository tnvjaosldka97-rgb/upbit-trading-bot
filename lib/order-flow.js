"use strict";

/**
 * lib/order-flow.js — Order Flow Toxicity 분석
 *
 * 0.1% 퀀트 표준 (HFT 영역):
 *   체결(trades) 흐름에서 "정보 우위 가진 큰 손 vs 노이즈 개미" 분류.
 *   큰 손 매수 = 정보 → 같이 매수 (adverse selection 피함)
 *
 * 측정 지표:
 *   1. Trade Size Distribution — 평균/중앙값/큰거래비율
 *   2. Buy/Sell Aggression Ratio — taker 매수 vs taker 매도
 *   3. Volume-Weighted Toxicity — 큰 거래의 매수/매도 편향
 *   4. Burst Detection — 짧은 시간 큰 거래 집중 (whale buying)
 *
 * 진입 가산점:
 *   toxicity > 0.6 (강한 매수 우세) → +10점
 *   toxicity < -0.6 (강한 매도 우세) → -15점 (진입 차단)
 */

const UPBIT_BASE = "https://api.upbit.com";

const RECENT_TRADES_COUNT = 100;
const LARGE_TRADE_PERCENTILE = 75; // 상위 25% = 큰 거래
const BURST_WINDOW_MS = 60_000; // 1분 burst 윈도우

async function _fetchRecentTrades(market, count = RECENT_TRADES_COUNT) {
  try {
    const res = await fetch(
      `${UPBIT_BASE}/v1/trades/ticks?market=${market}&count=${count}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function _percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.floor(sortedArr.length * (p / 100));
  return sortedArr[Math.min(idx, sortedArr.length - 1)];
}

/**
 * 메인 분석
 *
 * @returns {{
 *   trades: number,
 *   buyAggressionRatio: number,    // 0~1, taker 매수 / 전체 비율
 *   weightedToxicity: number,       // -1~+1, 거래량 가중 매수/매도 편향
 *   largeTradeBuyRatio: number,     // 0~1, 큰 거래 중 매수 비율
 *   burstScore: number,             // 0~1, 1분 내 큰 거래 집중도
 *   signal: "STRONG_BUY"|"BUY"|"NEUTRAL"|"SELL"|"STRONG_SELL",
 *   scoreContribution: number,      // -15~+10
 * }}
 */
async function analyze(market, opts = {}) {
  const upbitMarket = market.startsWith("KRW-") ? market : `KRW-${market.toUpperCase()}`;
  const count = opts.tradesCount || RECENT_TRADES_COUNT;

  const trades = await _fetchRecentTrades(upbitMarket, count);
  if (!trades || trades.length < 20) {
    return {
      trades: 0,
      buyAggressionRatio: 0.5,
      weightedToxicity: 0,
      largeTradeBuyRatio: 0.5,
      burstScore: 0,
      signal: "NEUTRAL",
      scoreContribution: 0,
      error: "insufficient_data",
    };
  }

  // 1) 정렬: 거래액(KRW) 기준
  const tradesKrw = trades.map(t => ({
    krw:   parseFloat(t.trade_price) * parseFloat(t.trade_volume),
    side:  t.ask_bid === "BID" ? "buy" : "sell",
    time:  new Date(`${t.trade_date_utc}T${t.trade_time_utc}Z`).getTime(),
  })).filter(t => t.krw > 0);

  if (tradesKrw.length < 20) {
    return { trades: 0, signal: "NEUTRAL", scoreContribution: 0, error: "filtered_empty" };
  }

  // 2) Buy aggression
  const buyCount  = tradesKrw.filter(t => t.side === "buy").length;
  const buyAggressionRatio = buyCount / tradesKrw.length;

  // 3) Volume-weighted toxicity
  const totalKrw = tradesKrw.reduce((s, t) => s + t.krw, 0);
  const buyKrw   = tradesKrw.filter(t => t.side === "buy").reduce((s, t) => s + t.krw, 0);
  const sellKrw  = totalKrw - buyKrw;
  const weightedToxicity = totalKrw > 0 ? (buyKrw - sellKrw) / totalKrw : 0;

  // 4) Large trade ratio — 상위 25%
  const sortedKrw = [...tradesKrw].map(t => t.krw).sort((a, b) => a - b);
  const largeThreshold = _percentile(sortedKrw, LARGE_TRADE_PERCENTILE);
  const largeTradesArr = tradesKrw.filter(t => t.krw >= largeThreshold);
  const largeBuyKrw    = largeTradesArr.filter(t => t.side === "buy").reduce((s, t) => s + t.krw, 0);
  const largeTotalKrw  = largeTradesArr.reduce((s, t) => s + t.krw, 0);
  const largeTradeBuyRatio = largeTotalKrw > 0 ? largeBuyKrw / largeTotalKrw : 0.5;

  // 5) Burst — 최근 1분 내 큰 거래 집중도
  const now = Date.now();
  const recentLarge = largeTradesArr.filter(t => now - t.time < BURST_WINDOW_MS);
  const burstScore = recentLarge.length / Math.max(largeTradesArr.length, 1);

  // 6) 시그널 분류
  let signal = "NEUTRAL";
  let score = 0;

  // 강한 매수: 거래량 토xicity > 0.4 + 큰 거래 매수 우세 + burst
  if (weightedToxicity > 0.4 && largeTradeBuyRatio > 0.65) {
    signal = burstScore > 0.5 ? "STRONG_BUY" : "BUY";
    score = signal === "STRONG_BUY" ? 10 : 6;
  } else if (weightedToxicity > 0.2 && buyAggressionRatio > 0.55) {
    signal = "BUY";
    score = 4;
  } else if (weightedToxicity < -0.4 && largeTradeBuyRatio < 0.35) {
    signal = burstScore > 0.5 ? "STRONG_SELL" : "SELL";
    score = signal === "STRONG_SELL" ? -15 : -8;
  } else if (weightedToxicity < -0.2 && buyAggressionRatio < 0.45) {
    signal = "SELL";
    score = -5;
  }

  return {
    trades: tradesKrw.length,
    buyAggressionRatio: +buyAggressionRatio.toFixed(3),
    weightedToxicity:   +weightedToxicity.toFixed(3),
    largeTradeBuyRatio: +largeTradeBuyRatio.toFixed(3),
    burstScore:         +burstScore.toFixed(3),
    signal,
    scoreContribution:  score,
    largeTradesCount:   largeTradesArr.length,
    largeThresholdKrw:  Math.round(largeThreshold),
  };
}

module.exports = { analyze };
