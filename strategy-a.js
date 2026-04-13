"use strict";

/**
 * Strategy A v3 — 신호 퓨전 기반 1시간봉 스윙
 *
 * 핵심 설계 철학:
 *   단일 지표 → 복합 점수 퓨전
 *   MacroEngine + DataEngine + RegimeEngine + 기술적지표를 하나의 점수로 통합
 *   각 신호가 독립적으로 검증하므로 가짜 신호가 대폭 감소
 *
 * 진입 점수 구성 (진입 임계값: ≥ 40점):
 *   [필수] 골든크로스 (MA8 > MA21, 전봉 MA8 < MA21): 통과 아니면 즉시 종료
 *   [레짐] RegimeEngine:   BULL +25 / NEUTRAL 0 / BEAR → 즉시 차단
 *   [기술] EMA200 위:      +8  / 아래: -20
 *   [기술] MACD 양전환:    +10 / 음수:  -5
 *   [기술] VWAP 위:        +5  / 아래:  -3
 *   [기술] RSI 42~58:      +5  (35~65 범위 외: 차단)
 *   [기술] 거래량 급등:    +5
 *   [매크로] MacroEngine: -30 ~ +30
 *   [데이터] DataEngine:  -25 ~ +25  (OI/테이커/L·S/뉴스)
 *
 * 사이징:
 *   기본 예산 × RegimeEngine.getKellyMultiplier()
 *   BULL: 1.5x / NEUTRAL: 1.0x / BEAR: 0x
 *
 * 청산:
 *   - 부분청산: +2% 달성 시 50% 익절, 스탑 → 진입가 이동
 *   - ATR 트레일링 스탑 (+2% 이후 나머지)
 *   - 레짐 전환 청산: BULL→BEAR 즉시 전량 / BULL→NEUTRAL 스탑 브레이크이븐
 *   - 타임스탑 12h
 *   - 손절 후 2h 쿨다운
 *
 * 펀딩비 연동 (BybitFundingEngine):
 *   극단 롱크라우딩 (rate > 0.1%/8h): score -= 15
 *   LONG_COLLECT (rate < -0.03%): score += 8
 *   SHORT_COLLECT 중간 (0.03~0.1%): score -= 5
 */

const MARKETS          = ["KRW-BTC"];
const ENTRY_THRESHOLD  = 40;          // 진입 최소 점수
const TARGET_RATE      = 0.035;       // +3.5% 기본 목표
const PARTIAL_RATE     = 0.020;       // +2% 부분청산 트리거
const STOP_RATE        = -0.015;      // -1.5% 기본 손절
const MAX_HOLD_MS      = 12 * 60 * 60_000;
const ATR_TRAIL_MULT   = 2.0;
const LOSS_COOLDOWN_MS = 2 * 60 * 60_000;
const TICK_MS          = 5 * 60_000;

class StrategyA {
  constructor({ orderService, macroEngine, dataEngine, regimeEngine, fundingEngine, initialCapital, dryRun }) {
    this.orderService  = orderService;
    this.macroEngine   = macroEngine;
    this.dataEngine    = dataEngine;
    this.regimeEngine  = regimeEngine;
    this.fundingEngine = fundingEngine ?? null;   // BybitFundingEngine (선택적)
    this.dryRun        = dryRun ?? true;
    this.initialCapital = initialCapital;

    this.sim = {
      cash:        initialCapital,
      position:    null,
      realizedPnl: 0,
      totalTrades: 0,
      wins: 0, losses: 0,
      history:      [],
      tradeReturns: [],
    };

    this.livePosition  = null;
    this.enteringLock  = false;
    this._intervalId   = null;
    this._lastLossAt   = 0;

    // WebSocket 실시간
    this._wsPrice      = null;   // 마지막 수신 가격
    this._wsActive     = false;  // WS 연결 여부
    this._stoppingLive = false;  // 실거래 손절 중복 방지 락
    this._obImbalance  = null;   // 호가창 불균형 (-1 ~ +1, 양수=매수압)
  }

