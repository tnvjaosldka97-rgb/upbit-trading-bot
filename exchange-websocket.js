'use strict';

/**
 * ExchangeWebSocketManager — 멀티 거래소 WebSocket 매니저
 *
 * 지원 거래소:
 *   - Binance:  wss://stream.binance.com:9443/ws  (miniTicker, depth@100ms)
 *   - Bybit:    wss://stream.bybit.com/v5/public/spot  (tickers, orderbook)
 *   - OKX:      wss://ws.okx.com:8443/ws/v5/public  (tickers, books5)
 *   - Gate.io:  wss://api.gateio.ws/ws/v4/  (spot.tickers, spot.order_book)
 *
 * 공통 정규화 포맷:
 *   { exchange, symbol, bid, ask, price, volume, timestamp }
 *
 * 필요 패키지: npm install ws
 */

const { EventEmitter } = require('events');

let WebSocket;
try { WebSocket = require('ws'); } catch {
  WebSocket = globalThis.WebSocket || null;
}

const RECONNECT_BASE_MS  = 3_000;
const RECONNECT_MAX_MS   = 30_000;
const PING_INTERVAL_MS   = 30_000;

// ── 공통 코인 목록 (USDT 페어) ──────────────────────────
const DEFAULT_COINS = [
  'BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOGE', 'AVAX',
  'DOT', 'LINK', 'MATIC', 'NEAR', 'APT', 'ARB', 'OP',
  'AAVE', 'UNI', 'ATOM', 'FIL', 'ICP', 'HBAR',
];

// ═══════════════════════════════════════════════════════════
//  Base WebSocket (공통 로직)
// ═══════════════════════════════════════════════════════════
class BaseExchangeWS extends EventEmitter {
  constructor(name) {
    super();
    this._name        = name;
    this._ws          = null;
    this._prices      = new Map();  // coin → { price, bid, ask, volume, time }
    this._coins       = new Set(DEFAULT_COINS);
    this._running     = false;
    this._reconnects  = 0;
    this._pingTimer   = null;
  }

  addCoin(coin) {
    const upper = coin.toUpperCase();
    if (this._coins.has(upper)) return;
    this._coins.add(upper);
    this._onCoinAdded(upper);
  }

  getPrice(coin) { return this._prices.get(coin.toUpperCase())?.price || null; }
  getData(coin)  { return this._prices.get(coin.toUpperCase()) || null; }

  getAllPrices() {
    const result = {};
    for (const [coin, data] of this._prices) result[coin] = data.price;
    return result;
  }

  connect() {
    if (!WebSocket) {
      console.warn(`[${this._name}] WebSocket 모듈 없음 — 스킵`);
      return;
    }
    this._running = true;
    this._doConnect();
  }

  stop() {
    this._running = false;
    this._stopPing();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
  }

  // 하위 클래스에서 구현
  _getUrl()              { throw new Error('_getUrl 구현 필요'); }
  _onOpen()              {}
  _onRawMessage(_msg)    {}
  _onCoinAdded(_coin)    {}
  _sendPing()            {}

  _doConnect() {
    if (!this._running) return;
    const url = this._getUrl();

    try {
      this._ws = new WebSocket(url);
    } catch (e) {
      console.error(`[${this._name}] 연결 생성 실패:`, e.message);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      this._reconnects = 0;
      console.log(`[${this._name}] 연결됨`);
      this._onOpen();
      this._startPing();
      this.emit('connected');
    });

