'use strict';

/**
 * UpbitWebSocket — Upbit 실시간 WebSocket 클라이언트
 *
 * 기능:
 *   - ticker, orderbook 구독 (wss://api.upbit.com/websocket/v1)
 *   - 자동 재접속 (지수 백오프 1s → 2s → 4s → ... → 60s)
 *   - ping/pong 하트비트 (30초 간격)
 *   - EventEmitter 패턴: emit('ticker', data), emit('orderbook', data)
 *
 * 필요 패키지: npm install ws
 */

const { EventEmitter } = require('events');
const { randomUUID }   = require('crypto');

let WebSocketLib;
try {
  WebSocketLib = require('ws');
} catch {
  console.error('[UpbitWebSocket] npm install ws 필요');
  WebSocketLib = null;
}

const WS_URL             = 'wss://api.upbit.com/websocket/v1';
const PING_INTERVAL_MS   = 30_000;
const RECONNECT_BASE_MS  = 1_000;
const RECONNECT_MAX_MS   = 60_000;
const RECONNECT_FACTOR   = 2;

class UpbitWebSocket extends EventEmitter {
  /**
   * @param {Object}   opts
   * @param {string[]} opts.markets        - 구독 마켓 목록 (예: ['KRW-BTC','KRW-ETH'])
   * @param {string[]} opts.subscribeTypes - 구독 타입 (기본: ['ticker','orderbook'])
   */
  constructor(opts = {}) {
    super();
    this.markets        = opts.markets || ['KRW-BTC', 'KRW-ETH'];
    this.subscribeTypes = opts.subscribeTypes || ['ticker', 'orderbook'];

    this._ws              = null;
    this._pingTimer       = null;
    this._reconnectTimer  = null;
    this._reconnectMs     = RECONNECT_BASE_MS;
    this._intentionalClose = false;
    this._connected       = false;

    // 최근 데이터 캐시
    this._prices     = new Map();   // market → price
    this._orderbooks = new Map();   // market → { bidSize, askSize, imbalance, ts }
  }

  // ── 접속 ───────────────────────────────────────────────

  connect() {
    if (!WebSocketLib) {
      console.warn('[UpbitWebSocket] ws 패키지 없음 — WebSocket 비활성화');
      return;
    }
    if (this._ws && (this._ws.readyState === WebSocketLib.OPEN ||
                     this._ws.readyState === WebSocketLib.CONNECTING)) {
      return;
    }

    this._intentionalClose = false;
    console.log(`[UpbitWebSocket] 연결 시도 → ${WS_URL}`);

    try {
      this._ws = new WebSocketLib(WS_URL);
    } catch (err) {
      console.error('[UpbitWebSocket] WebSocket 생성 실패:', err.message);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      console.log('[UpbitWebSocket] 연결 성공');
      this._connected    = true;
      this._reconnectMs  = RECONNECT_BASE_MS;
      this._sendSubscription();
      this._startPing();
      this.emit('connected');
    });