  start() {
    this._tick();
    this._intervalId = setInterval(() => this._tick(), TICK_MS);
    console.log("[StrategyA v3] 신호 퓨전 스윙 시작 — BTC");
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
  }

  /**
   * WebSocket 주입 (trading-bot.js에서 호출)
   * WS 연결 시 손절 감시가 5분 폴링 → ~100ms 실시간으로 전환됨
   */
  setWebSocket(ws) {
    this._wsActive = true;
    ws.subscribe("KRW-BTC");

    // 가격 → 실시간 손절/목표 감시
    ws.onPrice((market, price) => {
      if (market !== "KRW-BTC") return;
      this._wsPrice = price;
      this._onWsPrice(price);
    });

    // 호가창 → 진입 타이밍 신호 (REST 봇이 못 보는 엣지)
    ws.onOrderbook((market, imbalance) => {
      if (market === "KRW-BTC") this._obImbalance = imbalance;
    });

    console.log("[StrategyA] WebSocket 활성화 — 손절 실시간(~100ms) + 호가 불균형 신호");
  }

  /**
   * WebSocket 가격 수신 시 실시간 호출 (~100ms 간격)
   * 손절/목표/트레일링/타임스탑 즉시 체크
   */
  _onWsPrice(price) {
    // ── 시뮬 포지션 (동기, 즉시 처리) ──────────────────
    if (this.sim.position) {
      const pos = this.sim.position;
      if (price > pos.peakPrice) pos.peakPrice = price;

      const move = (price - pos.entryPrice) / pos.entryPrice;

      // ── 레짐 전환 청산 ────────────────────────────────
      const curRegime = this.regimeEngine?.getRegime?.();
      if (pos.regime === "BULL" && curRegime === "BEAR") {
        console.warn(`[A] 레짐 전환 청산(BULL→BEAR) — ${pos.market}`);
        const pnlRate = (price - pos.entryPrice) / pos.entryPrice;
        if (pnlRate < 0) this._lastLossAt = Date.now();
        this._recordSimClose(pos, price, pnlRate, pnlRate * pos.budget, "레짐전환BEAR");
        return;
      }
      if (pos.regime === "BULL" && curRegime === "NEUTRAL" && !pos.partialDone) {
        // NEUTRAL 전환 → 스탑을 브레이크이븐으로 올림 (청산하진 않음)
        if (pos.entryPrice > pos.stopPrice) {
          pos.stopPrice = pos.entryPrice * 1.001;
          console.log(`[A] 레짐 NEUTRAL 전환 — 스탑 브레이크이븐으로 상향`);
        }
      }

      // ── 부분청산: +PARTIAL_RATE 달성 시 50% 익절 ────
      if (!pos.partialDone && move >= PARTIAL_RATE) {
        const halfBudget = pos.budget * 0.5;
        const halfPnl    = halfBudget * move;
        this.sim.cash       += halfBudget + halfPnl;
        this.sim.realizedPnl += halfPnl;
        pos.budget   *= 0.5;
        pos.quantity *= 0.5;
        pos.partialDone = true;
        // 스탑을 진입가로 이동 (이후 리스크 0)
        if (pos.entryPrice > pos.stopPrice) pos.stopPrice = pos.entryPrice * 1.001;
        pos.trailActive = true;
        console.log(
          `[A] 부분청산(WS) +${(move * 100).toFixed(2)}% — ` +
          `50% 익절, 스탑→진입가, 나머지 트레일링`
        );
      }

      if (!pos.trailActive && move >= 0.02) {
        pos.trailActive = true;
      }
      if (pos.trailActive) {
        const newStop = pos.peakPrice * (1 - pos.atrStop);
        if (newStop > pos.stopPrice) pos.stopPrice = newStop;
      }

      const timeout  = Date.now() - pos.openedAt > MAX_HOLD_MS;
      const hitTarget = price >= pos.targetPrice;
      const hitStop   = price <= pos.stopPrice;

      if (hitTarget || hitStop || timeout) {
        const pnlRate = (price - pos.entryPrice) / pos.entryPrice;
        const reason  = hitTarget ? "목표" : hitStop ? "손절" : "타임";
        if (hitStop && pnlRate < 0) this._lastLossAt = Date.now();
        this._recordSimClose(pos, price, pnlRate, pnlRate * pos.budget, reason);
      }
    }

    // ── 실거래 포지션 (비동기, 락으로 중복 방지) ────────
    if (this.livePosition && !this._stoppingLive) {
      const pos = this.livePosition;
      if (price > pos.peakPrice) pos.peakPrice = price;

      const move = (price - pos.entryPrice) / pos.entryPrice;
      if (!pos.trailActive && move >= 0.02) pos.trailActive = true;
      if (pos.trailActive) {
        const newStop = pos.peakPrice * (1 - pos.atrStop);
        if (newStop > pos.stopPrice) pos.stopPrice = newStop;
      }

      if (price <= pos.stopPrice) {
        this._stoppingLive = true;
        this._executeLiveStop(pos, price)
          .finally(() => { this._stoppingLive = false; });
      }
    }
  }

