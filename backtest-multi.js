"use strict";

/**
 * 멀티코인 1개월 백테스트
 * 업비트 거래량 상위 20개 알트 대상
 *
 * 신호: 상대강도 + RSI 과매도 반등
 *   - BTC 대비 상대강도 양수 (코인이 BTC보다 강할 때)
 *   - RSI < 35 → 40 이상 회복 (과매도 반등)
 *   - 거래량 급등: 최근 3봉 평균 > 20봉 평균 × 2
 *   - EMA21 위 (기본 추세)
 *
 * 청산:
 *   - 목표: +3%
 *   - 손절: -1.5%
 *   - 타임스탑: 24h
 */

const STOP   = -0.015;
const TARGET = 0.030;
const HOLD   = 24;   // 최대 보유 (1h 캔들)
const WARMUP = 50;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 업비트 상위 코인 조회 ─────────────────────────────

async function getTopMarkets(n = 20) {
  // 전체 KRW 마켓 목록
  const res1 = await fetch("https://api.upbit.com/v1/market/all?isDetails=false");
  const all  = await res1.json();
  const krw  = all.filter(m => m.market.startsWith("KRW-") &&
    !["KRW-BTC","KRW-USDT","KRW-USDC"].includes(m.market))
    .map(m => m.market);

  // 24h 거래대금 기준 정렬 (200개씩 조회)
  const tickers = [];
  for (let i = 0; i < krw.length; i += 100) {
    const chunk = krw.slice(i, i + 100);
    const res2  = await fetch(
      `https://api.upbit.com/v1/ticker?markets=${chunk.join(",")}`
    );
    const data  = await res2.json();
    tickers.push(...data);
    await sleep(120);
  }

  return tickers
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, n)
    .map(t => t.market);
}

// ── 1h 캔들 수집 ─────────────────────────────────────

async function fetchCandles(market, count = 750) {
  const candles = [];
  let to = null;
  while (candles.length < count) {
    const url = `https://api.upbit.com/v1/candles/minutes/60?market=${market}&count=200` +
      (to ? `&to=${to}` : "");
    try {
      const res  = await fetch(url);
      if (!res.ok) { await sleep(500); continue; }
      const data = await res.json();
      if (!data.length) break;
      candles.push(...data);
      to = data[data.length - 1].candle_date_time_utc;
      await sleep(110);
    } catch { await sleep(300); }
  }
  return candles.reverse().map(c => ({
    time:   new Date(c.candle_date_time_utc).getTime(),
    open:   c.opening_price,
    high:   c.high_price,
    low:    c.low_price,
    close:  c.trade_price,
    volume: c.candle_acc_trade_volume,
  }));
}

// ── 지표 ─────────────────────────────────────────────

function rsi(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? g += d : l -= d;
  }
  const al = l / p;
  return al === 0 ? 99 : 100 - 100 / (1 + (g / p) / al);
}

