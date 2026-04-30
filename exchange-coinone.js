"use strict";

/**
 * Coinone Adapter — 코인원 공개 API (KRW 마켓)
 * https://docs.coinone.co.kr/
 *
 * 현재 공개(인증 불필요) 엔드포인트만 사용:
 *   - getMarkets()
 *   - getTicker(symbol)
 *   - getOrderbook(symbol, depth)
 *
 * Private API(주문/잔고)는 추후 KYC 후 키 발급 시 추가.
 */

const crypto = require("crypto");

async function fetchJSON(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 5000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

class CoinoneAdapter {
  constructor(config = {}) {
    this._apiKey    = config.apiKey    || "";
    this._secretKey = config.secretKey || "";
    this._base      = "https://api.coinone.co.kr";

    this._requestTimes = [];
    this._maxReqPerSec = 10; // 코인원 공개 API: 초당 10회 보수적
  }

  get name()          { return "Coinone"; }
  get quoteCurrency() { return "KRW"; }

  async _rateLimit() {
    const now = Date.now();
    this._requestTimes = this._requestTimes.filter(t => now - t < 1000);
    if (this._requestTimes.length >= this._maxReqPerSec) {
      const waitMs = 1000 - (now - this._requestTimes[0]) + 10;
      await new Promise(r => setTimeout(r, waitMs));
    }
    this._requestTimes.push(Date.now());
  }

  async _publicFetch(url) {
    await this._rateLimit();
    return fetchJSON(url);
  }

  // ── 심볼 정규화 ────────────────────────────────────────────
  // 입력: "BTC", "KRW-BTC", "BTC/KRW" → "BTC" (target currency)
  _toCoin(symbol) {
    if (!symbol) return "";
    const s = symbol.toUpperCase();
    if (s.startsWith("KRW-")) return s.slice(4);
    if (s.includes("/"))      return s.split("/")[0];
    return s;
  }

  // ── 공개 API ──────────────────────────────────────────────

  /**
   * 거래중인 마켓 목록 (KRW 마켓만)
   * 코인원은 ticker_new 응답으로 전체 마켓 한 번에 조회
   */
  async getMarkets() {
    const data = await this._publicFetch(
      `${this._base}/public/v2/ticker_new/KRW`
    );
    const tickers = data?.tickers || [];
    return tickers.map(t => ({
      symbol:   `${(t.target_currency || "").toUpperCase()}/KRW`,
      base:     (t.target_currency || "").toUpperCase(),
      quote:    "KRW",
      exchange: "coinone",
    }));
  }

  /**
   * 단일 코인 ticker
   * GET /public/v2/ticker_new/KRW/{coin}
   */
  async getTicker(symbol) {
    const coin = this._toCoin(symbol);
    const data = await this._publicFetch(
      `${this._base}/public/v2/ticker_new/KRW/${coin}`
    );
    const t = data?.tickers?.[0];
    if (!t) {
      throw new Error(`Coinone ticker empty for ${coin}`);
    }
    return {
      price:     parseFloat(t.last),
      volume24h: parseFloat(t.quote_volume) || 0,
      change24h: parseFloat(t.yesterday_last) > 0
        ? (parseFloat(t.last) - parseFloat(t.yesterday_last)) / parseFloat(t.yesterday_last)
        : 0,
      high24h:   parseFloat(t.high) || 0,
      low24h:    parseFloat(t.low)  || 0,
      bestBid:   parseFloat(t.best_bids?.[0]?.price) || parseFloat(t.last),
      bestAsk:   parseFloat(t.best_asks?.[0]?.price) || parseFloat(t.last),
    };
  }

  /**
   * 호가창
   * GET /public/v2/orderbook/KRW/{coin}
   */
  async getOrderbook(symbol, depth = 15) {
    const coin = this._toCoin(symbol);
    const data = await this._publicFetch(
      `${this._base}/public/v2/orderbook/KRW/${coin}?size=${depth}`
    );
    return {
      bids: (data.bids || []).slice(0, depth).map(b => ({
        price: parseFloat(b.price),
        qty:   parseFloat(b.qty),
      })),
      asks: (data.asks || []).slice(0, depth).map(a => ({
        price: parseFloat(a.price),
        qty:   parseFloat(a.qty),
      })),
    };
  }

  // ── Private API 자리 (추후 키 발급 시 활성) ────────────
  async getBalance(asset) {
    throw new Error("Coinone private API not implemented yet (KYC + key needed)");
  }
  async marketBuy()  { throw new Error("Coinone trading not implemented"); }
  async marketSell() { throw new Error("Coinone trading not implemented"); }
  async limitBuy()   { throw new Error("Coinone trading not implemented"); }
  async limitSell()  { throw new Error("Coinone trading not implemented"); }
}

module.exports = { CoinoneAdapter };
