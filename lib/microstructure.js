"use strict";

/**
 * lib/microstructure.js — 호가창 미시구조 분석
 *
 * alpha-engine.js의 analyzeTape(체결 분석)과 보완.
 * 이쪽은 호가창(orderbook) 자체에 초점.
 *
 * 출력 시그널:
 *   - bidAskImbalance: 매수/매도 압력 비율 (-1 ~ +1)
 *   - spreadBps: bid-ask spread (basis points)
 *   - depthScore: 호가창 깊이 점수 (얕음/깊음)
 *   - slippageEstimate: 시장가 N달러 매수 시 예상 슬리피지
 *   - microSignal: "BUY_PRESSURE" / "SELL_PRESSURE" / "NEUTRAL"
 *
 * 사용처:
 *   1. Strategy A 진입 직전 슬리피지 가드
 *   2. Strategy C 차익 실행 직전 호가창 검증
 *   3. ArbExecutor의 atomic dual order 사전 필터
 */

const UPBIT_BASE = "https://api.upbit.com";

const DEPTH_LEVELS = 15; // 분석 호가 단계
const LARGE_DEPTH_KRW = 10_000_000; // 호가창 깊이 임계 (1천만원 = 깊음)

async function _fetchOrderbook(market) {
  const url = `${UPBIT_BASE}/v1/orderbook?markets=${market}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Upbit orderbook ${res.status}`);
  const data = await res.json();
  return data[0]; // 단일 마켓 응답
}

/**
 * 호가창 walk — 시장가 N원 매수/매도 시 평균 체결가 + 슬리피지
 *
 * @param {Array} units — orderbook_units (bid_price, ask_price, bid_size, ask_size)
 * @param {string} side — "buy" or "sell"
 * @param {number} budgetKrw — 매수 예산 (KRW)
 * @returns {{avgPrice, slippagePct, filled, remainingKrw}}
 */
function _walkOrderbook(units, side, budgetKrw) {
  let remainingKrw = budgetKrw;
  let totalCost = 0;
  let totalSize = 0;
  const startPrice = side === "buy" ? units[0]?.ask_price : units[0]?.bid_price;
  if (!startPrice) return { avgPrice: 0, slippagePct: 0, filled: 0, remainingKrw: budgetKrw };

  for (const u of units.slice(0, DEPTH_LEVELS)) {
    if (remainingKrw <= 0) break;
    const price = side === "buy" ? u.ask_price : u.bid_price;
    const sizeAvail = side === "buy" ? u.ask_size : u.bid_size;
    if (!price || !sizeAvail) continue;

    const levelCapKrw = price * sizeAvail;
    const usedKrw = Math.min(remainingKrw, levelCapKrw);
    const usedSize = usedKrw / price;

    totalCost += usedKrw;
    totalSize += usedSize;
    remainingKrw -= usedKrw;
  }

  if (totalSize === 0) {
    return { avgPrice: startPrice, slippagePct: 0, filled: 0, remainingKrw: budgetKrw };
  }

  const avgPrice = totalCost / totalSize;
  const slippagePct = side === "buy"
    ? (avgPrice - startPrice) / startPrice
    : (startPrice - avgPrice) / startPrice;

  return {
    avgPrice,
    slippagePct,
    filled: totalCost,
    remainingKrw,
  };
}

/**
 * 호가 불균형 — 매수/매도 압력 비율
 *   +1 = 매수 압도, -1 = 매도 압도, 0 = 균형
 */
function _imbalance(units, levels = 5) {
  let bidSum = 0, askSum = 0;
  for (const u of units.slice(0, levels)) {
    bidSum += (u.bid_size || 0) * (u.bid_price || 0);
    askSum += (u.ask_size || 0) * (u.ask_price || 0);
  }
  const total = bidSum + askSum;
  return total > 0 ? (bidSum - askSum) / total : 0;
}

/**
 * Spread (basis points)
 */
function _spreadBps(units) {
  const u0 = units[0];
  if (!u0 || !u0.bid_price || !u0.ask_price) return 0;
  const mid = (u0.bid_price + u0.ask_price) / 2;
  return mid > 0 ? ((u0.ask_price - u0.bid_price) / mid) * 10000 : 0;
}

