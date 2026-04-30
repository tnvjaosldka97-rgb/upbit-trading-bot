"use strict";

/**
 * lib/performance.js — 전략별 성과 측정 + DB 인프라
 *
 * 0.1% 퀀트 표준 지표:
 *   - EV (per trade expected value)
 *   - Win rate, payoff ratio
 *   - Sharpe ratio (annualized)
 *   - Sortino ratio (downside-only volatility)
 *   - Max drawdown (MDD)
 *   - Profit factor (sum_wins / sum_losses)
 *   - Realized vs Expected (실거래와 백테스트 갭)
 *
 * 데이터 소스:
 *   - trades.db (TradeLogger) — 모든 sim/live 거래
 *   - 30일 롤링 윈도우 (configurable)
 *
 * 결과 저장:
 *   - performance.db (별도 SQLite)
 *   - 매일 자정 daily snapshot 기록 → 시계열 분석 가능
 */

let Database;
try { Database = require("better-sqlite3"); } catch { Database = null; }

const DEFAULT_DB_PATH = "./performance.db";
const DEFAULT_WINDOW_DAYS = 30;
const TRADES_PER_YEAR = 365 * 24; // 시간당 1거래 가정 (Sharpe annualization)

class PerformanceTracker {
  constructor(opts = {}) {
    this.tradesDbPath = opts.tradesDbPath || "./trades.db";
    this.perfDbPath   = opts.perfDbPath   || DEFAULT_DB_PATH;
    this.windowDays   = opts.windowDays   || DEFAULT_WINDOW_DAYS;

    this.tradesDb = null;
    this.perfDb   = null;
    this._ready   = false;

    if (!Database) {
      console.warn("[Performance] better-sqlite3 없음 — disabled");
      return;
    }

    try {
      // trades.db는 readonly로 — TradeLogger와 충돌 안 나게
      this.tradesDb = new Database(this.tradesDbPath, { readonly: true, fileMustExist: false });
      this.perfDb   = new Database(this.perfDbPath);
      this.perfDb.pragma("journal_mode = WAL");
      this._migrate();
      this._ready = true;
      console.log(`[Performance] 활성화 — perf:${this.perfDbPath} trades:${this.tradesDbPath}`);
    } catch (e) {
      console.warn(`[Performance] 초기화 실패: ${e.message}`);
    }
  }

  _migrate() {
    this.perfDb.exec(`
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        date          TEXT    NOT NULL,
        strategy      TEXT    NOT NULL,
        window_days   INTEGER NOT NULL,
        trade_count   INTEGER NOT NULL,
        win_count     INTEGER NOT NULL,
        loss_count    INTEGER NOT NULL,
        win_rate      REAL,
        avg_win       REAL,
        avg_loss      REAL,
        payoff_ratio  REAL,
        ev            REAL,
        sharpe        REAL,
        sortino       REAL,
        max_drawdown  REAL,
        profit_factor REAL,
        total_pnl_krw REAL,
        captured_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(date, strategy, window_days)
      );
      CREATE INDEX IF NOT EXISTS idx_perf_date ON daily_snapshots(date DESC);
      CREATE INDEX IF NOT EXISTS idx_perf_strategy ON daily_snapshots(strategy);

      CREATE TABLE IF NOT EXISTS strategy_status (
        strategy   TEXT PRIMARY KEY,
        active     INTEGER NOT NULL DEFAULT 1,
        ev_30d     REAL,
        sharpe_30d REAL,
        last_eval  TEXT,
        reason     TEXT,
        deactivated_at TEXT
      );
    `);
  }

  // ─── 통계 헬퍼 ─────────────────────────────────────

  _stddev(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }

  _sharpe(returns, periodsPerYear = TRADES_PER_YEAR) {
    if (returns.length < 5) return 0;
    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    const std  = this._stddev(returns);
    return std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
  }

  _sortino(returns, periodsPerYear = TRADES_PER_YEAR) {
    if (returns.length < 5) return 0;
    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    const downside = returns.filter(r => r < 0);
    if (downside.length < 2) return 0;
    const downStd = this._stddev(downside);
    return downStd > 0 ? (mean / downStd) * Math.sqrt(periodsPerYear) : 0;
  }

  _maxDrawdown(returns) {
    let equity = 1, peak = 1, mdd = 0;
    for (const r of returns) {
      equity *= (1 + r);
      if (equity > peak) peak = equity;
      const dd = (equity - peak) / peak;
      if (dd < mdd) mdd = dd;
    }
    return mdd; // -0.05 = -5%
  }

  // ─── 메인 측정 ─────────────────────────────────────

  /**
   * 특정 전략의 N일 윈도우 성과
   *
   * @param {string} strategy — "A", "B", "C", or null(전체)
   * @param {number} windowDays
   * @returns {Object}
   */
  computeStats(strategy = null, windowDays = null) {
    if (!this._ready) return null;
    const days = windowDays || this.windowDays;

    const where = strategy
      ? `WHERE strategy = ? AND side = 'SELL' AND created_at >= datetime('now', '-${days} days', 'localtime')`
      : `WHERE side = 'SELL' AND created_at >= datetime('now', '-${days} days', 'localtime')`;

    let trades;
    try {
      const stmt = this.tradesDb.prepare(`
        SELECT pnl_rate, pnl_krw, dry_run, partial, reason, created_at
        FROM trades
        ${where}
        ORDER BY created_at ASC
      `);
      trades = strategy ? stmt.all(strategy) : stmt.all();
    } catch (e) {
      console.warn("[Performance] computeStats DB error:", e.message);
      return null;
    }

    if (trades.length === 0) {
      return {
        strategy: strategy || "ALL",
        windowDays: days,
        tradeCount: 0,
        sufficient: false,
      };
    }

    const returns = trades.map(t => t.pnl_rate || 0).filter(r => r !== 0 || trades.length < 10);
    const wins    = returns.filter(r => r > 0);
    const losses  = returns.filter(r => r <= 0);
    const winRate = returns.length > 0 ? wins.length / returns.length : 0;
    const avgWin  = wins.length > 0 ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 0;
    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 99 : 0);
    const ev      = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
    const sharpe  = this._sharpe(returns);
    const sortino = this._sortino(returns);
    const mdd     = this._maxDrawdown(returns);

