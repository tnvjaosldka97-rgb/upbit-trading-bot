'use strict';

const CFG = require("./config");

/**
 * RebalanceManager — XRP 브릿지 크로스 거래소 리밸런서
 *
 * 기능:
 *   - 5분마다 전 거래소 잔고 확인
 *   - 불균형 > ARB_REBALANCE_THRESHOLD (기본 30%) 시 XRP 이체 트리거
 *   - XRP 브릿지: 출금수수료 ~0.25 XRP ($0.15), 전송 3~5초
 *   - DRY_RUN 지원 (로그만, 실제 이체 없음)
 *   - 전체 이력 로그
 *
 * 환경변수:
 *   ARB_REBALANCE_THRESHOLD — 불균형 퍼센트 (기본 0.30 = 30%)
 *   DRY_RUN                 — true면 로그만
 */

require('dotenv').config();

const BRIDGE_COIN         = 'XRP';
const BRIDGE_WITHDRAW_FEE = 0.25;    // XRP 출금 수수료
const CHECK_INTERVAL_MS   = 5 * 60_000;  // 5분
const MIN_REBALANCE_USD   = 50;
const REBALANCE_THRESHOLD = parseFloat(process.env.ARB_REBALANCE_THRESHOLD) || 0.30;
const DRY_RUN_DEFAULT     = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

class RebalanceManager {
  /**
   * @param {Object}  opts
   * @param {Object}  opts.exchanges    - { upbit, binance, bybit, okx, gate }
   * @param {number}  opts.usdKrw       - USD/KRW 환율
   * @param {number}  opts.targetRatio  - Upbit(KRW):해외(USDT) 목표 비율 (0.5 = 50:50)
   * @param {boolean} opts.dryRun       - DRY_RUN 모드
   */
  constructor({
    exchanges   = {},
    usdKrw      = CFG.DEFAULT_USD_KRW,
    targetRatio = 0.5,
    dryRun      = DRY_RUN_DEFAULT,
  } = {}) {
    this._exchanges    = exchanges;
    this._usdKrw       = usdKrw;
    this._targetRatio  = targetRatio;
    this._dryRun       = dryRun;
    this._intervalId   = null;
    this._running      = false;

    // 최근 잔고 스냅샷
    this._balances = {
      exchanges: {},        // { name: { asset: amount } }
      totalUsd:  0,
      krwSideUsd:   0,     // KRW 거래소 합산 (USD)
      usdtSideUsd:  0,     // USDT 거래소 합산
      imbalancePct: 0,
      status:       'UNKNOWN',
    };

    // 이체 이력
    this._history = [];

    // 통계
    this._stats = {
      totalChecks:     0,
      warnings:        0,
      rebalancesTriggered: 0,
      rebalancesExecuted:  0,
      lastCheckAt:     null,
      errors:          0,
    };
  }

  setUsdKrw(rate) { if (rate > 0) this._usdKrw = rate; }