function ema(closes, n) {
  if (closes.length < n) return null;
  const k = 2 / (n + 1);
  let v = closes.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

// ── 신호 평가 ─────────────────────────────────────────

function evaluate(candles, i, btcReturns) {
  if (i < WARMUP) return false;

  const window  = candles.slice(0, i + 1);
  const closes  = window.map(c => c.close);
  const volumes = window.map(c => c.volume);
  const price   = closes[closes.length - 1];
  const prev    = closes[closes.length - 2];

  // ① RSI 과매도 반등: 이전봉 RSI < 35, 현재봉 RSI ≥ 38
  const rsiNow  = rsi(closes, 14);
  const rsiPrev = rsi(closes.slice(0, -1), 14);
  if (!(rsiPrev < 35 && rsiNow >= 38)) return false;

  // ② EMA21 위 (기본 상승추세)
  const e21 = ema(closes, 21);
  if (!e21 || price < e21 * 0.985) return false;

  // ③ 거래량 급등: 최근 3봉 평균 > 20봉 평균 × 2
  const volRecent = volumes.slice(-3).reduce((s, v) => s + v, 0) / 3;
  const volBase   = volumes.slice(-23, -3).reduce((s, v) => s + v, 0) / 20;
  if (volBase > 0 && volRecent < volBase * 2) return false;

  // ④ 상대강도: 최근 12h 수익 > BTC 12h 수익 + 1%
  const ret12h  = (price - closes[closes.length - 13]) / closes[closes.length - 13];
  const btcRet  = btcReturns[i] ?? 0;
  if (ret12h <= btcRet + 0.01) return false;

  return true;
}

// ── 거래 시뮬레이션 ───────────────────────────────────

function simulate(candles, entryIdx) {
  const entry = candles[entryIdx].close;
  const stop  = entry * (1 + STOP);
  const tgt   = entry * (1 + TARGET);

  for (let j = 1; j <= HOLD; j++) {
    const idx = entryIdx + j;
    if (idx >= candles.length) break;
    const c = candles[idx];
    if (c.low <= stop && c.high >= tgt) return { pnl: STOP, exit: "STOP" };
    if (c.low <= stop)  return { pnl: STOP,   exit: "STOP"   };
    if (c.high >= tgt)  return { pnl: TARGET,  exit: "TARGET" };
  }
  const last = Math.min(entryIdx + HOLD, candles.length - 1);
  return { pnl: (candles[last].close - entry) / entry, exit: "TIME" };
}

// ── 메인 ─────────────────────────────────────────────

async function run() {
  console.log("══════════════════════════════════════════════");
  console.log("  멀티코인 백테스트 — 상대강도 + RSI 반등");
  console.log("  기간: 최근 1개월 | 업비트 거래량 상위 20개");
  console.log("══════════════════════════════════════════════\n");

  // 상위 코인 목록
  process.stdout.write("거래량 상위 코인 조회 중...");
  const markets = await getTopMarkets(20);
  console.log(` ${markets.length}개\n${markets.join(", ")}\n`);

  // BTC 기준 데이터
  process.stdout.write("KRW-BTC 기준 데이터 수집...");
  const btcCandles = await fetchCandles("KRW-BTC", 750);
  // BTC 12h 수익률 배열
  const btcReturns = btcCandles.map((c, i) => {
    if (i < 12) return 0;
    return (c.close - btcCandles[i - 12].close) / btcCandles[i - 12].close;
  });
  console.log(` ${btcCandles.length}개`);

  // 최근 1개월 (720봉) 기준 시작 인덱스
  const oneMonthAgo = Date.now() - 30 * 24 * 3600 * 1000;

  const results = [];

  for (const market of markets) {
    process.stdout.write(`  ${market.padEnd(14)} 수집 중...`);
    const candles = await fetchCandles(market, 750);
    if (candles.length < WARMUP + HOLD) { console.log(" 데이터 부족"); continue; }

    // BTC 수익률을 코인 타임스탬프에 맞게 매핑
    const btcTimeMap = new Map(btcCandles.map((c, i) => [c.time, i]));

    const trades = [];
    let skipUntil = 0;

    for (let i = WARMUP; i < candles.length - HOLD; i++) {
      if (i < skipUntil) continue;
      if (candles[i].time < oneMonthAgo) continue;

      // BTC 수익률 인덱스 매핑
      const btcIdx = btcTimeMap.get(candles[i].time) ?? -1;
      const btcRet = btcIdx >= 0 ? (btcReturns[btcIdx] ?? 0) : 0;

      const btcRetArr = new Array(i + 1).fill(0).map((_, idx) => {
        const bi = btcTimeMap.get(candles[idx]?.time ?? 0) ?? -1;
        return bi >= 0 ? (btcReturns[bi] ?? 0) : 0;
      });

      if (!evaluate(candles, i, btcRetArr)) continue;

      const trade = simulate(candles, i);
      trade.time  = new Date(candles[i].time).toISOString().slice(0, 16);
      trade.market = market;
      trades.push(trade);
      skipUntil = i + trade.exit === "TIME" ? HOLD : 2;
    }

    const FEES    = 0.00278;
    const wins    = trades.filter(t => t.pnl > 0);
    const netPnls = trades.map(t => t.pnl - FEES);
    const cumRet  = netPnls.reduce((s, v) => s + v, 0);
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;
    const ev      = trades.length > 0 ? cumRet / trades.length : 0;

    const result = {
      market,
      trades: trades.length,
      winRate: +(winRate * 100).toFixed(1),
      ev:      +(ev * 100).toFixed(3),
      cumRet:  +(cumRet * 100).toFixed(2),
      targets: trades.filter(t => t.exit === "TARGET").length,
      stops:   trades.filter(t => t.exit === "STOP").length,
    };
    results.push(result);

    const evColor = ev > 0 ? "✅" : "❌";
    console.log(` ${trades.length}건 | 승률 ${result.winRate}% | EV ${result.ev}% ${evColor}`);
  }

  // ── 결과 요약 ───────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  console.log("  결과 요약 (EV 순 정렬)");
  console.log("══════════════════════════════════════════════");
  console.log("  코인            거래  승률    EV      누적    목표  손절");
  console.log("  ──────────────────────────────────────────────────────");

  results.sort((a, b) => b.ev - a.ev);
  for (const r of results) {
    const evMark = r.ev > 0 ? "🟢" : "🔴";
    console.log(
      `  ${r.market.padEnd(14)} ${String(r.trades).padStart(3)}건` +
      `  ${String(r.winRate).padStart(5)}%` +
      `  ${(r.ev >= 0 ? "+" : "") + String(r.ev).padStart(7)}%` +
      `  ${(r.cumRet >= 0 ? "+" : "") + String(r.cumRet).padStart(7)}%` +
      `  ${r.targets}/${r.trades}  ${evMark}`
    );
  }

  const profitable = results.filter(r => r.ev > 0 && r.trades >= 3);
  console.log(`\n  수익성 있는 코인: ${profitable.length}/${results.length}개`);
  if (profitable.length > 0) {
    console.log(`  → 실거래 후보: ${profitable.map(r => r.market.replace("KRW-","")).join(", ")}`);
  }
  console.log("══════════════════════════════════════════════\n");
}

run().catch(console.error);
