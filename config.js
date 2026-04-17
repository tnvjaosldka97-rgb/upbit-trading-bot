"use strict";

/**
 * config.js — 환경변수 기반 설정 (기본값 = 현재 하드코딩 값)
 *
 * 배포 환경에서 env var로 오버라이드 가능.
 * 모든 기본값은 기존 동작과 동일하게 유지.
 */

const env = (key, fallback) => process.env[key] ?? fallback;
const num = (key, fallback) => Number(process.env[key] ?? fallback);

module.exports = Object.freeze({
  // ─── FX ────────────────────────────────────────────
  DEFAULT_USD_KRW: num("DEFAULT_USD_KRW", 1400),

  // ─── Strategy A (1h Swing BTC) ─────────────────────
  A_MARKET:          env("A_MARKET", "KRW-BTC"),
  A_RSI_OVERSOLD:    num("A_RSI_OVERSOLD", 35),
  A_RSI_OVERBOUGHT:  num("A_RSI_OVERBOUGHT", 70),
  A_ENTRY_THRESHOLD: num("A_ENTRY_THRESHOLD", 40),
  A_DEFAULT_TARGET:  num("A_DEFAULT_TARGET", 0.035),
  A_DEFAULT_STOP:    num("A_DEFAULT_STOP", -0.015),
  A_PARTIAL_RATE:    num("A_PARTIAL_RATE", 0.020),
  A_ATR_TRAIL_MULT:  num("A_ATR_TRAIL_MULT", 2.0),
  A_MAX_HOLD_MS:     num("A_MAX_HOLD_MS", 12 * 60 * 60_000),
  A_COOLDOWN_MS:     num("A_COOLDOWN_MS", 2 * 60 * 60_000),

  // ─── Strategy B (New Listing) ──────────────────────
  B_SCAN_INTERVAL_MS:   num("B_SCAN_INTERVAL_MS", 30_000),
  B_MANAGE_INTERVAL_MS: num("B_MANAGE_INTERVAL_MS", 20_000),
  B_TARGET_RATE:        num("B_TARGET_RATE", 0.30),
  B_PARTIAL_AT:         num("B_PARTIAL_AT", 0.15),
  B_STOP_RATE:          num("B_STOP_RATE", -0.08),
  B_TRAIL_PCT:          num("B_TRAIL_PCT", 0.15),
  B_MAX_HOLD_MS:        num("B_MAX_HOLD_MS", 2 * 60 * 60_000),
  B_BUDGET_PCT:         num("B_BUDGET_PCT", 0.10),
  B_MAX_LISTING_AGE_MS: num("B_MAX_LISTING_AGE_MS", 24 * 60 * 60_000),
  B_MIN_VOLUME_SPIKE:   num("B_MIN_VOLUME_SPIKE", 3.0),
  B_MIN_PRICE_MOVE:     num("B_MIN_PRICE_MOVE", 0.05),

  // ─── Cross-Exchange Arb ────────────────────────────
  ARB_FEE_UPBIT:   num("ARB_FEE_UPBIT",   0.0005),
  ARB_FEE_BINANCE: num("ARB_FEE_BINANCE", 0.001),
  ARB_FEE_BYBIT:   num("ARB_FEE_BYBIT",   0.001),
  ARB_FEE_OKX:     num("ARB_FEE_OKX",     0.001),
  ARB_FEE_GATE:    num("ARB_FEE_GATE",    0.002),
  ARB_FEE_BITHUMB: num("ARB_FEE_BITHUMB", 0.0004),
  ARB_REST_POLL_INTERVAL_MS: num("ARB_REST_POLL_INTERVAL_MS", 15_000),
  ARB_MAX_TS_SKEW_MS:        num("ARB_MAX_TS_SKEW_MS", 2_000),
  ARB_DEDUP_BUCKET_PCT:      num("ARB_DEDUP_BUCKET_PCT", 0.01),
  ARB_DEDUP_WINDOW_MS:       num("ARB_DEDUP_WINDOW_MS", 60_000),
  ARB_LIVE_TTL_MS:           num("ARB_LIVE_TTL_MS", 60_000),
  ARB_PRUNE_INTERVAL_MS:     num("ARB_PRUNE_INTERVAL_MS", 30_000),
});
