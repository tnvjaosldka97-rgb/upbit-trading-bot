'use strict';

const CFG = require("./config");

/**
 * ArbExecutor — 크로스 거래소 동시 매수/매도 실행 엔진
 *
 * 전략: "양쪽 미리 자금 배치 + 동시 주문"
 *   1) CrossExchangeArb에서 기회 수신
 *   2) 검증: 잔고 확인, 호가 깊이, 슬리피지 추정
 *   3) 동시 매수(저가 거래소) + 매도(고가 거래소)
 *   4) 비상 청산: 한쪽만 체결 시 반대 포지션 즉시 청산
 *
 * 환경변수:
 *   ARB_MAX_POSITION_USD  — 1회 최대 포지션 (기본 500)
 *   ARB_MIN_SPREAD_PCT    — 최소 실행 스프레드 (기본 1.2)
 *   DRY_RUN               — true면 로그만, 실주문 없음
 */

require('dotenv').config();

const MAX_POSITION_USD  = parseFloat(process.env.ARB_MAX_POSITION_USD) || 500;
const MIN_SPREAD_PCT    = parseFloat(process.env.ARB_MIN_SPREAD_PCT)   || 1.2;
const MIN_POSITION_USD  = 10;
const MAX_SLIPPAGE_PCT  = 0.3;
const COOLDOWN_MS       = 30_000;
const MAX_DAILY_TRADES  = 50;
const FEE_RATE          = 0.001;  // 편도 0.1%
const DRY_RUN_DEFAULT   = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// 지속성 요구: 동일 기회가 2회 이상 + 간격 ≥ 500ms일 때만 실행 (플래시/stale 필터)
const PERSIST_MIN_TICKS = 2;
const PERSIST_MIN_MS    = 500;
const PERSIST_WINDOW_MS = 5_000;   // 5초 지나면 재카운트
// 빗썸 매수 레그 특수 가드: 유동성 얇은 구조적 갭 방어 (14h 데이터 기준 92% 빗썸 레그)
const THIN_LIQUIDITY_EXCHANGES = new Set(['bithumb']);
const THIN_LIQ_DEPTH_MULTIPLIER = 3;

class ArbExecutor {
  /**
   * @param {Object}  opts
   * @param {Object}  opts.exchanges      - { exchangeName: ExchangeAdapter }
   * @param {Object}  opts.dataLogger     - ArbDataLogger 인스턴스 (옵션)
   * @param {number}  opts.usdKrw         - USD/KRW 환율
   * @param {boolean} opts.dryRun         - DRY_RUN 모드
   * @param {number}  opts.maxPositionUsd - 1회 최대 포지션 (USD)
   */
  constructor({
    exchanges = {},
    dataLogger = null,
    usdKrw = CFG.DEFAULT_USD_KRW,
    dryRun = DRY_RUN_DEFAULT,
    maxPositionUsd = MAX_POSITION_USD,
  } = {}) {
    this._exchanges  = exchanges;
    this._logger     = dataLogger;
    this._usdKrw     = usdKrw;
    this._dryRun     = dryRun;
    this._maxPosUsd  = maxPositionUsd;

    // 쿨다운 추적 (심볼별 마지막 실행 시각)
    this._lastExec = new Map();

    // 지속성 추적: key → { firstSeen, lastSeen, count }
    this._persistence = new Map();

    // 일일 통계
    this._daily = {
      date:        this._todayStr(),
      trades:      0,
      totalProfit: 0,
      opportunities: 0,
      executed:    0,
      skipped:     0,
    };

    // 누적 통계
    this._cumulative = {
      totalTrades:    0,
      totalProfitUsd: 0,
      wins:           0,
      losses:         0,
      spreadsSum:     0,
      avgSpread:      0,
      bestTrade:      null,
      history:        [],   // 최근 50건
    };
  }

  setUsdKrw(rate) { if (rate > 0) this._usdKrw = rate; }

