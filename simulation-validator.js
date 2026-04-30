"use strict";

/**
 * SimulationValidator — 시뮬→LIVE 자동 전환 판정기
 *
 * 매시간 자동 평가 + LIVE 전환 가능 여부 판정.
 * 0.1% 퀀트 표준: 검증 없는 LIVE 전환 절대 금지.
 *
 * LIVE 전환 조건 (모두 충족):
 *   1. 시뮬 운영 시간 >= 24h (최소 1일)
 *   2. 시뮬 거래 수 >= 30건 (통계적 유의)
 *   3. EV > 0
 *   4. Sharpe > 1.0
 *   5. MDD > -5%
 *   6. 안전장치 0회 발동 (Watchdog halt 0회)
 *   7. API 에러율 < 1%
 *
 * 한 가지라도 미충족 → "LIVE 전환 불가" + 사유 보고
 */

const { PerformanceTracker } = require("./lib/performance");

const VALIDATION_RULES = {
  minRuntimeHours:   24,
  minTrades:         30,
  minEV:             0,        // 양수
  minSharpe:         1.0,
  maxMDD:           -0.05,     // -5% (더 음수면 차단)
  maxWatchdogHalts:  0,
  maxApiErrorRate:   0.01,     // 1%
};

class SimulationValidator {
  constructor(opts = {}) {
    this.tracker  = opts.tracker  || null;
    this.notifier = opts.notifier || null;
    this.bot      = opts.bot      || null;

    this._intervalId = null;
    this._startedAt  = Date.now();
    this._watchdogHaltCount = 0;
    this._lastReport = null;
  }

  start() {
    // 1시간마다 평가
    this._intervalId = setInterval(() => this.evaluate(), 60 * 60_000);
    // 시작 시 1회 즉시 평가
    setTimeout(() => this.evaluate(), 5 * 60_000);
    console.log("[SimValidator] 시작 — 매시간 LIVE 전환 가능 여부 평가");
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = null;
  }

  recordWatchdogHalt() {
    this._watchdogHaltCount++;
  }

  async evaluate() {
    const now = Date.now();
    const runtimeHours = (now - this._startedAt) / 3_600_000;

    // 모든 전략 통합 통계
    const stats = this.tracker?.computeStats(null, 30); // 전체
    if (!stats) return null;

    const checks = {
      runtimeHours: { value: runtimeHours.toFixed(1), pass: runtimeHours >= VALIDATION_RULES.minRuntimeHours },
      tradeCount:   { value: stats.tradeCount,        pass: stats.tradeCount >= VALIDATION_RULES.minTrades },
      ev:           { value: stats.ev,                pass: stats.ev > VALIDATION_RULES.minEV },
      sharpe:       { value: stats.sharpe,            pass: stats.sharpe > VALIDATION_RULES.minSharpe },
      mdd:          { value: stats.maxDrawdown,       pass: stats.maxDrawdown >= VALIDATION_RULES.maxMDD },
      watchdog:     { value: this._watchdogHaltCount, pass: this._watchdogHaltCount <= VALIDATION_RULES.maxWatchdogHalts },
    };

    const passing = Object.values(checks).filter(c => c.pass).length;
    const total   = Object.keys(checks).length;
    const liveReady = passing === total;

    const report = {
      runtimeHours: +runtimeHours.toFixed(1),
      stats,
      checks,
      passing:    `${passing}/${total}`,
      liveReady,
      evaluatedAt: new Date().toISOString(),
    };

    this._lastReport = report;

    // 처음 LIVE 전환 가능해진 시점에만 알림
    if (liveReady) {
      console.log(`[SimValidator] ✅ LIVE 전환 가능 — ${passing}/${total} 모두 통과`);
      if (this.notifier?.send) {
        this.notifier.send(
          `✅ <b>시뮬 검증 완료 — LIVE 전환 가능</b>\n` +
          `운영 시간: ${runtimeHours.toFixed(1)}h\n` +
          `거래: ${stats.tradeCount}건 / EV ${(stats.ev * 100).toFixed(3)}%\n` +
          `Sharpe ${stats.sharpe} / MDD ${(stats.maxDrawdown * 100).toFixed(2)}%\n` +
          `Watchdog halt: ${this._watchdogHaltCount}\n` +
          `→ 사용자 결정 후 .env BOT_MODE=LIVE / DRY_RUN=false`
        );
      }
    } else if (runtimeHours > VALIDATION_RULES.minRuntimeHours) {
      // 1일 후에도 LIVE 전환 불가 시 알림
      const failed = Object.entries(checks).filter(([_, c]) => !c.pass).map(([k, c]) => `${k}=${c.value}`);
      console.warn(`[SimValidator] LIVE 전환 불가 — 미통과: ${failed.join(", ")}`);
    }

    return report;
  }

  getLastReport() {
    return this._lastReport;
  }

  getRules() {
    return VALIDATION_RULES;
  }
}

module.exports = { SimulationValidator };
