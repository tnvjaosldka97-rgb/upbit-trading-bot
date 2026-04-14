"use strict";

/**
 * OKX Adapter — OKX v5 API (USDT 마켓)
 * https://www.okx.com/docs-v5/en/
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

class OKXAdapter {
  constructor(config = {}) {
    this._apiKey     = config.apiKey    || "";
    this._secretKey  = config.secretKey || "";
    this._passphrase = config.passphrase || "";
    this._base       = config.testnet
      ? "https://www.okx.com"  // OKX demo trading uses same base with header
      : "https://www.okx.com";
    this._simulated  = config.testnet || false;

    this._requestTimes = [];
    this._maxReqPerSec = 10;
  }

  get name()          { return "OKX"; }
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

  // ── 서명 (HMAC-SHA256 + Base64) ─────────────────────────────
  _sign(timestamp, method, path, body = "") {
    const prehash = `${timestamp}${method}${path}${body}`;
    return crypto.createHmac("sha256", this._secretKey)
      .update(prehash)
      .digest("base64");
  }

  _authHeaders(method, path, body = "") {
    if (!this._apiKey || !this._secretKey) return null;
    const ts = new Date().toISOString();
    const sign = this._sign(ts, method, path, body);
    const headers = {
      "OK-ACCESS-KEY":        this._apiKey,
      "OK-ACCESS-SIGN":       sign,
      "OK-ACCESS-TIMESTAMP":  ts,
      "OK-ACCESS-PASSPHRASE": this._passphrase,
    };
    if (this._simulated) headers["x-simulated-trading"] = "1";
    return headers;
  }

  async _fetch(url, opts = {}) {
    await this._rateLimit();
    return fetchJSON(url, opts);
  }

  async _v5Fetch(url, opts = {}) {
    const data = await this._fetch(url, opts);
    if (data.code !== "0") {
      throw new Error(`OKX: ${data.msg || "Unknown error"} (code ${data.code})`);
    }
    return data.data;
  }

  // ── 마켓 데이터 ───────────────────────────────────────────

  async getMarkets() {
    const data = await this._v5Fetch(
      `${this._base}/api/v5/public/instruments?instType=SPOT`
    );
    return data
      .filter(s => s.state === "live" && s.quoteCcy === "USDT")
      .map(s => ({
        symbol:   s.instId,         // "BTC-USDT"
        base:     s.baseCcy,
        quote:    "USDT",
        exchange: "okx",
      }));
  }

  async getTicker(symbol) {
    const instId = this._toInstId(symbol);
    const data = await this._v5Fetch(
      `${this._base}/api/v5/market/ticker?instId=${instId}`
    );
    const t = data[0];
    return {
      price:     parseFloat(t.last),
      volume24h: parseFloat(t.volCcy24h),
      change24h: parseFloat(t.last) / parseFloat(t.open24h) * 100 - 100,
    };
  }

  async getOrderbook(symbol, depth = 10) {
    const instId = this._toInstId(symbol);
    const data = await this._v5Fetch(
      `${this._base}/api/v5/market/books?instId=${instId}&sz=${depth}`
    );
    const book = data[0];
    return {
      bids: (book.bids || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      asks: (book.asks || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    };
  }

  async getRecentTrades(symbol, limit = 100) {
    const instId = this._toInstId(symbol);
    const data = await this._v5Fetch(
      `${this._base}/api/v5/market/trades?instId=${instId}&limit=${limit}`
    );
    return data.map(t => ({
      price: parseFloat(t.px),
      qty:   parseFloat(t.sz),
      side:  t.side,
      time:  parseInt(t.ts),
    }));
  }

  async getCandles(symbol, interval = "1H", limit = 50) {
    const instId = this._toInstId(symbol);
    const bar = this._toOKXInterval(interval);
    const data = await this._v5Fetch(
      `${this._base}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`
    );
    return data.reverse().map(c => ({
      time:   parseInt(c[0]),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }

  // ── 거래 ──────────────────────────────────────────────────

  async getBalance(asset) {
    const path = "/api/v5/account/balance";
    const headers = this._authHeaders("GET", path);
    if (!headers) return null;
    const data = await this._v5Fetch(`${this._base}${path}`, { headers });
    const account = data[0];
    const coin = account?.details?.find(d => d.ccy === asset.toUpperCase());
    return coin ? parseFloat(coin.availBal) : 0;
  }

  async getBalances() {
    const path = "/api/v5/account/balance";
    const headers = this._authHeaders("GET", path);
    if (!headers) return new Map();
    const data = await this._v5Fetch(`${this._base}${path}`, { headers });
    const map = new Map();
    const details = data[0]?.details || [];
    for (const d of details) {
      const free   = parseFloat(d.availBal);
      const locked = parseFloat(d.frozenBal);
      if (free > 0 || locked > 0) {
        map.set(d.ccy, { free, locked });
      }
    }
    return map;
  }

  async marketBuy(symbol, quoteQty) {
    const instId = this._toInstId(symbol);
    const body = JSON.stringify({
      instId,
      tdMode: "cash",
      side:   "buy",
      ordType: "market",
      sz:     String(quoteQty),
      tgtCcy: "quote_ccy",
    });
    const path = "/api/v5/trade/order";
    const headers = this._authHeaders("POST", path, body);
    if (!headers) return null;
    headers["Content-Type"] = "application/json";
    const data = await this._v5Fetch(`${this._base}${path}`, {
      method: "POST", headers, body,
    });
    return { orderId: data[0]?.ordId, avgPrice: null, filledQty: null };
  }

  async marketSell(symbol, baseQty) {
    const instId = this._toInstId(symbol);
    const body = JSON.stringify({
      instId,
      tdMode: "cash",
      side:   "sell",
      ordType: "market",
      sz:     String(baseQty),
      tgtCcy: "base_ccy",
    });
    const path = "/api/v5/trade/order";
    const headers = this._authHeaders("POST", path, body);
    if (!headers) return null;
    headers["Content-Type"] = "application/json";
    const data = await this._v5Fetch(`${this._base}${path}`, {
      method: "POST", headers, body,
    });
    return { orderId: data[0]?.ordId, avgPrice: null, filledQty: null };
  }

  async limitBuy(symbol, qty, price) {
    const instId = this._toInstId(symbol);
    const body = JSON.stringify({
      instId, tdMode: "cash", side: "buy", ordType: "limit",
      sz: String(qty), px: String(price),
    });
    const path = "/api/v5/trade/order";
    const headers = this._authHeaders("POST", path, body);
    if (!headers) return null;
    headers["Content-Type"] = "application/json";
    const data = await this._v5Fetch(`${this._base}${path}`, {
      method: "POST", headers, body,
    });
    return { orderId: data[0]?.ordId };
  }

  async limitSell(symbol, qty, price) {
    const instId = this._toInstId(symbol);
    const body = JSON.stringify({
      instId, tdMode: "cash", side: "sell", ordType: "limit",
      sz: String(qty), px: String(price),
    });
    const path = "/api/v5/trade/order";
    const headers = this._authHeaders("POST", path, body);
    if (!headers) return null;
    headers["Content-Type"] = "application/json";
    const data = await this._v5Fetch(`${this._base}${path}`, {
      method: "POST", headers, body,
    });
    return { orderId: data[0]?.ordId };
  }

  async cancelOrder(orderId, symbol) {
    const instId = this._toInstId(symbol);
    const body = JSON.stringify({ instId, ordId: orderId });
    const path = "/api/v5/trade/cancel-order";
    const headers = this._authHeaders("POST", path, body);
    if (!headers) return false;
    headers["Content-Type"] = "application/json";
    try {
      await this._v5Fetch(`${this._base}${path}`, {
        method: "POST", headers, body,
      });
      return true;
    } catch { return false; }
  }

  async getOpenOrders(symbol) {
    const instId = this._toInstId(symbol);
    const path = `/api/v5/trade/orders-pending?instType=SPOT&instId=${instId}`;
    const headers = this._authHeaders("GET", path);
    if (!headers) return [];
    const data = await this._v5Fetch(`${this._base}${path}`, { headers });
    return data.map(o => ({
      orderId: o.ordId,
      side:    o.side,
      price:   parseFloat(o.px),
      qty:     parseFloat(o.sz),
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
  _toInstId(symbol) {
    if (symbol.includes("-USDT")) return symbol;
    if (symbol.includes("USDT")) return symbol.replace("USDT", "-USDT");
    if (symbol.includes("-")) return symbol.split("-")[1] + "-USDT";
    return `${symbol.toUpperCase()}-USDT`;
  }

  _toOKXInterval(interval) {
    if (typeof interval === "number") {
      const map = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1H", 240: "4H" };
      return map[interval] || "1H";
    }
    const map = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
    return map[interval?.toLowerCase()] || "1H";
  }
}

module.exports = { OKXAdapter };
