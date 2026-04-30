"use strict";

/**
 * RiskManager — 포트폴리오 단위 리스크 관리
 *
 * 0.1% 퀀트 표준 리스크 컨트롤:
 *   1. 전략별 노출 한도 (capital allocation cap)
 *   2. 카테고리별 한도 (directional / market-neutral / event-driven)
 *   3. 일일 VaR 95% 추정 (실거래 기반 historical VaR)
 *   4. 한도 초과 시 신규 진입 차단
 *   5. Daily/Monthly stop-loss
 *
 * 카테고리 분류:
 *   - directional: Strategy A (BTC 추세 베팅)
 *   - event-driven: Strategy B (신규상장)
 *   - market-neutral: Strategy C (한국 3사 차익)
 *   - prediction-market: Strategy E (Polymarket — 추후)
 *
 * 한도 정책 (자본 100만원 기준):
 *   directional total: 60% (Strategy A 60%)
 *   event-driven total: 40% (Strategy B 40%)
 *   market-neutral total: 0% (지금은 모니터링만)
 *
 *   일일 손실 한도: -1.0% (자본 1만원)
 *   월간 손실 한도: -5.0% (자본 5만원)
 *   VaR 95% 한도: 일일 손실 추정치 < 0.6%
 */

let Database;
try { Database = require("better-sqlite3"); } catch { Database = null; }

const DEFAULT_LIMITS = {
  // 카테고리별 자본 한도 (총 자본 대비 %)
  directional:    0.60,
  eventDriven:    0.40,
  marketNeutral:  0.50,
  predictionMkt:  0.20,

  // 일일/월간 손실 한도 (총 자본 대비)
  dailyLossPct:   0.010,  // -1.0%
  monthlyLossPct: 0.050,  // -5.0%

  // VaR 95% 한도 (일일 손실 추정치 < x)
  varPct:         0.006,  // -0.6%

  // 거래 빈도 한도
  maxDailyTrades:    8,
  maxConsecLosses:   3,
};

const STRATEGY_CATEGORY = {
  A: "directional",
  B: "eventDriven",
  C: "marketNeutral",
  D: "directional",     // 한국 sentiment (추후)
  E: "predictionMkt",   // Polymarket (추후)
};

class RiskManager {
  constructor(opts = {}) {
    this.tradesDbPath = opts.tradesDbPath || "./trades.db";
    this.totalCapital = opts.totalCapital || 100_000;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };

    this.tradesDb = null;
    this._ready = false;

    if (!Database) return;
    try {
      this.tradesDb = new Database(this.tradesDbPath, { readonly: true, fileMustExist: false });
      this._ready = true;
    } catch (e) {
      console.warn(`[RiskManager] init: ${e.message}`);
    }

