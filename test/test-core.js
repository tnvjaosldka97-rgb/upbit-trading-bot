"use strict";

/**
 * test/test-core.js — 핵심 모듈 단위 테스트
 *
 * 실행: node test/test-core.js
 *
 * LIVE 전환 전 모든 핵심 로직 정합성 검증.
 * 거래소 API 호출 없이 순수 로직만 테스트 (offline).
 */

const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const failures = [];

function assert(cond, name) {
  if (cond) {
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    fail++;
    failures.push(name);
    process.stdout.write(`  ✗ ${name}\n`);
  }
}

function eq(a, b, name) {
  const ok = a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (!ok) console.log(`    expected: ${b}, got: ${a}`);
  assert(ok, name);
}

function approx(a, b, eps, name) {
  const ok = Math.abs(a - b) < eps;
  if (!ok) console.log(`    expected ~${b} (eps ${eps}), got ${a}`);
  assert(ok, name);
}

// ── Sanity ────────────────────────────────────────────
console.log("\n[lib/sanity]");
const sanity = require(path.join(ROOT, "lib/sanity"));

assert(sanity.checkOrder({ price: 100, marketPrice: 100, quantity: 1, budgetKrw: 50000, totalCapital: 100000 }).ok, "정상 주문 통과");
assert(!sanity.checkOrder({ price: 0, quantity: 1, budgetKrw: 50000, totalCapital: 100000 }).ok, "가격 0 차단");
assert(!sanity.checkOrder({ price: -10, quantity: 1, budgetKrw: 50000, totalCapital: 100000 }).ok, "음수 가격 차단");
assert(!sanity.checkOrder({ price: NaN, quantity: 1, budgetKrw: 50000, totalCapital: 100000 }).ok, "NaN 가격 차단");
assert(!sanity.checkOrder({ price: 100, marketPrice: 100, quantity: 1, budgetKrw: 99000, totalCapital: 100000 }).ok, "오버사이즈 차단 (자본 99%)");
assert(!sanity.checkOrder({ price: 110, marketPrice: 100, quantity: 1, budgetKrw: 50000, totalCapital: 100000 }).ok, "시장가 +10% 차단");
assert(!sanity.checkOrder({ price: 100, marketPrice: 100, quantity: 0, budgetKrw: 50000, totalCapital: 100000 }).ok, "수량 0 차단");
assert(sanity.checkTicker({ price: 100 }).ok, "정상 ticker");
assert(!sanity.checkTicker({ price: 0 }).ok, "ticker 가격 0 차단");
assert(!sanity.checkTicker(null).ok, "null ticker 차단");

// ── Multi-timeframe (toScoreContribution) ─────────────
console.log("\n[lib/multi-timeframe]");
const mtf = require(path.join(ROOT, "lib/multi-timeframe"));

eq(mtf.toScoreContribution(null), 0, "null 결과 0점");
eq(mtf.toScoreContribution({ direction: "BULL", score: 4 }), 20, "BULL strong +20");
eq(mtf.toScoreContribution({ direction: "BULL", score: 3 }), 12, "BULL align +12");
eq(mtf.toScoreContribution({ direction: "BULL_WEAK", score: 2 }), 5, "BULL weak +5");
eq(mtf.toScoreContribution({ direction: "NEUTRAL", score: 2 }), 0, "NEUTRAL 0");
eq(mtf.toScoreContribution({ direction: "BEAR_WEAK", score: 2 }), -5, "BEAR weak -5");
eq(mtf.toScoreContribution({ direction: "BEAR", score: 3 }), -15, "BEAR align -15");
eq(mtf.toScoreContribution({ direction: "BEAR", score: 4 }), -25, "BEAR strong -25");

// ── Microstructure passesEntryGate ────────────────────
console.log("\n[lib/microstructure]");
const micro = require(path.join(ROOT, "lib/microstructure"));

assert(!micro.passesEntryGate(null), "null 결과 차단");
assert(!micro.passesEntryGate({ error: "x" }), "error 결과 차단");
assert(micro.passesEntryGate({
  liquidityClass: "DEEP",
  buySlippagePct: 0.1,
  bidAskImbalance: 0,
}), "DEEP + 슬리피지 0.1% 통과");
assert(!micro.passesEntryGate({
  liquidityClass: "THIN",
  buySlippagePct: 0.1,
  bidAskImbalance: 0,
}), "THIN 차단");
assert(!micro.passesEntryGate({
  liquidityClass: "DEEP",
  buySlippagePct: 0.5,
  bidAskImbalance: 0,
}), "슬리피지 0.5% 차단");

// ── Risk Manager ──────────────────────────────────────
console.log("\n[risk-manager]");
const { RiskManager } = require(path.join(ROOT, "risk-manager"));
const rm = new RiskManager({ totalCapital: 100000 });

let r1 = rm.checkEntry({ strategy: "A", budgetKrw: 50000, currentPositions: {} });
assert(r1.allowed, "Strategy A 50k 통과 (60% 한도)");

let r2 = rm.checkEntry({ strategy: "A", budgetKrw: 70000, currentPositions: {} });
assert(!r2.allowed && /category_limit/.test(r2.reason), "Strategy A 70k 차단 (60% 초과)");

// 일일 손실 한도 초과 시뮬
rm.recordTrade({ pnlKrw: -1500, isLoss: true });
let r3 = rm.checkEntry({ strategy: "A", budgetKrw: 30000, currentPositions: {} });
assert(!r3.allowed && /daily_loss/.test(r3.reason), "일일 손실 한도 초과 차단");

// 새 RiskManager로 reset
const rm2 = new RiskManager({ totalCapital: 100000 });
for (let i = 0; i < 8; i++) rm2.recordTrade({ pnlKrw: 100, isLoss: false });
let r4 = rm2.checkEntry({ strategy: "A", budgetKrw: 30000, currentPositions: {} });
assert(!r4.allowed && /daily_trades/.test(r4.reason), "일일 거래 8회 한도 차단");

// 연속 손실 차단
const rm3 = new RiskManager({ totalCapital: 100000 });
for (let i = 0; i < 3; i++) rm3.recordTrade({ pnlKrw: -50, isLoss: true });
let r5 = rm3.checkEntry({ strategy: "A", budgetKrw: 30000, currentPositions: {} });
assert(!r5.allowed && /consec_losses/.test(r5.reason), "연속 손실 3회 차단");

rm.close(); rm2.close(); rm3.close();

// ── Indicators (sanity) ─────────────────────────────
console.log("\n[lib/indicators]");
const indicators = require(path.join(ROOT, "lib/indicators"));

const closes = [10, 11, 12, 11, 13, 14, 13, 15, 16, 15, 17, 18, 19, 20, 21];
const sma5 = indicators.sma(closes, 5);
approx(sma5, (17 + 18 + 19 + 20 + 21) / 5, 0.01, "SMA(5) 정확");

eq(indicators.sma([1], 5), null, "데이터 부족 시 null");

const ema5 = indicators.ema(closes, 5);
assert(ema5 > 0 && ema5 < 25, "EMA(5) 합리적 범위");

// ── 결과 ────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════");
console.log(`  PASS: ${pass}  /  FAIL: ${fail}`);
if (fail > 0) {
  console.log(`  실패 항목:`);
  failures.forEach(f => console.log(`    - ${f}`));
}
console.log("══════════════════════════════════════════════\n");
process.exit(fail > 0 ? 1 : 0);
