"use strict";

/**
 * Gate.io Adapter — Gate.io API v4 (USDT 마켓)
 * https://www.gate.com/docs/developers/apiv4/en/
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

class GateAdapter {
  constructor(config = {}) {
    this._apiKey    = config.apiKey    || "";
    this._secretKey = config.secretKey || "";
    this._base      = "https://api.gateio.ws/api/v4";

    this._requestTimes = [];
    this._maxReqPerSec = 10;
  }

  get name()          { return "Gate"; }
  get quoteCurrency() { return "USDT"; }

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

  // ── HMAC-SHA512 서명 (Gate.io v4) ──────────────────────────
  _sign(method, path, queryString = "", body = "") {
    const ts = Math.floor(Date.now() / 1000).toString();
    const bodyHash = crypto.createHash("sha512").update(body).digest("hex");
    const signStr = `${method}\n${path}\n${queryString}\n${bodyHash}\n${ts}`;
    const signature = crypto.createHmac("sha512", this._secretKey)
      .update(signStr).digest("hex");
    return {
      "KEY":       this._apiKey,
      "SIGN":      signature,
      "Timestamp": ts,
    };
  }

  async _fetch(url, opts = {}) {
    await this._rateLimit();
    return fetchJSON(url, opts);
  }

  // ── 마켓 데이터 ───────────────────────────────────────────

  async getMarkets() {
    const data = await this._fetch(`${this._base}/spot/currency_pairs`);
    return data
      .filter(s => s.trade_status === "tradable" && s.quote === "USDT")
      .map(s => ({
        symbol:   s.id,          // "BTC_USDT"
        base:     s.base,
        quote:    "USDT",
        exchange: "gate",
      }));
  }

  async getTicker(symbol) {
    const pair = this._toPair(symbol);
    const data = await this._fetch(
      `${this._base}/spot/tickers?currency_pair=${pair}`
    );
    const t = Array.isArray(data) ? data[0] : data;
    return {
      price:     parseFloat(t.last),
      volume24h: parseFloat(t.quote_volume),
      change24h: parseFloat(t.change_percentage),
    };
  }

  async getOrderbook(symbol, depth = 10) {
    const pair = this._toPair(symbol);
    const data = await this._fetch(
      `${this._base}/spot/order_book?currency_pair=${pair}&limit=${depth}`
    );
    return {
      bids: (data.bids || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      asks: (data.asks || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    };
  }

  async getRecentTrades(symbol, limit = 100) {
    const pair = this._toPair(symbol);
    const data = await this._fetch(
      `${this._base}/spot/trades?currency_pair=${pair}&limit=${limit}`
    );
    return data.map(t => ({
      price: parseFloat(t.price),
      qty:   parseFloat(t.amount),
      side:  t.side,
      time:  parseInt(t.create_time_ms) || parseInt(t.create_time) * 1000,
    }));
  }

  async getCandles(symbol, interval = "1h", limit = 50) {
    const pair = this._toPair(symbol);
    const intv = this._toGateInterval(interval);
    const data = await this._fetch(
      `${this._base}/spot/candlesticks?currency_pair=${pair}&interval=${intv}&limit=${limit}`
    );
    return data.map(c => ({
      time:   parseInt(c[0]) * 1000,
      volume: parseFloat(c[1]),
      close:  parseFloat(c[2]),
      high:   parseFloat(c[3]),
      low:    parseFloat(c[4]),
      open:   parseFloat(c[5]),
    }));
  }

  // ── 거래 ──────────────────────────────────────────────────

  async getBalance(asset) {
    if (!this._apiKey || !this._secretKey) return null;
    const path = "/api/v4/spot/accounts";
    const headers = this._sign("GET", path);
    const data = await this._fetch(`https://api.gateio.ws${path}`, { headers });
    const found = data.find(a => a.currency === asset.toUpperCase());
    return found ? parseFloat(found.available) : 0;
  }

  async getBalances() {
    if (!this._apiKey || !this._secretKey) return new Map();
    const path = "/api/v4/spot/accounts";
    const headers = this._sign("GET", path);
    const data = await this._fetch(`https://api.gateio.ws${path}`, { headers });
    const map = new Map();
    for (const a of data) {
      const free   = parseFloat(a.available);
      const locked = parseFloat(a.locked);
      if (free > 0 || locked > 0) {
        map.set(a.currency, { free, locked });
      }
    }
    return map;
  }

  async marketBuy(symbol, quoteQty) {
    const pair = this._toPair(symbol);
    const body = JSON.stringify({
      currency_pair: pair,
      type:         "market",
      side:         "buy",
      amount:       String(quoteQty),  // quote amount for market buy
      time_in_force: "ioc",
    });
    const path = "/api/v4/spot/orders";
    const headers = this._sign("POST", path, "", body);
    headers["Content-Type"] = "application/json";
    const data = await this._fetch(`https://api.gateio.ws${path}`, {
      method: "POST", headers, body,
    });
    return { orderId: data.id, avgPrice: null, filledQty: null };
  }

  async marketSell(symbol, baseQty) {
    const pair = this._toPair(symbol);
    const body = JSON.stringify({
      currency_pair: pair,
      type:         "market",
      side:         "sell",
      amount:       String(baseQty),
      time_in_force: "ioc",
    });
    const path = "/api/v4/spot/orders";
    const headers = this._sign("POST", path, "", body);
    headers["Content-Type"] = "application/json";
    const data = await this._fetch(`https://api.gateio.ws${path}`, {
      method: "POST", headers, body,
    });
    return { orderId: data.id, avgPrice: null, filledQty: null };
  }

  async limitBuy(symbol, qty, price) {
    const pair = this._toPair(symbol);
    const body = JSON.stringify({
      currency_pair: pair,
      type:    "limit",
      side:    "buy",
      amount:  String(qty),
      price:   String(price),
    });
    const path = "/api/v4/spot/orders";
    const headers = this._sign("POST", path, "", body);
    headers["Content-Type"] = "application/json";
    const data = await this._fetch(`https://api.gateio.ws${path}`, {
      method: "POST", headers, body,
    });
    return { orderId: data.id };
  }

  async limitSell(symbol, qty, price) {
    const pair = this._toPair(symbol);
    const body = JSON.stringify({
      currency_pair: pair,
      type:    "limit",
      side:    "sell",
      amount:  String(qty),
      price:   String(price),
    });
    const path = "/api/v4/spot/orders";
    const headers = this._sign("POST", path, "", body);
    headers["Content-Type"] = "application/json";
    const data = await this._fetch(`https://api.gateio.ws${path}`, {
      method: "POST", headers, body,
    });
    return { orderId: data.id };
  }

  async cancelOrder(orderId, symbol) {
    const pair = this._toPair(symbol);
    const path = `/api/v4/spot/orders/${orderId}`;
    const qs = `currency_pair=${pair}`;
    const headers = this._sign("DELETE", path, qs);
    try {
      await this._fetch(`https://api.gateio.ws${path}?${qs}`, {
        method: "DELETE", headers,
      });
      return true;
    } catch { return false; }
  }

  async getOpenOrders(symbol) {
    if (!this._apiKey || !this._secretKey) return [];
    const pair = this._toPair(symbol);
    const path = "/api/v4/spot/orders";
    const qs = `currency_pair=${pair}&status=open`;
    const headers = this._sign("GET", path, qs);
    const data = await this._fetch(`https://api.gateio.ws${path}?${qs}`, { headers });
    return data.map(o => ({
      orderId: o.id,
      side:    o.side,
      price:   parseFloat(o.price),
      qty:     parseFloat(o.amount),
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
  _toPair(symbol) {
    if (symbol.includes("_")) return symbol;
    if (symbol.includes("-")) {
      const parts = symbol.split("-");
      return parts.length === 2 && parts[0] === "KRW"
        ? `${parts[1]}_USDT`
        : `${parts[0]}_${parts[1]}`;
    }
    if (symbol.includes("USDT")) return symbol.replace("USDT", "_USDT");
    return `${symbol.toUpperCase()}_USDT`;
  }

  _toGateInterval(interval) {
    if (typeof interval === "number") {
      const map = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h" };
      return map[interval] || "1h";
    }
    return interval;
  }
}

module.exports = { GateAdapter };
