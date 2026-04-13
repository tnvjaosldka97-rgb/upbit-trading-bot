"use strict";

/**
 * 업비트 전체 KRW 마켓 멀티 백테스트
 *
 * 전략: backtest-v3.js (Strategy A v4) 동일 로직
 *   - 4h 신호: 20봉 고점 돌파 + BULL 레짐 + EMA200 + RSI + 거래량
 *   - 1h 청산: ATR×2 손절 / ATR×4 목표 / 트레일링스탑
 *
 * 기간: 최근 3개월 (4h 캔들 ~540개, 유효 트레이딩 ~330개)
 * 필터: 최근 30일 일평균 거래량 $1B KRW 이상 코인만
 */

// ── 파라미터 ──────────────────────────────────────────────
const ATR_STOP_MULT   = 2.0;
const ATR_TARGET_MULT = 4.0;
const ATR_BE_MULT     = 1.0;
const ATR_TRAIL_MULT  = 1.5;
const MAX_HOLD_4H     = 20;
const ATR_PERIOD      = 14;
const DAILY_ATR_MAX   = 0.05;
const COOLDOWN_4H     = 2;

const CANDLES_1H      = 4400;   // ~6개월 1h
const CANDLES_DAILY   = 250;    // SMA200용
const MIN_TRADES      = 3;      // 신뢰성 최소 트레이드 수
const MIN_VOL_KRW     = 1e9;    // 일평균 KRW 거래량 최소 10억원
const SLEEP_MS        = 130;    // API rate limit

// ── 유틸 ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

function emaArr(arr, n) {
  if (arr.length < n) return null;
  const k = 2 / (n + 1);
  const out = [];
  let val = arr.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out.push(val);
  for (let i = n; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
    out.push(val);
  }
  return out;
}

function ema(arr, n) {
  const a = emaArr(arr, n);
  return a ? a[a.length - 1] : null;
}

function rsi(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const al = l / p;
  return al === 0 ? 99 : 100 - 100 / (1 + (g / p) / al);
}

function atr(candles) {
  if (candles.length < 2) return 0;
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close))
  );
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

function dateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// ── 데이터 수집 ────────────────────────────────────────────

async function fetchCandles1h(market, totalCount) {
  const candles = [];
  let to = null;
  while (candles.length < totalCount) {
    const url = `https://api.upbit.com/v1/candles/minutes/60?market=${market}&count=200` +
      (to ? `&to=${to}` : "");
    try {
      const res  = await fetch(url);
      if (!res.ok) { await sleep(1000); continue; }
      const data = await res.json();
      if (!data.length) break;
      candles.push(...data);
      to = data[data.length - 1].candle_date_time_utc;
      await sleep(SLEEP_MS);
    } catch { await sleep(500); }
  }
  return candles.reverse().map(c => ({
    time:   new Date(c.candle_date_time_utc).getTime(),
    open:   c.opening_price,
    high:   c.high_price,
    low:    c.low_price,
    close:  c.trade_price,
    volume: c.candle_acc_trade_price,  // KRW 거래대금
  }));
}

async function fetchCandlesDaily(market, totalCount = 250) {
  const candles = [];
  let to = null;
  while (candles.length < totalCount) {
    const need = Math.min(200, totalCount - candles.length);
    const url  = `https://api.upbit.com/v1/candles/days?market=${market}&count=${need}` +
      (to ? `&to=${to}` : "");
    try {
      const res  = await fetch(url);
      if (!res.ok) { await sleep(1000); continue; }
      const data = await res.json();
      if (!data.length) break;
      candles.push(...data);
      to = data[data.length - 1].candle_date_time_utc;
      await sleep(SLEEP_MS);
    } catch { await sleep(500); }
  }
  return candles.reverse().map(c => ({
    time:  new Date(c.candle_date_time_utc).getTime(),
    open:  c.opening_price,
    high:  c.high_price,
    low:   c.low_price,
    close: c.trade_price,
    volume: c.candle_acc_trade_price,
  }));
}

// ── 4h 캔들 집계 ──────────────────────────────────────────

