"use strict";

/**
 * RotationEngine — 알파 자동 활성/비활성 + 매일 자정 성과 측정
 *
 * 동작:
 *   1. 매일 자정(KST) 자동 실행
 *   2. 모든 활성 전략의 30일 EV/Sharpe/MDD 측정
 *   3. 임계 미달 → 자동 비활성 + Telegram 알림
 *   4. 회복 임계 충족 → 자동 부활 + Telegram 알림
 *   5. daily_snapshot DB에 저장 (시계열 분석)
 *
 * 정책 (보수적):
 *   - 비활성 임계: EV < -0.05% AND tradeCount >= 30
 *   - 부활 임계: EV >= +0.02% AND sharpe >= 0.5 (관찰 7일)
 *   - tradeCount < 30: 측정 불가, 활성 유지 (under-observation)
 *   - MDD < -10%: 즉시 비활성 (catastrophic)
 *
 * 0.1% 퀀트 vs 우리:
 *   그들 = 매주 알파 회의 + 비활성 결정. 우리 = 매일 자동.
 *   속도가 우리의 알파.
 */

const { PerformanceTracker } = require("./lib/performance");

const STRATEGIES = ["A", "B", "C"]; // 추후 D/E 추가 시 확장

const DEACTIVATE_EV     = Number(process.env.ROT_DEACTIVATE_EV    ?? -0.0005);  // -0.05%
const REACTIVATE_EV     = Number(process.env.ROT_REACTIVATE_EV    ??  0.0002);  // +0.02%
const REACTIVATE_SHARPE = Number(process.env.ROT_REACTIVATE_SHARPE ?? 0.5);
const MIN_TRADES        = Number(process.env.ROT_MIN_TRADES       ?? 30);
const CATASTROPHIC_MDD  = Number(process.env.ROT_CATASTROPHIC_MDD ?? -0.10);    // -10%

class RotationEngine {
  constructor(opts = {}) {
    this.tracker  = opts.tracker  || new PerformanceTracker();
    this.notifier = opts.notifier || null;
    this._cronId  = null;
  }

  start() {
    // 즉시 1회 실행 (서비스 시작 시 마지막 평가가 너무 오래됐으면 갱신)
    this.evaluateAll().catch(e => console.error("[Rotation] initial eval:", e.message));

    // 자정 KST 매일 실행 — setInterval로 매 시간 체크 후 자정만 실행
    this._cronId = setInterval(() => {
      const now = new Date();
      // KST = UTC+9
      const kstHour   = (now.getUTCHours() + 9) % 24;
      const kstMinute = now.getUTCMinutes();
      if (kstHour === 0 && kstMinute < 5) {
        this.evaluateAll().catch(e => console.error("[Rotation] daily eval:", e.message));
      }
    }, 5 * 60_000);

    console.log("[Rotation] 시작 — 매일 자정(KST) 알파 회귀 검증");
  }

  stop() {
    if (this._cronId) clearInterval(this._cronId);
    this._cronId = null;
  }

  async evaluateAll() {
    if (!this.tracker || !this.tracker._ready) {
      console.warn("[Rotation] PerformanceTracker not ready — skip");
      return;
    }

    console.log("[Rotation] 일일 알파 평가 시작");
    const results = {};

    for (const strategy of STRATEGIES) {
      try {
        const stats = this.tracker.computeStats(strategy, 30);
        if (!stats) continue;

        // 일일 스냅샷 저장
        this.tracker.saveSnapshot(strategy, stats);

        // 활성/비활성 판단
        const status = this.tracker.getStrategyStatus(strategy);
        const decision = this._decide(stats, status);

        if (decision.changeAction) {
          this.tracker.setStrategyStatus(
            strategy,
            decision.shouldBeActive,
            decision.reason,
            stats.ev,
            stats.sharpe
          );

          const emoji = decision.shouldBeActive ? "🟢 부활" : "🔴 비활성";
          const msg = `${emoji} <b>Strategy ${strategy}</b>\n` +
                      `사유: ${decision.reason}\n` +
                      `EV: ${(stats.ev * 100).toFixed(3)}% | Sharpe: ${stats.sharpe} | ` +
                      `MDD: ${(stats.maxDrawdown * 100).toFixed(2)}%\n` +
                      `거래: ${stats.tradeCount}건 / 승률 ${(stats.winRate * 100).toFixed(1)}%`;
          console.log(`[Rotation] ${msg.replace(/<[^>]+>/g, "")}`);
          this.notifier?.send?.(msg);
        }

        results[strategy] = { stats, decision };
      } catch (e) {
        console.error(`[Rotation] ${strategy} 평가 실패:`, e.message);
      }
    }

    console.log("[Rotation] 일일 평가 완료");
    return results;
  }

  _decide(stats, currentStatus) {
    const isActive = currentStatus.active !== false;

    // 측정 불가 (under-observation)
    if (!stats.sufficient || stats.tradeCount < MIN_TRADES) {
      return { changeAction: false, shouldBeActive: isActive, reason: "under_observation" };
    }

    // Catastrophic MDD — 즉시 비활성
    if (stats.maxDrawdown <= CATASTROPHIC_MDD) {
      return {
        changeAction: isActive,
        shouldBeActive: false,
        reason: `catastrophic_mdd ${(stats.maxDrawdown * 100).toFixed(1)}%`,
      };
    }

    // 비활성 → 부활 검사
    if (!isActive) {
      if (stats.ev >= REACTIVATE_EV && stats.sharpe >= REACTIVATE_SHARPE) {
        return {
          changeAction: true,
          shouldBeActive: true,
          reason: `recovered ev=${(stats.ev * 100).toFixed(3)}% sharpe=${stats.sharpe}`,
        };
      }
      return { changeAction: false, shouldBeActive: false, reason: "still_underperforming" };
    }

    // 활성 → 비활성 검사
    if (stats.ev < DEACTIVATE_EV) {
      return {
        changeAction: true,
        shouldBeActive: false,
        reason: `low_ev ${(stats.ev * 100).toFixed(3)}%`,
      };
    }

    return { changeAction: false, shouldBeActive: true, reason: "performing" };
  }

  /**
   * 외부에서 전략 활성 여부 조회 (StrategyA/B/C가 호출)
   */
  isStrategyActive(strategy) {
    if (!this.tracker || !this.tracker._ready) return true; // fail-open
    const status = this.tracker.getStrategyStatus(strategy);
    return status.active !== false;
  }

  getSummary() {
    const summary = {};
    for (const s of STRATEGIES) {
      const status = this.tracker?.getStrategyStatus(s) || { active: true };
      const stats  = this.tracker?.computeStats(s, 30) || null;
      summary[s] = { ...status, stats };
    }
    return summary;
  }
}

module.exports = { RotationEngine };
