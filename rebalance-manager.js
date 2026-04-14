"use strict";

/**
 * RebalanceManager — 크로스 거래소 자금 리밸런싱 관리자
 *
 * 전략: 양쪽(Upbit KRW + Binance/Bybit USDT) 자금 비율 모니터링
 *   - 불균형 30% 초과 시 경고
 *   - 불균형 50% 초과 시 자동 리밸런싱 제안
 *   - 수동 승인 후 TRC20 경로로 최저 수수료 이체
 *
 * 자금 흐름:
 *   Upbit → (XRP 매수 → 출금 → Binance 입금 → USDT 매도) → Binance
 *   Binance → (XRP 매수 → 출금 → Upbit 입금 → KRW 매도) → Upbit
 *   * XRP: 출금수수료 ~0.25 XRP ($0.15), 전송시간 3~5초
 */

const WARN_THRESHOLD       = 0.30;  // 30% 불균형 경고
const CRITICAL_THRESHOLD   = 0.50;  // 50% 자동 리밸런싱 제안
const CHECK_INTERVAL_MS    = 5 * 60_000;  // 5분마다 체크
const BRIDGE_COIN          = "XRP"; // 이체 브릿지 코인 (최저 수수료 + 최고 속도)
const BRIDGE_WITHDRAW_FEE  = 0.25;  // XRP 출금 수수료
const MIN_REBALANCE_USD    = 50;    // 최소 리밸런싱 금액

class RebalanceManager {
  /**
   * @param {Object} opts
   * @param {Object} opts.exchanges      - { upbit, binance, bybit }
   * @param {number} opts.usdKrw         - USD/KRW 환율
   * @param {number} opts.targetRatio    - Upbit:해외 목표 비율 (0.5 = 50:50)
   * @param {boolean} opts.autoExecute   - 자동 실행 (false면 제안만)
   */
  constructor({
    exchanges = {},
    usdKrw = 1350,
    targetRatio = 0.5,
    autoExecute = false,
  } = {}) {
    this._exchanges   = exchanges;
    this._usdKrw      = usdKrw;
    this._targetRatio = targetRatio;
    this._autoExecute = autoExecute;
    this._intervalId  = null;
    this._running     = false;

    // 잔고 스냅샷
    this._balances = {
      upbit:   { krw: 0, usd: 0 },
      binance: { usdt: 0 },
      bybit:   { usdt: 0 },
      total:   0,     // 총 USD 환산
      upbitPct: 0,    // Upbit 비중 (%)
      foreignPct: 0,  // 해외 비중 (%)
      imbalance: 0,   // |실제비율 - 목표비율|
      status: "BALANCED", // BALANCED / WARN / CRITICAL
    };

    // 리밸런싱 이력
    this._history = [];

    // 통계
    this._stats = {
      totalChecks:      0,
      warnings:         0,
      criticals:        0,
      rebalancesExecuted: 0,
      lastCheckAt:      null,
    };

    // 대기 중인 리밸런싱 제안
    this._pendingRebalance = null;
  }

  setUsdKrw(rate) { if (rate > 0) this._usdKrw = rate; }

