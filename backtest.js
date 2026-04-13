"use strict";

/**
 * ATS 백테스트 엔진 v1
 *
 * 업비트 1분봉 과거 데이터로 현재 신호 로직의 실제 성과 측정.
 * 파라미터 그리드 서치 후 최적값 자동 도출.
 *
 * 측정 지표:
 *   - 실제 승률 (신호 발생 후 목표 먼저 도달 vs 손절 먼저 도달)
 *   - 평균 이익 / 평균 손실
 *   - EV (기대값)
 *   - 샤프 비율
 *   - 최대 낙폭 (MDD)
 *   - 신호 발생 빈도
 */

const MARKETS    = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-SOL", "KRW-DOGE"];
const CANDLES_PER_FETCH = 200;
const TOTAL_CANDLES     = 10080; // 약 7일 (1분봉 × 10080)
const DAILY_CANDLES     = 90;    // 일봉 90개 (장기 추세 필터용)
const SLEEP_MS          = 150;   // API rate limit 방어

// ─── 유틸 ───────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((s, v) => s + v, 0) / n;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length);
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 99;
  return 100 - 100 / (1 + ag / al);
}

function sharpe(returns) {
  if (returns.length < 5) return 0;
  const avg = returns.reduce((s, v) => s + v, 0) / returns.length;
  const std = stddev(returns);
  return std > 0 ? (avg / std) * Math.sqrt(1512) : 0;
}

function maxDrawdown(equityCurve) {
  let peak = equityCurve[0], mdd = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

// ─── 업비트 데이터 수집 ──────────────────────────────────

async function fetchDailyCandles(market) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const url = `https://api.upbit.com/v1/candles/days?market=${market}&count=${DAILY_CANDLES}`;
      const res  = await fetch(url);
      if (!res.ok) { await sleep(600); continue; }
      const data = await res.json();
      return data.sort((a, b) => new Date(a.candle_date_time_utc) - new Date(b.candle_date_time_utc));
    } catch { await sleep(1000 * (attempt + 1)); }
  }
  return [];
}

// 일봉 MA 기반 장기 추세: +1=상승, 0=횡보, -1=하락
function getDailyTrend(dailyCandles) {
  const closes = dailyCandles.map(c => c.trade_price);
  if (closes.length < 20) return 0;
  const ma20 = sma(closes, 20);
  const ma60 = closes.length >= 60 ? sma(closes, 60) : null;
  const cur  = closes[closes.length - 1];
  if (ma60 == null) return cur > ma20 ? 1 : -1;
  if (cur > ma20 && ma20 > ma60) return 1;
  if (cur < ma20 && ma20 < ma60) return -1;
  return 0;
}

// 일봉 upDay 비율 (bullishProbability 보정용)
function getUpDayRatio(dailyCandles) {
  if (!dailyCandles.length) return 0.5;
  const up = dailyCandles.filter(c => c.trade_price > (c.opening_price || c.trade_price)).length;
  return up / dailyCandles.length;
}

async function fetchCandles(market, totalCount = TOTAL_CANDLES) {
  const all = [];
  let to = null;
  let retries = 0;

  while (all.length < totalCount) {
    const url = `https://api.upbit.com/v1/candles/minutes/1?market=${market}&count=${CANDLES_PER_FETCH}${to ? `&to=${to}` : ""}`;
    try {
      const res  = await fetch(url);
      if (!res.ok) { await sleep(600); continue; }
      const data = await res.json();
      if (!data.length) break;
      all.push(...data);
      to = data[data.length - 1].candle_date_time_utc;
      retries = 0;
    } catch (e) {
      retries++;
      if (retries > 5) { console.error(`  [${market}] 재시도 한도 초과, 수집 중단`); break; }
      await sleep(1000 * retries);
      continue;
    }
    await sleep(SLEEP_MS);
  }

  // 시간순 정렬 (오래된 것 → 최신)
  return all
    .slice(0, totalCount)
    .sort((a, b) => new Date(a.candle_date_time_utc) - new Date(b.candle_date_time_utc));
}

// ─── 신호 생성 ───────────────────────────────────────────

