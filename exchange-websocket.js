"use strict";

/**
 * ExchangeWebSocket — Binance + Bybit 실시간 WebSocket 가격 스트림
 *
 * CrossExchangeArb의 REST 15초 폴링을 보완하여
 * 실시간(~100ms) 가격 피드를 제공.
 *
 * Binance: wss://stream.binance.com:9443/ws/<stream>
 * Bybit:   wss://stream.bybit.com/v5/public/spot
 */

let WebSocket;
try { WebSocket = require("ws"); } catch {
  // ws 모듈 없으면 브라우저 WebSocket 사용 시도
  WebSocket = globalThis.WebSocket;
}

// ── 모니터링 대상 코인 (USDT 페어) ─────────────────────────
const DEFAULT_COINS = [
  "BTC", "ETH", "XRP", "SOL", "ADA", "DOGE", "AVAX",
  "DOT", "LINK", "MATIC", "NEAR", "APT", "ARB", "OP",
  "AAVE", "UNI", "ATOM", "FIL", "ICP", "HBAR",
];

const RECONNECT_DELAY_MS   = 3000;
const MAX_RECONNECT_DELAY  = 30000;
const PING_INTERVAL_MS     = 30000;

// ═══════════════════════════════════════════════════════════════
//  Binance WebSocket
// ═══════════════════════════════════════════════════════════════
class BinanceWebSocket {
  constructor() {
    this._ws          = null;
    this._prices      = new Map(); // coin → { price, time }
    this._coins       = new Set(DEFAULT_COINS);
    this._callbacks   = [];
    this._running     = false;
    this._reconnects  = 0;
    this._pingTimer   = null;
  }

  onPrice(cb) { this._callbacks.push(cb); }

  addCoin(coin) {
    const upper = coin.toUpperCase();
    if (this._coins.has(upper)) return;
    this._coins.add(upper);
    // 재연결하여 새 스트림 구독
    if (this._running) this._reconnect();
  }

  getPrice(coin) {
    return this._prices.get(coin.toUpperCase())?.price || null;
  }

  getAllPrices() {
    const result = {};
    for (const [coin, data] of this._prices) {
      result[coin] = data.price;
    }
    return result;
  }

  connect() {
    if (!WebSocket) {
      console.warn("[BinanceWS] WebSocket 모듈 없음 — 스킵");
      return;
    }
    this._running = true;
    this._doConnect();
  }

