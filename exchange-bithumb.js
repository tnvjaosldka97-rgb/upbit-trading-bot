"use strict";

/**
 * Bithumb Adapter — 빗썸 공개/비공개 API (KRW 마켓)
 * https://apidocs.bithumb.com/
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

class BithumbAdapter {
  constructor(config = {}) {
    this._apiKey    = config.apiKey    || "";
    this._secretKey = config.secretKey || "";
    this._base      = "https://api.bithumb.com";

    this._requestTimes = [];
    this._maxReqPerSec = 15; // 빗썸 API: 초당 15회
  }

  get name()          { return "Bithumb"; }
  get quoteCurrency() { return "KRW"; }

  // ── 레이트 리미팅 ─────────────────────────────────────────
  async _rateLimit() {
    const now = Date.now();
    this._requestTimes = this._requestTimes.filter(t => now - t < 1000);
    if (this._requestTimes.length >= this._maxReqPerSec) {
      const waitMs = 1000 - (now - this._requestTimes[0]) + 10;
      await new Promise(r => setTimeout(r, waitMs));
    }
    this._requestTimes.push(Date.now());
  }

  // ── HMAC-SHA512 서명 (빗썸 방식) ───────────────────────────
  _sign(endpoint, params = {}) {
    const nonce = Date.now().toString();
    const queryString = new URLSearchParams(params).toString();
    const hmacData = `${endpoint}\0${queryString}\0${nonce}`;
    const signature = crypto
      .createHmac("sha512", this._secretKey)
      .update(hmacData)
      .digest("hex");
    return {
      "Api-Key":       this._apiKey,
      "Api-Sign":      Buffer.from(signature).toString("base64"),
      "Api-Nonce":     nonce,
      "Content-Type":  "application/x-www-form-urlencoded",
    };
  }

  async _publicFetch(url) {
    await this._rateLimit();
    const data = await fetchJSON(url);
    if (data.status !== "0000") {
      throw new Error(`Bithumb: ${data.message || "Unknown error"} (${data.status})`);
    }
    return data.data;
  }

  async _privateFetch(endpoint, params = {}) {
    await this._rateLimit();
    if (!this._apiKey || !this._secretKey) return null;
    const headers = this._sign(endpoint, params);
    const body = new URLSearchParams(params).toString();
    const data = await fetchJSON(`${this._base}${endpoint}`, {
      method: "POST",
      headers,
      body,
    });
    if (data.status !== "0000") {
      throw new Error(`Bithumb: ${data.message || "Unknown error"} (${data.status})`);
    }
    return data.data;
  }

  // ── 마켓 데이터 ───────────────────────────────────────────

  async getMarkets() {
    const data = await this._publicFetch(`${this._base}/public/ticker/ALL_KRW`);
    const coins = Object.keys(data).filter(k => k !== "date");
    return coins.map(coin => ({
      symbol:   `${coin}_KRW`,
      base:     coin,
      quote:    "KRW",
      exchange: "bithumb",
    }));
  }

  async getTicker(symbol) {
    const coin = this._toCoin(symbol);
    const data = await this._publicFetch(
      `${this._base}/public/ticker/${coin}_KRW`
    );
    return {
      price:     parseFloat(data.closing_price),
      volume24h: parseFloat(data.acc_trade_value_24H),
      change24h: parseFloat(data.fluctate_rate_24H),
    };
  }

  async getOrderbook(symbol, depth = 10) {
    const coin = this._toCoin(symbol);
    const data = await this._publicFetch(
      `${this._base}/public/orderbook/${coin}_KRW?count=${depth}`
    );
    return {
      bids: (data.bids || []).slice(0, depth).map(b => ({
        price: parseFloat(b.price),
        qty:   parseFloat(b.quantity),
      })),
      asks: (data.asks || []).slice(0, depth).map(a => ({
        price: parseFloat(a.price),
        qty:   parseFloat(a.quantity),
      })),
    };
  }

  async getRecentTrades(symbol, limit = 100) {
    const coin = this._toCoin(symbol);
    const data = await this._publicFetch(
      `${this._base}/public/transaction_history/${coin}_KRW?count=${limit}`
    );
    return (Array.isArray(data) ? data : []).map(t => ({
      price: parseFloat(t.price),
      qty:   parseFloat(t.units_traded),
      side:  t.type === "bid" ? "buy" : "sell",
      time:  new Date(t.transaction_date).getTime(),
    }));
  }

  async getCandles(symbol, interval = "24h", limit = 50) {
    // 빗썸은 캔들 API가 제한적 — ticker로 대체
    const ticker = await this.getTicker(symbol);
    return [{ time: Date.now(), close: ticker.price, volume: 0 }];
  }

  // ── 거래 ──────────────────────────────────────────────────

  async getBalance(asset) {
    const data = await this._privateFetch("/info/balance", {
      currency: asset.toUpperCase(),
    });
    if (!data) return null;
    if (asset.toUpperCase() === "KRW") {
      return parseFloat(data.available_krw) || 0;
    }
    const key = `available_${asset.toLowerCase()}`;
    return parseFloat(data[key]) || 0;
  }

  async getBalances() {
    const data = await this._privateFetch("/info/balance", { currency: "ALL" });
    if (!data) return new Map();
    const map = new Map();
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith("available_")) {
        const asset = key.replace("available_", "").toUpperCase();
        const free = parseFloat(val) || 0;
        if (free > 0) map.set(asset, { free, locked: 0 });
      }
    }
    return map;
  }

  async marketBuy(symbol, quoteQty) {
    const coin = this._toCoin(symbol);
    const data = await this._privateFetch("/trade/market_buy", {
      units:           "0",  // 빗썸 시장가 매수는 KRW 금액 기준
      order_currency:  coin,
      payment_currency: "KRW",
    });
    return { orderId: data?.order_id, avgPrice: null, filledQty: null };
  }

  async marketSell(symbol, baseQty) {
    const coin = this._toCoin(symbol);
    const data = await this._privateFetch("/trade/market_sell", {
      units:           String(baseQty),
      order_currency:  coin,
      payment_currency: "KRW",
    });
    return { orderId: data?.order_id, avgPrice: null, filledQty: null };
  }

  async limitBuy(symbol, qty, price) {
    const coin = this._toCoin(symbol);
    const data = await this._privateFetch("/trade/place", {
      order_currency:  coin,
      payment_currency: "KRW",
      units:           String(qty),
      price:           String(Math.floor(price)),
      type:            "bid",
    });
    return { orderId: data?.order_id };
  }

  async limitSell(symbol, qty, price) {
    const coin = this._toCoin(symbol);
    const data = await this._privateFetch("/trade/place", {
      order_currency:  coin,
      payment_currency: "KRW",
      units:           String(qty),
      price:           String(Math.floor(price)),
      type:            "ask",
    });
    return { orderId: data?.order_id };
  }

  async cancelOrder(orderId, symbol) {
    const coin = this._toCoin(symbol);
    try {
      await this._privateFetch("/trade/cancel", {
        order_id:        orderId,
        type:            "bid",
        order_currency:  coin,
        payment_currency: "KRW",
      });
      return true;
    } catch { return false; }
  }

  async getOpenOrders(symbol) {
    const coin = this._toCoin(symbol);
    const data = await this._privateFetch("/info/orders", {
      order_currency:  coin,
      payment_currency: "KRW",
    });
    if (!data || !Array.isArray(data)) return [];
    return data.map(o => ({
      orderId: o.order_id,
      side:    o.type === "bid" ? "buy" : "sell",
      price:   parseFloat(o.price),
      qty:     parseFloat(o.units),
    }));
  }

  async getNewListings(knownSymbols) {
    const markets = await this.getMarkets();
    const now = Date.now();
    return markets
      .filter(m => !knownSymbols.has(m.symbol))
      .map(m => ({ symbol: m.symbol, base: m.base, listedAt: now }));
  }

  // ── 내부 유틸 ─────────────────────────────────────────────
  _toCoin(symbol) {
    if (symbol.includes("_")) return symbol.split("_")[0].toUpperCase();
    if (symbol.includes("-")) return symbol.split("-")[1].toUpperCase();
    return symbol.toUpperCase();
  }
}

module.exports = { BithumbAdapter };