    this._ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this._handleMessage(data);
      } catch (err) {
        console.error('[UpbitWebSocket] 메시지 파싱 실패:', err.message);
      }
    });

    this._ws.on('pong', () => {
      // 서버 pong 수신 — 연결 정상
    });

    this._ws.on('close', (code, reason) => {
      this._connected = false;
      this._stopPing();
      const reasonStr = reason ? reason.toString() : 'N/A';
      console.warn(`[UpbitWebSocket] 연결 종료 (code=${code}, reason=${reasonStr})`);
      this.emit('disconnected', { code, reason: reasonStr });
      if (!this._intentionalClose) {
        this._scheduleReconnect();
      }
    });

    this._ws.on('error', (err) => {
      console.error('[UpbitWebSocket] WebSocket 에러:', err.message);
      this.emit('error', err);
    });
  }

  disconnect() {
    this._intentionalClose = true;
    this._stopPing();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(1000, 'intentional'); } catch {}
      this._ws = null;
    }
    this._connected = false;
    console.log('[UpbitWebSocket] 의도적 연결 종료');
  }

  /** 현재 연결 상태 */
  get isConnected() {
    return this._connected && this._ws && this._ws.readyState === WebSocketLib.OPEN;
  }

  // ── 구독 ───────────────────────────────────────────────

  _sendSubscription() {
    if (!this.isConnected || !this.markets.length) return;

    const payload = [
      { ticket: randomUUID() },
    ];

    for (const type of this.subscribeTypes) {
      payload.push({
        type,
        codes:          this.markets,
        isOnlyRealtime: true,
      });
    }

    payload.push({ format: 'DEFAULT' });

    this._ws.send(JSON.stringify(payload), (err) => {
      if (err) {
        console.error('[UpbitWebSocket] 구독 전송 실패:', err.message);
      } else {
        console.log(`[UpbitWebSocket] 구독 완료 — types=${this.subscribeTypes.join(',')} markets=${this.markets.length}개`);
      }
    });
  }

  /**
   * 마켓 목록 갱신 (런타임 중 변경 가능)
   * @param {string[]} markets
   */
  subscribe(market) {
    if (!this.markets.includes(market)) {
      this.markets.push(market);
    }
    if (this.isConnected) this._sendSubscription();
  }

  updateMarkets(markets) {
    this.markets = markets;
    if (this.isConnected) this._sendSubscription();
  }

  // ── 메시지 처리 ───────────────────────────────────────

  _handleMessage(data) {
    const type = data.type;

    if (type === 'ticker') {
      const normalized = {
        exchange:    'upbit',
        symbol:      data.code,
        price:       data.trade_price,
        bid:         data.best_bid || data.trade_price,
        ask:         data.best_ask || data.trade_price,
        volume:      data.acc_trade_volume_24h,
        change:      data.signed_change_rate,
        high:        data.high_price,
        low:         data.low_price,
        timestamp:   data.timestamp || Date.now(),
      };
      this._prices.set(data.code, data.trade_price);
      this.emit('ticker', normalized);

    } else if (type === 'orderbook') {
      const units   = data.orderbook_units || [];
      const bidSize = data.total_bid_size ?? 0;
      const askSize = data.total_ask_size ?? 0;
      const total   = bidSize + askSize;
      const imbalance = total > 0 ? (bidSize - askSize) / total : 0;

      const normalized = {
        exchange:   'upbit',
        symbol:     data.code,
        bid:        units[0]?.bid_price || 0,
        ask:        units[0]?.ask_price || 0,
        bids:       units.map(u => ({ price: u.bid_price, size: u.bid_size })),
        asks:       units.map(u => ({ price: u.ask_price, size: u.ask_size })),
        bidSize,
        askSize,
        imbalance,
        timestamp:  data.timestamp || Date.now(),
      };
      this._orderbooks.set(data.code, { bidSize, askSize, imbalance, ts: Date.now() });
      this.emit('orderbook', normalized);

    } else if (type === 'trade') {
      this.emit('trade', data);
    }
  }

  // ── 데이터 조회 ────────────────────────────────────────

  getPrice(market)     { return this._prices.get(market) ?? null; }
  getOrderbook(market) { return this._orderbooks.get(market) ?? null; }
  getImbalance(market) { return this._orderbooks.get(market)?.imbalance ?? null; }

  // ── 하트비트 ───────────────────────────────────────────

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.isConnected) {
        try { this._ws.ping(); } catch (err) {
          console.error('[UpbitWebSocket] ping 전송 실패:', err.message);
        }
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // ── 재접속 (지수 백오프) ───────────────────────────────

  _scheduleReconnect() {
    if (this._intentionalClose) return;

    const delay = this._reconnectMs + Math.random() * 1000;
    console.log(`[UpbitWebSocket] ${(delay / 1000).toFixed(1)}초 후 재접속 시도...`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectMs = Math.min(this._reconnectMs * RECONNECT_FACTOR, RECONNECT_MAX_MS);
      this.connect();
    }, delay);
  }

  /** 명시적 종료 */
  stop() {
    this.disconnect();
  }
}

module.exports = { UpbitWebSocket };