  _doConnect() {
    if (!this._running) return;

    // Combined stream: 모든 코인의 miniTicker
    const streams = Array.from(this._coins)
      .map(c => `${c.toLowerCase()}usdt@miniTicker`)
      .join("/");

    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    try {
      this._ws = new WebSocket(url);
    } catch (e) {
      console.error("[BinanceWS] 연결 생성 실패:", e.message);
      this._scheduleReconnect();
      return;
    }

    this._ws.on("open", () => {
      this._reconnects = 0;
      console.log(`[BinanceWS] 연결됨 — ${this._coins.size}개 코인 구독`);
      this._startPing();
    });

    this._ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.data && msg.data.s) {
          const symbol = msg.data.s; // e.g. "BTCUSDT"
          const coin = symbol.replace("USDT", "");
          const price = parseFloat(msg.data.c); // close price

          this._prices.set(coin, { price, time: Date.now() });

          for (const cb of this._callbacks) {
            try { cb("Binance", coin, price); } catch {}
          }
        }
      } catch {}
    });

    this._ws.on("close", () => {
      console.warn("[BinanceWS] 연결 종료");
      this._stopPing();
      this._scheduleReconnect();
    });

    this._ws.on("error", (err) => {
      console.error("[BinanceWS] 오류:", err.message);
    });
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _reconnect() {
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this._doConnect();
  }

  _scheduleReconnect() {
    if (!this._running) return;
    this._reconnects++;
    const delay = Math.min(RECONNECT_DELAY_MS * this._reconnects, MAX_RECONNECT_DELAY);
    console.log(`[BinanceWS] ${delay}ms 후 재연결 (시도 #${this._reconnects})`);
    setTimeout(() => this._doConnect(), delay);
  }

  stop() {
    this._running = false;
    this._stopPing();
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Bybit WebSocket (v5 spot)
// ═══════════════════════════════════════════════════════════════
class BybitWebSocket {
  constructor() {
    this._ws          = null;
    this._prices      = new Map();
    this._coins       = new Set(DEFAULT_COINS);
    this._callbacks   = [];
    this._running     = false;
    this._reconnects  = 0;
    this._pingTimer   = null;
  }

  onPrice(cb) { this._callbacks.push(cb); }

  addCoin(coin) {
    const upper = coin.toUpperCase();
    if (this._coins.has(upper)) return;
    this._coins.add(upper);
    // 실행 중이면 subscribe 메시지 전송
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._subscribe([upper]);
    }
  }

  getPrice(coin) {
    return this._prices.get(coin.toUpperCase())?.price || null;
  }

  getAllPrices() {
    const result = {};
    for (const [coin, data] of this._prices) {
      result[coin] = data.price;
    }
    return result;
  }

  connect() {
    if (!WebSocket) {
      console.warn("[BybitWS] WebSocket 모듈 없음 — 스킵");
      return;
    }
    this._running = true;
    this._doConnect();
  }

  _doConnect() {
    if (!this._running) return;

    const url = "wss://stream.bybit.com/v5/public/spot";

    try {
      this._ws = new WebSocket(url);
    } catch (e) {
      console.error("[BybitWS] 연결 생성 실패:", e.message);
      this._scheduleReconnect();
      return;
    }

    this._ws.on("open", () => {
      this._reconnects = 0;
      console.log(`[BybitWS] 연결됨`);
      this._subscribe(Array.from(this._coins));
      this._startPing();
    });

    this._ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Pong 응답
        if (msg.op === "pong") return;

        // Ticker 데이터
        if (msg.topic && msg.topic.startsWith("tickers.") && msg.data) {
          const symbol = msg.data.symbol; // e.g. "BTCUSDT"
          const coin = symbol.replace("USDT", "");
          const price = parseFloat(msg.data.lastPrice);

          if (price > 0) {
            this._prices.set(coin, { price, time: Date.now() });

            for (const cb of this._callbacks) {
              try { cb("Bybit", coin, price); } catch {}
            }
          }
        }
      } catch {}
    });

    this._ws.on("close", () => {
      console.warn("[BybitWS] 연결 종료");
      this._stopPing();
      this._scheduleReconnect();
    });

    this._ws.on("error", (err) => {
      console.error("[BybitWS] 오류:", err.message);
    });
  }

  _subscribe(coins) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const args = coins.map(c => `tickers.${c.toUpperCase()}USDT`);

    // Bybit은 한번에 최대 10개씩 구독
    for (let i = 0; i < args.length; i += 10) {
      const batch = args.slice(i, i + 10);
      this._ws.send(JSON.stringify({
        op: "subscribe",
        args: batch,
      }));
    }
    console.log(`[BybitWS] ${coins.length}개 코인 구독 요청`);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ op: "ping" }));
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _scheduleReconnect() {
    if (!this._running) return;
    this._reconnects++;
    const delay = Math.min(RECONNECT_DELAY_MS * this._reconnects, MAX_RECONNECT_DELAY);
    console.log(`[BybitWS] ${delay}ms 후 재연결 (시도 #${this._reconnects})`);
    setTimeout(() => this._doConnect(), delay);
  }

  stop() {
    this._running = false;
    this._stopPing();
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  OKX WebSocket (v5 public spot)
// ═══════════════════════════════════════════════════════════════
class OKXWebSocket {
  constructor() {
    this._ws          = null;
    this._prices      = new Map();
    this._coins       = new Set(DEFAULT_COINS);
    this._callbacks   = [];
    this._running     = false;
    this._reconnects  = 0;
    this._pingTimer   = null;
  }

  onPrice(cb) { this._callbacks.push(cb); }
  addCoin(coin) {
    const upper = coin.toUpperCase();
    if (this._coins.has(upper)) return;
    this._coins.add(upper);
    if (this._ws?.readyState === WebSocket.OPEN) this._subscribe([upper]);
  }
  getPrice(coin) { return this._prices.get(coin.toUpperCase())?.price || null; }

  connect() {
    if (!WebSocket) return;
    this._running = true;
    this._doConnect();
  }

  _doConnect() {
    if (!this._running) return;
    try {
      this._ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");
    } catch (e) {
      this._scheduleReconnect();
      return;
    }

    this._ws.on("open", () => {
      this._reconnects = 0;
      console.log("[OKXWS] 연결됨");
      this._subscribe(Array.from(this._coins));
      this._startPing();
    });

    this._ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.data && msg.arg?.channel === "tickers") {
          for (const t of msg.data) {
            const instId = t.instId; // "BTC-USDT"
            const coin = instId.split("-")[0];
            const price = parseFloat(t.last);
            if (price > 0) {
              this._prices.set(coin, { price, time: Date.now() });
              for (const cb of this._callbacks) {
                try { cb("OKX", coin, price); } catch {}
              }
            }
          }
        }
      } catch {}
    });

    this._ws.on("close", () => { this._stopPing(); this._scheduleReconnect(); });
    this._ws.on("error", (err) => console.error("[OKXWS] 오류:", err.message));
  }

  _subscribe(coins) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const args = coins.map(c => ({ channel: "tickers", instId: `${c}-USDT` }));
    this._ws.send(JSON.stringify({ op: "subscribe", args }));
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) this._ws.send("ping");
    }, PING_INTERVAL_MS);
  }
  _stopPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }

  _scheduleReconnect() {
    if (!this._running) return;
    this._reconnects++;
    const delay = Math.min(RECONNECT_DELAY_MS * this._reconnects, MAX_RECONNECT_DELAY);
    setTimeout(() => this._doConnect(), delay);
  }

  stop() {
    this._running = false;
    this._stopPing();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Gate.io WebSocket (v4 spot)
// ═══════════════════════════════════════════════════════════════
class GateWebSocket {
  constructor() {
    this._ws          = null;
    this._prices      = new Map();
    this._coins       = new Set(DEFAULT_COINS);
    this._callbacks   = [];
    this._running     = false;
    this._reconnects  = 0;
    this._pingTimer   = null;
  }

  onPrice(cb) { this._callbacks.push(cb); }
  addCoin(coin) {
    const upper = coin.toUpperCase();
    if (this._coins.has(upper)) return;
    this._coins.add(upper);
    if (this._ws?.readyState === WebSocket.OPEN) this._subscribe([upper]);
  }
  getPrice(coin) { return this._prices.get(coin.toUpperCase())?.price || null; }

  connect() {
    if (!WebSocket) return;
    this._running = true;
    this._doConnect();
  }

  _doConnect() {
    if (!this._running) return;
    try {
      this._ws = new WebSocket("wss://api.gateio.ws/ws/v4/");
    } catch (e) {
      this._scheduleReconnect();
      return;
    }

    this._ws.on("open", () => {
      this._reconnects = 0;
      console.log("[GateWS] 연결됨");
      this._subscribe(Array.from(this._coins));
      this._startPing();
    });

    this._ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel === "spot.tickers" && msg.event === "update" && msg.result) {
          const t = msg.result;
          const pair = t.currency_pair; // "BTC_USDT"
          const coin = pair.split("_")[0];
          const price = parseFloat(t.last);
          if (price > 0) {
            this._prices.set(coin, { price, time: Date.now() });
            for (const cb of this._callbacks) {
              try { cb("Gate", coin, price); } catch {}
            }
          }
        }
      } catch {}
    });

    this._ws.on("close", () => { this._stopPing(); this._scheduleReconnect(); });
    this._ws.on("error", (err) => console.error("[GateWS] 오류:", err.message));
  }

  _subscribe(coins) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const payload = coins.map(c => `${c}_USDT`);
    this._ws.send(JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      channel: "spot.tickers",
      event:   "subscribe",
      payload,
    }));
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          channel: "spot.ping",
        }));
      }
    }, PING_INTERVAL_MS);
  }
  _stopPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }

  _scheduleReconnect() {
    if (!this._running) return;
    this._reconnects++;
    const delay = Math.min(RECONNECT_DELAY_MS * this._reconnects, MAX_RECONNECT_DELAY);
    setTimeout(() => this._doConnect(), delay);
  }

  stop() {
    this._running = false;
    this._stopPing();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
  }
}

