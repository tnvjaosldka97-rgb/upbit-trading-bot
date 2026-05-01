"use strict";

/**
 * TradeLogger — SQLite 기반 매수/매도 거래 기록
 *
 * 모든 전략(A/B)의 진입/청산을 영속적으로 기록
 * 대시보드에서 조회 가능
 */

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = null;
}

class TradeLogger {
  constructor(dbPath = "./trades.db") {
    this.db = null;
    this._ready = false;
    this._onLogged = null;

    if (!Database) {
      console.warn("[TradeLogger] better-sqlite3 없음 — 메모리 폴백");
      this._memLog = [];
      this._ready = true;
      return;
    }

    try {
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this._migrate();
      this._ready = true;
      console.log(`[TradeLogger] SQLite 활성화 — ${dbPath}`);
    } catch (e) {
      console.warn(`[TradeLogger] SQLite 실패 — 메모리 폴백: ${e.message}`);
      this._memLog = [];
      this._ready = true;
    }
  }

  /** 알림/외부 hook 등록 — 모든 logBuy/logSell 후 호출됨 */
  setOnLogged(cb) {
    this._onLogged = cb;
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy    TEXT    NOT NULL,
        market      TEXT    NOT NULL,
        side        TEXT    NOT NULL,
        price       REAL    NOT NULL,
        quantity    REAL    NOT NULL DEFAULT 0,
        budget      REAL    NOT NULL DEFAULT 0,
        reason      TEXT    DEFAULT NULL,
        pnl_rate    REAL    DEFAULT NULL,
        pnl_krw     REAL    DEFAULT NULL,
        quality_score INTEGER DEFAULT NULL,
        quality_flags TEXT   DEFAULT NULL,
        partial     INTEGER DEFAULT 0,
        trail       INTEGER DEFAULT 0,
        dry_run     INTEGER DEFAULT 1,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market);
      CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
      CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at DESC);
    `);
  }

  /**
   * 매수 기록
   */
  logBuy({ strategy, market, price, quantity, budget, qualityScore, qualityFlags, dryRun }) {
    if (!this._ready) return;

    const row = {
      strategy, market, side: "BUY", price, quantity, budget,
      reason: null, pnl_rate: null, pnl_krw: null,
      quality_score: qualityScore ?? null,
      quality_flags: Array.isArray(qualityFlags) ? qualityFlags.join(",") : (qualityFlags ? String(qualityFlags) : null),
      partial: 0, trail: 0,
      dry_run: dryRun ? 1 : 0,
      created_at: new Date().toLocaleString("sv-SE"),
    };

    if (this.db) {
      try {
        this.db.prepare(`
          INSERT INTO trades (strategy,market,side,price,quantity,budget,reason,pnl_rate,pnl_krw,quality_score,quality_flags,partial,trail,dry_run,created_at)
          VALUES (@strategy,@market,@side,@price,@quantity,@budget,@reason,@pnl_rate,@pnl_krw,@quality_score,@quality_flags,@partial,@trail,@dry_run,@created_at)
        `).run(row);
      } catch (e) {
        console.warn("[TradeLogger] BUY 기록 실패:", e.message);
      }
    } else {
      this._memLog.push(row);
      if (this._memLog.length > 500) this._memLog.shift();
    }

    if (this._onLogged) {
      try { this._onLogged(row); } catch (e) {
        console.warn("[TradeLogger] onLogged 콜백 오류:", e.message);
      }
    }
  }

  /**
   * 매도 기록 (청산/부분청산)
   */
  logSell({ strategy, market, price, quantity, budget, reason, pnlRate, pnlKrw, partial, trail, dryRun }) {
    if (!this._ready) return;

    const row = {
      strategy, market, side: "SELL", price, quantity, budget,
      reason: reason || null,
      pnl_rate: pnlRate ?? null,
      pnl_krw: pnlKrw ?? null,
      quality_score: null, quality_flags: null,
      partial: partial ? 1 : 0,
      trail: trail ? 1 : 0,
      dry_run: dryRun ? 1 : 0,
      created_at: new Date().toLocaleString("sv-SE"),
    };

    if (this.db) {
      try {
        this.db.prepare(`
          INSERT INTO trades (strategy,market,side,price,quantity,budget,reason,pnl_rate,pnl_krw,quality_score,quality_flags,partial,trail,dry_run,created_at)
          VALUES (@strategy,@market,@side,@price,@quantity,@budget,@reason,@pnl_rate,@pnl_krw,@quality_score,@quality_flags,@partial,@trail,@dry_run,@created_at)
        `).run(row);
      } catch (e) {
        console.warn("[TradeLogger] SELL 기록 실패:", e.message);
      }
    } else {
      this._memLog.push(row);
      if (this._memLog.length > 500) this._memLog.shift();
    }

    if (this._onLogged) {
      try { this._onLogged(row); } catch (e) {
        console.warn("[TradeLogger] onLogged 콜백 오류:", e.message);
      }
    }
  }

  /**
   * 최근 거래 조회 (대시보드용)
   */
  getRecent(limit = 50) {
    if (this.db) {
      try {
        return this.db.prepare(
          `SELECT * FROM trades ORDER BY created_at DESC, id DESC LIMIT ?`
        ).all(limit);
      } catch { return []; }
    }
    return [...(this._memLog || [])].reverse().slice(0, limit);
  }

  /**
   * 전략별 통계
   */
  getStats(strategy = null) {
    if (!this.db) {
      const sells = (this._memLog || []).filter(r => r.side === "SELL" && (!strategy || r.strategy === strategy));
      const wins = sells.filter(r => (r.pnl_rate || 0) >= 0).length;
      const total = sells.length;
      const totalPnl = sells.reduce((s, r) => s + (r.pnl_krw || 0), 0);
      return { total, wins, losses: total - wins, winRate: total > 0 ? +(wins / total * 100).toFixed(1) : null, totalPnl: Math.round(totalPnl) };
    }
    try {
      const where = strategy ? `WHERE strategy = '${strategy}' AND side = 'SELL'` : `WHERE side = 'SELL'`;
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN pnl_rate >= 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl_rate < 0 THEN 1 ELSE 0 END) as losses,
          SUM(pnl_krw) as totalPnl,
          AVG(pnl_rate) as avgPnlRate
        FROM trades ${where}
      `).get();
      return {
        total: row.total || 0,
        wins: row.wins || 0,
        losses: row.losses || 0,
        winRate: row.total > 0 ? +((row.wins / row.total) * 100).toFixed(1) : null,
        totalPnl: Math.round(row.totalPnl || 0),
        avgPnlRate: row.avgPnlRate != null ? +(row.avgPnlRate * 100).toFixed(2) : null,
      };
    } catch { return { total: 0, wins: 0, losses: 0, winRate: null, totalPnl: 0 }; }
  }

  /**
   * 일별 손익 (차트용)
   */
  getDailyPnl(days = 30) {
    if (!this.db) return [];
    try {
      return this.db.prepare(`
        SELECT
          date(created_at) as date,
          SUM(pnl_krw) as pnl,
          COUNT(*) as trades
        FROM trades
        WHERE side = 'SELL' AND created_at >= date('now', '-${days} days', 'localtime')
        GROUP BY date(created_at)
        ORDER BY date ASC
      `).all();
    } catch { return []; }
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
    }
  }
}

module.exports = { TradeLogger };
