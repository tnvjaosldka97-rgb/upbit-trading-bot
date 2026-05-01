"use strict";

/**
 * PositionLedger — 포지션 state machine 영속 추적
 *
 * 0.1% 퀀트 표준 — 포지션 무결성:
 *   1. 모든 진입/청산 단계 DB 영속 기록
 *   2. State machine: OPENING → OPEN → CLOSING → CLOSED / FAILED
 *   3. 봇 크래시 시 재시작 후 정확히 어느 단계에서 끊겼는지 알 수 있음
 *   4. OrderRouter의 idempotency_key와 연결 (entry/exit 주문 추적)
 *
 * State 정의:
 *   OPENING — 진입 주문 제출, 체결 대기
 *   OPEN    — 진입 체결 완료, 포지션 보유 중 (target/stop 매도 대기)
 *   CLOSING — 청산 주문 제출, 체결 대기
 *   CLOSED  — 청산 완료
 *   FAILED  — 진입 실패 또는 비정상 종료
 *   STUCK   — 5분+ OPEN 상태인데 매도 주문 없음 (단방향 노출 — Watchdog 감지)
 */

let Database;
try { Database = require("better-sqlite3"); } catch { Database = null; }

const POSITION_STATES = {
  OPENING: "OPENING",
  OPEN:    "OPEN",
  CLOSING: "CLOSING",
  CLOSED:  "CLOSED",
  FAILED:  "FAILED",
  STUCK:   "STUCK",
};

class PositionLedger {
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || "./positions.db";
    this.db = null;
    this._ready = false;

