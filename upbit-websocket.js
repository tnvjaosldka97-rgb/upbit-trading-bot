"use strict";

/**
 * UpbitWebSocket — 업비트 실시간 시세 + 호가창 스트림
 *
 * 구독 타입:
 *   ticker    → trade_price (~100ms)  : 손절/목표 실시간 감시
 *   orderbook → 호가 불균형 (~100ms) : 진입 타이밍 신호 (REST 봇이 못 보는 엣지)
 *
 * 호가 불균형(imbalance):
 *   = (총 매수잔량 - 총 매도잔량) / 총잔량
 *   +1에 가까울수록 매수압 지배, -1에 가까울수록 매도압 지배
 *
 * 자동 재연결: 지수 백오프 (1s → 2s → 4s → ... → 30s)
 */

let WebSocketLib;
try {
  WebSocketLib = require("ws");
} catch {
  WebSocketLib = null;
}

const { randomUUID } = require("crypto");

class UpbitWebSocket {
  constructor() {
    this._ws             = null;
    this._markets        = new Set();
    this._reconnectDelay = 1_000;
    this._stopped        = false;
    this._pingId         = null;
    this._connected      = false;

    // ticker
    this._prices         = new Map();   // market → price
    this._priceListeners = [];          // (market, price) => void

    // orderbook
    this._orderbooks     = new Map();   // market → { bidSize, askSize, imbalance, ts }
    this._obListeners    = [];          // (market, imbalance, {bidSize, askSize}) => void
  }

  // ── 구독 ───────────────────────────────────────────────
  subscribe(market) {
    this._markets.add(market);
    if (this._connected) this._sendSubscription();
  }

  // ── 콜백 등록 ──────────────────────────────────────────
  onPrice(cb)     { this._priceListeners.push(cb); }
  onOrderbook(cb) { this._obListeners.push(cb); }

  // ── 조회 ───────────────────────────────────────────────
  getPrice(market)     { return this._prices.get(market)     ?? null; }
  getOrderbook(market) { return this._orderbooks.get(market) ?? null; }
  getImbalance(market) { return this._orderbooks.get(market)?.imbalance ?? null; }
  isConnected()        { return this._connected; }

  // ── 연결 ───────────────────────────────────────────────
  connect() {
    if (!WebSocketLib) {
      console.warn("[WS] 'ws' 패키지 없음 — npm install 후 재시작 (REST 폴백 사용)");
      return;
    }
    if (this._stopped) return;

    console.log("[WS] 업비트 WebSocket 연결 중...");
    const ws = new WebSocketLib("wss://api.upbit.com/websocket/v1");
    this._ws = ws;

    ws.on("open", () => {
      console.log("[WS] 연결 완료 — ticker + orderbook 실시간 수신 시작");
      this._connected      = true;
      this._reconnectDelay = 1_000;
      this._sendSubscription();

      // 30초마다 ping (업비트 WS 60초 비활성 자동 끊김 방지)
      this._pingId = setInterval(() => {
        if (ws.readyState === WebSocketLib.OPEN) ws.ping();
      }, 30_000);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "ticker") {
          const market = msg.code;
          const price  = msg.trade_price;
          if (!market || !price) return;
          this._prices.set(market, price);
          for (const cb of this._priceListeners) {
            try { cb(market, price); } catch (e) {
              console.error("[WS] price 콜백 오류:", e.message);
            }
          }

        } else if (msg.type === "orderbook") {
          const market  = msg.code;
          const bidSize = msg.total_bid_size ?? 0;
          const askSize = msg.total_ask_size ?? 0;
          const total   = bidSize + askSize;
          if (!market || total === 0) return;

          const imbalance = (bidSize - askSize) / total;  // -1 ~ +1
          this._orderbooks.set(market, {
            bidSize, askSize, imbalance, ts: Date.now(),
          });
          for (const cb of this._obListeners) {
            try { cb(market, imbalance, { bidSize, askSize }); } catch (e) {
              console.error("[WS] orderbook 콜백 오류:", e.message);
            }
          }
        }
      } catch {}  // JSON 파싱 실패 무시
    });

    ws.on("close", (code) => {
      this._onDisconnect(`close(${code})`);
    });

    ws.on("error", (err) => {
      console.error("[WS] 오류:", err.message);
      this._onDisconnect("error");
    });
  }

  // ── 내부 ───────────────────────────────────────────────

  _sendSubscription() {
    if (!this._markets.size || !this._ws) return;
    const codes   = [...this._markets];
    const payload = JSON.stringify([
      { ticket: randomUUID() },
      { type: "ticker",    codes },
      { type: "orderbook", codes },
      { format: "DEFAULT" },
    ]);
    this._ws.send(payload);
    console.log(`[WS] 구독 갱신: ${codes.join(", ")} (ticker + orderbook)`);
  }

  _onDisconnect(reason) {
    this._connected = false;
    if (this._pingId) { clearInterval(this._pingId); this._pingId = null; }
    if (!this._stopped) {
      console.warn(`[WS] 연결 끊김(${reason}) — ${this._reconnectDelay}ms 후 재연결`);
      setTimeout(() => this.connect(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30_000);
    }
  }

  stop() {
    this._stopped = true;
    if (this._pingId) { clearInterval(this._pingId); this._pingId = null; }
    if (this._ws) { this._ws.terminate(); this._ws = null; }
    this._connected = false;
    console.log("[WS] 종료");
  }
}

module.exports = { UpbitWebSocket };