  // ── 기회 실행 ──────────────────────────────────────────

  /**
   * CrossExchangeArb의 opportunity 이벤트에서 호출
   * @param {Object} opp - { buyExchange, sellExchange, symbol, spread, netSpread, volume }
   */
  async execute(opp) {
    this._resetDailyIfNeeded();
    this._daily.opportunities++;

    // ── 0) 지속성 체크: 2+ ticks, ≥500ms 간격 ──────
    const persistKey = `${opp.symbol}-${opp.buyExchange}-${opp.sellExchange}`;
    const now = Date.now();
    let p = this._persistence.get(persistKey);
    if (!p || (now - p.lastSeen) > PERSIST_WINDOW_MS) {
      p = { firstSeen: now, lastSeen: now, count: 1 };
      this._persistence.set(persistKey, p);
      // 누수 방지: 500개 넘으면 오래된 것부터 정리
      if (this._persistence.size > 500) {
        const cutoff = now - PERSIST_WINDOW_MS * 2;
        for (const [k, v] of this._persistence) if (v.lastSeen < cutoff) this._persistence.delete(k);
      }
      return { executed: false, reason: 'persistence_first_tick' };
    }
    p.count++;
    p.lastSeen = now;
    if (p.count < PERSIST_MIN_TICKS || (now - p.firstSeen) < PERSIST_MIN_MS) {
      return { executed: false, reason: `persistence_${p.count}/${PERSIST_MIN_TICKS}` };
    }

    // ── 1) 사전 조건 검증 ─────────────────────────────
    const skipReason = this._shouldSkip(opp);
    if (skipReason) {
      this._daily.skipped++;
      console.log(`[ArbExecutor] 스킵 — ${opp.symbol} ${opp.buyExchange}->${opp.sellExchange}: ${skipReason}`);
      return { executed: false, reason: skipReason };
    }

    // ── 2) 실시간 스프레드 재검증 ─────────────────────
    const verified = await this._verifySpread(opp);
    if (!verified.ok) {
      this._daily.skipped++;
      console.log(
        `[ArbExecutor] 스프레드 소멸 — ${opp.symbol} 실시간: ${verified.realSpread?.toFixed(2) || 'N/A'}%`
      );
      return { executed: false, reason: 'spread_vanished' };
    }

    // ── 3) 슬리피지 가드: 호가 깊이 확인 ────────────
    const depthCheck = await this._checkOrderbookDepth(opp);
    if (!depthCheck.ok) {
      this._daily.skipped++;
      console.log(
        `[ArbExecutor] 호가 깊이 부족 — ${opp.symbol} | ` +
        `슬리피지 추정: ${depthCheck.estSlippage?.toFixed(2)}% (한도: ${MAX_SLIPPAGE_PCT}%)`
      );
      return { executed: false, reason: `slippage_${depthCheck.estSlippage?.toFixed(1)}%` };
    }

    // ── 4) 잔고 확인 + 포지션 사이즈 계산 ────────────
    const positionUsd = Math.min(
      this._maxPosUsd,
      await this._getAvailableBudget(opp.buyExchange),
    );
    if (positionUsd < MIN_POSITION_USD) {
      this._daily.skipped++;
      return { executed: false, reason: `balance_low($${positionUsd.toFixed(0)})` };
    }

    console.log(
      `[ArbExecutor] 실행! ${opp.symbol} | ` +
      `${opp.buyExchange}(매수$${verified.buyPrice.toFixed(2)}) -> ` +
      `${opp.sellExchange}(매도$${verified.sellPrice.toFixed(2)}) | ` +
      `스프레드: ${verified.realSpread.toFixed(2)}% | 포지션: $${positionUsd.toFixed(0)}` +
      (this._dryRun ? ' [DRY_RUN]' : '')
    );

    // ── 5) 동시 주문 실행 ─────────────────────────────
    const result = this._dryRun
      ? this._simulateExecution(opp, verified, positionUsd)
      : await this._liveExecution(opp, verified, positionUsd);

    // ── 6) 결과 기록 ─────────────────────────────────
    this._recordResult(opp, result, positionUsd);
    this._lastExec.set(opp.symbol, Date.now());

    // ArbDataLogger에 기록
    if (this._logger && result.executed) {
      try { this._logger.logExecution(result); } catch {}
    }

    return result;
  }