    if (!Database) return;
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this._migrate();
      this._ready = true;
      console.log(`[PositionLedger] 활성 — ${this.dbPath}`);
    } catch (e) {
      console.warn(`[PositionLedger] init: ${e.message}`);
    }
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy        TEXT NOT NULL,
        market          TEXT NOT NULL,
        state           TEXT NOT NULL,

        entry_order_key TEXT,
        entry_qty       REAL,
        entry_price     REAL,
        entry_filled_qty REAL DEFAULT 0,
        entry_avg_price REAL,

        target_price    REAL,
        stop_price      REAL,

        exit_order_key  TEXT,
        exit_qty        REAL,
        exit_price      REAL,
        exit_avg_price  REAL,
        exit_reason     TEXT,

        pnl_rate        REAL,
        pnl_krw         REAL,

        opened_at       TEXT,
        filled_at       TEXT,
        closing_at      TEXT,
        closed_at       TEXT,

        created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_pos_state ON positions(state);
      CREATE INDEX IF NOT EXISTS idx_pos_market ON positions(market);
      CREATE INDEX IF NOT EXISTS idx_pos_strategy ON positions(strategy);
    `);
  }

  _now() { return new Date().toLocaleString("sv-SE"); }

  // ── 라이프사이클 ──────────────────────────────────

  /**
   * 진입 주문 제출 직후 호출 (state: OPENING)
   */
  openPosition({ strategy, market, entryOrderKey, entryQty, entryPrice, targetPrice, stopPrice }) {
    if (!this._ready) return null;
    try {
      const result = this.db.prepare(`
        INSERT INTO positions (
          strategy, market, state,
          entry_order_key, entry_qty, entry_price,
          target_price, stop_price, opened_at
        ) VALUES (
          @strategy, @market, @state,
          @entry_order_key, @entry_qty, @entry_price,
          @target_price, @stop_price, @opened_at
        )
      `).run({
        strategy, market,
        state: POSITION_STATES.OPENING,
        entry_order_key: entryOrderKey,
        entry_qty: entryQty,
        entry_price: entryPrice,
        target_price: targetPrice || null,
        stop_price: stopPrice || null,
        opened_at: this._now(),
      });
      return result.lastInsertRowid;
    } catch (e) {
      console.error("[PositionLedger] openPosition:", e.message);
      return null;
    }
  }

  /**
   * 진입 체결 완료 시 호출 (OPENING → OPEN)
   */
  markOpen(positionId, { entryFilledQty, entryAvgPrice }) {
    if (!this._ready) return;
    try {
      this.db.prepare(`
        UPDATE positions SET
          state = ?, entry_filled_qty = ?, entry_avg_price = ?, filled_at = ?
        WHERE id = ? AND state = 'OPENING'
      `).run(POSITION_STATES.OPEN, entryFilledQty, entryAvgPrice, this._now(), positionId);
    } catch (e) {
      console.error("[PositionLedger] markOpen:", e.message);
    }
  }

  /**
   * 청산 주문 제출 시 호출 (OPEN → CLOSING)
   */
  markClosing(positionId, { exitOrderKey, exitQty, exitPrice, exitReason }) {
    if (!this._ready) return;
    try {
      this.db.prepare(`
        UPDATE positions SET
          state = ?, exit_order_key = ?, exit_qty = ?, exit_price = ?,
          exit_reason = ?, closing_at = ?
        WHERE id = ?
      `).run(
        POSITION_STATES.CLOSING,
        exitOrderKey, exitQty, exitPrice, exitReason, this._now(),
        positionId
      );
    } catch (e) {
      console.error("[PositionLedger] markClosing:", e.message);
    }
  }

  /**
   * 청산 체결 완료 (CLOSING → CLOSED)
   */
  markClosed(positionId, { exitAvgPrice, pnlRate, pnlKrw }) {
    if (!this._ready) return;
    try {
      this.db.prepare(`
        UPDATE positions SET
          state = ?, exit_avg_price = ?, pnl_rate = ?, pnl_krw = ?, closed_at = ?
        WHERE id = ?
      `).run(POSITION_STATES.CLOSED, exitAvgPrice, pnlRate, pnlKrw, this._now(), positionId);
    } catch (e) {
      console.error("[PositionLedger] markClosed:", e.message);
    }
  }

  /**
   * 진입 실패 (OPENING → FAILED)
   */
  markFailed(positionId, reason) {
    if (!this._ready) return;
    try {
      this.db.prepare(`
        UPDATE positions SET state = ?, exit_reason = ?, closed_at = ?
        WHERE id = ?
      `).run(POSITION_STATES.FAILED, reason, this._now(), positionId);
    } catch (e) {
      console.error("[PositionLedger] markFailed:", e.message);
    }
  }

  /**
   * STUCK 표시 (단방향 노출 위험 — Watchdog이 호출)
   */
  markStuck(positionId, reason) {
    if (!this._ready) return;
    try {
      this.db.prepare(`UPDATE positions SET state = ?, exit_reason = ? WHERE id = ?`)
        .run(POSITION_STATES.STUCK, reason, positionId);
    } catch (e) {
      console.error("[PositionLedger] markStuck:", e.message);
    }
  }

  // ── 조회 ────────────────────────────────────────

  /**
   * 활성 포지션 (OPEN 상태 — 매도 주문 발사 후 미체결도 OPEN으로 봄)
   */
  getActivePositions() {
    if (!this._ready) return [];
    return this.db.prepare(`
      SELECT * FROM positions WHERE state IN ('OPENING','OPEN','CLOSING','STUCK') ORDER BY id DESC
    `).all();
  }

  /**
   * 단방향 노출 의심 포지션 (OPEN 상태 + 매도 주문 X + N분+)
   */
  getUnhedgedPositions(stuckThresholdMinutes = 5) {
    if (!this._ready) return [];
    return this.db.prepare(`
      SELECT * FROM positions
      WHERE state = 'OPEN'
        AND exit_order_key IS NULL
        AND filled_at IS NOT NULL
        AND filled_at <= datetime('now', '-${stuckThresholdMinutes} minutes', 'localtime')
    `).all();
  }

  getRecent(limit = 50) {
    if (!this._ready) return [];
    return this.db.prepare(`SELECT * FROM positions ORDER BY id DESC LIMIT ?`).all(limit);
  }

  getSummary() {
    if (!this._ready) return { ready: false };
    try {
      const counts = this.db.prepare(`
        SELECT state, COUNT(*) as c FROM positions GROUP BY state
      `).all().reduce((acc, r) => { acc[r.state] = r.c; return acc; }, {});
      const unhedged = this.getUnhedgedPositions(5).length;
      return { ready: true, counts, unhedgedCount: unhedged };
    } catch (e) {
      return { ready: true, error: e.message };
    }
  }

  close() {
    try { this.db?.close(); } catch {}
  }
}

module.exports = { PositionLedger, POSITION_STATES };
