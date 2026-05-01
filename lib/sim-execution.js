"use strict";

/**
 * lib/sim-execution.js — 시뮬 모드 라우팅/레이턴시/슬리피지 시뮬레이터
 *
 * 0.1% 퀀트 표준 — 백테스트와 LIVE 갭 0에 가깝게:
 *   1. API 레이턴시 시뮬 (50~200ms 무작위)
 *   2. 호가창 walk로 실제 평균 체결가 계산 (microstructure 모듈 활용)
 *   3. 부분 체결 시뮬 (5% 확률)
 *   4. 주문 거부 시뮬 (1% 확률)
 *
 * 사용처:
 *   Strategy A/B의 시뮬 진입 직전 호출
 *   → 실제 LIVE처럼 가격이 살짝 미끄러진 진입가 반환
 *   → 더 보수적 EV 측정 (LIVE 가서 EV 떨어지는 일 방지)
 */

const microstructure = require("./microstructure");
const makerBot       = require("./maker-bot");

// 거래소별 레이턴시 분포 (실측 평균, ms)
const LATENCY_PROFILES = {
  upbit:   { min: 80,  max: 250, mean: 130 },
  bithumb: { min: 100, max: 300, mean: 180 },
  binance: { min: 30,  max: 120, mean: 60  },  // (해외)
  bybit:   { min: 50,  max: 150, mean: 90  },
  default: { min: 100, max: 300, mean: 180 },
};

// 부분 체결 / 거부 확률
const PARTIAL_FILL_PROB    = 0.05;
const ORDER_REJECT_PROB    = 0.01;
const PARTIAL_MIN_RATIO    = 0.50;
const PARTIAL_MAX_RATIO    = 0.95;

/**
 * 시뮬 진입 — 실제 라우팅처럼 처리
 *
 * @param {Object} opts
 * @param {string} opts.market         "KRW-BTC"
 * @param {string} opts.side           "BUY" or "SELL"
 * @param {number} opts.requestedQty   목표 수량
 * @param {number} opts.requestedPrice 목표 가격 (limit) 또는 null (market)
 * @param {string} opts.exchange       (옵션) 어느 거래소 레이턴시 프로필 쓸지
 * @param {boolean} opts.useOrderbook  호가창 walk 슬리피지 시뮬 여부 (기본 true)
 *
 * @returns {Promise<{
 *   filled: boolean,
 *   executedQty: number,
 *   avgPrice: number,
 *   slippagePct: number,
 *   latencyMs: number,
 *   reason: string,
 * }>}
 */
async function simulateExecution(opts) {
  const {
    market,
    side,
    requestedQty,
    requestedPrice,
    exchange = "upbit",
    useOrderbook = true,
    orderType = "taker",  // "maker" or "taker"
    makerWaitMs = 60_000,
  } = opts;

  // 1) 레이턴시 시뮬
  const profile = LATENCY_PROFILES[exchange] || LATENCY_PROFILES.default;
  const latency = Math.floor(profile.min + Math.random() * (profile.max - profile.min));
  await new Promise(r => setTimeout(r, latency));

  // 2) 거부 시뮬 (1%)
  if (Math.random() < ORDER_REJECT_PROB) {
    return {
      filled: false,
      executedQty: 0,
      avgPrice: 0,
      slippagePct: 0,
      latencyMs: latency,
      reason: "rejected_simulated",
    };
  }

  // 2.5) Maker 모드 — 호가 top에 깔고 fill 대기
  if (orderType === "maker" && market.startsWith("KRW-")) {
    try {
      const makerResult = await makerBot.simulateMakerOrder({
        market, side, waitMs: makerWaitMs, fallbackTaker: true,
      });
      if (makerResult.filled) {
        return {
          filled: true,
          partial: false,
          executedQty: requestedQty,
          avgPrice:    makerResult.makerPrice,
          slippagePct: 0,                          // Maker = 슬리피지 0
          latencyMs:   latency + makerResult.waitedMs,
          reason:      "maker_filled",
          orderType:   "maker",
          fillProb:    makerResult.fillProb,
        };
      }
      // Fallback to taker (아래 호가창 walk로)
      console.log(`[SimExec] maker timeout (prob ${makerResult.fillProb}) → fallback taker`);
    } catch (e) {
      console.warn("[SimExec] maker error:", e.message);
    }
  }

  // 3) 호가창 walk 슬리피지 시뮬 (taker 또는 maker fallback)
  let avgPrice = requestedPrice;
  let slippagePct = 0;

  if (useOrderbook && market.startsWith("KRW-")) {
    try {
      const budget = requestedQty * (requestedPrice || 1);
      const microResult = await microstructure.analyze(market, { simulatedBudgetKrw: budget });
      if (!microResult.error) {
        if (side === "BUY") {
          avgPrice = microResult.buyPriceSim;
          slippagePct = microResult.buySlippagePct;
        } else {
          avgPrice = microResult.sellPriceSim;
          slippagePct = microResult.sellSlippagePct;
        }
      }
    } catch {
      // 실패 시 requested price 그대로 (안전)
    }
  }

  // 4) 부분 체결 시뮬 (5%)
  let executedQty = requestedQty;
  let partial = false;
  if (Math.random() < PARTIAL_FILL_PROB) {
    const ratio = PARTIAL_MIN_RATIO + Math.random() * (PARTIAL_MAX_RATIO - PARTIAL_MIN_RATIO);
    executedQty = requestedQty * ratio;
    partial = true;
  }

  return {
    filled: !partial,
    partial,
    executedQty,
    avgPrice,
    slippagePct,
    latencyMs: latency,
    reason: partial ? "partial_fill" : "filled",
  };
}

module.exports = { simulateExecution, LATENCY_PROFILES };