// ═══════════════════════════════════════════════════════════════
//  통합 멀티거래소 WebSocket 매니저 (4개 거래소)
// ═══════════════════════════════════════════════════════════════
class MultiExchangeWebSocket {
  constructor() {
    this.binance = new BinanceWebSocket();
    this.bybit   = new BybitWebSocket();
    this.okx     = new OKXWebSocket();
    this.gate    = new GateWebSocket();

    // 통합 가격 맵: coin → { Binance: price, Bybit: price, OKX: price, Gate: price }
    this._unified = new Map();
    this._callbacks = [];

    // 내부 콜백 등록
    this.binance.onPrice((ex, coin, price) => this._onPrice(ex, coin, price));
    this.bybit.onPrice((ex, coin, price)   => this._onPrice(ex, coin, price));
    this.okx.onPrice((ex, coin, price)     => this._onPrice(ex, coin, price));
    this.gate.onPrice((ex, coin, price)    => this._onPrice(ex, coin, price));
  }

  onPrice(cb) { this._callbacks.push(cb); }

  addCoin(coin) {
    this.binance.addCoin(coin);
    this.bybit.addCoin(coin);
    this.okx.addCoin(coin);
    this.gate.addCoin(coin);
  }

  getPrice(exchange, coin) {
    const key = exchange.toLowerCase();
    if (key === "binance") return this.binance.getPrice(coin);
    if (key === "bybit")   return this.bybit.getPrice(coin);
    if (key === "okx")     return this.okx.getPrice(coin);
    if (key === "gate")    return this.gate.getPrice(coin);
    return null;
  }