/**
 * 호가창 깊이 점수 (양쪽 5단계 평균 KRW 가치)
 *   값 클수록 깊음 (good liquidity)
 */
function _depthScore(units, levels = 5) {
  let total = 0;
  let count = 0;
  for (const u of units.slice(0, levels)) {
    if (u.bid_price && u.bid_size) {
      total += u.bid_price * u.bid_size;
      count++;
    }
    if (u.ask_price && u.ask_size) {
      total += u.ask_price * u.ask_size;
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}

/**
 * 미시구조 분석 메인 — 단일 마켓
 *
 * @param {string} market — "KRW-BTC"
 * @param {Object} opts
 * @param {number} opts.simulatedBudgetKrw — 슬리피지 시뮬 예산 (기본 100,000)
 * @returns {Promise<Object>}
 */
async function analyze(market, opts = {}) {
  const upbitMarket = market.startsWith("KRW-") ? market : `KRW-${market.toUpperCase()}`;
  const simBudget   = opts.simulatedBudgetKrw || 100_000;

  let orderbook;
  try {
    orderbook = await _fetchOrderbook(upbitMarket);
  } catch (e) {
    return { market: upbitMarket, error: e.message, timestamp: Date.now() };
  }

  const units = orderbook?.orderbook_units || [];
  if (units.length === 0) {
    return { market: upbitMarket, error: "empty_orderbook", timestamp: Date.now() };
  }

  // 1) 호가 불균형 (5단계)
  const bidAskImbalance = _imbalance(units, 5);

  // 2) Spread (bps)
  const spreadBps = _spreadBps(units);

  // 3) 깊이 점수
  const depthScore = _depthScore(units, 5);

  // 4) 시뮬레이션 매수 슬리피지
  const buySim = _walkOrderbook(units, "buy", simBudget);

  // 5) 시뮬레이션 매도 슬리피지
  const sellSim = _walkOrderbook(units, "sell", simBudget);

  // 시그널 분류
  let microSignal = "NEUTRAL";
  if (bidAskImbalance > 0.25) microSignal = "BUY_PRESSURE";
  else if (bidAskImbalance > 0.10) microSignal = "BUY_LEAN";
  else if (bidAskImbalance < -0.25) microSignal = "SELL_PRESSURE";
  else if (bidAskImbalance < -0.10) microSignal = "SELL_LEAN";

  // 깊이 평가
  let liquidityClass = "THIN";
  if (depthScore >= LARGE_DEPTH_KRW) liquidityClass = "DEEP";
  else if (depthScore >= LARGE_DEPTH_KRW * 0.3) liquidityClass = "MEDIUM";

  return {
    market:           upbitMarket,
    timestamp:        Date.now(),
    bidAskImbalance:  +bidAskImbalance.toFixed(4),
    spreadBps:        +spreadBps.toFixed(2),
    depthScore:       Math.round(depthScore),
    liquidityClass,
    microSignal,
    buyPriceSim:      Math.round(buySim.avgPrice),
    buySlippagePct:   +(buySim.slippagePct * 100).toFixed(4),
    buyFillKrw:       Math.round(buySim.filled),
    sellPriceSim:     Math.round(sellSim.avgPrice),
    sellSlippagePct:  +(sellSim.slippagePct * 100).toFixed(4),
    sellFillKrw:      Math.round(sellSim.filled),
    bestBid:          units[0]?.bid_price || 0,
    bestAsk:          units[0]?.ask_price || 0,
  };
}

/**
 * Strategy 진입 가드 — 슬리피지 + 깊이 검증
 *   true: 진입 OK (슬리피지 작고 충분히 깊음)
 *   false: 진입 차단 (슬리피지 크거나 너무 얕음)
 */
function passesEntryGate(microResult, opts = {}) {
  if (!microResult || microResult.error) return false;
  const maxSlippagePct = opts.maxSlippagePct ?? 0.30; // 0.3%
  const minLiquidity   = opts.minLiquidity || "MEDIUM"; // THIN < MEDIUM < DEEP

  const liqRank = { THIN: 1, MEDIUM: 2, DEEP: 3 };
  if (liqRank[microResult.liquidityClass] < liqRank[minLiquidity]) return false;
  if (Math.abs(microResult.buySlippagePct) > maxSlippagePct) return false;
  return true;
}

module.exports = { analyze, passesEntryGate };
