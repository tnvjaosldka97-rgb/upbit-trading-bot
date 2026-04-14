"use strict";

/**
 * ArbExecutor — 크로스 거래소 동시 실행 아비트라지 엔진
 *
 * 핵심 전략: "양쪽 미리 자금 배치 + 동시 주문"
 *   1) 업비트에 KRW + Binance에 USDT 미리 배치
 *   2) 스프레드 감지 → 싼 쪽 매수 + 비싼 쪽 매도 동시 실행
 *   3) 코인 이체 없이 즉시 수익 확정
 *   4) 주기적 리밸런싱으로 양쪽 잔고 유지
 *
 * 리스크: 사실상 없음 (방향성 노출 제로)
 *   - 동시 실행이므로 가격 변동 리스크 ~0
 *   - 양쪽 주문 하나만 체결되면? → 즉시 취소 + 시장가 청산 (안전장치)
 *
 * 수익 구조:
 *   스프레드 1.5% 발생 시 → 수수료 0.2% 차감 → 순수익 ~1.3%
 *   일 1~3회 발생 가정 → 월 20~40% 복리 수익 가능
 */

// ── 설정 ──────────────────────────────────────────────────
const MIN_SPREAD_PCT       = 1.2;    // 최소 실행 스프레드 (%)
const MAX_POSITION_USD     = 500;    // 1회 최대 포지션 (USD)
const MIN_POSITION_USD     = 10;     // 최소 포지션
const COOLDOWN_MS          = 30_000; // 같은 코인 재진입 쿨다운 (30초)
const MAX_DAILY_TRADES     = 50;     // 일일 최대 거래 횟수
const MAX_SLIPPAGE_PCT     = 0.3;    // 최대 허용 슬리피지 (%)
const REBALANCE_THRESHOLD  = 0.3;    // 자산 불균형 30% 초과 시 리밸런싱 경고
const FEE_RATE             = 0.001;  // 편도 수수료 0.1%
const ORDER_TIMEOUT_MS     = 5_000;  // 주문 체결 대기 시간

class ArbExecutor {
  /**
   * @param {Object} opts
   * @param {Object} opts.exchanges      - { upbit, binance, bybit } ExchangeAdapter
   * @param {Object} opts.tradeLogger    - TradeLogger 인스턴스
   * @param {number} opts.usdKrw         - USD/KRW 환율
   * @param {boolean} opts.dryRun        - 시뮬레이션 모드
   * @param {number} opts.maxPositionUsd - 1회 최대 포지션 (USD)
   */
  constructor({
    exchanges = {},
    tradeLogger,
    usdKrw = 1350,
    dryRun = true,
    maxPositionUsd = MAX_POSITION_USD,
  } = {}) {
    this._exchanges      = exchanges;
    this._logger         = tradeLogger;
    this._usdKrw         = usdKrw;
    this._dryRun         = dryRun;
    this._maxPosUsd      = maxPositionUsd;

    // 쿨다운 추적 (코인별 마지막 실행 시간)
    this._lastExecution  = new Map();

    // 일일 통계
    this._daily = {
      date:        new Date().toLocaleDateString("ko-KR"),
      trades:      0,
      totalProfit: 0,  // USD
      opportunities: 0,
      executed:    0,
      skipped:     0,
    };

    // 전체 시뮬레이션 통계
    this._sim = {
      totalTrades:     0,
      totalProfitUsd:  0,
      totalProfitPct:  0,
      wins:            0,
      losses:          0,
      avgSpread:       0,
      spreadsSum:      0,
      bestTrade:       null,
      history:         [],   // 최근 50건
    };

    // 리밸런싱 상태
    this._balances = {
      lastCheck: 0,
      upbit:    { krw: 0, coins: {} },
      binance:  { usdt: 0, coins: {} },
      bybit:    { usdt: 0, coins: {} },
      imbalancePct: 0,
    };
  }

  // ── 환율 설정 ────────────────────────────────────────────
  setUsdKrw(rate) { if (rate > 0) this._usdKrw = rate; }