    this._ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._onRawMessage(msg);
      } catch { /* malformed WS frame — expected, ignore */ }
    });

    this._ws.on('close', () => {
      console.warn(`[${this._name}] 연결 종료`);
      this._stopPing();
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      console.error(`[${this._name}] 오류:`, err.message);
      this.emit('error', err);
    });
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) this._sendPing();
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _scheduleReconnect() {
    if (!this._running) return;
    this._reconnects++;
    const delay = Math.min(RECONNECT_BASE_MS * this._reconnects, RECONNECT_MAX_MS);
    console.log(`[${this._name}] ${delay}ms 후 재연결 (시도 #${this._reconnects})`);
    setTimeout(() => this._doConnect(), delay);
  }

  _emitNormalized(coin, price, bid, ask, volume) {
    const normalized = {
      exchange:  this._name.toLowerCase(),
      symbol:    coin,
      bid:       bid || price,
      ask:       ask || price,
      price,
      volume:    volume || 0,
      timestamp: Date.now(),
    };
    this._prices.set(coin, { price, bid, ask, volume, time: Date.now() });
    this.emit('ticker', normalized);
    return normalized;
  }
}

// ═══════════════════════════════════════════════════════════
//  Binance WebSocket
// ═══════════════════════════════════════════════════════════
class BinanceWS extends BaseExchangeWS {
  constructor() { super('BinanceWS'); }

  _getUrl() {
    const streams = Array.from(this._coins)
      .map(c => `${c.toLowerCase()}usdt@miniTicker`)
      .join('/');
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
  }

  _onOpen() {
    console.log(`[BinanceWS] ${this._coins.size}개 코인 miniTicker 구독`);
    // depth 구독은 별도 스트림 필요 — 간편 모드에서는 miniTicker만
  }

  _onRawMessage(msg) {
    if (msg.data && msg.data.s) {
      const symbol = msg.data.s;           // e.g. "BTCUSDT"
      const coin   = symbol.replace('USDT', '');
      const price  = parseFloat(msg.data.c);  // close
      const high   = parseFloat(msg.data.h);
      const low    = parseFloat(msg.data.l);
      const volume = parseFloat(msg.data.v);
      if (price > 0) this._emitNormalized(coin, price, low, high, volume);
    }
  }

  _onCoinAdded(_coin) {
    // Binance combined stream — 재접속 필요
    if (this._running && this._ws) {
      try { this._ws.close(); } catch {}
    }
  }

  _sendPing() { try { this._ws.ping(); } catch {} }
}

// ═══════════════════════════════════════════════════════════
//  Bybit WebSocket (v5 spot)
// ═══════════════════════════════════════════════════════════
class BybitWS extends BaseExchangeWS {
  constructor() { super('BybitWS'); }

  _getUrl() { return 'wss://stream.bybit.com/v5/public/spot'; }

  _onOpen() {
    this._subscribeBatch(Array.from(this._coins));
  }

  _subscribeBatch(coins) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    // tickers
    const tickerArgs = coins.map(c => `tickers.${c.toUpperCase()}USDT`);
    // orderbook (depth 50)
    const obArgs = coins.map(c => `orderbook.50.${c.toUpperCase()}USDT`);
    const allArgs = [...tickerArgs, ...obArgs];

