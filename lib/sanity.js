"use strict";

/**
 * lib/sanity.js — 봇 뻘짓 방지 — 모든 진입/주문 직전 sanity 체크
 *
 * 차단 시나리오:
 *   - 가격 0원, 음수, NaN
 *   - 주문 크기가 자본의 99%+ (한 번에 다 거는 것 차단)
 *   - 호가 spread 이상 (5%+)
 *   - 주문 가격이 시장가 ±5% 벗어남 (잘못된 가격 입력)
 *   - 주문 수량이 0 또는 비현실적
 */

const SANITY_RULES = {
  minPrice: 0.0001,
  maxPriceDeviationPct: 0.05,   // 시장가 대비 5% 벗어나면 차단
  maxOrderSizePct: 0.95,        // 자본 95% 초과 한 번에 차단
  maxSpreadPct: 0.05,            // spread 5% 이상 차단 (호가창 비정상)
  minQuantity: 0.0000001,
};

/**
 * 진입 직전 호출
 * @returns {{ok: boolean, reason: string}}
 */
function checkOrder({ price, marketPrice, quantity, budgetKrw, totalCapital, bestBid, bestAsk }) {
  // 가격
  if (!price || price <= SANITY_RULES.minPrice || !isFinite(price)) {
    return { ok: false, reason: `invalid_price ${price}` };
  }

  // 시장가 대비 ±5%
  if (marketPrice && Math.abs(price - marketPrice) / marketPrice > SANITY_RULES.maxPriceDeviationPct) {
    return { ok: false, reason: `price_deviation ${((price - marketPrice) / marketPrice * 100).toFixed(2)}%` };
  }

  // 수량
  if (!quantity || quantity < SANITY_RULES.minQuantity || !isFinite(quantity)) {
    return { ok: false, reason: `invalid_quantity ${quantity}` };
  }

  // 주문 크기 vs 자본
  if (totalCapital && budgetKrw / totalCapital > SANITY_RULES.maxOrderSizePct) {
    return { ok: false, reason: `oversized_order ${(budgetKrw / totalCapital * 100).toFixed(0)}%` };
  }

  // Spread
  if (bestBid && bestAsk && bestBid > 0) {
    const spread = (bestAsk - bestBid) / bestBid;
    if (spread > SANITY_RULES.maxSpreadPct) {
      return { ok: false, reason: `wide_spread ${(spread * 100).toFixed(2)}%` };
    }
  }

  return { ok: true, reason: "ok" };
}

/**
 * 가격 ticker sanity (외부 API 응답 검증)
 */
function checkTicker(ticker) {
  if (!ticker || typeof ticker !== "object") return { ok: false, reason: "no_ticker" };
  if (!ticker.price || ticker.price <= 0) return { ok: false, reason: "zero_price" };
  if (ticker.price > 1e10) return { ok: false, reason: "absurd_price" };
  return { ok: true };
}

module.exports = { checkOrder, checkTicker, SANITY_RULES };