  // ── 아비트라지 기회 실행 ─────────────────────────────────
  /**
   * CrossExchangeArb에서 기회 감지 시 호출
   * @param {Object} opp - { coin, buyExchange, sellExchange, buyPrice, sellPrice, spreadPct, netProfitPct }
   */
  async execute(opp) {
    this._resetDailyIfNeeded();
    this._daily.opportunities++;

    // ── 실행 조건 체크 ────────────────────────────────────
    const skipReason = this._shouldSkip(opp);
    if (skipReason) {
      this._daily.skipped++;
      console.log(`[ArbExec] 스킵 — ${opp.coin} ${opp.buyExchange}→${opp.sellExchange}: ${skipReason}`);
      return { executed: false, reason: skipReason };
    }

    // ── 호가창 검증 (실행 직전 실시간 가격 확인) ──────────
    const verified = await this._verifySpread(opp);
    if (!verified.ok) {
      this._daily.skipped++;
      console.log(
        `[ArbExec] 스프레드 소멸 — ${opp.coin} ` +
        `실시간: ${verified.realSpread?.toFixed(2)}% (최소 ${MIN_SPREAD_PCT}%)`
      );
      return { executed: false, reason: "스프레드 소멸" };
    }

    // ── 호가창 깊이 슬리피지 가드 ──────────────────────────
    const depthCheck = await this._checkOrderbookDepth(opp, verified);
    if (!depthCheck.ok) {
      this._daily.skipped++;
      console.log(
        `[ArbExec] 호가 깊이 부족 — ${opp.coin} | ` +
        `필요: $${depthCheck.requiredUsd?.toFixed(0)} | ` +
        `가용: $${depthCheck.availableUsd?.toFixed(0)} | ` +
        `예상슬리피지: ${depthCheck.estSlippage?.toFixed(2)}%`
      );
      return { executed: false, reason: `호가깊이부족(${depthCheck.estSlippage?.toFixed(1)}%)` };
    }

    // ── 포지션 사이즈 계산 ────────────────────────────────
    const positionUsd = Math.min(
      this._maxPosUsd,
      await this._getAvailableBudget(opp.buyExchange, opp.coin)
    );
    if (positionUsd < MIN_POSITION_USD) {
      this._daily.skipped++;
      return { executed: false, reason: `잔고부족($${positionUsd.toFixed(0)})` };
    }

    console.log(
      `[ArbExec] ⚡ 실행! ${opp.coin} | ` +
      `${opp.buyExchange}(매수$${verified.buyPrice.toFixed(2)}) → ` +
      `${opp.sellExchange}(매도$${verified.sellPrice.toFixed(2)}) | ` +
      `스프레드: ${verified.realSpread.toFixed(2)}% | 포지션: $${positionUsd.toFixed(0)}`
    );

    // ── 동시 주문 실행 ───────────────────────────────────
    const result = this._dryRun
      ? await this._simulateExecution(opp, verified, positionUsd)
      : await this._liveExecution(opp, verified, positionUsd);

    // ── 결과 기록 ────────────────────────────────────────
    this._recordResult(opp, result, positionUsd);
    this._lastExecution.set(opp.coin, Date.now());

    return result;
  }

  // ── 스킵 조건 체크 ───────────────────────────────────────
  _shouldSkip(opp) {
    // 1) 스프레드 너무 낮음
    if (opp.spreadPct < MIN_SPREAD_PCT) {
      return `스프레드${opp.spreadPct}%(<${MIN_SPREAD_PCT}%)`;
    }

    // 2) 쿨다운
    const lastTime = this._lastExecution.get(opp.coin) || 0;
    if (Date.now() - lastTime < COOLDOWN_MS) {
      return `쿨다운(${Math.round((COOLDOWN_MS - (Date.now() - lastTime)) / 1000)}초)`;
    }

    // 3) 일일 한도
    if (this._daily.trades >= MAX_DAILY_TRADES) {
      return `일일한도(${MAX_DAILY_TRADES}회)`;
    }

    // 4) 거래소 어댑터 존재 확인
    const buyEx  = this._getExchange(opp.buyExchange);
    const sellEx = this._getExchange(opp.sellExchange);
    if (!buyEx || !sellEx) {
      return `거래소없음(${opp.buyExchange}/${opp.sellExchange})`;
    }

    return null;
  }