function generateSignals(candles, params) {
  const {
    maFast, maMid, maSlow,
    minMomentum1m, maxVolatility,
    maxVolSpike, rsiOversold, rsiOverbought,
    minBullish, upDayRatio,
  } = params;

  const signals = [];

  for (let i = maSlow + 20; i < candles.length - 30; i++) {
    const window = candles.slice(0, i + 1);
    const closes  = window.map((c) => c.trade_price);
    const volumes = window.map((c) => c.candle_acc_trade_volume);

    const ma5  = sma(closes, maFast);
    const ma20 = sma(closes, maMid);
    const ma60 = sma(closes, maSlow);
    const price = closes[closes.length - 1];
    const price1mAgo = closes[closes.length - 2] || price;
    const price5mAgo = closes[closes.length - 6] || price;

    if (!ma5 || !ma20 || !ma60) continue;

    const momentum1m = (price - price1mAgo) / price1mAgo;
    const momentum5m = (price - price5mAgo) / price5mAgo;

    // 변동성 (최근 10봉 수익률 표준편차)
    const returns10 = closes.slice(-11).map((v, i, a) =>
      i === 0 ? 0 : (v - a[i-1]) / a[i-1]
    ).slice(1);
    const vol = stddev(returns10);

    // 거래량 스파이크
    const shortVol = volumes.slice(-3).reduce((s, v) => s + v, 0) / 3;
    const baseVol  = volumes.slice(-20, -3).reduce((s, v) => s + v, 0) / 17;
    const volSpike = baseVol > 0 ? shortVol / baseVol : 1;

    // RSI
    const rsiVal = rsi(closes, 14);

    // bullishProbability 계산 (live bot 로직과 동일)
    let bp = 28;
    // 일봉 MA 추세 (+18)
    if (params.dailyTrend === 1)    bp += 18;
    // 일봉 upDay 비율 (+16)
    if ((upDayRatio || 0) >= 0.55)  bp += 16;
    if (ma5 > ma20 && ma20 > ma60)  bp += 18;
    if (momentum1m > 0)             bp += 8;
    if (momentum5m > 0)             bp += 10;
    // RSI
    if (rsiVal < 25)                bp += 18;
    else if (rsiVal < 35)           bp += 12;
    else if (rsiVal < 45)           bp += 5;
    else if (rsiVal > 80)           bp -= 15;
    else if (rsiVal > 70)           bp -= 8;
    else if (rsiVal > 60)           bp -= 3;
    bp = Math.max(0, Math.min(99, bp));

    // 진입 조건 체크
    const trendOk   = ma5 > ma20 && ma20 > ma60 && momentum1m >= minMomentum1m;
    const volOk     = vol <= maxVolatility && volSpike <= maxVolSpike;
    const bullishOk = bp >= minBullish;
    // 장기 추세 필터: 하락장에서는 진입 금지
    const macroOk   = params.dailyTrend >= 0;

    if (!trendOk || !volOk || !bullishOk || !macroOk) continue;

    signals.push({ idx: i, price, bp, rsiVal, momentum1m, vol });
  }

  return signals;
}

// ─── 결과 측정 ───────────────────────────────────────────

