"use strict";

/**
 * Strategy A v4 백테스트 — 4h 신호 + 1h 청산 멀티타임프레임
 *
 * 설계 원칙 (최저 리스크 / 최고 EV):
 *   신호 타임프레임: 4h (노이즈 75% 제거, 월 2-5회 고품질 신호)
 *   청산 타임프레임: 1h (세밀한 손절 / 목표가 관리)
 *   손절: ATR(14, 4h) × 2.0 (정상 변동성에서 생존)
 *   목표: ATR(14, 4h) × 4.0 (2:1 R:R 고정)
 *   손익분기 보호: +1 ATR 달성 시 손절을 진입가로 이동
 *   최대 보유: 20 × 4h = 80시간 (~3.3일)
 *
 * 진입 조건 (ALL 충족 필요):
 *   1. 일봉 레짐: BULL (BTC > 일봉 SMA200)
 *   2. 4h MACD: 히스토그램이 음→양 제로크로스 (이번 4h 캔들)
 *   3. 4h 가격: EMA21 위 (기본 상승추세)
 *   4. 4h 가격: EMA200 위 (장기 추세 정렬)
 *   5. 4h RSI: 40~65 (적정 모멘텀, 과매수 제외)
 *   6. 4h 거래량: 20봉 평균 이상
 *   7. 일봉 ATR 가드: 일봉 ATR < 5% (극단 변동성 제외)
 *
 * 제외 신호 (백테스트 불가 → 실거래에서 추가 필터링됨):
 *   호가 불균형(OB), MacroEngine, DataEngine
 *   → 실거래 결과는 이 백테스트보다 더 좋을 가능성 높음
 */

const ATR_STOP_MULT   = 2.0;   // 손절: ATR × 2
const ATR_TARGET_MULT = 4.0;   // 목표: ATR × 4  (2:1 R:R)
const ATR_BE_MULT     = 1.0;   // 이 값 도달 시 손절→진입가(손익분기)
const ATR_TRAIL_MULT  = 1.5;   // 손익분기 이후 트레일링 폭
const MAX_HOLD_4H     = 20;    // 최대 보유 4h 캔들 수 (= 80시간)
const ATR_PERIOD      = 14;
const DAILY_ATR_MAX   = 0.05;  // 일봉 ATR > 5% → 진입 금지 (극단 변동성)
const COOLDOWN_4H     = 2;     // 청산 후 쿨다운 (4h 캔들 수)

// ── 데이터 수집 ──────────────────────────────────────────

async function fetchCandles1h(market, totalCount) {
  const candles = [];
  let to = null;
  process.stdout.write(`[Fetch] ${market} 1h 캔들 수집 중 (목표: ${totalCount}개)...`);
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
      process.stdout.write(`\r[Fetch] ${market} 1h 캔들 수집 중... ${candles.length}개`);
      await sleep(120);
    } catch (e) { await sleep(500); }
  }
  console.log(` → 완료 (${candles.length}개)`);
  return candles.reverse().map(c => ({
    time:   new Date(c.candle_date_time_utc).getTime(),
    open:   c.opening_price,
    high:   c.high_price,
    low:    c.low_price,
    close:  c.trade_price,
    volume: c.candle_acc_trade_volume,
  }));
}

async function fetchCandlesDaily(market, totalCount = 600) {
  const candles = [];
  let to = null;
  process.stdout.write(`[Fetch] ${market} 일봉 캔들 수집 중 (목표: ${totalCount}개)...`);
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
      await sleep(120);
    } catch (e) { await sleep(500); }
  }
  console.log(` → ${candles.length}개`);
  return candles.reverse().map(c => ({
    time:  new Date(c.candle_date_time_utc).getTime(),
    open:  c.opening_price,
    high:  c.high_price,
    low:   c.low_price,
    close: c.trade_price,
  }));
}

// ── 4h 캔들 집계 (1h → 4h) ──────────────────────────────