function buildCandles4h(candles1h) {
  const buckets = new Map();
  const FOUR_H  = 4 * 3600000;
  for (const c of candles1h) {
    const key = Math.floor(c.time / FOUR_H) * FOUR_H;
    if (!buckets.has(key)) {
      buckets.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      const b = buckets.get(key);
      if (c.high > b.high) b.high = c.high;
      if (c.low  < b.low)  b.low  = c.low;
      b.close  = c.close;
      b.volume += c.volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

// ── 레짐 맵 ───────────────────────────────────────────────

function buildRegimeMap(dailyCandles) {
  const map    = new Map();
  const closes = dailyCandles.map(c => c.close);
  for (let i = 0; i < dailyCandles.length; i++) {
    const slice  = closes.slice(0, i + 1);
    const price  = slice[slice.length - 1];
    const smaLen = Math.min(200, slice.length);
    if (smaLen < 50) { map.set(dateStr(dailyCandles[i].time), { regime: "NEUTRAL", dAtrPct: 0 }); continue; }
    const sma200   = slice.slice(-smaLen).reduce((s, v) => s + v, 0) / smaLen;
    const weekly   = slice.length >= 8 ? (price - slice[slice.length - 8]) / slice[slice.length - 8] : 0;
    const btcVsSma = (price - sma200) / sma200;
    const dAtr     = i >= ATR_PERIOD ? atr(dailyCandles.slice(i - ATR_PERIOD, i + 1)) : null;
    const dAtrPct  = dAtr ? dAtr / price : 0;
    let regime;
    if      (btcVsSma > 0.02 && weekly > 0.01)  regime = "BULL";
    else if (btcVsSma < -0.02 && weekly < -0.01) regime = "BEAR";
    else if (btcVsSma > 0.01)                    regime = "BULL";
    else if (btcVsSma < -0.01 && weekly < -0.01) regime = "BEAR";
    else                                          regime = "NEUTRAL";
    map.set(dateStr(dailyCandles[i].time), { regime, dAtrPct });
  }
  return map;
}

// ── 신호 평가 ──────────────────────────────────────────────

function evaluateSignal4h(candles4h, i, regimeInfo) {
  if (i < 210) return null;
  if (!regimeInfo) return null;
  const { regime, dAtrPct } = regimeInfo;
  if (regime !== "BULL") return null;
  if (dAtrPct > DAILY_ATR_MAX) return null;

  const window  = candles4h.slice(0, i + 1);
  const closes  = window.map(c => c.close);
  const highs   = window.map(c => c.high);
  const volumes = window.map(c => c.volume);
  const price   = closes[closes.length - 1];
  const curHigh = highs[highs.length - 1];

  if (window.length < 22) return null;
  const prev20High = Math.max(...highs.slice(-21, -1));
  if (curHigh <= prev20High) return null;

  const ema200 = ema(closes, 200);
  if (!ema200 || price < ema200 * 0.995) return null;

  const r = rsi(closes, 14);
  if (r < 50 || r > 75) return null;

  const recentVol = volumes[volumes.length - 1];
  const baseVol   = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
  if (baseVol > 0 && recentVol < baseVol * 1.5) return null;

  const ema21 = ema(closes, 21);
  if (!ema21 || price < ema21 * 0.99) return null;

  return { price, atrVal: atr(window.slice(-ATR_PERIOD)), rsi: r, regime };
}

// ── 1h 청산 시뮬레이션 ─────────────────────────────────────

function simulateTrade(candles1h, entryIdx1h, sig) {
  const entryPrice = sig.price;
  const atrVal     = sig.atrVal;
  const stopDist   = atrVal * ATR_STOP_MULT;
  const targetDist = atrVal * ATR_TARGET_MULT;
  const beDist     = atrVal * ATR_BE_MULT;

  let stopPrice   = entryPrice - stopDist;
  let targetPrice = entryPrice + targetDist;
  let peakPrice   = entryPrice;
  let beReached   = false;
  const maxCandles1h = MAX_HOLD_4H * 4;

  for (let j = 1; j <= maxCandles1h; j++) {
    const idx = entryIdx1h + j;
    if (idx >= candles1h.length) break;
    const c = candles1h[idx];
    if (c.high > peakPrice) peakPrice = c.high;
    if (!beReached && peakPrice >= entryPrice + beDist) {
      beReached = true;
      if (entryPrice > stopPrice) stopPrice = entryPrice;
    }
    if (beReached) {
      const trailStop = peakPrice - atrVal * ATR_TRAIL_MULT;
      if (trailStop > stopPrice) stopPrice = trailStop;
    }
    if (c.low <= stopPrice) return { pnl: (stopPrice - entryPrice) / entryPrice, exit: "STOP",   candles: j };
    if (c.high >= targetPrice) return { pnl: (targetPrice - entryPrice) / entryPrice, exit: "TARGET", candles: j };
  }
  const lastIdx = Math.min(entryIdx1h + maxCandles1h, candles1h.length - 1);
  return { pnl: (candles1h[lastIdx].close - entryPrice) / entryPrice, exit: "TIME", candles: maxCandles1h };
}

// ── 단일 마켓 백테스트 ─────────────────────────────────────

function backtestMarket(candles1h, candlesDaily) {
  if (candles1h.length < 500) return null;

  const candles4h  = buildCandles4h(candles1h);
  const regimeMap  = buildRegimeMap(candlesDaily);
  const timeToIdx1h = new Map();
  for (let i = 0; i < candles1h.length; i++) {
    timeToIdx1h.set(candles1h[i].time, i);
  }

  const trades = [];
  let skipUntil4h = 0;

  for (let i = 210; i < candles4h.length - MAX_HOLD_4H; i++) {
    if (i < skipUntil4h) continue;
    const c4h     = candles4h[i];
    const dStr    = dateStr(c4h.time);
    const regInfo = regimeMap.get(dStr) || null;
    const sig     = evaluateSignal4h(candles4h, i, regInfo);
    if (!sig) continue;

    // 진입 1h 캔들 찾기
    let entryIdx1h = timeToIdx1h.get(c4h.time);
    if (entryIdx1h === undefined) {
      let best = -1, bestDiff = Infinity;
      for (const [t, idx] of timeToIdx1h) {
        const d = Math.abs(t - c4h.time);
        if (d < bestDiff) { bestDiff = d; best = idx; }
      }
      entryIdx1h = best;
    }
    if (entryIdx1h < 0 || entryIdx1h >= candles1h.length - 5) continue;

    const trade = simulateTrade(candles1h, entryIdx1h, sig);
    trades.push({ ...trade, month: new Date(c4h.time).toISOString().slice(0, 7) });
    skipUntil4h = i + 1 + (trade.candles / 4 | 0) + COOLDOWN_4H;
  }

  if (trades.length < MIN_TRADES) return null;

  const FEES   = 0.00278;
  const netPnls = trades.map(t => t.pnl - FEES);
  const wins    = trades.filter(t => t.pnl > FEES);
  const mean    = avg(netPnls);
  const std     = Math.sqrt(avg(netPnls.map(v => (v - mean) ** 2)));
  const sharpe  = std > 0 ? (mean / std) * Math.sqrt(2190) : 0;

  let cum = 0, peak = 0, mdd = 0;
  for (const p of netPnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > mdd) mdd = dd;
  }

  return {
    trades: trades.length,
    winRate: wins.length / trades.length,
    ev: mean,
    sharpe,
    cumReturn: cum,
    mdd,
    target: trades.filter(t => t.exit === "TARGET").length,
    stop:   trades.filter(t => t.exit === "STOP").length,
  };
}

// ── 메인 ──────────────────────────────────────────────────

async function run() {
  console.log("=".repeat(65));
  console.log("  업비트 전체 KRW 마켓 백테스트 — Strategy A v4");
  console.log("  기간: 최근 3개월 | ATRx2 손절 / ATRx4 목표");
  console.log("=".repeat(65));

  // 1. 마켓 목록 가져오기
  const mktResp = await fetch("https://api.upbit.com/v1/market/all?isDetails=false");
  const allMkts = await mktResp.json();
  const krwMkts = allMkts.filter(m => m.market.startsWith("KRW-")).map(m => m.market);
  console.log(`\n전체 KRW 마켓: ${krwMkts.length}개`);

  // 2. 거래량 체크 (ticker API - 한번에 200개 가능)
  const tickerResp = await fetch(
    `https://api.upbit.com/v1/ticker?markets=${krwMkts.join(",")}`
  );
  const tickers = await tickerResp.json();
  await sleep(200);

  const liquidMkts = tickers
    .filter(t => (t.acc_trade_price_24h || 0) >= MIN_VOL_KRW)
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .map(t => ({ market: t.market, vol24h: t.acc_trade_price_24h }));

  console.log(`거래량 ${(MIN_VOL_KRW / 1e9).toFixed(0)}B+ 마켓: ${liquidMkts.length}개`);
  console.log(`예상 소요시간: ~${Math.ceil(liquidMkts.length * 15 / 60)}분\n`);

  // 3. 각 마켓 백테스트
  const results = [];

  for (let idx = 0; idx < liquidMkts.length; idx++) {
    const { market, vol24h } = liquidMkts[idx];
    process.stdout.write(
      `[${idx + 1}/${liquidMkts.length}] ${market.padEnd(15)} 데이터 수집중...`
    );

    try {
      const [candles1h, candlesDaily] = await Promise.all([
        fetchCandles1h(market, CANDLES_1H),
        fetchCandlesDaily(market, CANDLES_DAILY),
      ]);

      const stats = backtestMarket(candles1h, candlesDaily);

      if (stats) {
        results.push({ market, vol24h, ...stats });
        process.stdout.write(
          `\r[${idx + 1}/${liquidMkts.length}] ${market.padEnd(15)} ` +
          `EV=${( stats.ev * 100).toFixed(2).padStart(6)}%  ` +
          `WR=${( stats.winRate * 100).toFixed(0).padStart(3)}%  ` +
          `Sharpe=${stats.sharpe.toFixed(2).padStart(6)}  ` +
          `T=${stats.trades}\n`
        );
      } else {
        process.stdout.write(
          `\r[${idx + 1}/${liquidMkts.length}] ${market.padEnd(15)} 신호부족 (스킵)\n`
        );
      }
    } catch (e) {
      process.stdout.write(`\r[${idx + 1}/${liquidMkts.length}] ${market.padEnd(15)} ERROR: ${e.message}\n`);
    }

    await sleep(200);
  }

  // 4. 결과 정렬 및 출력
  const ranked = results
    .filter(r => r.ev > 0)
    .sort((a, b) => b.ev - a.ev);

  console.log("\n" + "=".repeat(65));
  console.log("  [EV 랭킹 — 양수 기대값 마켓]");
  console.log("=".repeat(65));
  console.log(
    `${"순위".padStart(4)}  ${"마켓".padEnd(14)}  ` +
    `${"EV".padStart(7)}  ${"승률".padStart(6)}  ` +
    `${"Sharpe".padStart(7)}  ${"누적".padStart(7)}  ` +
    `${"MDD".padStart(6)}  ${"T".padStart(3)}  ` +
    `${"24h거래량".padStart(12)}`
  );
  console.log("-".repeat(90));

  for (let i = 0; i < Math.min(ranked.length, 30); i++) {
    const r = ranked[i];
    console.log(
      `${String(i + 1).padStart(4)}  ${r.market.padEnd(14)}  ` +
      `${(r.ev * 100).toFixed(2).padStart(6)}%  ` +
      `${(r.winRate * 100).toFixed(0).padStart(5)}%  ` +
      `${r.sharpe.toFixed(2).padStart(7)}  ` +
      `${(r.cumReturn * 100).toFixed(1).padStart(6)}%  ` +
      `${(r.mdd * 100).toFixed(1).padStart(5)}%  ` +
      `${String(r.trades).padStart(3)}  ` +
      `${(r.vol24h / 1e9).toFixed(1).padStart(10)}B`
    );
  }

  // 5. 전략 추가 추천
  const top5 = ranked.slice(0, 5).map(r => r.market);
  console.log("\n" + "=".repeat(65));
  console.log("  [현재 전략 vs 추천 추가 마켓]");
  console.log(`  현재: BTC, ETH`);
  console.log(`  추가 추천: ${top5.join(", ")}`);
  console.log("\n  EV < 0 마켓:", results.filter(r => r.ev <= 0).length + "개 (제외)");
  console.log("  신호 없음 마켓:", (liquidMkts.length - results.length) + "개");
  console.log("=".repeat(65));
}

run().catch(console.error);
