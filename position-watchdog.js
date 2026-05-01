"use strict";

/**
 * PositionWatchdog — 단방향 노출 자동 감지 + 응급 헷지
 *
 * 가장 위험한 시나리오 방지:
 *   매수는 됐는데 매도 주문 발사 못한 상태 = 시장 폭락 시 무방비 손실
 *
 * 동작:
 *   매분 PositionLedger.getUnhedgedPositions() 호출
 *   5분+ OPEN 상태이며 exit_order_key 없는 포지션 감지
 *   → 옵션 1: 즉시 시장가 매도 (자동 헷지)
 *   → 옵션 2: STUCK 마킹 + Telegram 알림 (수동 처리 요구)
 *
 * 정책:
 *   기본: 시장가 매도 OFF (안전 — 사람 확인 후 처리)
 *   POS_AUTO_HEDGE=true 환경변수 시 자동 시장가 매도
 */

const STUCK_THRESHOLD_MIN  = Number(process.env.POS_STUCK_THRESHOLD_MIN ?? 5);
const AUTO_HEDGE           = process.env.POS_AUTO_HEDGE === "true";
const CHECK_INTERVAL_MS    = 60_000;

class PositionWatchdog {
  constructor(opts = {}) {
    this.ledger       = opts.ledger       || null;
    this.orderRouter  = opts.orderRouter  || null;
    this.orderService = opts.orderService || null;
    this.notifier     = opts.notifier     || null;

    this._intervalId = null;
    this._alerted    = new Set(); // 이미 알림 보낸 position id
  }

  start() {
    this._intervalId = setInterval(() => this._check(), CHECK_INTERVAL_MS);
    console.log(
      `[PositionWatchdog] 시작 — ${STUCK_THRESHOLD_MIN}분+ 단방향 노출 감지 ` +
      `(자동 헷지: ${AUTO_HEDGE ? "ON" : "OFF"})`
    );
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = null;
  }

  async _check() {
    if (!this.ledger) return;

    const unhedged = this.ledger.getUnhedgedPositions(STUCK_THRESHOLD_MIN);
    if (unhedged.length === 0) return;

    for (const pos of unhedged) {
      // 이미 알림 보낸 건 스킵 (단 5분 이상 + 자동 헷지 OFF인 경우)
      if (this._alerted.has(pos.id) && !AUTO_HEDGE) continue;
      this._alerted.add(pos.id);

      const ageMin = (Date.now() - new Date(pos.filled_at).getTime()) / 60_000;
      console.warn(
        `[PositionWatchdog] ⚠️ 단방향 노출 감지 — ${pos.market} ` +
        `qty:${pos.entry_filled_qty} ${ageMin.toFixed(1)}분 경과`
      );

      // STUCK 마킹
      this.ledger.markStuck(pos.id, `unhedged_${ageMin.toFixed(0)}min`);

      // Telegram 알림
      if (this.notifier?.send) {
        this.notifier.send(
          `🚨 <b>단방향 노출 감지</b>\n` +
          `포지션 #${pos.id} ${pos.market}\n` +
          `매수 ${pos.entry_filled_qty} (avg ${(pos.entry_avg_price || 0).toLocaleString()}원)\n` +
          `${ageMin.toFixed(1)}분 동안 매도 주문 X\n` +
          (AUTO_HEDGE ? "→ 자동 시장가 매도 시도" : "→ 수동 점검 권장 (또는 POS_AUTO_HEDGE=true)")
        );
      }

      // 자동 헷지
      if (AUTO_HEDGE && this.orderRouter) {
        try {
          const result = await this.orderRouter.submit({
            strategy: pos.strategy + "_HEDGE",
            market:   pos.market,
            side:     "SELL",
            type:     "market",
            qty:      pos.entry_filled_qty,
            relatedTo: pos.entry_order_key,
          });
          console.log(
            `[PositionWatchdog] 자동 헷지 결과 — ${pos.market} ${result.state} ` +
            `${result.executedQty}@${result.avgPrice}`
          );
          if (result.state === "FILLED") {
            const exitAvg = result.avgPrice;
            const pnlRate = (exitAvg - pos.entry_avg_price) / pos.entry_avg_price;
            const pnlKrw  = pnlRate * (pos.entry_avg_price * pos.entry_filled_qty);
            this.ledger.markClosing(pos.id, {
              exitOrderKey: result.key,
              exitQty: pos.entry_filled_qty,
              exitPrice: exitAvg,
              exitReason: "auto_hedge",
            });
            this.ledger.markClosed(pos.id, { exitAvgPrice: exitAvg, pnlRate, pnlKrw });
          }
        } catch (e) {
          console.error("[PositionWatchdog] 자동 헷지 실패:", e.message);
        }
      }
    }
  }

  reset(positionId) {
    this._alerted.delete(positionId);
  }

  getSummary() {
    return {
      stuckThresholdMin: STUCK_THRESHOLD_MIN,
      autoHedge: AUTO_HEDGE,
      alertedCount: this._alerted.size,
      unhedged: this.ledger?.getUnhedgedPositions(STUCK_THRESHOLD_MIN) || [],
    };
  }
}

module.exports = { PositionWatchdog };