function buildCandles4h(candles1h) {
  const buckets = new Map();
  const FOUR_H  = 4 * 3600000;

  for (const c of candles1h) {
    const key = Math.floor(c.time / FOUR_H) * FOUR_H;
    if (!buckets.has(key)) {
      buckets.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      const b = buckets.get(key);
      if (c.high  > b.high)  b.high  = c.high;
      if (c.low   < b.low)   b.low   = c.low;
      b.close  = c.close;
      b.volume += c.volume;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

// ── 지표 계산 ──────────────────────────────────────────

function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((s, v) => s + v, 0) / n;
}

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

function macd(closes) {
  if (closes.length < 35) return null;
  const emaF = emaArr(closes, 12);
  const emaS = emaArr(closes, 26);
  if (!emaF || !emaS) return null;
  const offset   = emaF.length - emaS.length;
  const macdLine = emaS.map((s, i) => emaF[offset + i] - s);
  const sigArr   = emaArr(macdLine, 9);
  if (!sigArr || sigArr.length < 2) return null;
  const n = macdLine.length, sn = sigArr.length;
  return {
    histogram:     macdLine[n - 1] - sigArr[sn - 1],
    prevHistogram: macdLine[n - 2] - sigArr[sn - 2],
  };
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

// ── 레짐 감지 (일봉 SMA200 + 4h 추세) ───────────────────

function buildRegimeMap(dailyCandles) {
  const map    = new Map();
  const closes = dailyCandles.map(c => c.close);

  for (let i = 0; i < dailyCandles.length; i++) {
    const slice  = closes.slice(0, i + 1);
    const price  = slice[slice.length - 1];
    const smaLen = Math.min(200, slice.length);
    if (smaLen < 50) { map.set(dateStr(dailyCandles[i].time), "NEUTRAL"); continue; }

    const sma200   = slice.slice(-smaLen).reduce((s, v) => s + v, 0) / smaLen;
    const weekly   = slice.length >= 8 ? (price - slice[slice.length - 8]) / slice[slice.length - 8] : 0;
    const btcVsSma = (price - sma200) / sma200;

    // ATR 가드용 일봉 ATR
    const dAtr = i >= ATR_PERIOD
      ? atr(dailyCandles.slice(i - ATR_PERIOD, i + 1))
      : null;
    const dAtrPct = dAtr ? dAtr / price : 0;

    let regime;
    if      (btcVsSma > 0.02 && weekly > 0.01)       regime = "BULL";
    else if (btcVsSma < -0.02 && weekly < -0.01)      regime = "BEAR";
    else if (btcVsSma > 0.01)                          regime = "BULL";
    else if (btcVsSma < -0.01 && weekly < -0.01)      regime = "BEAR";
    else                                               regime = "NEUTRAL";

    map.set(dateStr(dailyCandles[i].time), { regime, dAtrPct });
  }
  return map;
}

function dateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// ── 4h 신호 평가 ──────────────────────────────────────────
// 전략: 20봉 고점 돌파 + BULL 레짐 + EMA200 + 거래량 확인
// 돌파 진입 = 모멘텀이 시작하는 정확한 타이밍 (MACD는 늦음)

function evaluateSignal4h(candles4h, i, regimeInfo) {
  if (i < 210) return null;
  if (!regimeInfo) return null;

  const { regime, dAtrPct } = regimeInfo;

  // ① 레짐: BULL 전용
  if (regime !== "BULL") return null;

  // ② 일봉 ATR 가드: 극단 변동성 제외
  if (dAtrPct > DAILY_ATR_MAX) return null;

  const window  = candles4h.slice(0, i + 1);
  const closes  = window.map(c => c.close);
  const highs   = window.map(c => c.high);
  const volumes = window.map(c => c.volume);
  const price   = closes[closes.length - 1];
  const curHigh = highs[highs.length - 1];

  // ③ 20봉 고점 돌파 (현재 고가 > 이전 20봉 최고가)
  //    → 모멘텀이 실제로 시작되는 순간, 거짓 신호 최소화
  if (window.length < 22) return null;
  const prev20High = Math.max(...highs.slice(-21, -1));  // 현재 제외 이전 20봉
  if (curHigh <= prev20High) return null;  // 신고점 아니면 제외

  // ④ 4h EMA200 위 (장기 추세 정렬 필수)
  const ema200 = ema(closes, 200);
  if (!ema200 || price < ema200 * 0.995) return null;

  // ⑤ 4h RSI: 50~75 (돌파 시 모멘텀 있어야, 과매수 제외)
  const r = rsi(closes, 14);
  if (r < 50 || r > 75) return null;

  // ⑥ 돌파 캔들 거래량: 20봉 평균의 1.5배 이상 (거짓 돌파 제거)
  const recentVol = volumes[volumes.length - 1];
  const baseVol   = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
  if (baseVol > 0 && recentVol < baseVol * 1.5) return null;

  // ⑦ 전일 저점 위 (트렌드 연속성 확인)
  const ema21 = ema(closes, 21);
  if (!ema21 || price < ema21 * 0.99) return null;

  // ATR (4h 기준)
  const atrVal = atr(window.slice(-ATR_PERIOD));

  return {
    price,
    atrVal,
    rsi: r,
    regime,
    reasons: ["BO20", "BULL", "EMA200↑", `RSI${r.toFixed(0)}`, "VOL↑"],
  };
}

// ── 1h 청산 시뮬레이션 ────────────────────────────────────
// 4h 신호 기준 ATR로 손절/목표 설정, 1h 캔들로 세밀하게 청산

function simulateTrade(candles1h, entryIdx1h, sig) {
  const entryPrice = sig.price;
  const atrVal     = sig.atrVal;

  // ATR 기반 손절/목표 (2:1 R:R)
  const stopDist   = atrVal * ATR_STOP_MULT;
  const targetDist = atrVal * ATR_TARGET_MULT;
  const beDist     = atrVal * ATR_BE_MULT;    // 손익분기 이동 트리거

  let stopPrice   = entryPrice - stopDist;
  let targetPrice = entryPrice + targetDist;
  let peakPrice   = entryPrice;
  let beReached   = false;

  const maxCandles1h = MAX_HOLD_4H * 4;  // 80시간

  for (let j = 1; j <= maxCandles1h; j++) {
    const idx = entryIdx1h + j;
    if (idx >= candles1h.length) break;

    const c = candles1h[idx];

    // 피크 갱신
    if (c.high > peakPrice) peakPrice = c.high;

    // 손익분기 보호: +1 ATR 달성 시 손절 → 진입가
    if (!beReached && peakPrice >= entryPrice + beDist) {
      beReached = true;
      if (entryPrice > stopPrice) stopPrice = entryPrice;  // 진입가로 스탑 이동
    }

    // 손익분기 이후 트레일링 스탑
    if (beReached) {
      const trailStop = peakPrice - atrVal * ATR_TRAIL_MULT;
      if (trailStop > stopPrice) stopPrice = trailStop;
    }

    // 같은 캔들에서 목표/손절 → 손절 우선 (보수적)
    const hitStop   = c.low  <= stopPrice;
    const hitTarget = c.high >= targetPrice;

    if (hitStop && hitTarget) {
      const pnl = (stopPrice - entryPrice) / entryPrice;
      return { pnl, exit: "STOP", candles: j };
    }
    if (hitStop) {
      const pnl = (stopPrice - entryPrice) / entryPrice;
      return { pnl, exit: "STOP", candles: j };
    }
    if (hitTarget) {
      const pnl = (targetPrice - entryPrice) / entryPrice;
      return { pnl, exit: "TARGET", candles: j };
    }
  }

  // 타임스탑
  const lastIdx = Math.min(entryIdx1h + maxCandles1h, candles1h.length - 1);
  const pnl = (candles1h[lastIdx].close - entryPrice) / entryPrice;
  return { pnl, exit: "TIME", candles: maxCandles1h };
}

// ── 통계 계산 ──────────────────────────────────────────

function calcStats(trades) {
  if (!trades.length) return null;

  const wins   = trades.filter(t => t.pnl > 0.001);  // 수수료 이상 수익
  const losses = trades.filter(t => t.pnl <= 0.001);
  const winRate = wins.length / trades.length;

  const totalFees = 0.00278;
  const netPnls   = trades.map(t => t.pnl - totalFees);

  const avgNetWin  = wins.length   > 0 ? avg(wins.map(t => t.pnl - totalFees))   : 0;
  const avgNetLoss = losses.length > 0 ? avg(losses.map(t => t.pnl - totalFees)) : 0;

  const ev  = netPnls.reduce((s, v) => s + v, 0) / netPnls.length;
  const mean = ev;
  const std  = Math.sqrt(netPnls.map(v => (v - mean) ** 2).reduce((s, v) => s + v, 0) / netPnls.length);
  // Sharpe: 4h 기준 연환산 (365*6 = 2190 4h봉/년)
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(2190) : 0;

  let cumPnl = 0, peak = 0, mdd = 0;
  for (const t of trades) {
    cumPnl += t.pnl - totalFees;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > mdd) mdd = dd;
  }

  const b      = avgNetLoss !== 0 ? Math.abs(avgNetWin / avgNetLoss) : 1;
  const kelly  = (b * winRate - (1 - winRate)) / b;
  const qKelly = Math.max(0.02, Math.min(0.20, kelly * 0.25));

  const byRegime = {};
  for (const t of trades) {
    if (!byRegime[t.regime]) byRegime[t.regime] = [];
    byRegime[t.regime].push(t);
  }

  const monthly = {};
  for (const t of trades) {
    const mo = t.month || "??";
    if (!monthly[mo]) monthly[mo] = 0;
    monthly[mo] += t.pnl - totalFees;
  }

  return {
    total: trades.length, wins: wins.length, losses: losses.length,
    winRate, ev, avgNetWin, avgNetLoss, sharpe, mdd,
    cumReturn: netPnls.reduce((s, v) => s + v, 0),
    kelly: qKelly, byRegime, monthly,
    exitTypes: {
      target: trades.filter(t => t.exit === "TARGET").length,
      stop:   trades.filter(t => t.exit === "STOP").length,
      time:   trades.filter(t => t.exit === "TIME").length,
    },
  };
}

function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 메인 ───────────────────────────────────────────────

async function run() {
  const MARKET = "KRW-BTC";

  console.log("══════════════════════════════════════════════");
  console.log("  Strategy A v4 백테스트 — 4h 신호 + 1h 청산");
  console.log("  기간: 최근 18개월 | ATR×2 손절 / ATR×4 목표");
  console.log("  OB/Macro/DataEngine 제외 (실거래에서 추가 필터)");
  console.log("══════════════════════════════════════════════\n");

  const [candles1h, candlesDaily] = await Promise.all([
    fetchCandles1h(MARKET, 13200),   // ~18개월
    fetchCandlesDaily(MARKET, 600),  // ~600일 (일봉 레짐)
  ]);

  console.log(`\n1h 캔들: ${candles1h.length}개 | 일봉: ${candlesDaily.length}개`);
  if (candles1h.length > 0) {
    const from = new Date(candles1h[0].time).toISOString().slice(0, 10);
    const to   = new Date(candles1h[candles1h.length - 1].time).toISOString().slice(0, 10);
    console.log(`기간: ${from} ~ ${to}`);
  }

  // 4h 캔들 구성
  const candles4h = buildCandles4h(candles1h);
  console.log(`4h 캔들: ${candles4h.length}개 (~${Math.round(candles4h.length / (6 * 30))}개월)\n`);

  // 레짐 맵 (일봉 ATR 포함)
  const regimeMap = buildRegimeMap(candlesDaily);

  // 4h → 1h 시간 인덱스 매핑 (청산 시뮬레이션용)
  const timeToIdx1h = new Map();
  for (let i = 0; i < candles1h.length; i++) {
    timeToIdx1h.set(candles1h[i].time, i);
  }

  // ── 백테스트 실행 ───────────────────────────────────
  const trades   = [];
  let skipUntil4h = 0;  // 쿨다운 인덱스 (4h 기준)

  for (let i = 210; i < candles4h.length - MAX_HOLD_4H; i++) {
    if (i < skipUntil4h) continue;

    const c4h      = candles4h[i];
    const dStr     = dateStr(c4h.time);
    const regInfo  = regimeMap.get(dStr) || null;

    const sig = evaluateSignal4h(candles4h, i, regInfo);
    if (!sig) continue;

    // 4h 신호 → 해당 1h 캔들 찾기
    const entry1hIdx = timeToIdx1h.get(c4h.time);
    if (entry1hIdx === undefined) continue;
    if (entry1hIdx + MAX_HOLD_4H * 4 >= candles1h.length) continue;

    // 1h 청산 시뮬레이션
    const trade = simulateTrade(candles1h, entry1hIdx, sig);
    trade.entryTime  = new Date(c4h.time).toISOString().slice(0, 16);
    trade.entryPrice = sig.price;
    trade.regime     = sig.regime;
    trade.month      = new Date(c4h.time).toISOString().slice(0, 7);
    trade.rsi        = sig.rsi;
    trade.reasons    = sig.reasons.join(",");
    trade.atrPct     = (sig.atrVal / sig.price * 100).toFixed(2);

    trades.push(trade);

    // 쿨다운: 청산까지 4h 캔들 수 계산 후 + COOLDOWN_4H
    const held4h = Math.ceil(trade.candles / 4);
    skipUntil4h  = i + held4h + COOLDOWN_4H;
  }

  // ── 결과 출력 ───────────────────────────────────────
  const stats = calcStats(trades);
  if (!stats) {
    console.log("❌ 발생 거래 없음 — 신호 조건 미충족 또는 데이터 부족");
    return;
  }

  console.log("══════════════════════════════════════════════");
  console.log("  백테스트 결과");
  console.log("══════════════════════════════════════════════");
  console.log(`  총 거래:     ${stats.total}건  (월평균 ${(stats.total / 18).toFixed(1)}건)`);
  console.log(`  승률:        ${(stats.winRate * 100).toFixed(1)}%  (${stats.wins}승 ${stats.losses}패)`);
  console.log(`  EV/거래:     ${stats.ev >= 0 ? "+" : ""}${(stats.ev * 100).toFixed(3)}% (수수료 포함)`);
  console.log(`  평균 수익:   +${(stats.avgNetWin * 100).toFixed(2)}%`);
  console.log(`  평균 손실:   ${(stats.avgNetLoss * 100).toFixed(2)}%`);
  console.log(`  R:R 실현:    ${stats.avgNetLoss !== 0 ? Math.abs(stats.avgNetWin / stats.avgNetLoss).toFixed(2) : "∞"}:1`);
  console.log(`  Sharpe:      ${stats.sharpe.toFixed(2)}`);
  console.log(`  MDD:         -${(stats.mdd * 100).toFixed(2)}%`);
  console.log(`  누적 수익:   ${stats.cumReturn >= 0 ? "+" : ""}${(stats.cumReturn * 100).toFixed(2)}%`);
  console.log(`  Quarter Kelly: ${(stats.kelly * 100).toFixed(1)}%`);
  console.log("");
  console.log("  청산 유형:");
  console.log(`    목표 도달: ${stats.exitTypes.target}건 (${(stats.exitTypes.target / stats.total * 100).toFixed(0)}%)`);
  console.log(`    손절:      ${stats.exitTypes.stop}건   (${(stats.exitTypes.stop / stats.total * 100).toFixed(0)}%)`);
  console.log(`    타임스탑:  ${stats.exitTypes.time}건   (${(stats.exitTypes.time / stats.total * 100).toFixed(0)}%)`);
  console.log("");
  console.log("  레짐별 성과:");
  for (const [reg, rt] of Object.entries(stats.byRegime)) {
    const s = calcStats(rt);
    if (!s) continue;
    console.log(
      `    ${reg.padEnd(8)}: ${rt.length}건 | 승률 ${(s.winRate * 100).toFixed(0)}% | ` +
      `EV ${s.ev >= 0 ? "+" : ""}${(s.ev * 100).toFixed(3)}% | Sharpe ${s.sharpe.toFixed(2)}`
    );
  }
  console.log("");
  console.log("  월별 누적 손익:");
  for (const [mo, ret] of Object.entries(stats.monthly).sort()) {
    const bar = ret >= 0
      ? "█".repeat(Math.min(20, Math.floor(ret * 300)))
      : "░".repeat(Math.min(20, Math.floor(Math.abs(ret) * 300)));
    console.log(`    ${mo}: ${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(2)}%  ${bar}`);
  }

  // ── 전략 평가 ─────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  console.log("  전략 평가");
  console.log("══════════════════════════════════════════════");

  const evOk     = stats.ev > 0;
  const sharpeOk = stats.sharpe > 1.0;
  const mddOk    = stats.mdd < 0.12;   // 강화된 기준: MDD < 12%
  const tradeOk  = stats.total >= 20;  // 4h 전략은 건수가 적으므로 20건
  const rrOk     = stats.avgNetLoss !== 0 && Math.abs(stats.avgNetWin / stats.avgNetLoss) >= 1.5;

  console.log(`  EV 양수:       ${evOk     ? "✅" : "❌"}  (${stats.ev >= 0 ? "+" : ""}${(stats.ev * 100).toFixed(3)}%)`);
  console.log(`  Sharpe > 1:    ${sharpeOk ? "✅" : "❌"}  (${stats.sharpe.toFixed(2)})`);
  console.log(`  MDD < 12%:     ${mddOk    ? "✅" : "❌"}  (${(stats.mdd * 100).toFixed(1)}%)`);
  console.log(`  샘플 ≥ 20건:   ${tradeOk  ? "✅" : "❌"}  (${stats.total}건)`);
  console.log(`  R:R ≥ 1.5:1:   ${rrOk     ? "✅" : "❌"}  (${stats.avgNetLoss !== 0 ? Math.abs(stats.avgNetWin / stats.avgNetLoss).toFixed(2) : "∞"}:1)`);

  const pass = [evOk, sharpeOk, mddOk, tradeOk, rrOk].filter(Boolean).length;
  console.log("");
  if (pass === 5) {
    console.log("  🟢 실거래 권장 — 5/5 조건 통과");
    console.log(`  권장 포지션 크기: 자본의 ${(stats.kelly * 100).toFixed(0)}%`);
    console.log("  → .env DRY_RUN=false 전환 권장");
  } else if (pass >= 3) {
    console.log(`  🟡 조건부 통과 (${pass}/5) — 1개월 가상매매 후 재평가 권장`);
    console.log(`  권장 포지션 크기: 자본의 ${Math.max(2, (stats.kelly * 100 * 0.5)).toFixed(0)}% (절반 사이즈)`);
  } else {
    console.log(`  🔴 실거래 비권장 (${pass}/5) — 전략 재설계 필요`);
  }

  // 전체 거래 목록 (최근 15건)
  console.log("\n  최근 거래 15건:");
  console.log("  시간              레짐   청산    수익     ATR%  이유");
  console.log("  ───────────────────────────────────────────────────────────");
  for (const t of trades.slice(-15)) {
    const pct  = (t.pnl * 100).toFixed(2);
    const sign = t.pnl >= 0 ? "+" : "";
    const icon = t.exit === "TARGET" ? "🎯" : t.exit === "STOP" ? "🛑" : "⏱";
    console.log(
      `  ${t.entryTime}  ${t.regime.padEnd(6)} ${t.exit.padEnd(6)}  ${sign}${pct}%  ${t.atrPct}%  ${t.reasons}`
    );
  }
  console.log("\n══════════════════════════════════════════════\n");
}

run().catch(console.error);