  // ── 시작/종료 ──────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    console.log(
      `[Rebalance] 시작 — 목표비율 ${(this._targetRatio * 100).toFixed(0)}:${((1 - this._targetRatio) * 100).toFixed(0)} ` +
      `(Upbit:해외) | 경고: ${WARN_THRESHOLD * 100}% | 위험: ${CRITICAL_THRESHOLD * 100}%`
    );

    // 즉시 1회 체크
    await this._check().catch(e => console.error("[Rebalance] 초기 체크 오류:", e.message));

    this._intervalId = setInterval(
      () => this._check().catch(e => console.error("[Rebalance] 체크 오류:", e.message)),
      CHECK_INTERVAL_MS
    );
  }

  stop() {
    this._running = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  // ── 잔고 체크 ──────────────────────────────────────────────

  async _check() {
    this._stats.totalChecks++;
    this._stats.lastCheckAt = Date.now();

    // 병렬 잔고 조회
    const [upbitKrw, binanceUsdt, bybitUsdt] = await Promise.all([
      this._safeGetBalance("upbit", "KRW"),
      this._safeGetBalance("binance", "USDT"),
      this._safeGetBalance("bybit", "USDT"),
    ]);

    const upbitUsd   = upbitKrw / this._usdKrw;
    const foreignUsd = binanceUsdt + bybitUsdt;
    const totalUsd   = upbitUsd + foreignUsd;

    this._balances = {
      upbit:      { krw: upbitKrw, usd: +upbitUsd.toFixed(2) },
      binance:    { usdt: +binanceUsdt.toFixed(2) },
      bybit:      { usdt: +bybitUsdt.toFixed(2) },
      total:      +totalUsd.toFixed(2),
      upbitPct:   totalUsd > 0 ? +(upbitUsd / totalUsd * 100).toFixed(1) : 0,
      foreignPct: totalUsd > 0 ? +(foreignUsd / totalUsd * 100).toFixed(1) : 0,
      imbalance:  0,
      status:     "BALANCED",
    };

    if (totalUsd < MIN_REBALANCE_USD) {
      this._balances.status = "LOW_BALANCE";
      return;
    }

    // 불균형 계산
    const actualUpbitRatio = upbitUsd / totalUsd;
    const imbalance = Math.abs(actualUpbitRatio - this._targetRatio);
    this._balances.imbalance = +imbalance.toFixed(3);

    if (imbalance >= CRITICAL_THRESHOLD) {
      this._balances.status = "CRITICAL";
      this._stats.criticals++;
      this._suggestRebalance(upbitUsd, foreignUsd, totalUsd);
    } else if (imbalance >= WARN_THRESHOLD) {
      this._balances.status = "WARN";
      this._stats.warnings++;
      console.log(
        `[Rebalance] ⚠️ 불균형 경고 — ` +
        `Upbit: $${upbitUsd.toFixed(0)} (${this._balances.upbitPct}%) | ` +
        `해외: $${foreignUsd.toFixed(0)} (${this._balances.foreignPct}%) | ` +
        `불균형: ${(imbalance * 100).toFixed(1)}%`
      );
    }
  }

  async _safeGetBalance(exchangeName, asset) {
    try {
      const ex = this._exchanges[exchangeName];
      if (!ex) return 0;
      const bal = await ex.getBalance(asset);
      return bal || 0;
    } catch {
      return 0;
    }
  }

  // ── 리밸런싱 제안 ──────────────────────────────────────────

  _suggestRebalance(upbitUsd, foreignUsd, totalUsd) {
    const targetUpbit   = totalUsd * this._targetRatio;
    const targetForeign = totalUsd * (1 - this._targetRatio);

    let direction, amountUsd, fromExchange, toExchange;

    if (upbitUsd > targetUpbit) {
      // Upbit 과다 → 해외로 이체
      direction = "UPBIT_TO_FOREIGN";
      amountUsd = upbitUsd - targetUpbit;
      fromExchange = "upbit";
      toExchange = "binance"; // 기본으로 Binance
    } else {
      // 해외 과다 → Upbit으로 이체
      direction = "FOREIGN_TO_UPBIT";
      amountUsd = foreignUsd - targetForeign;
      fromExchange = "binance";
      toExchange = "upbit";
    }

    // XRP 기준 이체 비용 계산
    const bridgeFeeUsd = BRIDGE_WITHDRAW_FEE * 0.6; // XRP ~$0.60 추정
    const netAmountUsd = amountUsd - bridgeFeeUsd;

    const proposal = {
      direction,
      amountUsd:     +amountUsd.toFixed(2),
      netAmountUsd:  +netAmountUsd.toFixed(2),
      bridgeCoin:    BRIDGE_COIN,
      bridgeFee:     `${BRIDGE_WITHDRAW_FEE} ${BRIDGE_COIN} (~$${bridgeFeeUsd.toFixed(2)})`,
      fromExchange,
      toExchange,
      estimatedTime: "3~10초 (XRP)",
      currentBalance: {
        upbit:   `$${upbitUsd.toFixed(0)}`,
        foreign: `$${foreignUsd.toFixed(0)}`,
      },
      targetBalance: {
        upbit:   `$${targetUpbit.toFixed(0)}`,
        foreign: `$${targetForeign.toFixed(0)}`,
      },
      createdAt: Date.now(),
    };

    this._pendingRebalance = proposal;

    console.log(
      `[Rebalance] 🔴 리밸런싱 필요! ` +
      `${fromExchange} → ${toExchange} | $${amountUsd.toFixed(0)} | ` +
      `브릿지: ${BRIDGE_COIN} (수수료: ${proposal.bridgeFee})`
    );

    if (this._autoExecute && netAmountUsd >= MIN_REBALANCE_USD) {
      this._executeRebalance(proposal).catch(e =>
        console.error("[Rebalance] 자동 실행 오류:", e.message)
      );
    }
  }

  // ── 리밸런싱 실행 (XRP 브릿지) ─────────────────────────────

  async _executeRebalance(proposal) {
    console.log(`[Rebalance] 실행 시작 — ${proposal.direction} $${proposal.amountUsd}`);

    const from = this._exchanges[proposal.fromExchange];
    const to   = this._exchanges[proposal.toExchange];
    if (!from || !to) {
      console.error("[Rebalance] 거래소 어댑터 없음");
      return { success: false, reason: "거래소 없음" };
    }

    try {
      // Step 1: 출발 거래소에서 XRP 매수
      const xrpAmountUsd = proposal.amountUsd;
      let buyResult;
      if (from.quoteCurrency === "KRW") {
        buyResult = await from.marketBuy(BRIDGE_COIN, xrpAmountUsd * this._usdKrw);
      } else {
        buyResult = await from.marketBuy(BRIDGE_COIN, xrpAmountUsd);
      }
      console.log(`[Rebalance] Step 1: ${proposal.fromExchange}에서 XRP 매수 완료`);

      // Step 2: XRP 출금 (실제 출금 API는 거래소별로 다름 — 여기서는 로그만)
      // 실제 출금은 각 거래소의 withdraw API를 호출해야 함
      // 보안상 자동 출금은 위험하므로 알림만 발송
      console.log(
        `[Rebalance] Step 2: ⚠️ 수동 출금 필요! ` +
        `${proposal.fromExchange} → ${proposal.toExchange} | ` +
        `${BRIDGE_COIN} $${xrpAmountUsd.toFixed(0)} 상당`
      );

      // 이력 기록
      const record = {
        ...proposal,
        executedAt: Date.now(),
        status: "PENDING_WITHDRAWAL", // 수동 출금 대기
      };
      this._history.unshift(record);
      if (this._history.length > 20) this._history = this._history.slice(0, 20);
      this._stats.rebalancesExecuted++;
      this._pendingRebalance = null;

      return { success: true, status: "PENDING_WITHDRAWAL", record };
    } catch (e) {
      console.error(`[Rebalance] 실행 실패: ${e.message}`);
      return { success: false, reason: e.message };
    }
  }

  // ── 외부 API ──────────────────────────────────────────────

  getBalances() { return { ...this._balances }; }

  getPendingRebalance() { return this._pendingRebalance; }

  /** 수동 승인으로 리밸런싱 실행 */
  async approveRebalance() {
    if (!this._pendingRebalance) return { success: false, reason: "대기 중인 제안 없음" };
    return this._executeRebalance(this._pendingRebalance);
  }

  /** 대시보드 요약 */
  getSummary() {
    return {
      running:     this._running,
      balances:    this._balances,
      pending:     this._pendingRebalance ? {
        direction:  this._pendingRebalance.direction,
        amount:     this._pendingRebalance.amountUsd,
        bridge:     this._pendingRebalance.bridgeCoin,
      } : null,
      stats:       this._stats,
      history:     this._history.slice(0, 5),
    };
  }
}

module.exports = { RebalanceManager };