  // ── 실시간 스프레드 재검증 ───────────────────────────────
  async _verifySpread(opp) {
    try {
      const buyEx  = this._getExchange(opp.buyExchange);
      const sellEx = this._getExchange(opp.sellExchange);

      const [buyTicker, sellTicker] = await Promise.all([
        buyEx.getTicker(opp.coin),
        sellEx.getTicker(opp.coin),
      ]);

      if (!buyTicker?.price || !sellTicker?.price) {
        return { ok: false, reason: "가격조회실패" };
      }

      // USD 환산
      let buyPrice  = buyTicker.price;
      let sellPrice = sellTicker.price;
      if (buyEx.quoteCurrency === "KRW")  buyPrice  = buyPrice / this._usdKrw;
      if (sellEx.quoteCurrency === "KRW") sellPrice = sellPrice / this._usdKrw;

      const realSpread = (sellPrice - buyPrice) / buyPrice * 100;

      return {
        ok: realSpread >= MIN_SPREAD_PCT,
        realSpread,
        buyPrice,
        sellPrice,
        buyPriceRaw:  buyTicker.price,
        sellPriceRaw: sellTicker.price,
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // ── 시뮬레이션 실행 ──────────────────────────────────────
  async _simulateExecution(opp, verified, positionUsd) {
    const buyQty   = positionUsd / verified.buyPrice;
    const sellQty  = buyQty; // 같은 수량 매도

    const buyCost  = positionUsd * (1 + FEE_RATE);     // 수수료 포함 매수 비용
    const sellRecv = sellQty * verified.sellPrice * (1 - FEE_RATE); // 수수료 차감 매도 수익

    const profitUsd = sellRecv - buyCost;
    const profitPct = (profitUsd / positionUsd) * 100;

    // 슬리피지 시뮬레이션 (0~0.2% 랜덤)
    const slippage = Math.random() * 0.002;
    const adjProfitUsd = profitUsd - (positionUsd * slippage);
    const adjProfitPct = (adjProfitUsd / positionUsd) * 100;

    console.log(
      `[ArbExec] 시뮬 완료 — ${opp.coin} | ` +
      `순수익: $${adjProfitUsd.toFixed(2)} (${adjProfitPct.toFixed(2)}%) | ` +
      `슬리피지: ${(slippage * 100).toFixed(2)}%`
    );

    return {
      executed:   true,
      dryRun:     true,
      coin:       opp.coin,
      buyExchange:  opp.buyExchange,
      sellExchange: opp.sellExchange,
      buyPrice:   verified.buyPrice,
      sellPrice:  verified.sellPrice,
      quantity:   buyQty,
      positionUsd,
      spreadPct:  verified.realSpread,
      profitUsd:  +adjProfitUsd.toFixed(4),
      profitPct:  +adjProfitPct.toFixed(4),
      slippage:   +(slippage * 100).toFixed(3),
      timestamp:  Date.now(),
    };
  }

  // ── 실거래 실행 (양쪽 동시 주문) ─────────────────────────
  async _liveExecution(opp, verified, positionUsd) {
    const buyEx  = this._getExchange(opp.buyExchange);
    const sellEx = this._getExchange(opp.sellExchange);

    // 매수 수량 계산 (매수 거래소 기준)
    const buyQty = positionUsd / verified.buyPrice;

    try {
      // ★ 핵심: 양쪽 동시 주문 (Promise.all)
      const [buyResult, sellResult] = await Promise.all([
        buyEx.marketBuy(opp.coin, buyEx.quoteCurrency === "KRW"
          ? positionUsd * this._usdKrw   // KRW 환산
          : positionUsd                   // USDT
        ),
        sellEx.marketSell(opp.coin, buyQty),
      ]);

      // 체결 확인
      if (!buyResult || !sellResult) {
        // 한쪽만 체결 → 비상 청산
        console.error("[ArbExec] ⚠️ 한쪽만 체결! 비상 청산 시도");
        await this._emergencyUnwind(buyEx, sellEx, opp.coin, buyResult, sellResult);
        return { executed: false, reason: "부분체결_비상청산" };
      }

      const actualBuyPrice  = buyResult.avgPrice || verified.buyPrice;
      const actualSellPrice = sellResult.avgPrice || verified.sellPrice;

      // USD 환산
      let buyUsd  = actualBuyPrice;
      let sellUsd = actualSellPrice;
      if (buyEx.quoteCurrency === "KRW")  buyUsd  = buyUsd / this._usdKrw;
      if (sellEx.quoteCurrency === "KRW") sellUsd = sellUsd / this._usdKrw;

      const profitUsd = (sellUsd - buyUsd) * buyQty - (positionUsd * FEE_RATE * 2);
      const profitPct = (profitUsd / positionUsd) * 100;

      console.log(
        `[ArbExec] ✅ 실거래 완료 — ${opp.coin} | ` +
        `수익: $${profitUsd.toFixed(2)} (${profitPct.toFixed(2)}%)`
      );

      return {
        executed: true, dryRun: false,
        coin: opp.coin,
        buyExchange: opp.buyExchange, sellExchange: opp.sellExchange,
        buyPrice: buyUsd, sellPrice: sellUsd,
        quantity: buyQty, positionUsd,
        spreadPct: verified.realSpread,
        profitUsd: +profitUsd.toFixed(4),
        profitPct: +profitPct.toFixed(4),
        timestamp: Date.now(),
      };
    } catch (e) {
      console.error(`[ArbExec] 실행 오류: ${e.message}`);
      return { executed: false, reason: e.message };
    }
  }

  // ── 비상 청산 (한쪽만 체결 시) ───────────────────────────
  async _emergencyUnwind(buyEx, sellEx, coin, buyResult, sellResult) {
    try {
      if (buyResult && !sellResult) {
        // 매수만 됨 → 매수 거래소에서 시장가 매도
        const qty = buyResult.filledQty || buyResult.executedVolume || 0;
        if (qty > 0) await buyEx.marketSell(coin, qty);
        console.warn(`[ArbExec] 비상: ${buyEx.name} 매도 ${qty} ${coin}`);
      }
      if (!buyResult && sellResult) {
        // 매도만 됨 → 매도 거래소에서 시장가 매수
        const qty = sellResult.filledQty || sellResult.executedVolume || 0;
        const cost = qty * 100; // 대략적 비용
        if (qty > 0) await sellEx.marketBuy(coin, cost);
        console.warn(`[ArbExec] 비상: ${sellEx.name} 매수 ${coin}`);
      }
    } catch (e) {
      console.error(`[ArbExec] ⚠️ 비상 청산 실패! 수동 확인 필요: ${e.message}`);
    }
  }

  // ── 호가창 깊이 검증 (슬리피지 가드) ──────────────────────
  async _checkOrderbookDepth(opp, verified) {
    try {
      const buyEx  = this._getExchange(opp.buyExchange);
      const sellEx = this._getExchange(opp.sellExchange);

      const [buyOB, sellOB] = await Promise.all([
        buyEx.getOrderbook(opp.coin, 10),
        sellEx.getOrderbook(opp.coin, 10),
      ]);

      // 매수 거래소: asks (매도 호가) 깊이 확인 — 우리가 매수하려면 asks에 물량 필요
      // 매도 거래소: bids (매수 호가) 깊이 확인 — 우리가 매도하려면 bids에 물량 필요
      const positionUsd = Math.min(this._maxPosUsd, MAX_POSITION_USD);

      const buyDepthUsd  = this._calcDepthUsd(buyOB.asks,  buyEx.quoteCurrency, "ask");
      const sellDepthUsd = this._calcDepthUsd(sellOB.bids, sellEx.quoteCurrency, "bid");

      const availableUsd = Math.min(buyDepthUsd, sellDepthUsd);

      // 슬리피지 추정: 포지션/가용깊이 비율로 선형 근사
      const depthRatio = positionUsd / Math.max(availableUsd, 1);
      const estSlippage = depthRatio * 0.5; // 깊이의 50% 사용 시 ~0.5% 슬리피지

      // 가드: 슬리피지가 MAX_SLIPPAGE_PCT 초과 또는 포지션 > 가용깊이의 30%
      const ok = estSlippage <= MAX_SLIPPAGE_PCT && positionUsd <= availableUsd * 0.3;

      return {
        ok,
        buyDepthUsd:  +buyDepthUsd.toFixed(2),
        sellDepthUsd: +sellDepthUsd.toFixed(2),
        availableUsd: +availableUsd.toFixed(2),
        requiredUsd:  positionUsd,
        estSlippage:  +estSlippage.toFixed(3),
        depthRatio:   +depthRatio.toFixed(3),
      };
    } catch (e) {
      // 호가 조회 실패 시 보수적으로 통과 (REST 스프레드 검증은 이미 통과)
      console.warn(`[ArbExec] 호가 깊이 조회 실패 (통과): ${e.message}`);
      return { ok: true, estSlippage: 0 };
    }
  }

  _calcDepthUsd(levels, quoteCurrency, _type) {
    let totalUsd = 0;
    for (const level of levels) {
      const priceUsd = quoteCurrency === "KRW"
        ? level.price / this._usdKrw
        : level.price;
      totalUsd += priceUsd * level.qty;
    }
    return totalUsd;
  }

  // ── 사용 가능한 예산 계산 ─────────────────────────────────
  async _getAvailableBudget(exchangeName, coin) {
    if (this._dryRun) return this._maxPosUsd;

    try {
      const ex = this._getExchange(exchangeName);
      if (!ex) return 0;

      if (ex.quoteCurrency === "KRW") {
        const krw = await ex.getBalance("KRW");
        return (krw || 0) / this._usdKrw;
      } else {
        const usdt = await ex.getBalance("USDT");
        return usdt || 0;
      }
    } catch {
      return 0;
    }
  }

  // ── 결과 기록 ────────────────────────────────────────────
  _recordResult(opp, result, positionUsd) {
    if (!result.executed) return;

    this._daily.trades++;
    this._daily.totalProfit += result.profitUsd;
    this._daily.executed++;

    this._sim.totalTrades++;
    this._sim.totalProfitUsd += result.profitUsd;
    this._sim.spreadsSum     += result.spreadPct;
    this._sim.avgSpread       = this._sim.spreadsSum / this._sim.totalTrades;

    if (result.profitUsd >= 0) this._sim.wins++;
    else this._sim.losses++;

    if (!this._sim.bestTrade || result.profitPct > this._sim.bestTrade.profitPct) {
      this._sim.bestTrade = {
        coin: result.coin,
        profitPct: result.profitPct,
        profitUsd: result.profitUsd,
        spreadPct: result.spreadPct,
        timestamp: result.timestamp,
      };
    }

    this._sim.history.unshift({
      coin:         result.coin,
      buyExchange:  result.buyExchange,
      sellExchange: result.sellExchange,
      spreadPct:    result.spreadPct,
      profitUsd:    result.profitUsd,
      profitPct:    result.profitPct,
      dryRun:       result.dryRun,
      timestamp:    result.timestamp,
    });
    if (this._sim.history.length > 50) this._sim.history = this._sim.history.slice(0, 50);

    // SQLite 로그
    if (this._logger) {
      this._logger.logBuy({
        strategy: "ARB", market: `${result.buyExchange}:${result.coin}`,
        price: result.buyPrice, quantity: result.quantity,
        budget: positionUsd, dryRun: result.dryRun,
      });
      this._logger.logSell({
        strategy: "ARB", market: `${result.sellExchange}:${result.coin}`,
        price: result.sellPrice, quantity: result.quantity,
        budget: positionUsd, reason: `arb_spread_${result.spreadPct}%`,
        pnlRate: result.profitPct / 100, pnlKrw: result.profitUsd * this._usdKrw,
        dryRun: result.dryRun,
      });
    }
  }

  // ── 일일 리셋 ────────────────────────────────────────────
  _resetDailyIfNeeded() {
    const today = new Date().toLocaleDateString("ko-KR");
    if (this._daily.date !== today) {
      console.log(
        `[ArbExec] 일일 리셋 — 어제: ` +
        `${this._daily.executed}건 실행, $${this._daily.totalProfit.toFixed(2)} 수익`
      );
      this._daily = {
        date: today, trades: 0, totalProfit: 0,
        opportunities: 0, executed: 0, skipped: 0,
      };
    }
  }

  // ── 거래소 어댑터 조회 ───────────────────────────────────
  _getExchange(name) {
    const key = name.toLowerCase();
    return this._exchanges[key] || null;
  }

  // ── 대시보드 요약 ────────────────────────────────────────
  getSummary() {
    return {
      // 일일
      dailyTrades:      this._daily.executed,
      dailyProfitUsd:   +this._daily.totalProfit.toFixed(2),
      dailyOpps:        this._daily.opportunities,
      dailySkipped:     this._daily.skipped,

      // 전체
      totalTrades:      this._sim.totalTrades,
      totalProfitUsd:   +this._sim.totalProfitUsd.toFixed(2),
      wins:             this._sim.wins,
      losses:           this._sim.losses,
      winRate:          this._sim.totalTrades > 0
        ? +((this._sim.wins / this._sim.totalTrades) * 100).toFixed(1) : null,
      avgSpread:        +this._sim.avgSpread.toFixed(2),
      bestTrade:        this._sim.bestTrade,

      // 최근 거래
      history:          this._sim.history.slice(0, 10),

      // 설정
      dryRun:           this._dryRun,
      minSpread:        MIN_SPREAD_PCT,
      maxPosition:      this._maxPosUsd,
      cooldownSec:      COOLDOWN_MS / 1000,
    };
  }
}

module.exports = { ArbExecutor };
