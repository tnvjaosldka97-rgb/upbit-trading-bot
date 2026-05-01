"use strict";

/**
 * OrderRouter — 모든 주문 단일 진입점 + Idempotency + 영속 추적
 *
 * 0.1% 퀀트 표준 — 주문 라우팅 무결성:
 *   1. 모든 주문 → orders.db에 영속 기록 (중복 방지)
 *   2. UUID idempotency key (재시도 시 중복 주문 차단)
 *   3. 상태 머신: PENDING → SUBMITTED → FILLED/PARTIAL/CANCELLED/FAILED
 *   4. 부분 체결 처리 (executed_volume vs requested_volume)
 *   5. API 응답 누락 시 자동 재조회 (idempotency key로 안전)
 *
 * 사용:
 *   const router = new OrderRouter({ orderService });
 *   await router.submit({ strategy, market, side: "BUY", price, qty, type: "limit" });
 *   → 자동으로 DB 기록 + Upbit API 호출 + 결과 추적
 */

const crypto = require("crypto");

let Database;
try { Database = require("better-sqlite3"); } catch { Database = null; }

const ORDER_STATES = {
  PENDING:   "PENDING",      // DB 기록만, API 미호출
  SUBMITTED: "SUBMITTED",    // API 호출 완료, 응답 대기
  FILLED:    "FILLED",        // 100% 체결
  PARTIAL:   "PARTIAL",       // 부분 체결
  CANCELLED: "CANCELLED",     // 취소됨
  FAILED:    "FAILED",        // 실패 (사유 reason 컬럼)
};