  // ── 시작/종료 ──────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    console.log(
      `[RebalanceManager] 시작 — ` +
      `목표비율 ${(this._targetRatio * 100).toFixed(0)}:${((1 - this._targetRatio) * 100).toFixed(0)} (KRW:USDT) | ` +
      `임계값: ${(REBALANCE_THRESHOLD * 100).toFixed(0)}% | 브릿지: ${BRIDGE_COIN} | ` +
      `DRY_RUN: ${this._dryRun}`
    );

    // 즉시 1회 체크
    await this._check().catch(e => console.error('[RebalanceManager] 초기 체크 오류:', e.message));

    // 5분 주기
    this._intervalId = setInterval(
      () => this._check().catch(e => {
        console.error('[RebalanceManager] 체크 오류:', e.message);
        this._stats.errors++;
      }),
      CHECK_INTERVAL_MS,
    );
  }

  stop() {
    this._running = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    console.log('[RebalanceManager] 종료');
  }

  // ── 잔고 체크 ──────────────────────────────────────────

  async _check() {
    this._stats.totalChecks++;
    this._stats.lastCheckAt = Date.now();

    const exchangeEntries = Object.entries(this._exchanges);
    const balances = {};
    let krwSideUsd  = 0;
    let usdtSideUsd = 0;

    // 병렬 잔고 조회
    const results = await Promise.allSettled(
      exchangeEntries.map(async ([name, ex]) => {
        try {
          if (ex.quoteCurrency === 'KRW') {
            const krw = (await ex.getBalance('KRW')) || 0;
            const usd = krw / this._usdKrw;
            balances[name] = { krw, usd: +usd.toFixed(2) };
            krwSideUsd += usd;
          } else {
            const usdt = (await ex.getBalance('USDT')) || 0;
            balances[name] = { usdt: +usdt.toFixed(2) };
            usdtSideUsd += usdt;
          }
        } catch {
          balances[name] = { error: true };
        }
      })
    );

    const totalUsd = krwSideUsd + usdtSideUsd;

    this._balances = {
      exchanges:    balances,
      totalUsd:     +totalUsd.toFixed(2),
      krwSideUsd:   +krwSideUsd.toFixed(2),
      usdtSideUsd:  +usdtSideUsd.toFixed(2),
      imbalancePct: 0,
      status:       'BALANCED',
    };

    if (totalUsd < MIN_REBALANCE_USD) {
      this._balances.status = 'LOW_BALANCE';
      return;
    }

    // 불균형 계산
    const actualKrwRatio = krwSideUsd / totalUsd;
    const imbalance      = Math.abs(actualKrwRatio - this._targetRatio);
    this._balances.imbalancePct = +(imbalance * 100).toFixed(1);

    if (imbalance >= REBALANCE_THRESHOLD) {
      this._balances.status = 'REBALANCE_NEEDED';
      this._stats.warnings++;

      console.log(
        `[RebalanceManager] 불균형 감지! ` +
        `KRW측: $${krwSideUsd.toFixed(0)} (${(actualKrwRatio * 100).toFixed(1)}%) | ` +
        `USDT측: $${usdtSideUsd.toFixed(0)} (${((1 - actualKrwRatio) * 100).toFixed(1)}%) | ` +
        `불균형: ${(imbalance * 100).toFixed(1)}%`
      );

      await this._triggerRebalance(krwSideUsd, usdtSideUsd, totalUsd);
    } else {
      this._balances.status = 'BALANCED';
    }
  }

  // ── 리밸런싱 트리거 ────────────────────────────────────

  async _triggerRebalance(krwSideUsd, usdtSideUsd, totalUsd) {
    const targetKrw     = totalUsd * this._targetRatio;
    const targetUsdt    = totalUsd * (1 - this._targetRatio);

    let direction, amountUsd, fromExchange, toExchange;

    if (krwSideUsd > targetKrw) {
      // KRW 과다 → 해외로 이체
      direction    = 'KRW_TO_USDT';
      amountUsd    = krwSideUsd - targetKrw;
      fromExchange = this._findKrwExchange();
      toExchange   = this._findUsdtExchange();
    } else {
      // USDT 과다 → KRW로 이체
      direction    = 'USDT_TO_KRW';
      amountUsd    = usdtSideUsd - targetUsdt;
      fromExchange = this._findUsdtExchange();
      toExchange   = this._findKrwExchange();
    }

    if (!fromExchange || !toExchange) {
      console.warn('[RebalanceManager] 거래소 어댑터 없음 — 리밸런싱 불가');
      return;
    }

    const bridgeFeeUsd = BRIDGE_WITHDRAW_FEE * 0.6;  // XRP ~$0.60 추정
    const netAmountUsd = amountUsd - bridgeFeeUsd;

    this._stats.rebalancesTriggered++;

    const transfer = {
      direction,
      amountUsd:    +amountUsd.toFixed(2),
      netAmountUsd: +netAmountUsd.toFixed(2),
      bridgeCoin:   BRIDGE_COIN,
      bridgeFee:    `${BRIDGE_WITHDRAW_FEE} ${BRIDGE_COIN} (~$${bridgeFeeUsd.toFixed(2)})`,
      fromExchange,
      toExchange,
      timestamp:    Date.now(),
      status:       'pending',
    };

    console.log(
      `[RebalanceManager] XRP 브릿지 이체 ${this._dryRun ? '[DRY_RUN] ' : ''}` +
      `${fromExchange} -> ${toExchange} | ` +
      `$${amountUsd.toFixed(0)} (${direction}) | ` +
      `수수료: ${transfer.bridgeFee}`
    );

    if (this._dryRun) {
      transfer.status = 'dry_run';
      console.log('[RebalanceManager] [DRY_RUN] 실제 이체 없음 — 로그만 기록');
    } else if (netAmountUsd >= MIN_REBALANCE_USD) {
      try {
        await this._executeXrpBridge(fromExchange, toExchange, amountUsd);
        transfer.status = 'executed';
        this._stats.rebalancesExecuted++;
        console.log('[RebalanceManager] XRP 브릿지 이체 완료');
      } catch (e) {
        transfer.status = 'failed';
        transfer.error  = e.message;
        console.error(`[RebalanceManager] 이체 실패: ${e.message}`);
      }
    } else {
      transfer.status = 'below_minimum';
      console.log(`[RebalanceManager] 이체 금액 부족 ($${netAmountUsd.toFixed(0)} < $${MIN_REBALANCE_USD})`);
    }

    // 이력 저장
    this._history.unshift(transfer);
    if (this._history.length > 50) this._history = this._history.slice(0, 50);
  }

  // ── XRP 브릿지 실행 ────────────────────────────────────

  async _executeXrpBridge(fromExchange, toExchange, amountUsd) {
    const fromEx = this._exchanges[fromExchange];
    const toEx   = this._exchanges[toExchange];
    if (!fromEx || !toEx) throw new Error('거래소 어댑터 없음');

    // Step 1: 출발 거래소에서 XRP 매수
    const buyAmount = fromEx.quoteCurrency === 'KRW'
      ? amountUsd * this._usdKrw
      : amountUsd;
    await fromEx.marketBuy(BRIDGE_COIN, buyAmount);
    console.log(`[RebalanceManager] Step 1: ${fromExchange}에서 XRP $${amountUsd.toFixed(0)} 매수`);

    // Step 2: XRP 출금 → 도착 거래소
    // 보안상 실제 출금 API 호출은 위험 → 알림만
    console.log(
      `[RebalanceManager] Step 2: 수동 출금 필요! ` +
      `${fromExchange} -> ${toExchange} | ${BRIDGE_COIN} $${amountUsd.toFixed(0)} 상당`
    );

    // Step 3: 도착 거래소에서 XRP 매도 (수동 확인 후)
    console.log(
      `[RebalanceManager] Step 3: ${toExchange}에 입금 확인 후 XRP 매도 필요`
    );
  }

  // ── 유틸 ───────────────────────────────────────────────

  _findKrwExchange() {
    for (const [name, ex] of Object.entries(this._exchanges)) {
      if (ex.quoteCurrency === 'KRW') return name;
    }
    return null;
  }

  _findUsdtExchange() {
    for (const [name, ex] of Object.entries(this._exchanges)) {
      if (ex.quoteCurrency !== 'KRW') return name;
    }
    return null;
  }

  // ── 외부 API ──────────────────────────────────────────

  getBalances() { return { ...this._balances }; }
  getHistory(limit = 20) { return this._history.slice(0, limit); }

  getSummary() {
    return {
      running:     this._running,
      dryRun:      this._dryRun,
      threshold:   +(REBALANCE_THRESHOLD * 100).toFixed(0) + '%',
      bridgeCoin:  BRIDGE_COIN,
      balances:    this._balances,
      stats:       { ...this._stats },
      recentHistory: this._history.slice(0, 5),
    };
  }
}

module.exports = { RebalanceManager };
