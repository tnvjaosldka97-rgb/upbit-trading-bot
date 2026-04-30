"use strict";

/**
 * lib/multi-timeframe.js — 멀티 타임프레임 정합 분석
 *
 * 4h(macro) + 1h(meso) + 15m(micro) + 5m(entry) 4단계 추세 정합 검증.
 *
 * 사상:
 *   - 4h: 거시 추세 (장세 판단)
 *   - 1h: 진입 후보 캔들 (Strategy A 기본)
 *   - 15m: 진입 타이밍 미세조정
 *   - 5m: 즉시 진입 트리거
 *
 * 점수 산출:
 *   각 timeframe에서 EMA21 vs EMA50 위치 + 모멘텀 → BULL/BEAR/NEUTRAL
 *   4개 모두 같은 방향이면 STRONG_ALIGN (4점)
 *   3/4 정합 = ALIGN (3점)
 *   2/4 = NEUTRAL (2점)
 *   1/4 이하 = CONFLICT (0~1점)
 *
 * 출력:
 *   { score: 0~4, direction: "BULL"|"BEAR"|"NEUTRAL", details: {tf4h:..., tf1h:..., ...} }
 *
 * 사용처:
 *   strategy-a.js에서 옵션으로 호출 → score >= 3이면 진입 가산점
 */

const indicators = require("./indicators");

const UPBIT_BASE = "https://api.upbit.com";

const TF_MINUTES = {
  "5m":  5,
  "15m": 15,
  "1h":  60,
  "4h":  240,
};

const TF_FETCH_COUNT = {
  "5m":  100,
  "15m": 100,
  "1h":  120,
  "4h":  100,
};

async function _fetchCandles(market, tfMinutes, count) {
  const url = `${UPBIT_BASE}/v1/candles/minutes/${tfMinutes}?market=${market}&count=${count}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Upbit ${tfMinutes}m candles ${res.status}`);
  const data = await res.json();
  return data.reverse().map(c => ({
    time:   new Date(c.candle_date_time_utc + "Z").getTime(),
    open:   c.opening_price,
    high:   c.high_price,
    low:    c.low_price,
    close:  c.trade_price,
    volume: c.candle_acc_trade_volume,
  }));
}

/**
 * 단일 timeframe의 추세 방향 + 강도
 *   직진성 강하면 점수 높음
 */
function _classifyTrend(candles) {
  if (!candles || candles.length < 50) {
    return { direction: "NEUTRAL", strength: 0, reason: "insufficient_candles" };
  }
  const closes = candles.map(c => c.close);
  const ema21 = indicators.ema(closes, 21);
  const ema50 = indicators.ema(closes, 50);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 13] || closes[0]; // ~12봉 전

  if (!ema21 || !ema50) {
    return { direction: "NEUTRAL", strength: 0, reason: "ema_unavailable" };
  }

  const trend12bar = (last - prev) / prev; // 12봉 모멘텀
  const ema21AboveEma50 = ema21 > ema50;
  const priceAboveEma21 = last > ema21;
  const priceAboveEma50 = last > ema50;

  // BULL 정합: ema21 > ema50 + 가격 위 + 12봉 양수 모멘텀
  if (ema21AboveEma50 && priceAboveEma21 && priceAboveEma50 && trend12bar > 0.001) {
    const strength = Math.min(1, Math.abs(trend12bar) * 50);
    return { direction: "BULL", strength, reason: `trend12=+${(trend12bar * 100).toFixed(2)}%` };
  }
  // BEAR 정합: ema21 < ema50 + 가격 아래 + 12봉 음수
  if (!ema21AboveEma50 && !priceAboveEma21 && !priceAboveEma50 && trend12bar < -0.001) {
    const strength = Math.min(1, Math.abs(trend12bar) * 50);
    return { direction: "BEAR", strength, reason: `trend12=${(trend12bar * 100).toFixed(2)}%` };
  }
  // 그 외 NEUTRAL (부분 정합)
  return {
    direction: "NEUTRAL",
    strength: 0.3,
    reason: `mixed: ema21>${ema21AboveEma50?'gt':'lt'}ema50, price=${priceAboveEma21?'above':'below'}ema21, mom=${(trend12bar*100).toFixed(2)}%`,
  };
}