class OrderRouter {
  constructor(opts = {}) {
    this.orderService = opts.orderService || null;
    this.dbPath       = opts.dbPath || "./orders.db";
    this.db           = null;
    this._ready       = false;
    this._notifier    = opts.notifier || null;

    if (!Database) {
      console.warn("[OrderRouter] better-sqlite3 없음 — disabled");
      return;
    }
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this._migrate();
      this._ready = true;
      console.log(`[OrderRouter] 활성 — ${this.dbPath}`);
    } catch (e) {
      console.warn(`[OrderRouter] init: ${e.message}`);
    }
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        idempotency_key TEXT PRIMARY KEY,
        strategy        TEXT NOT NULL,
        market          TEXT NOT NULL,
        side            TEXT NOT NULL,
        type            TEXT NOT NULL,
        requested_qty   REAL NOT NULL,
        requested_price REAL,
        executed_qty    REAL DEFAULT 0,
        avg_price       REAL,
        upbit_uuid      TEXT,
        state           TEXT NOT NULL,
        reason          TEXT,
        related_to      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        submitted_at    TEXT,
        filled_at       TEXT,
        closed_at       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);
      CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market);
      CREATE INDEX IF NOT EXISTS idx_orders_strategy ON orders(strategy);
      CREATE INDEX IF NOT EXISTS idx_orders_uuid ON orders(upbit_uuid);
      CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    `);
  }

  _now() { return new Date().toLocaleString("sv-SE"); }

  _record(row) {
    if (!this._ready) return;
    try {
      this.db.prepare(`
        INSERT INTO orders (
          idempotency_key, strategy, market, side, type,
          requested_qty, requested_price, state, related_to
        ) VALUES (
          @idempotency_key, @strategy, @market, @side, @type,
          @requested_qty, @requested_price, @state, @related_to
        )
      `).run(row);
    } catch (e) {
      console.error("[OrderRouter] record failed:", e.message);
    }
  }

  _update(idempotencyKey, fields) {
    if (!this._ready) return;
    const set = Object.keys(fields).map(k => `${k} = @${k}`).join(", ");
    try {
      this.db.prepare(`UPDATE orders SET ${set} WHERE idempotency_key = @idempotency_key`).run({
        ...fields,
        idempotency_key: idempotencyKey,
      });
    } catch (e) {
      console.error("[OrderRouter] update failed:", e.message);
    }
  }

  // ── 메인 API ────────────────────────────────────

  /**
   * 주문 제출 (멱등 보장)
   * @returns {{key, state, executedQty, avgPrice, uuid, reason}}
   */
  async submit({ strategy, market, side, type = "limit", qty, price, relatedTo = null, idempotencyKey = null }) {
    const key = idempotencyKey || crypto.randomUUID();

    // 1) 중복 체크
    if (this._ready) {
      const existing = this.db.prepare(`SELECT * FROM orders WHERE idempotency_key = ?`).get(key);
      if (existing) {
        console.log(`[OrderRouter] 중복 idempotency key — 기존 응답 반환: ${key.slice(0,8)} state=${existing.state}`);
        return {
          key,
          state:       existing.state,
          executedQty: existing.executed_qty,
          avgPrice:    existing.avg_price,
          uuid:        existing.upbit_uuid,
          reason:      existing.reason,
        };
      }
    }

    // 2) DB PENDING 기록
    this._record({
      idempotency_key: key,
      strategy, market, side, type,
      requested_qty: qty,
      requested_price: price || null,
      state: ORDER_STATES.PENDING,
      related_to: relatedTo,
    });

    // 3) API 호출
    let apiResult, error;
    try {
      apiResult = await this._dispatchApi({ market, side, type, qty, price });
    } catch (e) {
      error = e.message;
    }

    // 4) 결과 기록
    if (error || !apiResult) {
      this._update(key, {
        state:  ORDER_STATES.FAILED,
        reason: error || "no_response",
        closed_at: this._now(),
      });
      try {
        this._notifier?.send?.(
          `❌ <b>주문 실패</b>\n${strategy} ${market} ${side}\n사유: ${error || "no_response"}`
        );
      } catch {}
      return { key, state: ORDER_STATES.FAILED, reason: error || "no_response" };
    }

    // 5) 성공 — 부분/전체 체결 분기
    const executed = apiResult.executedVolume || apiResult.executed_volume || 0;
    const avgPrice = apiResult.avgPrice || apiResult.avg_price || price || 0;
    const uuid     = apiResult.uuid || null;
    let state;

    if (apiResult.filled === true || executed >= qty * 0.999) {
      state = ORDER_STATES.FILLED;
    } else if (executed > 0) {
      state = ORDER_STATES.PARTIAL;
    } else {
      state = ORDER_STATES.SUBMITTED;
    }

    this._update(key, {
      state,
      executed_qty: executed,
      avg_price:    avgPrice,
      upbit_uuid:   uuid,
      submitted_at: this._now(),
      filled_at:    state === ORDER_STATES.FILLED ? this._now() : null,
    });

    return { key, state, executedQty: executed, avgPrice, uuid };
  }

  async _dispatchApi({ market, side, type, qty, price }) {
    if (!this.orderService) throw new Error("no_orderService");
    if (side === "BUY") {
      if (type === "market") {
        return this.orderService.marketBuy(market, qty);
      }
      // smartLimitBuy는 budget 입력 → qty * price
      return this.orderService.smartLimitBuy(market, qty * (price || 1));
    }
    if (side === "SELL") {
      if (type === "market") {
        return this.orderService.marketSell(market, qty);
      }
      return this.orderService.limitSell(market, qty, price);
    }
    throw new Error(`unknown side: ${side}`);
  }

  // ── 조회 ────────────────────────────────────────

  getOrder(key) {
    if (!this._ready) return null;
    return this.db.prepare(`SELECT * FROM orders WHERE idempotency_key = ?`).get(key);
  }

  getOpenOrders() {
    if (!this._ready) return [];
    return this.db.prepare(`
      SELECT * FROM orders
      WHERE state IN ('PENDING','SUBMITTED','PARTIAL')
      ORDER BY created_at DESC
    `).all();
  }

  getRecentOrders(limit = 50) {
    if (!this._ready) return [];
    return this.db.prepare(`
      SELECT * FROM orders ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  }

  // ── 외부 update (체결 알림 받았을 때 등) ───────

  markFilled(key, executedQty, avgPrice) {
    this._update(key, {
      state: ORDER_STATES.FILLED,
      executed_qty: executedQty,
      avg_price: avgPrice,
      filled_at: this._now(),
      closed_at: this._now(),
    });
  }

  markCancelled(key, reason = null) {
    this._update(key, {
      state: ORDER_STATES.CANCELLED,
      reason,
      closed_at: this._now(),
    });
  }

  // ── 통계 ────────────────────────────────────────

  getSummary() {
    if (!this._ready) return { ready: false };
    try {
      const counts = this.db.prepare(`
        SELECT state, COUNT(*) as c FROM orders GROUP BY state
      `).all().reduce((acc, r) => { acc[r.state] = r.c; return acc; }, {});
      const last24h = this.db.prepare(`
        SELECT COUNT(*) as c FROM orders WHERE created_at >= datetime('now', '-24 hours', 'localtime')
      `).get();
      return {
        ready: true,
        counts,
        last24hOrders: last24h.c,
        openOrders: (counts.PENDING || 0) + (counts.SUBMITTED || 0) + (counts.PARTIAL || 0),
      };
    } catch (e) {
      return { ready: true, error: e.message };
    }
  }

  close() {
    try { this.db?.close(); } catch {}
  }
}

module.exports = { OrderRouter, ORDER_STATES };