  getCoinPrices(coin) {
    return this._unified.get(coin.toUpperCase()) || {};
  }

  getAllPrices() {
    const result = {};
    for (const [coin, exchanges] of this._unified) {
      result[coin] = { ...exchanges };
    }
    return result;
  }

  connect() {
    this.binance.connect();
    this.bybit.connect();
    this.okx.connect();
    this.gate.connect();
    console.log("[MultiExWS] 4개 거래소 WebSocket 연결 시작 (Binance/Bybit/OKX/Gate)");
  }

  stop() {
    this.binance.stop();
    this.bybit.stop();
    this.okx.stop();
    this.gate.stop();
  }

  _onPrice(exchange, coin, price) {
    if (!this._unified.has(coin)) this._unified.set(coin, {});
    this._unified.get(coin)[exchange] = price;

    for (const cb of this._callbacks) {
      try { cb(exchange, coin, price); } catch {}
    }
  }

  getSummary() {
    const wsState = (ws) => ({
      connected: ws._ws?.readyState === WebSocket?.OPEN,
      coins:     ws._prices.size,
    });
    return {
      binance:    wsState(this.binance),
      bybit:      wsState(this.bybit),
      okx:        wsState(this.okx),
      gate:       wsState(this.gate),
      totalCoins: this._unified.size,
    };
  }
}

module.exports = {
  BinanceWebSocket, BybitWebSocket, OKXWebSocket, GateWebSocket,
  MultiExchangeWebSocket,
};