/**
 * 멀티 타임프레임 정합 분석
 *
 * @param {string} market — "KRW-BTC" 또는 "BTC"
 * @param {Object} opts.timeframes — 사용할 timeframe 배열 (기본: 모두)
 * @returns {Promise<{score, direction, details}>}
 *
 * score:
 *   4 = STRONG_ALIGN (전 timeframe 같은 방향)
 *   3 = ALIGN
 *   2 = NEUTRAL
 *   0~1 = CONFLICT
 */
async function analyze(market, opts = {}) {
  const tfList = opts.timeframes || ["5m", "15m", "1h", "4h"];
  const upbitMarket = market.startsWith("KRW-") ? market : `KRW-${market.toUpperCase()}`;

  const details = {};
  await Promise.all(tfList.map(async tf => {
    try {
      const candles = await _fetchCandles(upbitMarket, TF_MINUTES[tf], TF_FETCH_COUNT[tf]);
      details[tf] = _classifyTrend(candles);
    } catch (e) {
      details[tf] = { direction: "NEUTRAL", strength: 0, reason: `fetch_error: ${e.message}` };
    }
  }));

  // 정합 점수 산출
  const directions = tfList.map(tf => details[tf].direction);
  const bullCount  = directions.filter(d => d === "BULL").length;
  const bearCount  = directions.filter(d => d === "BEAR").length;
  const neutralCount = directions.filter(d => d === "NEUTRAL").length;

  let direction = "NEUTRAL";
  let score = neutralCount;
  if (bullCount >= 3) {
    direction = "BULL";
    score = bullCount;
  } else if (bearCount >= 3) {
    direction = "BEAR";
    score = bearCount;
  } else if (bullCount > bearCount) {
    direction = "BULL_WEAK";
    score = bullCount;
  } else if (bearCount > bullCount) {
    direction = "BEAR_WEAK";
    score = bearCount;
  }

  // 평균 강도 (정합된 방향 timeframe만)
  const alignedTfs = tfList.filter(tf =>
    direction.startsWith("BULL") ? details[tf].direction === "BULL" :
    direction.startsWith("BEAR") ? details[tf].direction === "BEAR" :
    false
  );
  const avgStrength = alignedTfs.length > 0
    ? alignedTfs.reduce((s, tf) => s + details[tf].strength, 0) / alignedTfs.length
    : 0;

  return {
    market: upbitMarket,
    direction,    // "BULL" / "BEAR" / "BULL_WEAK" / "BEAR_WEAK" / "NEUTRAL"
    score,        // 0~4 (정합된 timeframe 수)
    avgStrength,  // 0~1 (정합 강도 평균)
    details,      // { "4h": {...}, "1h": {...}, ... }
    timestamp: Date.now(),
  };
}

/**
 * Strategy A 진입 가중치 계산 헬퍼
 *   score 4 (STRONG_ALIGN BULL) → +20점
 *   score 3 (ALIGN BULL) → +12점
 *   BULL_WEAK → +5점
 *   NEUTRAL → 0점
 *   BEAR_WEAK → -5점
 *   ALIGN BEAR → -15점
 *   STRONG_ALIGN BEAR → -25점
 */
function toScoreContribution(mtfResult) {
  if (!mtfResult) return 0;
  const { direction, score } = mtfResult;
  switch (direction) {
    case "BULL":      return score >= 4 ? 20 : 12;
    case "BULL_WEAK": return 5;
    case "NEUTRAL":   return 0;
    case "BEAR_WEAK": return -5;
    case "BEAR":      return score >= 4 ? -25 : -15;
    default:          return 0;
  }
}

module.exports = { analyze, toScoreContribution };
