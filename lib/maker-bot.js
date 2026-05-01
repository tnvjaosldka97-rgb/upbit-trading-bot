"use strict";

/**
 * lib/maker-bot.js — Maker 주문 전략 (호가창 top에 limit 깔기)
 *
 * 0.1% 퀀트 표준 — 시장 메이커 역할:
 *   1. best_bid + 1tick 위치에 limit buy 발사
 *   2. taker가 우리 호가 칠 때까지 대기 (N초)
 *   3. fill 안 되면 cancel + 호가 재배치
 *   4. 결국 fill 안 되면 fallback to taker (또는 포기)
 *
 * 이점:
 *   - 슬리피지 0 (호가창 top에서 체결)
 *   - 매도 측 보유자가 우리 호가 친 거 = 우리가 시장 메이커
 *   - 한국 거래소: maker fee == taker fee지만 가격 우위 큼
 *   - 해외 거래소: maker rebate (Bybit -0.01%) → EV +0.07%
 *
 * 시뮬에서:
 *   - useOrderbook 호출로 호가창 fetch
 *   - best_bid + 1tick 가격 계산
 *   - fill 확률 시뮬: 가격 적극도 + 호가 두께 기반
 *   - fill 안 되면 partial fill 또는 timeout
 */

const UPBIT_BASE = "https://api.upbit.com";

const DEFAULT_WAIT_MS = 60_000;       // 60초 대기 후 cancel
const DEFAULT_MAX_REPLACES = 3;        // 최대 호가 재배치 횟수
const DEFAULT_FILL_PROB_BASE = 0.55;   // 기본 fill 확률 55%

// 한국 거래소 호가 단위 (price tick) — Upbit 기준
function _priceTick(price) {
  if (price >= 2_000_000) return 1000;
  if (price >= 1_000_000) return 500;
  if (price >= 500_000)   return 100;
  if (price >= 100_000)   return 50;
  if (price >= 10_000)    return 10;
  if (price >= 1_000)     return 1;
  if (price >= 100)       return 1;
  if (price >= 10)        return 0.1;
  if (price >= 1)         return 0.01;
  if (price >= 0.1)       return 0.001;
  return 0.0001;
}

/**
 * Best bid + 1 tick 가격 계산 (BUY 시)
 * 또는 best ask - 1 tick 계산 (SELL 시)
 */
function getMakerPrice(orderbook, side) {
  const u0 = orderbook?.[0] || orderbook?.orderbook_units?.[0];
  if (!u0) return null;

  const bestBid = parseFloat(u0.bid_price);
  const bestAsk = parseFloat(u0.ask_price);

  if (side === "BUY") {
    const tick = _priceTick(bestBid);
    const newBid = bestBid + tick;
    // 단 ask보다 같거나 높으면 그냥 best_bid 유지 (cross 방지)
    return newBid < bestAsk ? newBid : bestBid;
  } else {
    const tick = _priceTick(bestAsk);
    const newAsk = bestAsk - tick;
    return newAsk > bestBid ? newAsk : bestAsk;
  }
}

/**
 * Maker fill 확률 시뮬레이션
 *   여러 요소 고려:
 *   - 호가 두께 (얇으면 빨리 fill)
 *   - 시간 경과
 *   - 가격 적극도 (best_bid에 깔았는지 vs best_bid + 1tick)
 *
 * @param {Object} opts
 * @returns {number} 0~1 fill 확률
 */
function simulateFillProbability(opts = {}) {
  const { liquidityClass = "MEDIUM", elapsedMs = 0, aggressiveness = 1 } = opts;

  // 기본 확률
  let prob = DEFAULT_FILL_PROB_BASE;

  // 호가 두께 (얕을수록 빨리 fill)
  if (liquidityClass === "THIN") prob += 0.20;
  else if (liquidityClass === "DEEP") prob -= 0.10;

  // 시간 경과 (60초 대기 시 prob *= 1.5)
  prob *= 1 + Math.min(elapsedMs / 60_000, 1.0) * 0.5;

  // 적극도 (best_bid + 1tick = 1.0, best_bid = 0.7)
  prob *= aggressiveness;

  return Math.min(Math.max(prob, 0), 1);
}

/**
 * Maker 주문 시뮬 (실제 거래소 호출 X — 호가창만 페치 후 시뮬)
 *
 * @returns {Promise<{
 *   filled: boolean,
 *   makerPrice: number,
 *   waitedMs: number,
 *   fillProb: number,
 *   fallbackToTaker: boolean,
 *   reason: string,
 * }>}
 */
async function simulateMakerOrder(opts) {
  const {
    market, side = "BUY", aggressiveness = 1,
    waitMs = DEFAULT_WAIT_MS,
    fallbackTaker = true,
    liquidityClass = "MEDIUM",
  } = opts;

  // 1) 호가창 페치
  let orderbookUnits;
  try {
    const res = await fetch(`${UPBIT_BASE}/v1/orderbook?markets=${market}`,
      { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`orderbook ${res.status}`);
    const data = await res.json();
    orderbookUnits = data[0]?.orderbook_units;
  } catch (e) {
    return { filled: false, reason: `orderbook_fetch_failed: ${e.message}` };
  }

  if (!orderbookUnits || orderbookUnits.length === 0) {
    return { filled: false, reason: "empty_orderbook" };
  }

  // 2) Maker 가격 계산
  const makerPrice = getMakerPrice(orderbookUnits, side);
  if (!makerPrice) return { filled: false, reason: "maker_price_calc_failed" };

  // 3) Fill 확률 시뮬 — N초 대기 후 fill 됐는지
  const fillProb = simulateFillProbability({ liquidityClass, elapsedMs: waitMs, aggressiveness });
  const filled = Math.random() < fillProb;

  if (filled) {
    return {
      filled: true,
      makerPrice,
      waitedMs: waitMs,
      fillProb: +fillProb.toFixed(3),
      fallbackToTaker: false,
      reason: "maker_filled",
    };
  }

  // 4) Fill 실패 → fallback
  return {
    filled: false,
    makerPrice,
    waitedMs: waitMs,
    fillProb: +fillProb.toFixed(3),
    fallbackToTaker: fallbackTaker,
    reason: fallbackTaker ? "timeout_fallback_taker" : "timeout_no_fill",
  };
}

module.exports = {
  simulateMakerOrder,
  getMakerPrice,
  simulateFillProbability,
  _priceTick, // for testing
};