  async _executeLiveStop(pos, price) {
    console.warn(
      `[A] 손절 실행(WS 실시간) — ${pos.market} ` +
      `현재가 ${price.toLocaleString()} ≤ 손절선 ${pos.stopPrice.toLocaleString()}`
    );
    if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
      if (pos.limitSellUuid) {
        await this.orderService.cancelOrder(pos.limitSellUuid).catch(() => {});
      }
      const bal = await this.orderService
        .getBalance(pos.market.split("-")[1]).catch(() => 0);
      if (bal > 0.00001) {
        await this.orderService.marketSell(pos.market, bal)
          .catch(e => console.error("[A] 손절 매도 실패:", e.message));
      }
    }
    this._closeLive("손절(WS)");
  }

  // ── 메인 틱 ──────────────────────────────────────────
  async _tick() {
    try {
      // 쿨다운 체크
      if (Date.now() - this._lastLossAt < LOSS_COOLDOWN_MS) return;

      // 손절/목표 감시: WS 없을 때만 폴링 (WS 있으면 _onWsPrice에서 실시간 처리)
      if (!this._wsActive) {
        if (this.sim.position)  await this._manageSimPos();
        if (this.livePosition)  await this._manageLivePos();
      }

      if (!this.sim.position && !this.livePosition && !this.enteringLock) {
        for (const market of MARKETS) {
          const result = await this._evaluate(market);
          if (result && result.score >= ENTRY_THRESHOLD) {
            await this._enter(market, result);
            break;
          }
        }
      }
    } catch (e) {
      console.error("[A] tick 오류:", e.message);
    }
  }

  // ── 신호 퓨전 평가 ───────────────────────────────────
  /**
   * 모든 신호를 통합해 단일 점수 반환.
   * 골든크로스가 없거나 BEAR 레짐이면 null.
   * 점수 >= ENTRY_THRESHOLD 이면 진입.
   */
  async _evaluate(market) {
    const candles = await this._fetch1h(market, 200);
    if (!candles || candles.length < 50) return null;

    const closes  = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const price   = closes[closes.length - 1];

    // ── [필수] 골든크로스 ───────────────────────────────
    const ma8   = this._sma(closes, 8);
    const ma21  = this._sma(closes, 21);
    const ma8p  = this._sma(closes.slice(0, -1), 8);
    const ma21p = this._sma(closes.slice(0, -1), 21);
    if (!ma8 || !ma21 || !ma8p || !ma21p) return null;

    const golden = ma8p < ma21p && ma8 > ma21;
    if (!golden) return null;  // 골든크로스 없으면 종료

    let score = 0;
    const reasons = [];

    // ── [레짐] RegimeEngine ─────────────────────────────
    const regimeScore = this.regimeEngine?.getScoreContribution?.() ?? 0;
    if (regimeScore <= -999) return null;  // BEAR → 즉시 차단
    score += regimeScore;
    const regime = this.regimeEngine?.getRegime?.() ?? "NEUTRAL";
    if (regime === "BULL") reasons.push("BULL_REGIME");

    // 골든크로스 자체 점수
    score += 15;
    reasons.push("GOLDEN_CROSS");

    // ── [기술] EMA200 ───────────────────────────────────
    const ema200 = this._ema(closes, 200);
    if (ema200) {
      if (price >= ema200 * 0.998) {
        score += 8;
        reasons.push("ABOVE_EMA200");
      } else {
        score -= 20;
        reasons.push("BELOW_EMA200");
      }
    }

    // ── [기술] MACD(12,26,9) ────────────────────────────
    const macd = this._macd(closes);
    if (macd) {
      if (macd.histogram > 0 && macd.histogram > macd.prevHistogram) {
        score += 10;
        reasons.push("MACD_MOMENTUM");
      } else if (macd.histogram <= 0) {
        score -= 5;
        reasons.push("MACD_NEGATIVE");
      }
    }

    // ── [기술] VWAP ─────────────────────────────────────
    const vwap = this._vwap(candles.slice(-24));
    if (vwap > 0) {
      if (price > vwap) { score += 5; reasons.push("ABOVE_VWAP"); }
      else              { score -= 3; reasons.push("BELOW_VWAP"); }
    }

    // ── [기술] RSI ──────────────────────────────────────
    const rsi = this._rsi(closes, 14);
    if (rsi < 35 || rsi > 68) return null;  // 극단 RSI 하드 차단
    if (rsi >= 42 && rsi <= 58) { score += 5; reasons.push(`RSI_SWEET(${rsi.toFixed(0)})`); }

    // ── [기술] 거래량 급등 ──────────────────────────────
    const recentVol = this._avg(volumes.slice(-3));
    const baseVol   = this._avg(volumes.slice(-23, -3));
    if (baseVol > 0 && recentVol > baseVol * 1.3) {
      score += 5;
      reasons.push("VOLUME_SPIKE");
    }

    // ── [매크로] MacroEngine (-30 ~ +30) ────────────────
    const macroSig = this.macroEngine?.getSignals?.(market);
    if (macroSig) {
      score += macroSig.macroScore;
      if (macroSig.macroScore > 10)  reasons.push("MACRO_BULLISH");
      if (macroSig.macroScore < -10) reasons.push("MACRO_BEARISH");
      // 극단 매크로 차단 (김치프리미엄 과열 등)
      if (macroSig.flags?.includes("KIMCHI_OVERPRICED")) {
        score -= 10;
        reasons.push("KIMCHI_OVERHEATED");
      }
    }

    // ── [데이터] DataEngine (-25 ~ +25) ─────────────────
    const dataSig = this.dataEngine?.getSignals?.(market);
    if (dataSig) {
      score += dataSig.dataScore;
      if (dataSig.flags?.includes("OI_SURGE"))             reasons.push("OI_SURGE");
      if (dataSig.flags?.includes("TAKER_BUY_DOMINANT"))   reasons.push("TAKER_BUY");
      if (dataSig.flags?.includes("LS_CROWDED_SHORT"))     reasons.push("SHORT_SQUEEZE");
      if (dataSig.flags?.includes("OI_CONFIRMED_CROSS_EXCHANGE")) reasons.push("OI_CROSS_CONFIRM");
    }

    // ── [실시간] 호가창 불균형 (-10 ~ +10) ─────────────
    // REST 폴링 봇이 볼 수 없는 ~100ms 실시간 매수/매도 압력
    // imbalance = (총매수잔량 - 총매도잔량) / 총잔량
    if (this._obImbalance !== null) {
      const ob = this._obImbalance;
      if (ob > 0.30) {
        score += 10;
        reasons.push(`OB_BID(${(ob * 100).toFixed(0)}%)`);   // 강한 매수압
      } else if (ob > 0.10) {
        score += 5;
        reasons.push(`OB_BID_WEAK`);
      } else if (ob < -0.30) {
        score -= 10;
        reasons.push(`OB_ASK(${(Math.abs(ob) * 100).toFixed(0)}%)`);  // 강한 매도압
      } else if (ob < -0.10) {
        score -= 5;
        reasons.push(`OB_ASK_WEAK`);
      }
    }

    const atr = this._atr(candles.slice(-14));

    // ── 호가창 하드 게이트 (강한 매도압 = 진입 차단) ────
    // 점수가 충분해도 매도압이 압도적이면 진입 타이밍이 아님
    // OB 데이터 있고, 강한 매도압(-0.35 이하)이면 null 반환
    if (this._obImbalance !== null && this._obImbalance < -0.35) {
      console.log(
        `[A] 진입 차단(OB 하드게이트) — ${market} 점수:${score} ` +
        `매도압 ${(Math.abs(this._obImbalance) * 100).toFixed(0)}% 우세`
      );
      return null;
    }

    // ── [펀딩비] BybitFundingEngine (-15 ~ +8) ───────────
    // 극단 롱크라우딩(rate>0.1%/8h): 롱 포지션 청산 압력 위험 → 강하게 차단
    // LONG_COLLECT(rate<-0.03%): 롱에게 유리 → 보너스
    const funding = this.fundingEngine?.state;
    if (funding?.fundingRate != null) {
      const rate = funding.fundingRate;
      if (rate > 0.001) {
        // 극단 크라우딩 (0.1%/8h ≈ 연 109%) → 진입 차단
        score -= 15;
        reasons.push(`FUND_EXTREME(${(rate * 100).toFixed(3)}%)`);
        if (score < ENTRY_THRESHOLD) {
          console.log(`[A] 차단(극단 펀딩비) — rate=${(rate * 100).toFixed(3)}%/8h`);
          return null;
        }
      } else if (rate > 0.0003) {
        // SHORT_COLLECT 중간 수준
        score -= 5;
        reasons.push(`FUND_SHORT_COLLECT`);
      } else if (rate < -0.0003) {
        // LONG_COLLECT → 롱에게 유리
        score += 8;
        reasons.push(`FUND_LONG_COLLECT`);
      }
    }

    console.log(
      `[A] 평가 — ${market} 점수:${score} (임계:${ENTRY_THRESHOLD}) ` +
      `[${reasons.join(",")}]`
    );

    return { score, reasons, price, rsi, ema200, vwap, ma8, ma21, atr, regime };
  }

  // ── 진입 ─────────────────────────────────────────────
  async _enter(market, sig) {
    if (this.enteringLock) return;
    this.enteringLock = true;
    try {
      const price = sig.price;

      // 레짐 기반 예산 배율
      const kellyMult = this.regimeEngine?.getKellyMultiplier?.() ?? 1.0;
      const budget    = this.sim.cash * 0.95 * Math.min(kellyMult, 1.5);

      // 변동성 기반 동적 목표/손절
      const dynTarget = sig.atr > 0
        ? Math.max(TARGET_RATE, (sig.atr / price) * 2.5)
        : TARGET_RATE;
      const dynStop = sig.atr > 0
        ? Math.max(STOP_RATE, -((sig.atr / price) * 1.2))
        : STOP_RATE;
      const atrStop = sig.atr > 0
        ? (sig.atr / price) * ATR_TRAIL_MULT
        : 0.015;

      this.sim.position = {
        market,
        entryPrice:   price,
        quantity:     budget / price,
        budget,
        targetPrice:  price * (1 + dynTarget),
        stopPrice:    price * (1 + dynStop),
        atrStop,
        peakPrice:    price,
        trailActive:  false,
        partialDone:  false,    // 부분청산 완료 여부
        openedAt:     Date.now(),
        entryScore:   sig.score,
        entryReasons: sig.reasons,
        rsiAtEntry:   sig.rsi,
        regime:       sig.regime,
      };
      this.sim.cash -= budget;

      console.log(
        `[A] ✅ 진입 — ${market} @${price.toLocaleString()} ` +
        `점수:${sig.score} 레짐:${sig.regime} ` +
        `목표:+${(dynTarget * 100).toFixed(1)}% ` +
        `손절:${(dynStop * 100).toFixed(1)}% ` +
        `예산배율:${kellyMult}x`
      );

      // 실거래
      if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
        const krw = await this.orderService.getBalance("KRW").catch(() => 0);
        const liveBudget = Math.min(krw * 0.9, this.initialCapital * 0.6 * kellyMult);
        if (liveBudget >= 5000) {
          const res = await this.orderService.smartLimitBuy(market, Math.floor(liveBudget));
          if (res.filled) {
            const ep = res.avgPrice;
            const lp = {
              market, quantity: res.executedVolume,
              entryPrice: ep, budget: liveBudget,
              targetPrice: ep * (1 + dynTarget),
              stopPrice:   ep * (1 + dynStop),
              atrStop, peakPrice: ep, trailActive: false,
              openedAt: Date.now(),
            };
            const sell = await this.orderService.limitSell(market, res.executedVolume, lp.targetPrice);
            lp.limitSellUuid = sell.uuid;
            this.livePosition = lp;
            this.orderService
              .waitForFillOrMarketSell(sell.uuid, market, res.executedVolume)
              .then(() => this._closeLive("TARGET"))
              .catch(e => console.error("[A] 매도 감시:", e.message));
          }
        }
      }
    } catch (e) {
      console.error("[A] 진입 오류:", e.message);
    } finally {
      this.enteringLock = false;
    }
  }

  // ── 시뮬 포지션 관리 ─────────────────────────────────
  async _manageSimPos() {
    const pos = this.sim.position;
    if (!pos) return;

    const candles = await this._fetch1h(pos.market, 3).catch(() => null);
    if (!candles?.length) return;

    const cur     = candles[candles.length - 1].close;
    const move    = (cur - pos.entryPrice) / pos.entryPrice;
    const timeout = Date.now() - pos.openedAt > MAX_HOLD_MS;

    // 최고가 갱신
    if (cur > pos.peakPrice) pos.peakPrice = cur;

    // ── 레짐 전환 청산 ────────────────────────────────
    const curRegime = this.regimeEngine?.getRegime?.();
    if (pos.regime === "BULL" && curRegime === "BEAR") {
      const pnlRate = (cur - pos.entryPrice) / pos.entryPrice;
      if (pnlRate < 0) this._lastLossAt = Date.now();
      this._recordSimClose(pos, cur, pnlRate, pnlRate * pos.budget, "레짐전환BEAR");
      return;
    }
    if (pos.regime === "BULL" && curRegime === "NEUTRAL" && !pos.partialDone) {
      if (pos.entryPrice > pos.stopPrice) {
        pos.stopPrice = pos.entryPrice * 1.001;
        console.log(`[A] 레짐 NEUTRAL — 스탑 브레이크이븐 상향`);
      }
    }

    // ── 부분청산 (폴링 경로, WS 없을 때) ─────────────
    if (!pos.partialDone && move >= PARTIAL_RATE) {
      const halfBudget = pos.budget * 0.5;
      const halfPnl    = halfBudget * move;
      this.sim.cash        += halfBudget + halfPnl;
      this.sim.realizedPnl += halfPnl;
      pos.budget   *= 0.5;
      pos.quantity *= 0.5;
      pos.partialDone = true;
      if (pos.entryPrice > pos.stopPrice) pos.stopPrice = pos.entryPrice * 1.001;
      pos.trailActive = true;
      console.log(`[A] 부분청산(폴링) +${(move * 100).toFixed(1)}% — 50% 익절, 스탑→진입가`);
    }

    // ATR 트레일링 스탑
    if (!pos.trailActive && move >= 0.02) {
      pos.trailActive = true;
    }
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - pos.atrStop);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    const hitTarget = cur >= pos.targetPrice;
    const hitStop   = cur <= pos.stopPrice;

    if (hitTarget || hitStop || timeout) {
      const pnlRate = (cur - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      const reason  = hitTarget ? "목표" : hitStop ? "손절" : "타임";
      if (hitStop && pnlRate < 0) this._lastLossAt = Date.now();
      this._recordSimClose(pos, cur, pnlRate, pnlKrw, reason);
    }
  }

  _recordSimClose(pos, exitPrice, pnlRate, pnlKrw, reason) {
    this.sim.cash += pos.budget * (1 + pnlRate);
    this.sim.realizedPnl += pnlKrw;
    this.sim.totalTrades++;
    if (pnlKrw >= 0) this.sim.wins++; else this.sim.losses++;
    this.sim.tradeReturns.push(pnlRate);
    if (this.sim.tradeReturns.length > 100) this.sim.tradeReturns.shift();
    this.sim.history.unshift({
      market: pos.market, entryPrice: pos.entryPrice, exitPrice,
      pnlRate: +pnlRate.toFixed(4), reason,
      entryScore: pos.entryScore, regime: pos.regime,
      closedAt: Date.now(),
    });
    this.sim.history = this.sim.history.slice(0, 30);
    this.sim.position = null;
    console.log(
      `[A] 청산(${reason}) — ${pos.market} ` +
      `${pnlRate >= 0 ? "+" : ""}${(pnlRate * 100).toFixed(2)}% ` +
      `(${Math.round(pnlKrw).toLocaleString()}원)`
    );
  }

  // ── 실거래 포지션 관리 ───────────────────────────────
  async _manageLivePos() {
    if (!this.livePosition) return;
    const pos = this.livePosition;

    let cur;
    try {
      const res  = await fetch(`https://api.upbit.com/v1/ticker?markets=${pos.market}`);
      const data = await res.json();
      cur = data[0]?.trade_price;
    } catch { return; }
    if (!cur) return;

    const move = (cur - pos.entryPrice) / pos.entryPrice;
    if (cur > pos.peakPrice) pos.peakPrice = cur;
    if (!pos.trailActive && move >= 0.02) pos.trailActive = true;
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - pos.atrStop);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    if (cur <= pos.stopPrice) {
      console.warn(`[A] 손절 트리거 — ${pos.market} ${cur.toLocaleString()} ≤ ${pos.stopPrice.toLocaleString()}`);
      if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
        if (pos.limitSellUuid) await this.orderService.cancelOrder(pos.limitSellUuid).catch(() => {});
        const bal = await this.orderService.getBalance(pos.market.split("-")[1]).catch(() => 0);
        if (bal > 0.00001) {
          await this.orderService.marketSell(pos.market, bal).catch(e => console.error("[A]", e.message));
        }
      }
      this._closeLive("손절");
    }
  }

  _closeLive(reason) {
    if (!this.livePosition) return;
    console.log(`[A] 실거래 청산(${reason}) — ${this.livePosition.market}`);
    this.livePosition = null;
  }

  // ── 데이터 수집 ──────────────────────────────────────
  async _fetch1h(market, count = 200) {
    const res  = await fetch(
      `https://api.upbit.com/v1/candles/minutes/60?market=${market}&count=${count}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.reverse().map(c => ({
      time:   new Date(c.candle_date_time_utc).getTime(),
      open:   c.opening_price, high: c.high_price,
      low:    c.low_price,     close: c.trade_price,
      volume: c.candle_acc_trade_volume,
    }));
  }

  // ── 기술적 지표 ──────────────────────────────────────
  _sma(arr, n) {
    if (!arr || arr.length < n) return null;
    return arr.slice(-n).reduce((s, v) => s + v, 0) / n;
  }

  _ema(arr, n) {
    if (!arr || arr.length < n) return null;
    const k = 2 / (n + 1);
    let ema = arr.slice(0, n).reduce((s, v) => s + v, 0) / n;
    for (let i = n; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
    return ema;
  }

  _emaArr(arr, n) {
    if (!arr || arr.length < n) return null;
    const k = 2 / (n + 1);
    const out = [];
    let ema = arr.slice(0, n).reduce((s, v) => s + v, 0) / n;
    out.push(ema);
    for (let i = n; i < arr.length; i++) { ema = arr[i] * k + ema * (1 - k); out.push(ema); }
    return out;
  }

  _macd(closes, fast = 12, slow = 26, sig = 9) {
    if (closes.length < slow + sig + 2) return null;
    const emaF = this._emaArr(closes, fast);
    const emaS = this._emaArr(closes, slow);
    if (!emaF || !emaS) return null;
    const offset   = emaF.length - emaS.length;
    const macdLine = emaS.map((s, i) => emaF[offset + i] - s);
    const sigArr   = this._emaArr(macdLine, sig);
    if (!sigArr || sigArr.length < 2) return null;
    const n = macdLine.length, sn = sigArr.length;
    return {
      histogram:     macdLine[n - 1] - sigArr[sn - 1],
      prevHistogram: macdLine[n - 2] - sigArr[sn - 2],
    };
  }

  _vwap(candles) {
    let cumVP = 0, cumV = 0;
    for (const c of candles) {
      const tp = (c.high + c.low + c.close) / 3;
      cumVP += tp * c.volume;
      cumV  += c.volume;
    }
    return cumV > 0 ? cumVP / cumV : 0;
  }

  _rsi(closes, p = 14) {
    if (closes.length < p + 1) return 50;
    let g = 0, l = 0;
    for (let i = closes.length - p; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    const al = l / p;
    return al === 0 ? 99 : 100 - 100 / (1 + (g / p) / al);
  }

  _atr(candles) {
    if (candles.length < 2) return 0;
    const trs = candles.slice(1).map((c, i) =>
      Math.max(
        c.high - c.low,
        Math.abs(c.high - candles[i].close),
        Math.abs(c.low  - candles[i].close)
      )
    );
    return trs.reduce((s, v) => s + v, 0) / trs.length;
  }

  _avg(arr) {
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  }

  // ── 대시보드 요약 ────────────────────────────────────
  getSummary() {
    const pos  = this.sim.position;
    const init = this.initialCapital;
    const inPos = pos ? pos.budget : 0;
    const total = this.sim.cash + inPos;
    return {
      name: "A — 신호퓨전 스윙 v3",
      pnlRate:     +((total - init) / init * 100).toFixed(3),
      totalAsset:  Math.round(total),
      realizedPnl: Math.round(this.sim.realizedPnl),
      totalTrades: this.sim.totalTrades,
      wins: this.sim.wins, losses: this.sim.losses,
      winRate: this.sim.totalTrades > 0
        ? +(this.sim.wins / this.sim.totalTrades * 100).toFixed(1) : null,
      regime:    this.regimeEngine?.getRegime?.() ?? "N/A",
      position: pos ? {
        market:       pos.market,
        entryPrice:   Math.round(pos.entryPrice),
        targetPrice:  Math.round(pos.targetPrice),
        stopPrice:    Math.round(pos.stopPrice),
        peakPrice:    Math.round(pos.peakPrice),
        trailActive:  pos.trailActive,
        openedAt:     pos.openedAt,
        entryScore:   pos.entryScore,
        entryReasons: pos.entryReasons,
        regime:       pos.regime,
      } : null,
      livePosition:  this.livePosition,
      history:       this.sim.history.slice(0, 8),
      tradeReturns:  this.sim.tradeReturns,
    };
  }
}

module.exports = { StrategyA };
