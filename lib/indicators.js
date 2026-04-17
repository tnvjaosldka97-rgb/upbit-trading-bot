"use strict";

/**
 * lib/indicators.js — 공용 기술적 지표 함수
 *
 * 순수 함수만 포함 (side-effect 없음).
 * strategy-a.js에서 추출.
 */

function sma(arr, n) {
  if (!arr || arr.length < n) return null;
  return arr.slice(-n).reduce((s, v) => s + v, 0) / n;
}

function ema(arr, n) {
  if (!arr || arr.length < n) return null;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function emaArr(arr, n) {
  if (!arr || arr.length < n) return null;
  const k = 2 / (n + 1);
  const out = [];
  let e = arr.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out.push(e);
  for (let i = n; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
  return out;
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

function macd(closes, fast = 12, slow = 26, sig = 9) {
  if (closes.length < slow + sig + 2) return null;
  const emaF = emaArr(closes, fast);
  const emaS = emaArr(closes, slow);
  if (!emaF || !emaS) return null;
  const offset   = emaF.length - emaS.length;
  const macdLine = emaS.map((s, i) => emaF[offset + i] - s);
  const sigArr   = emaArr(macdLine, sig);
  if (!sigArr || sigArr.length < 2) return null;
  const n = macdLine.length, sn = sigArr.length;
  return {
    histogram:     macdLine[n - 1] - sigArr[sn - 1],
    prevHistogram: macdLine[n - 2] - sigArr[sn - 2],
  };
}

function bollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper:  mean + std * mult,
    middle: mean,
    lower:  mean - std * mult,
    width:  (std * mult * 2) / mean,
  };
}

function atr(highs, lows, closes, period) {
  if (highs.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

module.exports = { sma, ema, emaArr, rsi, macd, bollingerBands, atr, mean };