function measureOutcomes(candles, signals, params) {
  const { targetRate, stopRate, maxHoldBars } = params;

  let wins = 0, losses = 0, timeouts = 0;
  const pnls = [];

  for (const sig of signals) {
    const entry  = sig.price;
    const target = entry * (1 + targetRate);
    const stop   = entry * (1 + stopRate);
    let outcome  = "TIMEOUT";
    let pnl      = 0;

    for (let j = sig.idx + 1; j < Math.min(sig.idx + maxHoldBars + 1, candles.length); j++) {
      const high = candles[j].high_price;
      const low  = candles[j].low_price;

      if (high >= target) { outcome = "WIN";  pnl = targetRate;  break; }
      if (low  <= stop)   { outcome = "LOSS"; pnl = stopRate;    break; }
    }

    if (outcome === "TIMEOUT") {
      const exitPrice = candles[Math.min(sig.idx + maxHoldBars, candles.length - 1)].trade_price;
      pnl = (exitPrice - entry) / entry;
      timeouts++;
    }

    if (outcome === "WIN")  wins++;
    if (outcome === "LOSS") losses++;
    pnls.push(pnl);
  }

  const totalTrades = wins + losses + timeouts;
  if (totalTrades === 0) return null;

  const winRate   = wins / totalTrades;
  const avgWin    = pnls.filter(p => p > 0).reduce((s, v) => s + v, 0) / (wins || 1);
  const avgLoss   = Math.abs(pnls.filter(p => p <= 0).reduce((s, v) => s + v, 0) / (losses + timeouts || 1));
  const ev        = winRate * avgWin - (1 - winRate) * avgLoss;

  // 자본 곡선
  let equity = 1;
  const curve = [1];
  for (const p of pnls) {
    equity *= (1 + p * 0.08); // 8% 포지션 사이징
    curve.push(equity);
  }

  return {
    totalTrades,
    wins, losses, timeouts,
    winRate: +(winRate * 100).toFixed(1),
    avgWin:  +(avgWin  * 100).toFixed(3),
    avgLoss: +(avgLoss * 100).toFixed(3),
    ev:      +(ev      * 100).toFixed(4),
    rrRatio: +(avgWin  / (avgLoss || 0.001)).toFixed(2),
    sharpe:  +sharpe(pnls).toFixed(2),
    mdd:     +(maxDrawdown(curve) * 100).toFixed(2),
    finalEquity: +(curve[curve.length - 1] * 100 - 100).toFixed(2),
  };
}

// ─── 그리드 서치 ─────────────────────────────────────────

async function gridSearch(market, candles, dailyTrend, upDayRatio) {
  const trendLabel = dailyTrend === 1 ? "📈 상승장" : dailyTrend === -1 ? "📉 하락장" : "➡️ 횡보";
  console.log(`\n  [${market}] 파라미터 탐색 중... 장기추세: ${trendLabel} | 상승일비율: ${(upDayRatio*100).toFixed(0)}%`);

  const grid = {
    minBullish:    [45, 50, 55, 62],
    maxVolatility: [0.003, 0.005, 0.008],
    maxVolSpike:   [3.0, 5.0, 10.0],
    targetRate:    [0.004, 0.006, 0.008, 0.010],
    stopRate:      [-0.003, -0.002, -0.0015],
  };

  const fixed = {
    maFast: 5, maMid: 20, maSlow: 60,
    minMomentum1m: dailyTrend >= 0 ? 0 : -0.001,
    rsiOversold: 35, rsiOverbought: 70,
    maxHoldBars: 30,
    dailyTrend,
    upDayRatio,
  };

  const allResults = [];

  for (const minBullish of grid.minBullish) {
    for (const maxVolatility of grid.maxVolatility) {
      for (const maxVolSpike of grid.maxVolSpike) {
        for (const targetRate of grid.targetRate) {
          for (const stopRate of grid.stopRate) {
            const params = { ...fixed, minBullish, maxVolatility, maxVolSpike, targetRate, stopRate };
            const signals = generateSignals(candles, params);
            if (signals.length < 8) continue;

            const result = measureOutcomes(candles, signals, params);
            if (!result) continue;

            const score = result.ev * Math.max(0.1, result.sharpe) * (1 - result.mdd / 100);
            allResults.push({ params, result, score: +score.toFixed(4) });
          }
        }
      }
    }
  }

  // 신호 수 디버그
  const maxSignalParams = { ...fixed, minBullish: 45, maxVolatility: 0.008, maxVolSpike: 10.0, targetRate: 0.006, stopRate: -0.002 };
  const maxSignals = generateSignals(candles, maxSignalParams);
  console.log(`    [디버그] 최완화 파라미터 신호 수: ${maxSignals.length}건`);

  if (allResults.length === 0) return null;
  allResults.sort((a, b) => b.score - a.score);

  // Top 3 출력
  console.log(`    전체 유효 파라미터 조합: ${allResults.length}개`);
  allResults.slice(0, 3).forEach((r, i) => {
    console.log(`    #${i+1} EV=${r.result.ev}% 승률=${r.result.winRate}% 샤프=${r.result.sharpe} MDD=${r.result.mdd}% (${r.result.totalTrades}건)`);
  });

  return allResults[0];
}

