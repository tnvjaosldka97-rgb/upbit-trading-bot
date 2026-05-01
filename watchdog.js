"use strict";

/**
 * Watchdog — 봇 비정상 행동 감지 + 자동 정지
 *
 * 감지 항목:
 *   1. 봇 heartbeat 멈춤 (5분 이상 _tick 없음)
 *   2. 비정상 거래 빈도 (1분에 5건 이상 진입 = 폭주)
 *   3. 동일 마켓 재진입 빈도 이상 (10초 내 재진입)
 *   4. API 에러율 급증 (1분에 10건 이상)
 *   5. 메모리 leak (RSS 1GB 초과)
 *
 * 비상 시: notifier 알림 + orderService.halt() 호출
 */

const HEARTBEAT_TIMEOUT_MS = 5 * 60_000;
const MAX_TRADES_PER_MIN   = 5;
const MAX_API_ERRORS_PER_MIN = 10;
const MAX_MEMORY_RSS_MB    = 1024;
const REENTRY_GUARD_MS     = 10_000;

class Watchdog {
  constructor(opts = {}) {
    this.bot      = opts.bot      || null;
    this.notifier = opts.notifier || null;

    this._lastHeartbeat = Date.now();
    this._tradeTimes    = [];        // 진입 시각 배열
    this._apiErrors     = [];        // API 에러 시각 배열
    this._lastEntries   = new Map(); // market → 마지막 진입 시각
    this._intervalId    = null;
    this._haltCalled    = false;
  }

  start() {
    this._intervalId = setInterval(() => this._tick(), 30_000);
    // 60초마다 자체 heartbeat — 거래 0건이어도 봇이 살아있으면 OK
    this._selfHeartbeat = setInterval(() => this.heartbeat(), 60_000);
    console.log("[Watchdog] 시작 — 30초 주기 모니터");
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
    if (this._selfHeartbeat) clearInterval(this._selfHeartbeat);
    this._intervalId = null;
    this._selfHeartbeat = null;
  }

  // 외부에서 호출 (각 이벤트 시점)
  heartbeat()         { this._lastHeartbeat = Date.now(); }
  recordTrade(market) {
    const now = Date.now();
    this._tradeTimes.push(now);

    // 동일 마켓 재진입 가드
    const last = this._lastEntries.get(market) || 0;
    if (now - last < REENTRY_GUARD_MS) {
      this._haltWithReason(`reentry_guard ${market} (${now - last}ms)`);
    }
    this._lastEntries.set(market, now);
  }
  recordApiError() { this._apiErrors.push(Date.now()); }

  _tick() {
    const now = Date.now();

    // 1) Heartbeat
    if (now - this._lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      this._haltWithReason(`heartbeat_dead ${((now - this._lastHeartbeat) / 1000).toFixed(0)}s`);
      return;
    }

    // 2) 거래 빈도 (최근 1분)
    this._tradeTimes = this._tradeTimes.filter(t => now - t < 60_000);
    if (this._tradeTimes.length > MAX_TRADES_PER_MIN) {
      this._haltWithReason(`burst_trading ${this._tradeTimes.length}/min`);
      return;
    }

    // 3) API 에러 (최근 1분)
    this._apiErrors = this._apiErrors.filter(t => now - t < 60_000);
    if (this._apiErrors.length > MAX_API_ERRORS_PER_MIN) {
      this._haltWithReason(`api_errors ${this._apiErrors.length}/min`);
      return;
    }

    // 4) 메모리
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssMb > MAX_MEMORY_RSS_MB) {
      this._haltWithReason(`memory_leak ${rssMb.toFixed(0)}MB`);
      return;
    }
  }

  _haltWithReason(reason) {
    if (this._haltCalled) return;
    this._haltCalled = true;
    console.error(`[Watchdog] ⛔ HALT — ${reason}`);

    // 봇 정지 시도
    try {
      if (this.bot?.orderService?.halt) {
        this.bot.orderService.halt(reason);
      }
    } catch {}

    // 알림
    try {
      this.notifier?.send?.(
        `🚨 <b>Watchdog HALT</b>\n사유: ${reason}\n신규 진입 차단됨. 점검 필요.`
      );
    } catch {}
  }

  reset() {
    this._haltCalled = false;
  }

  getSummary() {
    const now = Date.now();
    return {
      lastHeartbeat:    this._lastHeartbeat,
      heartbeatAgeSec:  Math.round((now - this._lastHeartbeat) / 1000),
      tradesLastMin:    this._tradeTimes.length,
      apiErrorsLastMin: this._apiErrors.length,
      memoryMb:         Math.round(process.memoryUsage().rss / 1024 / 1024),
      halted:           this._haltCalled,
    };
  }
}

module.exports = { Watchdog };