    // 일일 추적 캐시
    this._dailyState = {
      date:           "",
      realizedPnl:    0,
      trades:         0,
      consecLosses:   0,
      categoryUsage:  {}, // category → KRW exposure
    };
  }

  // ─── 메인 게이트 ────────────────────────────────────

  /**
   * 진입 직전 호출 — 모든 한도 체크
   * @returns {{allowed:boolean, reason:string, severity:"info"|"warn"|"halt"}}
   */
  checkEntry({ strategy, budgetKrw, currentPositions = {} }) {
    this._refreshDaily();

    const category = STRATEGY_CATEGORY[strategy] || "other";

    // 1. 일일 손실 한도
    const dailyLoss = -this._dailyState.realizedPnl;
    if (dailyLoss > this.totalCapital * this.limits.dailyLossPct) {
      return {
        allowed: false,
        reason: `daily_loss_limit ${dailyLoss.toLocaleString()}원 > ${(this.totalCapital * this.limits.dailyLossPct).toLocaleString()}원`,
        severity: "halt",
      };
    }

    // 2. 일일 거래 횟수 한도
    if (this._dailyState.trades >= this.limits.maxDailyTrades) {
      return {
        allowed: false,
        reason: `daily_trades ${this._dailyState.trades}/${this.limits.maxDailyTrades}`,
        severity: "halt",
      };
    }

    // 3. 연속 손실 한도
    if (this._dailyState.consecLosses >= this.limits.maxConsecLosses) {
      return {
        allowed: false,
        reason: `consec_losses ${this._dailyState.consecLosses}/${this.limits.maxConsecLosses}`,
        severity: "halt",
      };
    }

    // 4. 월간 손실 한도
    const monthlyLoss = this._monthlyLoss();
    if (monthlyLoss > this.totalCapital * this.limits.monthlyLossPct) {
      return {
        allowed: false,
        reason: `monthly_loss ${monthlyLoss.toLocaleString()}원 > ${(this.totalCapital * this.limits.monthlyLossPct).toLocaleString()}원`,
        severity: "halt",
      };
    }

    // 5. 카테고리 노출 한도
    const currentCategoryExposure = this._calcCategoryExposure(category, currentPositions);
    const newExposure = currentCategoryExposure + budgetKrw;
    const categoryLimit = this.totalCapital * (this.limits[category] || 0.20);
    if (newExposure > categoryLimit) {
      return {
        allowed: false,
        reason: `category_limit ${category} ${newExposure.toLocaleString()} > ${categoryLimit.toLocaleString()}`,
        severity: "warn",
      };
    }

    // 6. VaR 95% 추정 (30일 historical)
    const varEstimate = this._estimateVaR(0.95, 30);
    if (varEstimate !== null && varEstimate < -this.limits.varPct) {
      return {
        allowed: false,
        reason: `var_95 ${(varEstimate * 100).toFixed(2)}% < -${(this.limits.varPct * 100).toFixed(2)}%`,
        severity: "warn",
      };
    }

    return { allowed: true, reason: "ok", severity: "info" };
  }

  // ─── 거래 결과 기록 (외부에서 호출) ────────────────

  recordTrade({ pnlKrw, isLoss }) {
    this._refreshDaily();
    this._dailyState.realizedPnl += pnlKrw;
    this._dailyState.trades += 1;
    if (isLoss) this._dailyState.consecLosses += 1;
    else this._dailyState.consecLosses = 0;
  }

  // ─── 내부 헬퍼 ────────────────────────────────────

  _refreshDaily() {
    const today = new Date().toLocaleDateString("ko-KR");
    if (this._dailyState.date !== today) {
      this._dailyState = {
        date:           today,
        realizedPnl:    0,
        trades:         0,
        consecLosses:   0,
        categoryUsage:  {},
      };
    }
  }

  _calcCategoryExposure(category, currentPositions) {
    let total = 0;
    for (const [strategy, position] of Object.entries(currentPositions)) {
      if (!position) continue;
      const cat = STRATEGY_CATEGORY[strategy];
      if (cat === category) total += position.budget || 0;
    }
    return total;
  }

  _monthlyLoss() {
    if (!this._ready) return 0;
    try {
      const row = this.tradesDb.prepare(`
        SELECT COALESCE(SUM(pnl_krw), 0) as total
        FROM trades
        WHERE side = 'SELL'
          AND dry_run = 0
          AND created_at >= date('now', '-30 days', 'localtime')
      `).get();
      return -Math.min(0, row.total || 0);
    } catch { return 0; }
  }

  /**
   * Historical VaR 95% — 최근 N일 LIVE 거래 기준
   *   하위 5% 일일 수익률 (음수면 손실)
   */
  _estimateVaR(confidence = 0.95, days = 30) {
    if (!this._ready) return null;
    try {
      const rows = this.tradesDb.prepare(`
        SELECT date(created_at) as date, COALESCE(SUM(pnl_rate), 0) as daily_ret
        FROM trades
        WHERE side = 'SELL'
          AND dry_run = 0
          AND created_at >= date('now', '-${days} days', 'localtime')
        GROUP BY date(created_at)
      `).all();
      if (rows.length < 5) return null;
      const returns = rows.map(r => r.daily_ret).sort((a, b) => a - b);
      const idx = Math.floor((1 - confidence) * returns.length);
      return returns[idx] ?? null;
    } catch { return null; }
  }

  getSummary() {
    this._refreshDaily();
    return {
      capital:       this.totalCapital,
      limits:        this.limits,
      daily: {
        date:          this._dailyState.date,
        realizedPnl:   Math.round(this._dailyState.realizedPnl),
        trades:        this._dailyState.trades,
        consecLosses:  this._dailyState.consecLosses,
        lossLimitKrw:  Math.round(this.totalCapital * this.limits.dailyLossPct),
        remainingTrades: Math.max(0, this.limits.maxDailyTrades - this._dailyState.trades),
      },
      monthly: {
        loss:        Math.round(this._monthlyLoss()),
        lossLimit:   Math.round(this.totalCapital * this.limits.monthlyLossPct),
      },
      var95: this._estimateVaR(0.95, 30),
    };
  }

  close() {
    try { this.tradesDb?.close(); } catch {}
  }
}

module.exports = { RiskManager, STRATEGY_CATEGORY };
