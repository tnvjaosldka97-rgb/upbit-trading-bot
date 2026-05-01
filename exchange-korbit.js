"use strict";

/**
 * Korbit Adapter — 코빗 공개 API (KRW 마켓)
 * https://apidocs.korbit.co.kr/
 *
 * 공개 엔드포인트만 (KYC + key 없이도 ticker/orderbook 조회 가능):
 *   GET /v1/ticker/detailed/all  — 전체 마켓 ticker
 *   GET /v1/ticker/detailed?currency_pair=btc_krw — 단일 ticker
 *   GET /v1/orderbook?currency_pair=btc_krw — 호가창
 *
 * Private API는 추후 KYC + key 발급 시 추가.
 */

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

class KorbitAdapter {
  constructor(config = {}) {
    this._apiKey    = config.apiKey    || "";
    this._secretKey = config.secretKey || "";
    this._base      = "https://api.korbit.co.kr";

    this._requestTimes = [];
    this._maxReqPerSec = 10;
  }

  get name()          { return "Korbit"; }
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

  /**
   * 입력: "BTC", "KRW-BTC", "BTC/KRW" → "btc_krw" (Korbit 형식)
   */
  _toPair(symbol) {
    if (!symbol) return "";
    const s = symbol.toUpperCase();
    if (s.includes("_")) return s.toLowerCase();
    if (s.startsWith("KRW-")) return `${s.slice(4).toLowerCase()}_krw`;
    if (s.includes("/")) return `${s.split("/")[0].toLowerCase()}_krw`;
    return `${s.toLowerCase()}_krw`;
  }

  /**
   * 마켓 목록 — 전체 KRW 마켓
   * GET /v1/ticker/detailed/all
   */
  async getMarkets() {
    const data = await this._publicFetch(
      `${this._base}/v1/ticker/detailed/all`
    );
    // data: { btc_krw: { last, ... }, eth_krw: { ... }, ... }
    if (!data || typeof data !== "object") return [];
    return Object.keys(data)
      .filter(k => k.endsWith("_krw"))
      .map(k => {
        const base = k.replace("_krw", "").toUpperCase();
        return {
          symbol:   `${base}/KRW`,
          base,
          quote:    "KRW",
          exchange: "korbit",
        };
      });
  }

  /**
   * 단일 ticker
   * GET /v1/ticker/detailed?currency_pair=btc_krw
   */
  async getTicker(symbol) {
    const pair = this._toPair(symbol);
    const data = await this._publicFetch(
      `${this._base}/v1/ticker/detailed?currency_pair=${pair}`
    );
    if (!data || !data.last) {
      throw new Error(`Korbit ticker empty for ${pair}`);
    }
    return {
      price:     parseFloat(data.last),
      volume24h: parseFloat(data.volume) || 0,
      change24h: parseFloat(data.changeRate) || 0,
      high24h:   parseFloat(data.high)   || 0,
      low24h:    parseFloat(data.low)    || 0,
      bestBid:   parseFloat(data.bid)    || parseFloat(data.last),
      bestAsk:   parseFloat(data.ask)    || parseFloat(data.last),
    };
  }

  /**
   * 호가창
   * GET /v1/orderbook?currency_pair=btc_krw
   */
  async getOrderbook(symbol, depth = 15) {
    const pair = this._toPair(symbol);
    const data = await this._publicFetch(
      `${this._base}/v1/orderbook?currency_pair=${pair}`
    );
    return {
      bids: (data.bids || []).slice(0, depth).map(b => ({
        price: parseFloat(b[0]),
        qty:   parseFloat(b[1]),
      })),
      asks: (data.asks || []).slice(0, depth).map(a => ({
        price: parseFloat(a[0]),
        qty:   parseFloat(a[1]),
      })),
    };
  }

  // Private API placeholder
  async getBalance()    { throw new Error("Korbit private API not implemented"); }
  async marketBuy()     { throw new Error("Korbit trading not implemented"); }
  async marketSell()    { throw new Error("Korbit trading not implemented"); }
  async limitBuy()      { throw new Error("Korbit trading not implemented"); }
  async limitSell()     { throw new Error("Korbit trading not implemented"); }
}

module.exports = { KorbitAdapter };