    const sumWins   = wins.reduce((s, v) => s + v, 0);
    const sumLosses = Math.abs(losses.reduce((s, v) => s + v, 0));
    const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? 99 : 0);

    const totalPnlKrw = trades.reduce((s, t) => s + (t.pnl_krw || 0), 0);

    return {
      strategy:    strategy || "ALL",
      windowDays:  days,
      tradeCount:  trades.length,
      winCount:    wins.length,
      lossCount:   losses.length,
      winRate:     +winRate.toFixed(4),
      avgWin:      +avgWin.toFixed(6),
      avgLoss:     +avgLoss.toFixed(6),
      payoffRatio: +payoffRatio.toFixed(2),
      ev:          +ev.toFixed(6),
      sharpe:      +sharpe.toFixed(2),
      sortino:     +sortino.toFixed(2),
      maxDrawdown: +mdd.toFixed(4),
      profitFactor: +profitFactor.toFixed(2),
      totalPnlKrw: Math.round(totalPnlKrw),
      sufficient:  trades.length >= 20,
    };
  }

  /**
   * 일별 스냅샷 저장 — daily cron에서 호출
   */
  saveSnapshot(strategy, stats, date = null) {
    if (!this._ready || !stats) return false;
    const today = date || new Date().toISOString().slice(0, 10);
    try {
      this.perfDb.prepare(`
        INSERT OR REPLACE INTO daily_snapshots (
          date, strategy, window_days, trade_count, win_count, loss_count,
          win_rate, avg_win, avg_loss, payoff_ratio, ev, sharpe, sortino,
          max_drawdown, profit_factor, total_pnl_krw
        ) VALUES (
          @date, @strategy, @windowDays, @tradeCount, @winCount, @lossCount,
          @winRate, @avgWin, @avgLoss, @payoffRatio, @ev, @sharpe, @sortino,
          @maxDrawdown, @profitFactor, @totalPnlKrw
        )
      `).run({
        date:         today,
        strategy:     strategy,
        windowDays:   stats.windowDays,
        tradeCount:   stats.tradeCount,
        winCount:     stats.winCount || 0,
        lossCount:    stats.lossCount || 0,
        winRate:      stats.winRate ?? null,
        avgWin:       stats.avgWin ?? null,
        avgLoss:      stats.avgLoss ?? null,
        payoffRatio:  stats.payoffRatio ?? null,
        ev:           stats.ev ?? null,
        sharpe:       stats.sharpe ?? null,
        sortino:      stats.sortino ?? null,
        maxDrawdown:  stats.maxDrawdown ?? null,
        profitFactor: stats.profitFactor ?? null,
        totalPnlKrw:  stats.totalPnlKrw ?? null,
      });
      return true;
    } catch (e) {
      console.warn("[Performance] saveSnapshot 실패:", e.message);
      return false;
    }
  }

  /**
   * 시계열 조회 — 차트용
   */
  getHistory(strategy, days = 90) {
    if (!this._ready) return [];
    try {
      return this.perfDb.prepare(`
        SELECT date, ev, sharpe, win_rate, max_drawdown, total_pnl_krw, trade_count
        FROM daily_snapshots
        WHERE strategy = ? AND date >= date('now', '-${days} days')
        ORDER BY date ASC
      `).all(strategy);
    } catch { return []; }
  }

  /**
   * 전략 활성/비활성 상태 조회
   */
  getStrategyStatus(strategy) {
    if (!this._ready) return { active: true };
    try {
      const row = this.perfDb.prepare(
        `SELECT * FROM strategy_status WHERE strategy = ?`
      ).get(strategy);
      if (!row) return { active: true };
      return { ...row, active: row.active === 1 };
    } catch {
      return { active: true };
    }
  }

  /**
   * 전략 활성/비활성 설정 (Rotation Engine에서 호출)
   */
  setStrategyStatus(strategy, active, reason = null, ev30d = null, sharpe30d = null) {
    if (!this._ready) return;
    try {
      this.perfDb.prepare(`
        INSERT OR REPLACE INTO strategy_status
          (strategy, active, ev_30d, sharpe_30d, last_eval, reason, deactivated_at)
        VALUES (
          @strategy, @active, @ev30d, @sharpe30d,
          datetime('now','localtime'), @reason,
          CASE WHEN @active = 0 THEN datetime('now','localtime') ELSE NULL END
        )
      `).run({
        strategy,
        active: active ? 1 : 0,
        ev30d,
        sharpe30d,
        reason,
      });
    } catch (e) {
      console.warn("[Performance] setStrategyStatus 실패:", e.message);
    }
  }

  close() {
    try { this.tradesDb?.close(); } catch {}
    try { this.perfDb?.close(); } catch {}
  }
}

module.exports = { PerformanceTracker };
