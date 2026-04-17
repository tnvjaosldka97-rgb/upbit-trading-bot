"use strict";

/**
 * Exchange Adapter — 글로벌 거래소 추상화 레이어
 *
 * 지원 거래소:
 *   - Upbit (KRW 마켓)
 *   - Binance (USDT 마켓)
 *   - Bybit (USDT 마켓)
 *
 * 모든 어댑터는 동일한 인터페이스를 제공하여
 * 전략 코드가 거래소에 의존하지 않도록 함.
 */

const crypto = require("crypto");

// Upbit 인증용 (package.json에 이미 포함)
let jwt, uuidv4;
try { jwt = require("jsonwebtoken"); } catch {}
try { uuidv4 = require("uuid").v4; } catch {}

// ── 공통 fetch 래퍼 (타임아웃 + 에러 처리) ─────────────────
async function safeFetch(url, opts = {}) {
  const timeout = opts.timeout || 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url, opts = {}) {
  const res = await safeFetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════════════
//  Upbit Adapter — 업비트 (KRW 마켓)
// ═══════════════════════════════════════════════════════════════
class UpbitAdapter {
  constructor(config = {}) {
    this._apiKey    = config.apiKey    || "";
    this._secretKey = config.secretKey || "";
    this._base      = "https://api.upbit.com";
  }

  get name()          { return "Upbit"; }
  get quoteCurrency() { return "KRW"; }

  // ── JWT 인증 헤더 생성 ──────────────────────────────────
  _authHeader(query = "") {
    if (!this._apiKey || !this._secretKey || !jwt || !uuidv4) return null;
    const payload = {
      access_key: this._apiKey,
      nonce:      uuidv4(),
    };
    if (query) {
      const queryHash = crypto.createHash("sha512").update(query, "utf-8").digest("hex");
      payload.query_hash     = queryHash;
      payload.query_hash_alg = "SHA512";
    }
    const token = jwt.sign(payload, this._secretKey);
    return { Authorization: `Bearer ${token}` };
  }

  // ── 마켓 데이터 (인증 불필요) ─────────────────────────────

  async getMarkets() {
    const data = await fetchJSON(`${this._base}/v1/market/all?isDetails=false`);
    return data
      .filter(m => m.market.startsWith("KRW-"))
      .map(m => ({
        symbol:   m.market,
        base:     m.market.split("-")[1],
        quote:    "KRW",
        exchange: "upbit",
      }));
  }

  async getTicker(symbol) {
    const market = this._toMarket(symbol);
    const data = await fetchJSON(`${this._base}/v1/ticker?markets=${market}`);
    const t = data[0];
    return {
      price:     t.trade_price,
      volume24h: t.acc_trade_price_24h,
      change24h: t.signed_change_rate * 100,
    };
  }

  async getOrderbook(symbol, depth = 10) {
    const market = this._toMarket(symbol);
    const data = await fetchJSON(`${this._base}/v1/orderbook?markets=${market}`);
    const units = (data[0]?.orderbook_units || []).slice(0, depth);
    return {
      bids: units.map(u => ({ price: u.bid_price, qty: u.bid_size })),
      asks: units.map(u => ({ price: u.ask_price, qty: u.ask_size })),
    };
  }

  async getRecentTrades(symbol, limit = 100) {
    const market = this._toMarket(symbol);
    const data = await fetchJSON(`${this._base}/v1/trades/ticks?market=${market}&count=${limit}`);
    return data.map(t => ({
      price: t.trade_price,
      qty:   t.trade_volume,
      side:  t.ask_bid === "BID" ? "buy" : "sell",
      time:  new Date(`${t.trade_date_utc}T${t.trade_time_utc}Z`).getTime(),
    }));
  }

  async getCandles(symbol, interval = 60, limit = 50) {
    const market = this._toMarket(symbol);
    // interval: 분 단위 (1, 3, 5, 15, 30, 60, 240)
    const mins = this._toUpbitInterval(interval);
    const data = await fetchJSON(
      `${this._base}/v1/candles/minutes/${mins}?market=${market}&count=${limit}`
    );
    return data.reverse().map(c => ({
      time:   new Date(c.candle_date_time_utc + "Z").getTime(),
      open:   c.opening_price,
      high:   c.high_price,
      low:    c.low_price,
      close:  c.trade_price,
      volume: c.candle_acc_trade_volume,
    }));
  }

  // ── 거래 (인증 필요) ──────────────────────────────────────

  async getBalance(asset) {
    const auth = this._authHeader();
    if (!auth) return null;
    const data = await fetchJSON(`${this._base}/v1/accounts`, { headers: auth });
    if (asset === "KRW") {
      const krw = data.find(a => a.currency === "KRW");
      return krw ? parseFloat(krw.balance) : 0;
    }
    const found = data.find(a => a.currency === asset.toUpperCase());
    return found ? parseFloat(found.balance) : 0;
  }

  async getBalances() {
    const auth = this._authHeader();
    if (!auth) return new Map();
    const data = await fetchJSON(`${this._base}/v1/accounts`, { headers: auth });
    const map = new Map();
    for (const a of data) {
      map.set(a.currency, {
        free:   parseFloat(a.balance),
        locked: parseFloat(a.locked),
      });
    }
    return map;
  }

  async marketBuy(symbol, quoteQty) {
    const market = this._toMarket(symbol);
    const body = `market=${market}&side=bid&ord_type=price&price=${Math.floor(quoteQty)}`;
    const auth = this._authHeader(body);
    if (!auth) return null;
    const data = await fetchJSON(`${this._base}/v1/orders`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return { orderId: data.uuid, avgPrice: null, filledQty: null };
  }

  async marketSell(symbol, baseQty) {
    const market = this._toMarket(symbol);
    const body = `market=${market}&side=ask&ord_type=market&volume=${baseQty}`;
    const auth = this._authHeader(body);
    if (!auth) return null;
    const data = await fetchJSON(`${this._base}/v1/orders`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return { orderId: data.uuid, avgPrice: null, filledQty: null };
  }

  async limitBuy(symbol, qty, price) {
    const market = this._toMarket(symbol);
    const body = `market=${market}&side=bid&ord_type=limit&volume=${qty}&price=${price}`;
    const auth = this._authHeader(body);
    if (!auth) return null;
    const data = await fetchJSON(`${this._base}/v1/orders`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return { orderId: data.uuid };
  }

  async limitSell(symbol, qty, price) {
    const market = this._toMarket(symbol);
    const body = `market=${market}&side=ask&ord_type=limit&volume=${qty}&price=${price}`;
    const auth = this._authHeader(body);
    if (!auth) return null;
    const data = await fetchJSON(`${this._base}/v1/orders`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return { orderId: data.uuid };
  }

  async cancelOrder(orderId) {
    const body = `uuid=${orderId}`;
    const auth = this._authHeader(body);
    if (!auth) return false;
    try {
      await fetchJSON(`${this._base}/v1/order?${body}`, {
        method: "DELETE",
        headers: auth,
      });
      return true;
    } catch { return false; }
  }

  async getOpenOrders(symbol) {
    const market = this._toMarket(symbol);
    const query = `market=${market}&state=wait`;
    const auth = this._authHeader(query);
    if (!auth) return [];
    const data = await fetchJSON(`${this._base}/v1/orders?${query}`, { headers: auth });
    return data.map(o => ({
      orderId: o.uuid,
      side:    o.side === "bid" ? "buy" : "sell",
      price:   parseFloat(o.price),
      qty:     parseFloat(o.volume),
    }));
  }

  // ── 신규 상장 감지 ─────────────────────────────────────────
  async getNewListings(knownSymbols) {
    const markets = await this.getMarkets();
    const now = Date.now();
    return markets
      .filter(m => !knownSymbols.has(m.symbol))
      .map(m => ({ symbol: m.symbol, base: m.base, listedAt: now }));
  }

  // ── 내부 유틸 ─────────────────────────────────────────────
  _toMarket(symbol) {
    // "BTC" → "KRW-BTC", "KRW-BTC" → "KRW-BTC"
    if (symbol.includes("-")) return symbol;
    return `KRW-${symbol.toUpperCase()}`;
  }

  _toUpbitInterval(interval) {
    // interval 문자열 → 분 단위 변환
    if (typeof interval === "number") return interval;
    const map = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 };
    return map[interval] || 60;
  }
}


// ═══════════════════════════════════════════════════════════════
//  Binance Adapter — 바이낸스 (USDT 마켓)
// ═══════════════════════════════════════════════════════════════
class BinanceAdapter {
  constructor(config = {}) {
    this._apiKey    = config.apiKey    || "";
    this._secretKey = config.secretKey || "";
    this._base      = config.testnet
      ? "https://testnet.binance.vision"
      : "https://api.binance.com";

    // ── 레이트 리미터 (최대 10 req/sec) ──────────────────────
    this._requestTimes = [];
    this._maxReqPerSec = 10;
  }

  get name()          { return "Binance"; }
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

  async _fetch(url, opts = {}) {
    await this._rateLimit();
    return fetchJSON(url, opts);
  }

  // ── HMAC-SHA256 서명 ───────────────────────────────────────
  _sign(queryString) {
    return crypto.createHmac("sha256", this._secretKey)
      .update(queryString)
      .digest("hex");
  }

  _signedHeaders() {
    return { "X-MBX-APIKEY": this._apiKey };
  }

  _signedQuery(params = {}) {
    params.timestamp = Date.now();
    params.recvWindow = 5000;
    const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
    const signature = this._sign(qs);
    return `${qs}&signature=${signature}`;
  }

  // ── 마켓 데이터 ───────────────────────────────────────────

  async getMarkets() {
    const data = await this._fetch(`${this._base}/api/v3/exchangeInfo`);
    return data.symbols
      .filter(s => s.status === "TRADING" && s.quoteAsset === "USDT")
      .map(s => ({
        symbol:   s.symbol,
        base:     s.baseAsset,
        quote:    "USDT",
        exchange: "binance",
      }));
  }

  async getTicker(symbol) {
    const sym = this._toSymbol(symbol);
    const data = await this._fetch(`${this._base}/api/v3/ticker/24hr?symbol=${sym}`);
    return {
      price:     parseFloat(data.lastPrice),
      volume24h: parseFloat(data.quoteVolume),
      change24h: parseFloat(data.priceChangePercent),
    };
  }

  async getOrderbook(symbol, depth = 10) {
    const sym = this._toSymbol(symbol);
    const data = await this._fetch(`${this._base}/api/v3/depth?symbol=${sym}&limit=${depth}`);
    return {
      bids: data.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      asks: data.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    };
  }

  async getRecentTrades(symbol, limit = 100) {
    const sym = this._toSymbol(symbol);
    const data = await this._fetch(`${this._base}/api/v3/trades?symbol=${sym}&limit=${limit}`);
    return data.map(t => ({
      price: parseFloat(t.price),
      qty:   parseFloat(t.qty),
      side:  t.isBuyerMaker ? "sell" : "buy",
      time:  t.time,
    }));
  }

  async getCandles(symbol, interval = "1h", limit = 50) {
    const sym = this._toSymbol(symbol);
    const intv = this._toBinanceInterval(interval);
    const data = await this._fetch(
      `${this._base}/api/v3/klines?symbol=${sym}&interval=${intv}&limit=${limit}`
    );
    return data.map(c => ({
      time:   c[0],
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }

  // ── 거래 ──────────────────────────────────────────────────

  async getBalance(asset) {
    if (!this._apiKey || !this._secretKey) return null;
    const qs = this._signedQuery();
    const data = await this._fetch(`${this._base}/api/v3/account?${qs}`, {
      headers: this._signedHeaders(),
    });
    const found = data.balances.find(b => b.asset === asset.toUpperCase());
    return found ? parseFloat(found.free) : 0;
  }

  async getBalances() {
    if (!this._apiKey || !this._secretKey) return new Map();
    const qs = this._signedQuery();
    const data = await this._fetch(`${this._base}/api/v3/account?${qs}`, {
      headers: this._signedHeaders(),
    });
    const map = new Map();
    for (const b of data.balances) {
      const free   = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      if (free > 0 || locked > 0) {
        map.set(b.asset, { free, locked });
      }
    }
    return map;
  }

  async marketBuy(symbol, quoteQty) {
    if (!this._apiKey || !this._secretKey) return null;
    const sym = this._toSymbol(symbol);
    const qs = this._signedQuery({
      symbol:           sym,
      side:             "BUY",
      type:             "MARKET",
      quoteOrderQty:    quoteQty,
    });
    const data = await this._fetch(`${this._base}/api/v3/order?${qs}`, {
      method: "POST",
      headers: this._signedHeaders(),
    });
    const fills = data.fills || [];
    const totalQty   = fills.reduce((s, f) => s + parseFloat(f.qty), 0);
    const totalQuote = fills.reduce((s, f) => s + parseFloat(f.qty) * parseFloat(f.price), 0);
    return {
      orderId:   data.orderId,
      avgPrice:  totalQty > 0 ? totalQuote / totalQty : parseFloat(data.price || 0),
      filledQty: totalQty,
    };
  }

  async marketSell(symbol, baseQty) {
    if (!this._apiKey || !this._secretKey) return null;
    const sym = this._toSymbol(symbol);
    const qs = this._signedQuery({
      symbol:   sym,
      side:     "SELL",
      type:     "MARKET",
      quantity: baseQty,
    });
    const data = await this._fetch(`${this._base}/api/v3/order?${qs}`, {
      method: "POST",
      headers: this._signedHeaders(),
    });
    const fills = data.fills || [];
    const totalQty   = fills.reduce((s, f) => s + parseFloat(f.qty), 0);
    const totalQuote = fills.reduce((s, f) => s + parseFloat(f.qty) * parseFloat(f.price), 0);
    return {
      orderId:   data.orderId,
      avgPrice:  totalQty > 0 ? totalQuote / totalQty : 0,
      filledQty: totalQty,
    };
  }

  async limitBuy(symbol, qty, price) {
    if (!this._apiKey || !this._secretKey) return null;
    const sym = this._toSymbol(symbol);
    const qs = this._signedQuery({
      symbol:      sym,
      side:        "BUY",
      type:        "LIMIT",
      timeInForce: "GTC",
      quantity:    qty,
      price:       price,
    });
    const data = await this._fetch(`${this._base}/api/v3/order?${qs}`, {
      method: "POST",
      headers: this._signedHeaders(),
    });
    return { orderId: data.orderId };
  }

  async limitSell(symbol, qty, price) {
    if (!this._apiKey || !this._secretKey) return null;
    const sym = this._toSymbol(symbol);
    const qs = this._signedQuery({
      symbol:      sym,
      side:        "SELL",
      type:        "LIMIT",
      timeInForce: "GTC",
      quantity:    qty,
      price:       price,
    });
    const data = await this._fetch(`${this._base}/api/v3/order?${qs}`, {
      method: "POST",
      headers: this._signedHeaders(),
    });
    return { orderId: data.orderId };
  }

  async cancelOrder(orderId, symbol) {
    if (!this._apiKey || !this._secretKey) return false;
    const sym = this._toSymbol(symbol);
    try {
      const qs = this._signedQuery({ symbol: sym, orderId });
      await this._fetch(`${this._base}/api/v3/order?${qs}`, {
        method: "DELETE",
        headers: this._signedHeaders(),
      });
      return true;
    } catch { return false; }
  }

  async getOpenOrders(symbol) {
    if (!this._apiKey || !this._secretKey) return [];
    const sym = this._toSymbol(symbol);
    const qs = this._signedQuery({ symbol: sym });
    const data = await this._fetch(`${this._base}/api/v3/openOrders?${qs}`, {
      headers: this._signedHeaders(),
    });
    return data.map(o => ({
      orderId: o.orderId,
      side:    o.side.toLowerCase(),
      price:   parseFloat(o.price),
      qty:     parseFloat(o.origQty),
    }));
  }

  // ── 신규 상장 감지 ─────────────────────────────────────────
  async getNewListings(knownSymbols) {
    const markets = await this.getMarkets();
    const now = Date.now();
    return markets
      .filter(m => !knownSymbols.has(m.symbol))
      .map(m => ({ symbol: m.symbol, base: m.base, listedAt: now }));
  }

  // ── 내부 유틸 ─────────────────────────────────────────────
  _toSymbol(symbol) {
    // "BTC" → "BTCUSDT", "BTCUSDT" → "BTCUSDT"
    if (symbol.includes("USDT")) return symbol;
    if (symbol.includes("-")) {
      // "KRW-BTC" 형식 → "BTCUSDT"
      return symbol.split("-")[1] + "USDT";
    }
    return symbol.toUpperCase() + "USDT";
  }

  _toBinanceInterval(interval) {
    if (typeof interval === "number") {
      const map = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h" };
      return map[interval] || "1h";
    }
    return interval; // 이미 "1h", "4h" 등 문자열
  }
}


// ═══════════════════════════════════════════════════════════════
//  Bybit Adapter — 바이비트 (USDT 마켓)
// ═══════════════════════════════════════════════════════════════
class BybitAdapter {
  constructor(config = {}) {
    this._apiKey    = config.apiKey    || "";
    this._secretKey = config.secretKey || "";
    this._base      = config.testnet
      ? "https://api-testnet.bybit.com"
      : "https://api.bybit.com";
    this._recvWindow = "5000";
  }

  get name()          { return "Bybit"; }
  get quoteCurrency() { return "USDT"; }

  // ── HMAC-SHA256 서명 (Bybit v5) ───────────────────────────
  _sign(timestamp, payload) {
    const raw = `${timestamp}${this._apiKey}${this._recvWindow}${payload}`;
    return crypto.createHmac("sha256", this._secretKey).update(raw).digest("hex");
  }

  _authHeaders(payload = "") {
    if (!this._apiKey || !this._secretKey) return null;
    const ts = Date.now().toString();
    const sign = this._sign(ts, payload);
    return {
      "X-BAPI-API-KEY":     this._apiKey,
      "X-BAPI-TIMESTAMP":   ts,
      "X-BAPI-RECV-WINDOW": this._recvWindow,
      "X-BAPI-SIGN":        sign,
    };
  }

  // Bybit v5 응답 래퍼 — retCode 체크
  async _v5Fetch(url, opts = {}) {
    const data = await fetchJSON(url, opts);
    if (data.retCode !== 0) {
      throw new Error(`Bybit: ${data.retMsg || "Unknown error"} (code ${data.retCode})`);
    }
    return data.result;
  }

  // ── 마켓 데이터 ───────────────────────────────────────────

  async getMarkets() {
    const result = await this._v5Fetch(
      `${this._base}/v5/market/instruments-info?category=spot`
    );
    return (result.list || [])
      .filter(s => s.status === "Trading" && s.quoteCoin === "USDT")
      .map(s => ({
        symbol:   s.symbol,
        base:     s.baseCoin,
        quote:    "USDT",
        exchange: "bybit",
      }));
  }

  async getTicker(symbol) {
    const sym = this._toSymbol(symbol);
    const result = await this._v5Fetch(
      `${this._base}/v5/market/tickers?category=spot&symbol=${sym}`
    );
    const t = result.list?.[0];
    if (!t) throw new Error(`Bybit ticker not found: ${sym}`);
    return {
      price:     parseFloat(t.lastPrice),
      volume24h: parseFloat(t.turnover24h),
      change24h: parseFloat(t.price24hPcnt) * 100,
    };
  }

  async getOrderbook(symbol, depth = 10) {
    const sym = this._toSymbol(symbol);
    const result = await this._v5Fetch(
      `${this._base}/v5/market/orderbook?category=spot&symbol=${sym}&limit=${depth}`
    );
    return {
      bids: (result.b || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      asks: (result.a || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    };
  }

  async getRecentTrades(symbol, limit = 100) {
    const sym = this._toSymbol(symbol);
    const result = await this._v5Fetch(
      `${this._base}/v5/market/recent-trade?category=spot&symbol=${sym}&limit=${limit}`
    );
    return (result.list || []).map(t => ({
      price: parseFloat(t.price),
      qty:   parseFloat(t.size),
      side:  t.side === "Buy" ? "buy" : "sell",
      time:  parseInt(t.time),
    }));
  }

  async getCandles(symbol, interval = "60", limit = 50) {
    const sym  = this._toSymbol(symbol);
    const intv = this._toBybitInterval(interval);
    const result = await this._v5Fetch(
      `${this._base}/v5/market/kline?category=spot&symbol=${sym}&interval=${intv}&limit=${limit}`
    );
    // Bybit은 최신순으로 반환 → 역순 정렬
    return (result.list || []).reverse().map(c => ({
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
    const headers = this._authHeaders("");
    if (!headers) return null;
    const qs = "accountType=UNIFIED";
    // 재서명 with query
    const ts = headers["X-BAPI-TIMESTAMP"];
    const sign = this._sign(ts, qs);
    headers["X-BAPI-SIGN"] = sign;

    const result = await this._v5Fetch(
      `${this._base}/v5/account/wallet-balance?${qs}`,
      { headers }
    );
    const account = result.list?.[0];
    if (!account) return 0;
    const coin = account.coin?.find(c => c.coin === asset.toUpperCase());
    return coin ? parseFloat(coin.walletBalance) : 0;
  }

  async getBalances() {
    const headers = this._authHeaders("");
    if (!headers) return new Map();
    const qs = "accountType=UNIFIED";
    const ts = headers["X-BAPI-TIMESTAMP"];
    const sign = this._sign(ts, qs);
    headers["X-BAPI-SIGN"] = sign;

    const result = await this._v5Fetch(
      `${this._base}/v5/account/wallet-balance?${qs}`,
      { headers }
    );
    const map = new Map();
    const coins = result.list?.[0]?.coin || [];
    for (const c of coins) {
      const free   = parseFloat(c.walletBalance) - parseFloat(c.locked || 0);
      const locked = parseFloat(c.locked || 0);
      if (free > 0 || locked > 0) {
        map.set(c.coin, { free, locked });
      }
    }
    return map;
  }

  async marketBuy(symbol, quoteQty) {
    return this._placeOrder(symbol, "Buy", "MARKET", null, null, quoteQty);
  }

  async marketSell(symbol, baseQty) {
    return this._placeOrder(symbol, "Sell", "MARKET", baseQty, null, null);
  }

  async limitBuy(symbol, qty, price) {
    return this._placeOrder(symbol, "Buy", "LIMIT", qty, price, null);
  }

  async limitSell(symbol, qty, price) {
    return this._placeOrder(symbol, "Sell", "LIMIT", qty, price, null);
  }

  async _placeOrder(symbol, side, orderType, qty, price, quoteQty) {
    if (!this._apiKey || !this._secretKey) return null;
    const sym = this._toSymbol(symbol);
    const body = {
      category:  "spot",
      symbol:    sym,
      side,
      orderType,
    };
    if (qty)      body.qty        = String(qty);
    if (price)    body.price      = String(price);
    if (quoteQty) body.marketUnit = "quoteCoin", body.qty = String(quoteQty);
    if (orderType === "LIMIT") body.timeInForce = "GTC";

    const bodyStr = JSON.stringify(body);
    const headers = this._authHeaders(bodyStr);
    headers["Content-Type"] = "application/json";

    const result = await this._v5Fetch(`${this._base}/v5/order/create`, {
      method: "POST",
      headers,
      body: bodyStr,
    });
    return { orderId: result.orderId, avgPrice: null, filledQty: null };
  }

  async cancelOrder(orderId, symbol) {
    if (!this._apiKey || !this._secretKey) return false;
    const sym = this._toSymbol(symbol);
    try {
      const body = JSON.stringify({
        category: "spot",
        symbol:   sym,
        orderId,
      });
      const headers = this._authHeaders(body);
      headers["Content-Type"] = "application/json";
      await this._v5Fetch(`${this._base}/v5/order/cancel`, {
        method: "POST",
        headers,
        body,
      });
      return true;
    } catch { return false; }
  }

  async getOpenOrders(symbol) {
    if (!this._apiKey || !this._secretKey) return [];
    const sym = this._toSymbol(symbol);
    const qs = `category=spot&symbol=${sym}`;
    const headers = this._authHeaders(qs);

    const result = await this._v5Fetch(
      `${this._base}/v5/order/realtime?${qs}`,
      { headers }
    );
    return (result.list || []).map(o => ({
      orderId: o.orderId,
      side:    o.side.toLowerCase(),
      price:   parseFloat(o.price),
      qty:     parseFloat(o.qty),
    }));
  }

  // ── 신규 상장 감지 ─────────────────────────────────────────
  async getNewListings(knownSymbols) {
    const markets = await this.getMarkets();
    const now = Date.now();
    return markets
      .filter(m => !knownSymbols.has(m.symbol))
      .map(m => ({ symbol: m.symbol, base: m.base, listedAt: now }));
  }

  // ── 내부 유틸 ─────────────────────────────────────────────
  _toSymbol(symbol) {
    if (symbol.includes("USDT")) return symbol;
    if (symbol.includes("-")) return symbol.split("-")[1] + "USDT";
    return symbol.toUpperCase() + "USDT";
  }

  _toBybitInterval(interval) {
    if (typeof interval === "number") {
      const map = { 1: "1", 3: "3", 5: "5", 15: "15", 30: "30", 60: "60", 240: "240" };
      return map[interval] || "60";
    }
    // "1m" → "1", "1h" → "60", "4h" → "240"
    const map = { "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D" };
    return map[interval] || "60";
  }
}


// ═══════════════════════════════════════════════════════════════
//  외부 어댑터 임포트
// ═══════════════════════════════════════════════════════════════
const { OKXAdapter }     = require("./exchange-okx");
const { BithumbAdapter } = require("./exchange-bithumb");
const { GateAdapter }    = require("./exchange-gate");

// ═══════════════════════════════════════════════════════════════
//  팩토리 함수
// ═══════════════════════════════════════════════════════════════
function createExchange(name, config = {}) {
  switch (name.toLowerCase()) {
    case "upbit":   return new UpbitAdapter(config);
    case "binance": return new BinanceAdapter(config);
    case "bybit":   return new BybitAdapter(config);
    case "okx":     return new OKXAdapter(config);
    case "bithumb": return new BithumbAdapter(config);
    case "gate":    return new GateAdapter(config);
    default: throw new Error(`[ExchangeAdapter] 알 수 없는 거래소: ${name}`);
  }
}

/** 지원 거래소 목록 */
const SUPPORTED_EXCHANGES = [
  { id: "upbit",   name: "Upbit",   quote: "KRW",  region: "KR",     fee: 0.0005 },
  { id: "bithumb", name: "Bithumb", quote: "KRW",  region: "KR",     fee: 0.0004 },
  { id: "binance", name: "Binance", quote: "USDT", region: "GLOBAL", fee: 0.0010 },
  { id: "bybit",   name: "Bybit",   quote: "USDT", region: "GLOBAL", fee: 0.0010 },
  { id: "okx",     name: "OKX",     quote: "USDT", region: "GLOBAL", fee: 0.0008 },
  { id: "gate",    name: "Gate.io", quote: "USDT", region: "GLOBAL", fee: 0.0010 },
];

module.exports = {
  safeFetch,
  fetchJSON,
  createExchange,
  SUPPORTED_EXCHANGES,
  UpbitAdapter,
  BinanceAdapter,
  BybitAdapter,
  OKXAdapter,
  BithumbAdapter,
  GateAdapter,
};