// ─── 메인 ────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  ATS 백테스트 엔진 v1");
  console.log(`  마켓: ${MARKETS.join(", ")}`);
  console.log(`  데이터: 1분봉 × ${TOTAL_CANDLES}개 (~${(TOTAL_CANDLES/60).toFixed(0)}시간)`);
  console.log("═══════════════════════════════════════════════════");

  const allBests = [];

  for (const market of MARKETS) {
    process.stdout.write(`\n[${market}] 캔들 수집 중...`);
    let candles, dailyCandles;
    try {
      [candles, dailyCandles] = await Promise.all([
        fetchCandles(market, TOTAL_CANDLES),
        fetchDailyCandles(market),
      ]);
    } catch (e) {
      console.log(` 수집 실패: ${e.message}`);
      continue;
    }
    if (!candles.length) { console.log(` 0개 — 건너뜀`); continue; }
    await sleep(200);
    const dailyTrend = getDailyTrend(dailyCandles);
    const upDayRatio = getUpDayRatio(dailyCandles);
    console.log(` ${candles.length}개 수집 완료`);

    const best = await gridSearch(market, candles, dailyTrend, upDayRatio);
    if (!best) {
      console.log(`  → 유효한 파라미터 없음`);
      continue;
    }

    allBests.push({ market, ...best });

    const r = best.result;
    console.log(`  ✓ 최적 파라미터 발견`);
    console.log(`    거래: ${r.totalTrades}건 | 승률: ${r.winRate}% | EV: +${r.ev}%`);
    console.log(`    R/R: ${r.rrRatio}:1 | 샤프: ${r.sharpe} | MDD: -${r.mdd}%`);
    console.log(`    누적 수익: ${r.finalEquity >= 0 ? "+" : ""}${r.finalEquity}%`);
    console.log(`    파라미터: bullish≥${best.params.minBullish}% | vol≤${best.params.maxVolatility} | target+${(best.params.targetRate*100).toFixed(1)}% | stop${(best.params.stopRate*100).toFixed(2)}%`);
  }

  // ── 전체 최적 파라미터 집계 ──────────────────────────
  if (allBests.length > 0) {
    console.log("\n═══════════════════════════════════════════════════");
    console.log("  종합 최적 파라미터 (실제 데이터 기반)");
    console.log("═══════════════════════════════════════════════════");

    const avgBullish    = Math.round(allBests.reduce((s, b) => s + b.params.minBullish, 0)    / allBests.length);
    const avgVolatility = (allBests.reduce((s, b) => s + b.params.maxVolatility, 0) / allBests.length).toFixed(4);
    const avgTarget     = (allBests.reduce((s, b) => s + b.params.targetRate, 0)    / allBests.length * 100).toFixed(2);
    const avgStop       = (allBests.reduce((s, b) => s + b.params.stopRate, 0)      / allBests.length * 100).toFixed(3);
    const avgWinRate    = (allBests.reduce((s, b) => s + b.result.winRate, 0)        / allBests.length).toFixed(1);
    const avgSharpe     = (allBests.reduce((s, b) => s + b.result.sharpe, 0)         / allBests.length).toFixed(2);

    console.log(`  minBullishProbability: ${avgBullish}`);
    console.log(`  maxVolatility5s:       ${avgVolatility}`);
    console.log(`  targetGrossRate:       ${(parseFloat(avgTarget)/100).toFixed(4)} (+${avgTarget}%)`);
    console.log(`  stopLossRate:          ${(parseFloat(avgStop)/100).toFixed(4)} (${avgStop}%)`);
    console.log(`  실측 평균 승률:         ${avgWinRate}%`);
    console.log(`  실측 평균 샤프:         ${avgSharpe}`);
    console.log("\n  → 위 값으로 market-data-service.js 파라미터 업데이트 권장");
  } else {
    console.log("\n  유효한 결과 없음 — 데이터 부족 또는 시장 조건 불리");
  }
}

main().catch(console.error);