  // ── 스킵 조건 검증 ─────────────────────────────────────

  _shouldSkip(opp) {
    if ((opp.spread || opp.spreadPct || 0) < MIN_SPREAD_PCT) {
      return `spread_${opp.spread || opp.spreadPct}%(<${MIN_SPREAD_PCT}%)`;
    }

    const lastTime = this._lastExec.get(opp.symbol) || 0;
    if (Date.now() - lastTime < COOLDOWN_MS) {
      const remain = Math.round((COOLDOWN_MS - (Date.now() - lastTime)) / 1000);
      return `cooldown(${remain}s)`;
    }

    if (this._daily.trades >= MAX_DAILY_TRADES) {
      return `daily_limit(${MAX_DAILY_TRADES})`;
    }

    const buyEx  = this._exchanges[opp.buyExchange];
    const sellEx = this._exchanges[opp.sellExchange];
    if (!buyEx || !sellEx) {
      return `exchange_not_found(${opp.buyExchange}/${opp.sellExchange})`;
    }

    return null;
  }

  // ── 실시간 스프레드 재검증 ──────────────────────────────

  async _verifySpread(opp) {
    try {
      // Fast path: opp가 신선한 소스 가격을 들고 오면 (WS 기반) REST 재호출 생략
      // 기존 구현은 WS-감지 opp를 REST로 재검증하다가 가격 불일치로 대부분 거부됨 (53건→0실행)
      const now = Date.now();
      const buyTsFresh  = opp.buyTs  && (now - opp.buyTs)  < 3_000;
      const sellTsFresh = opp.sellTs && (now - opp.sellTs) < 3_000;
      if (opp.buyPrice && opp.sellPrice && buyTsFresh && sellTsFresh) {
        const realSpread = (opp.sellPrice - opp.buyPrice) / opp.buyPrice * 100;
        return {
          ok: realSpread >= MIN_SPREAD_PCT,
          realSpread,
          buyPrice:  opp.buyPrice,
          sellPrice: opp.sellPrice,
          source:    'opp_cached',
        };
      }

      // Slow path: REST 재검증 (어댑터 필요)
      const buyEx  = this._exchanges[opp.buyExchange];
      const sellEx = this._exchanges[opp.sellExchange];
      if (!buyEx || !sellEx) return { ok: false, reason: 'no_adapter' };

      const [buyTicker, sellTicker] = await Promise.all([
        buyEx.getTicker(opp.symbol),
        sellEx.getTicker(opp.symbol),
      ]);

      if (!buyTicker?.price || !sellTicker?.price) return { ok: false, reason: 'no_price' };

      let buyPrice  = buyTicker.price;
      let sellPrice = sellTicker.price;
      if (buyEx.quoteCurrency === 'KRW')  buyPrice  /= this._usdKrw;
      if (sellEx.quoteCurrency === 'KRW') sellPrice /= this._usdKrw;

      const realSpread = (sellPrice - buyPrice) / buyPrice * 100;

      return {
        ok: realSpread >= MIN_SPREAD_PCT,
        realSpread,
        buyPrice,
        sellPrice,
        source: 'rest_verify',
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // ── 호가 깊이 슬리피지 가드 ────────────────────────────

  async _checkOrderbookDepth(opp) {
    try {
      const buyEx  = this._exchanges[opp.buyExchange];
      const sellEx = this._exchanges[opp.sellExchange];
      // 빗썸 레그에서 getOrderbook 미구현 시 "통과"는 위험 — 실패 처리
      const isThinLegUnverifiable =
        (THIN_LIQUIDITY_EXCHANGES.has(opp.buyExchange)  && !buyEx?.getOrderbook) ||
        (THIN_LIQUIDITY_EXCHANGES.has(opp.sellExchange) && !sellEx?.getOrderbook);
      if (isThinLegUnverifiable) {
        return { ok: false, reason: 'thin_liq_depth_unverifiable', estSlippage: 999 };
      }
      if (!buyEx?.getOrderbook || !sellEx?.getOrderbook) return { ok: true, estSlippage: 0 };

      const [buyOB, sellOB] = await Promise.all([
        buyEx.getOrderbook(opp.symbol, 10),
        sellEx.getOrderbook(opp.symbol, 10),
      ]);

      const posUsd = Math.min(this._maxPosUsd, MAX_POSITION_USD);

      const buyDepthUsd  = this._calcDepthUsd(buyOB.asks,  buyEx.quoteCurrency);
      const sellDepthUsd = this._calcDepthUsd(sellOB.bids, sellEx.quoteCurrency);
      const availableUsd = Math.min(buyDepthUsd, sellDepthUsd);

      const depthRatio  = posUsd / Math.max(availableUsd, 1);
      const estSlippage = depthRatio * 0.5;

      // Thin-liquidity 거래소가 레그에 있으면 depth ≥ position × 3 강제
      const thinLegPresent =
        THIN_LIQUIDITY_EXCHANGES.has(opp.buyExchange) ||
        THIN_LIQUIDITY_EXCHANGES.has(opp.sellExchange);
      const depthMultiplierOk = thinLegPresent
        ? (availableUsd >= posUsd * THIN_LIQ_DEPTH_MULTIPLIER)
        : (posUsd <= availableUsd * 0.3);

      return {
        ok: estSlippage <= MAX_SLIPPAGE_PCT && depthMultiplierOk,
        buyDepthUsd:  +buyDepthUsd.toFixed(2),
        sellDepthUsd: +sellDepthUsd.toFixed(2),
        availableUsd: +availableUsd.toFixed(2),
        estSlippage:  +estSlippage.toFixed(3),
        thinLegPresent,
      };
    } catch (e) {
      console.warn(`[ArbExecutor] 호가 깊이 조회 실패: ${e.message}`);
      // 빗썸 레그일 땐 실패 시 거부, 그 외는 통과 (기존 동작 유지)
      const thinLegPresent =
        THIN_LIQUIDITY_EXCHANGES.has(opp.buyExchange) ||
        THIN_LIQUIDITY_EXCHANGES.has(opp.sellExchange);
      return thinLegPresent
        ? { ok: false, reason: 'depth_fetch_failed_thin_leg', estSlippage: 999 }
        : { ok: true, estSlippage: 0 };
    }
  }

  _calcDepthUsd(levels, quoteCurrency) {
    let totalUsd = 0;
    for (const level of (levels || [])) {
      const priceUsd = quoteCurrency === 'KRW' ? level.price / this._usdKrw : level.price;
      totalUsd += priceUsd * (level.qty || level.size || 0);
    }
    return totalUsd;
  }

  // ── 잔고 확인 ──────────────────────────────────────────

  async _getAvailableBudget(exchangeName) {
    if (this._dryRun) return this._maxPosUsd;
    try {
      const ex = this._exchanges[exchangeName];
      if (!ex) return 0;
      if (ex.quoteCurrency === 'KRW') {
        return ((await ex.getBalance('KRW')) || 0) / this._usdKrw;
      }
      return (await ex.getBalance('USDT')) || 0;
    } catch { return 0; }
  }

  // ── DRY_RUN 시뮬레이션 ─────────────────────────────────

  _simulateExecution(opp, verified, positionUsd) {
    const buyQty   = positionUsd / verified.buyPrice;
    const buyCost  = positionUsd * (1 + FEE_RATE);
    const sellRecv = buyQty * verified.sellPrice * (1 - FEE_RATE);
    const profitUsd = sellRecv - buyCost;
    const profitPct = (profitUsd / positionUsd) * 100;

    // 랜덤 슬리피지 시뮬 (0~0.2%)
    const slippage = Math.random() * 0.002;
    const adjProfit = profitUsd - (positionUsd * slippage);
    const adjPct    = (adjProfit / positionUsd) * 100;

    console.log(
      `[ArbExecutor] [DRY_RUN] 시뮬 완료 — ${opp.symbol} | ` +
      `순수익: $${adjProfit.toFixed(2)} (${adjPct.toFixed(2)}%)`
    );

    return {
      executed:     true,
      dryRun:       true,
      coin:         opp.symbol,
      buyExchange:  opp.buyExchange,
      sellExchange: opp.sellExchange,
      buyPrice:     verified.buyPrice,
      sellPrice:    verified.sellPrice,
      quantity:     buyQty,
      positionUsd,
      spreadPct:    verified.realSpread,
      profitUsd:    +adjProfit.toFixed(4),
      profitPct:    +adjPct.toFixed(4),
      slippage:     +(slippage * 100).toFixed(3),
      timestamp:    Date.now(),
    };
  }

  // ── 실거래 동시 주문 ───────────────────────────────────

  async _liveExecution(opp, verified, positionUsd) {
    const buyEx  = this._exchanges[opp.buyExchange];
    const sellEx = this._exchanges[opp.sellExchange];
    const buyQty = positionUsd / verified.buyPrice;

    try {
      // 핵심: 양쪽 동시 주문 (Promise.all)
      const [buyResult, sellResult] = await Promise.all([
        buyEx.marketBuy(
          opp.symbol,
          buyEx.quoteCurrency === 'KRW' ? positionUsd * this._usdKrw : positionUsd,
        ),
        sellEx.marketSell(opp.symbol, buyQty),
      ]);

      // 한쪽만 체결 → 비상 청산
      if (!buyResult || !sellResult) {
        console.error('[ArbExecutor] 한쪽만 체결! 비상 청산 시도');
        await this._emergencyUnwind(buyEx, sellEx, opp.symbol, buyResult, sellResult);
        return { executed: false, reason: 'partial_fill_emergency' };
      }

      const actualBuy  = buyResult.avgPrice  || verified.buyPrice;
      const actualSell = sellResult.avgPrice || verified.sellPrice;

      let buyUsd  = actualBuy;
      let sellUsd = actualSell;
      if (buyEx.quoteCurrency  === 'KRW') buyUsd  /= this._usdKrw;
      if (sellEx.quoteCurrency === 'KRW') sellUsd /= this._usdKrw;

      const profitUsd = (sellUsd - buyUsd) * buyQty - (positionUsd * FEE_RATE * 2);
      const profitPct = (profitUsd / positionUsd) * 100;

      console.log(
        `[ArbExecutor] 실거래 완료 — ${opp.symbol} | ` +
        `수익: $${profitUsd.toFixed(2)} (${profitPct.toFixed(2)}%)`
      );

      return {
        executed: true, dryRun: false,
        coin: opp.symbol,
        buyExchange: opp.buyExchange, sellExchange: opp.sellExchange,
        buyPrice: buyUsd, sellPrice: sellUsd,
        quantity: buyQty, positionUsd,
        spreadPct: verified.realSpread,
        profitUsd: +profitUsd.toFixed(4),
        profitPct: +profitPct.toFixed(4),
        timestamp: Date.now(),
      };
    } catch (e) {
      console.error(`[ArbExecutor] 실행 오류: ${e.message}`);
      return { executed: false, reason: e.message };
    }
  }

  // ── 비상 청산 ──────────────────────────────────────────

  async _emergencyUnwind(buyEx, sellEx, symbol, buyResult, sellResult) {
    try {
      if (buyResult && !sellResult) {
        const qty = buyResult.filledQty || buyResult.executedVolume || 0;
        if (qty > 0) await buyEx.marketSell(symbol, qty);
        console.warn(`[ArbExecutor] 비상 매도 완료: ${buyEx.name} ${qty} ${symbol}`);
      }
      if (!buyResult && sellResult) {
        const qty = sellResult.filledQty || sellResult.executedVolume || 0;
        if (qty > 0) await sellEx.marketBuy(symbol, qty * 100);
        console.warn(`[ArbExecutor] 비상 매수 완료: ${sellEx.name} ${symbol}`);
      }
    } catch (e) {
      console.error(`[ArbExecutor] 비상 청산 실패! 수동 확인 필요: ${e.message}`);
    }
  }

  // ── 결과 기록 ──────────────────────────────────────────

  _recordResult(opp, result, positionUsd) {
    if (!result.executed) return;

    this._daily.trades++;
    this._daily.totalProfit += result.profitUsd;
    this._daily.executed++;

    this._cumulative.totalTrades++;
    this._cumulative.totalProfitUsd += result.profitUsd;
    this._cumulative.spreadsSum     += result.spreadPct;
    this._cumulative.avgSpread       = this._cumulative.spreadsSum / this._cumulative.totalTrades;

    if (result.profitUsd >= 0) this._cumulative.wins++;
    else this._cumulative.losses++;

    if (!this._cumulative.bestTrade || result.profitPct > this._cumulative.bestTrade.profitPct) {
      this._cumulative.bestTrade = {
        coin: result.coin, profitPct: result.profitPct,
        profitUsd: result.profitUsd, spreadPct: result.spreadPct,
        timestamp: result.timestamp,
      };
    }

    this._cumulative.history.unshift({
      coin: result.coin, buyExchange: result.buyExchange,
      sellExchange: result.sellExchange, spreadPct: result.spreadPct,
      profitUsd: result.profitUsd, profitPct: result.profitPct,
      dryRun: result.dryRun, timestamp: result.timestamp,
    });
    if (this._cumulative.history.length > 50) {
      this._cumulative.history = this._cumulative.history.slice(0, 50);
    }
  }

  // ── 유틸 ───────────────────────────────────────────────

  _todayStr() { return new Date().toISOString().slice(0, 10); }

  _resetDailyIfNeeded() {
    const today = this._todayStr();
    if (this._daily.date !== today) {
      console.log(
        `[ArbExecutor] 일일 리셋 — 어제: ` +
        `${this._daily.executed}건, $${this._daily.totalProfit.toFixed(2)} 수익`
      );
      this._daily = {
        date: today, trades: 0, totalProfit: 0,
        opportunities: 0, executed: 0, skipped: 0,
      };
    }
  }

  // ── 대시보드 요약 ──────────────────────────────────────

  getSummary() {
    return {
      dailyTrades:     this._daily.executed,
      dailyProfitUsd:  +this._daily.totalProfit.toFixed(2),
      dailyOpps:       this._daily.opportunities,
      dailySkipped:    this._daily.skipped,
      totalTrades:     this._cumulative.totalTrades,
      totalProfitUsd:  +this._cumulative.totalProfitUsd.toFixed(2),
      wins:            this._cumulative.wins,
      losses:          this._cumulative.losses,
      winRate:         this._cumulative.totalTrades > 0
        ? +((this._cumulative.wins / this._cumulative.totalTrades) * 100).toFixed(1) : null,
      avgSpread:       +this._cumulative.avgSpread.toFixed(2),
      bestTrade:       this._cumulative.bestTrade,
      history:         this._cumulative.history.slice(0, 10),
      dryRun:          this._dryRun,
      minSpread:       MIN_SPREAD_PCT,
      maxPosition:     this._maxPosUsd,
      cooldownSec:     COOLDOWN_MS / 1000,
    };
  }
}

module.exports = { ArbExecutor };