    // Bybit은 한번에 최대 10개씩 구독
    for (let i = 0; i < allArgs.length; i += 10) {
      this._ws.send(JSON.stringify({ op: 'subscribe', args: allArgs.slice(i, i + 10) }));
    }
    console.log(`[BybitWS] ${coins.length}개 코인 tickers+orderbook 구독`);
  }

  _onRawMessage(msg) {
    if (msg.op === 'pong') return;

    // Ticker 데이터
    if (msg.topic && msg.topic.startsWith('tickers.') && msg.data) {
      const symbol = msg.data.symbol;       // "BTCUSDT"
      const coin   = symbol.replace('USDT', '');
      const price  = parseFloat(msg.data.lastPrice);
      const bid    = parseFloat(msg.data.bid1Price) || price;
      const ask    = parseFloat(msg.data.ask1Price) || price;
      const volume = parseFloat(msg.data.volume24h) || 0;
      if (price > 0) this._emitNormalized(coin, price, bid, ask, volume);
    }

    // Orderbook 데이터
    if (msg.topic && msg.topic.startsWith('orderbook.') && msg.data) {
      this.emit('orderbook', {
        exchange: 'bybit',
        symbol:   msg.topic.split('.')[2]?.replace('USDT', '') || '',
        bids:     (msg.data.b || []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) })),
        asks:     (msg.data.a || []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) })),
        timestamp: Date.now(),
      });
    }
  }

  _onCoinAdded(coin) {
    if (this._ws?.readyState === WebSocket.OPEN) this._subscribeBatch([coin]);
  }

  _sendPing() {
    try { this._ws.send(JSON.stringify({ op: 'ping' })); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════
//  OKX WebSocket (v5 public)
// ═══════════════════════════════════════════════════════════
class OKXWS extends BaseExchangeWS {
  constructor() { super('OKXWS'); }

  _getUrl() { return 'wss://ws.okx.com:8443/ws/v5/public'; }

  _onOpen() {
    this._subscribeBatch(Array.from(this._coins));
  }

  _subscribeBatch(coins) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const tickerArgs = coins.map(c => ({ channel: 'tickers', instId: `${c}-USDT` }));
    const bookArgs   = coins.map(c => ({ channel: 'books5',  instId: `${c}-USDT` }));
    this._ws.send(JSON.stringify({ op: 'subscribe', args: tickerArgs }));
    this._ws.send(JSON.stringify({ op: 'subscribe', args: bookArgs }));
    console.log(`[OKXWS] ${coins.length}개 코인 tickers+books5 구독`);
  }

  _onRawMessage(msg) {
    // Ticker
    if (msg.data && msg.arg?.channel === 'tickers') {
      for (const t of msg.data) {
        const instId = t.instId;              // "BTC-USDT"
        const coin   = instId.split('-')[0];
        const price  = parseFloat(t.last);
        const bid    = parseFloat(t.bidPx) || price;
        const ask    = parseFloat(t.askPx) || price;
        const volume = parseFloat(t.vol24h) || 0;
        if (price > 0) this._emitNormalized(coin, price, bid, ask, volume);
      }
    }

    // Orderbook (books5)
    if (msg.data && msg.arg?.channel === 'books5') {
      for (const ob of msg.data) {
        const coin = msg.arg.instId?.split('-')[0] || '';
        this.emit('orderbook', {
          exchange: 'okx',
          symbol:   coin,
          bids:     (ob.bids || []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) })),
          asks:     (ob.asks || []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) })),
          timestamp: parseInt(ob.ts) || Date.now(),
        });
      }
    }
  }

  _onCoinAdded(coin) {
    if (this._ws?.readyState === WebSocket.OPEN) this._subscribeBatch([coin]);
  }

  _sendPing() {
    try { this._ws.send('ping'); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════
//  Gate.io WebSocket (v4 spot)
// ═══════════════════════════════════════════════════════════
class GateWS extends BaseExchangeWS {
  constructor() { super('GateWS'); }

  _getUrl() { return 'wss://api.gateio.ws/ws/v4/'; }

  _onOpen() {
    this._subscribeBatch(Array.from(this._coins));
  }

  _subscribeBatch(coins) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    // spot.tickers
    const tickerPayload = coins.map(c => `${c}_USDT`);
    this._ws.send(JSON.stringify({
      time:    Math.floor(Date.now() / 1000),
      channel: 'spot.tickers',
      event:   'subscribe',
      payload: tickerPayload,
    }));

    // spot.order_book (depth 5, update 100ms)
    for (const c of coins) {
      this._ws.send(JSON.stringify({
        time:    Math.floor(Date.now() / 1000),
        channel: 'spot.order_book',
        event:   'subscribe',
        payload: [`${c}_USDT`, '5', '100ms'],
      }));
    }

    console.log(`[GateWS] ${coins.length}개 코인 spot.tickers+spot.order_book 구독`);
  }

  _onRawMessage(msg) {
    // Ticker
    if (msg.channel === 'spot.tickers' && msg.event === 'update' && msg.result) {
      const t    = msg.result;
      const pair = t.currency_pair;          // "BTC_USDT"
      const coin = pair.split('_')[0];
      const price  = parseFloat(t.last);
      const bid    = parseFloat(t.highest_bid) || price;
      const ask    = parseFloat(t.lowest_ask)  || price;
      const volume = parseFloat(t.base_volume) || 0;
      if (price > 0) this._emitNormalized(coin, price, bid, ask, volume);
    }

    // Orderbook
    if (msg.channel === 'spot.order_book' && msg.event === 'update' && msg.result) {
      const ob   = msg.result;
      const pair = ob.s || ob.currency_pair || '';
      const coin = pair.split('_')[0];
      this.emit('orderbook', {
        exchange: 'gate',
        symbol:   coin,
        bids:     (ob.bids || []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) })),
        asks:     (ob.asks || []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) })),
        timestamp: parseInt(ob.t) || Date.now(),
      });
    }
  }

  _onCoinAdded(coin) {
    if (this._ws?.readyState === WebSocket.OPEN) this._subscribeBatch([coin]);
  }

  _sendPing() {
    try {
      this._ws.send(JSON.stringify({
        time:    Math.floor(Date.now() / 1000),
        channel: 'spot.ping',
      }));
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════
//  통합 멀티 거래소 WebSocket 매니저
// ═══════════════════════════════════════════════════════════
class ExchangeWebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.binance = new BinanceWS();
    this.bybit   = new BybitWS();
    this.okx     = new OKXWS();
    this.gate    = new GateWS();

    this._exchanges = [this.binance, this.bybit, this.okx, this.gate];

    // 통합 가격 맵: coin → { Binance: price, Bybit: price, OKX: price, Gate: price }
    this._unified = new Map();

    // 내부 이벤트 포워딩
    for (const ex of this._exchanges) {
      ex.on('ticker', (data) => {
        const coin = data.symbol;
        if (!this._unified.has(coin)) this._unified.set(coin, {});
        this._unified.get(coin)[data.exchange] = data.price;
        this.emit('ticker', data);
      });

      ex.on('orderbook', (data) => {
        this.emit('orderbook', data);
      });

      ex.on('connected', () => {
        this.emit('exchangeConnected', ex._name);
      });

      ex.on('disconnected', () => {
        this.emit('exchangeDisconnected', ex._name);
      });
    }
  }

  /**
   * 모든 거래소 WebSocket 시작
   * @param {string[]} symbols - 추가 구독할 코인 심볼 (옵션)
   */
  start(symbols) {
    if (symbols && Array.isArray(symbols)) {
      for (const s of symbols) {
        for (const ex of this._exchanges) ex.addCoin(s);
      }
    }
    for (const ex of this._exchanges) ex.connect();
    console.log('[ExchangeWSManager] 4개 거래소 WebSocket 연결 시작 (Binance/Bybit/OKX/Gate)');
  }

  /** 모든 거래소 WebSocket 중지 */
  stop() {
    for (const ex of this._exchanges) ex.stop();
    console.log('[ExchangeWSManager] 모든 거래소 WebSocket 중지');
  }

  /** 코인 추가 (모든 거래소에 동시 적용) */
  addCoin(coin) {
    for (const ex of this._exchanges) ex.addCoin(coin);
  }

  /** 특정 거래소의 코인 가격 조회 */
  getPrice(exchange, coin) {
    const key = exchange.toLowerCase();
    if (key === 'binance' || key === 'binancews') return this.binance.getPrice(coin);
    if (key === 'bybit'   || key === 'bybitws')   return this.bybit.getPrice(coin);
    if (key === 'okx'     || key === 'okxws')      return this.okx.getPrice(coin);
    if (key === 'gate'    || key === 'gatews')      return this.gate.getPrice(coin);
    return null;
  }

  /** 특정 코인의 모든 거래소 가격 */
  getCoinPrices(coin) {
    return this._unified.get(coin.toUpperCase()) || {};
  }

  /** 전체 가격 맵 반환 */
  getAllPrices() {
    const result = {};
    for (const [coin, exchanges] of this._unified) {
      result[coin] = { ...exchanges };
    }
    return result;
  }

  /** 대시보드 요약 */
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
  BinanceWS,
  BybitWS,
  OKXWS,
  GateWS,
  ExchangeWebSocketManager,
};
