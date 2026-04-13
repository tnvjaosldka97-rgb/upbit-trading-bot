"use strict";

/**
 * TradingBot v2 — 10점짜리 통합 엔진
 *
 * v1 대비 핵심 변경:
 *   1) 켈리 공식 기반 포지션 사이징 (캘리브레이션 결과 자동 반영)
 *   2) 시작 시 포지션 복구 (크래시 생존)
 *   3) 시장가 → 스마트 지정가 진입 (슬리피지 제거)
 *   4) 진입 중 잠금 (race condition 방지)
 *   5) 일일 통계 리셋 자정 자동 처리
 */

const { MarketDataService }    = require("./market-data-service");
const { CalibrationEngine }    = require("./calibration-engine");
const { UpbitOrderService }    = require("./upbit-order-service");
const { MacroSignalEngine }    = require("./macro-signal-engine");
const { DataAggregationEngine }= require("./data-aggregation-engine");
const { RegimeEngine }         = require("./regime-engine");
const { UpbitWebSocket }       = require("./upbit-websocket");
const { DashboardServer }      = require("./dashboard-server");
const { StrategyA }            = require("./strategy-a");
const { StrategyB }            = require("./strategy-b");
const { BybitFundingEngine }   = require("./bybit-funding-engine");

try { require("dotenv").config(); } catch {}

const INITIAL_KRW = Number(process.env.INITIAL_CAPITAL || 100_000);
const BOT_MODE    = process.env.BOT_MODE || "CALIBRATION";
const DRY_RUN     = process.env.DRY_RUN  !== "false";

// 자본 배분: A 60% / B 40%
const CAPITAL_A = Math.floor(INITIAL_KRW * 0.60);
const CAPITAL_B = Math.floor(INITIAL_KRW * 0.40);

class TradingBot {
  constructor() {
    this.mds = new MarketDataService({
      solutionName:       "ATS-v9",
      defaultMarketCode:  "KRW-BTC",
    });
    // simulationConfig AND simulation state 모두 갱신 (createSimulationState가 생성자에서 호출되므로)
    this.mds.simulationConfig.initialCapital  = INITIAL_KRW;
    this.mds.state.simulation.initialCapital  = INITIAL_KRW;
    this.mds.state.simulation.cash            = INITIAL_KRW;

    this.calibration  = new CalibrationEngine(this.mds);
    this.orderService = new UpbitOrderService({
      accessKey: process.env.UPBIT_ACCESS_KEY,
      secretKey: process.env.UPBIT_SECRET_KEY,
    });
    this.macroEngine  = new MacroSignalEngine(this.mds);
    this.dataEngine   = new DataAggregationEngine(this.mds);
    this.regimeEngine  = new RegimeEngine();
    this.fundingEngine = new BybitFundingEngine();
    this.upbitWs       = new UpbitWebSocket();
    this._wsBtcPrice  = null;   // WS 실시간 BTC 가격

    // ── Strategy A/B ─────────────────────────────────
    // 모든 엔진을 각 전략에 주입 → 신호 퓨전 가능
    const opts = { orderService: this.orderService, dryRun: DRY_RUN };
    this.strategyA = new StrategyA({
      ...opts,
      macroEngine:   this.macroEngine,
      dataEngine:    this.dataEngine,
      regimeEngine:  this.regimeEngine,
      fundingEngine: this.fundingEngine,   // 펀딩비 신호 연동
      initialCapital: CAPITAL_A,
    });
    this.strategyB = new StrategyB({
      ...opts,
      dataEngine:   this.dataEngine,   // DataEngine 연동 → 중복 폴링 제거
      initialCapital: CAPITAL_B,
    });

    // 실거래 포지션 (구 MDS 기반, 참조용 유지)
    this.livePosition = null;

    // 진입 중 잠금 (race condition 방지)
    this.enteringPosition = false;

    // 일일 손실 추적
    this.dailyStats = {
      date:         "",
      realizedPnl:  0,
      tradeCount:   0,
      consLosses:   0,
    };

    this.MAX_DAILY_LOSS      = INITIAL_KRW * 0.006; // -0.6%
    this.MAX_DAILY_TRADES    = 8;
    this.MAX_CONS_LOSSES     = 2;

    this.mainLoopId = null;
    this.dashboard  = new DashboardServer(this);
  }

  async start() {
    console.log("══════════════════════════════════════════");
    console.log("  ATS v9 — 상위 0.1% 트레이딩 봇");
    console.log(`  모드:     ${BOT_MODE}`);
    console.log(`  자본:     ${INITIAL_KRW.toLocaleString()}원`);
    console.log(`  실거래:   ${DRY_RUN ? "OFF (시뮬레이션만)" : "ON ⚡"}`);
    console.log(`  API 키:   ${this.orderService.getSummary().hasApiKeys ? "연결됨" : "없음 ⚠"}`);
    console.log("══════════════════════════════════════════");

    // ── 실거래 모드 프리플라이트 체크 ──────────────────
    if (!DRY_RUN) {
      const ok = await this._preflight();
      if (!ok) {
        console.error("[Bot] 프리플라이트 실패 — 안전을 위해 중단. DRY_RUN=true로 재시작하세요.");
        process.exit(1);
      }
    }

    this.dashboard.start();

    await this.mds.start();
    console.log("[Bot] 시세 엔진 준비 완료");

    this.calibration.start();
    console.log("[Bot] 캘리브레이션 엔진 시작");

    this.macroEngine.start();
    this.mds.setMacroEngine(this.macroEngine);
    console.log("[Bot] 매크로 시그널 엔진 시작 (김치 프리미엄 / 펀딩비 / 공포탐욕)");

    this.dataEngine.start();
    this.mds.setDataEngine(this.dataEngine);
    console.log("[Bot] 데이터 집합 엔진 시작 (OI / L/S비율 / 테이커 / 신규상장 / 뉴스)");

    await this.regimeEngine.start();
    console.log(`[Bot] 레짐 엔진 시작 — 현재 국면: ${this.regimeEngine.getRegime()}`);

    // ── WebSocket 실시간 시세 ─────────────────────────
    this.upbitWs.subscribe("KRW-BTC");
    this.upbitWs.onPrice((market, price) => {
      if (market === "KRW-BTC") this._wsBtcPrice = price;
    });
    this.upbitWs.connect();
    console.log("[Bot] WebSocket 시세 스트림 연결 시작 (KRW-BTC 실시간)");

    // ── Strategy A/B 시작 ─────────────────────────────
    this.strategyA.start();
    this.strategyA.setWebSocket(this.upbitWs);   // 실시간 손절 활성화
    console.log(`[Bot] Strategy A 시작 (1h 스윙) — 자본 ${CAPITAL_A.toLocaleString()}원`);
    await this.strategyB.start();
    console.log(`[Bot] Strategy B 시작 (신규상장) — 자본 ${CAPITAL_B.toLocaleString()}원`);

    // ── 시작 시 포지션 복구 ──────────────────────────
    if (!DRY_RUN && this.orderService.getSummary().hasApiKeys) {
      const recovered = await this.orderService
        .reconcilePosition(this.mds.state.analysisMarketCodes)
        .catch((e) => { console.error("[Bot] 복구 실패:", e.message); return null; });

      if (recovered) {
        this.livePosition = {
          ...recovered,
          entryPrice:  recovered.avgBuyPrice,
          budget:      recovered.quantity * recovered.avgBuyPrice,
          stopPrice:   recovered.avgBuyPrice * (1 + this.mds.simulationConfig.stopLossRate),
          targetPrice: recovered.avgBuyPrice * (1 + this.mds.simulationConfig.targetGrossRate),
        };
        console.log(`[Bot] 포지션 복구 완료 — ${recovered.market}`);
      }
    }

    // 캘리브레이션은 백그라운드 병렬 실행 — 게이트 제거
    // 실거래 루프는 즉시 시작, 캘리브레이션 데이터가 쌓이면 자동으로 파라미터 갱신
    console.log("[Bot] 실거래 루프 즉시 시작 (캘리브레이션 백그라운드 병렬 실행)");
    this.startMainLoop();

    process.on("SIGINT",  () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
  }

  startMainLoop() {
    this.mainLoopId = setInterval(async () => {
      try { await this.tick(); }
      catch (e) { console.error("[Bot] tick 오류:", e.message); }
    }, 5_000);
  }

  // ─── 5초 메인 틱 ────────────────────────────────────
  // Strategy A/B가 독립적으로 주문을 처리함.
  // 메인 틱은 공통 서킷브레이커 + MDS 구시스템 포지션 복구 관리만 담당.

  async tick() {
    const now = Date.now();
    this.resetDailyStatsIfNeeded(now);

    if (this.isHalted()) return;
    this.applyCalibratedConfig();

    // 복구된 구시스템 포지션(재시작 시)만 손절 감시
    // Strategy A/B 포지션은 각 전략이 직접 관리
    if (this.livePosition) {
      await this.managePosition();
    }
  }

  // ─── 진입 ───────────────────────────────────────────

  async enterPosition(simPosition) {
    if (DRY_RUN || !this.orderService.getSummary().hasApiKeys) return;
    if (this.enteringPosition) return;
    this.enteringPosition = true;

    try {
      const krwBalance = await this.orderService.getBalance("KRW");

      // ── 켈리 기반 포지션 사이징 ──────────────────────
      const budget = this.computeBudget(krwBalance);
      if (budget < 5_000) {
        console.warn("[Bot] 예산 부족 또는 켈리 0 — 진입 건너뜀");
        return;
      }

      console.log(
        `[Bot] 진입 시도 → ${simPosition.marketCode} | ` +
        `예산 ${budget.toLocaleString()}원 (잔고의 ${((budget / krwBalance) * 100).toFixed(1)}%)`,
      );

      // ── 스마트 지정가 매수 ────────────────────────────
      const result = await this.orderService.smartLimitBuy(
        simPosition.marketCode,
        budget,
      );

      if (!result.filled) {
        console.warn(`[Bot] 진입 실패: ${result.reason}`);
        return;
      }

      const { avgPrice, executedVolume } = result;

      // ── 지정가 매도 예약 ──────────────────────────────
      const targetPrice = avgPrice * (1 + simPosition.targetGrossRate);
      const limitSell   = await this.orderService.limitSell(
        simPosition.marketCode,
        executedVolume,
        targetPrice,
      );

      this.livePosition = {
        market:         simPosition.marketCode,
        quantity:       executedVolume,
        entryPrice:     avgPrice,
        budget,
        targetPrice,
        stopPrice:      avgPrice * (1 + (simPosition.dynamicStopRate ?? this.mds.simulationConfig.stopLossRate)),
        limitSellUuid:  limitSell.uuid,
        openedAt:       Date.now(),
      };

      console.log(
        `[Bot] 포지션 오픈 — 매수가 ${avgPrice.toLocaleString()} | ` +
        `목표 ${targetPrice.toLocaleString()} | 손절 ${this.livePosition.stopPrice.toLocaleString()}`,
      );

      // 지정가 체결 비동기 감시
      this.orderService
        .waitForFillOrMarketSell(limitSell.uuid, simPosition.marketCode, executedVolume)
        .then((r) => this.onPositionClosed(r))
        .catch((e) => console.error("[Bot] 매도 감시 오류:", e.message));

      this.dailyStats.tradeCount++;

    } catch (e) {
      console.error("[Bot] 진입 오류:", e.message);
    } finally {
      this.enteringPosition = false;
    }
  }

  // ─── 포지션 관리 (손절 감시) ────────────────────────

  async managePosition() {
    if (!this.livePosition) return;

    // WS 실시간 가격 우선, 없으면 MDS 폴백
    const ctx          = this.mds.ensureContext(this.livePosition.market);
    const currentPrice = (this.livePosition.market === "KRW-BTC" && this._wsBtcPrice)
      ? this._wsBtcPrice
      : this.mds.getCurrentPrice(ctx);
    if (!currentPrice) return;

    if (currentPrice <= this.livePosition.stopPrice) {
      console.warn(
        `[Bot] 손절 트리거 → ${this.livePosition.market} | ` +
        `현재 ${currentPrice.toLocaleString()} ≤ 손절가 ${this.livePosition.stopPrice.toLocaleString()}`,
      );

      if (!DRY_RUN && this.orderService.getSummary().hasApiKeys) {
        if (this.livePosition.limitSellUuid) {
          await this.orderService.cancelOrder(this.livePosition.limitSellUuid).catch(() => {});
        }
        const balance = await this.orderService
          .getBalance(this.livePosition.market.split("-")[1])
          .catch(() => 0);
        if (balance > 0.00001) {
          await this.orderService.marketSell(this.livePosition.market, balance).catch((e) => {
            console.error("[Bot] 손절 매도 실패:", e.message);
          });
        }
      }

      const pnl = (currentPrice - this.livePosition.entryPrice) / this.livePosition.entryPrice;
      this.recordPnl(pnl * this.livePosition.budget);
      this.livePosition = null;
    }
  }

  onPositionClosed(result) {
    if (!this.livePosition) return;
    const ctx          = this.mds.ensureContext(this.livePosition.market);
    const currentPrice = this.mds.getCurrentPrice(ctx) || this.livePosition.targetPrice;
    const pnl          = (currentPrice - this.livePosition.entryPrice) / this.livePosition.entryPrice;
    this.recordPnl(pnl * this.livePosition.budget);
    this.livePosition = null;
  }

  recordPnl(pnlKrw) {
    this.dailyStats.realizedPnl += pnlKrw;
    if (pnlKrw < 0) this.dailyStats.consLosses++;
    else             this.dailyStats.consLosses = 0;

    console.log(
      `[Bot] 실현 손익 ${pnlKrw >= 0 ? "+" : ""}${pnlKrw.toFixed(0)}원 | ` +
      `오늘 누적 ${this.dailyStats.realizedPnl.toFixed(0)}원`,
    );
  }

  // ─── 켈리 사이징 ────────────────────────────────────

  computeBudget(krwBalance) {
    const cal = this.calibration.getCalibratedConfig();

    let fraction;
    if (cal?.kellyFraction && cal.evPositive) {
      fraction = cal.kellyFraction;
    } else {
      // 캘리브레이션 전: 적정 고정값 (R/R 3:1 기반 최소 켈리)
      fraction = 0.08;
    }

    const budget = Math.min(krwBalance, INITIAL_KRW * fraction);
    return Math.floor(budget);
  }

  // ─── 캘리브레이션 파라미터 적용 ─────────────────────

  applyCalibratedConfig() {
    const cal = this.calibration.getCalibratedConfig();
    if (!cal || cal._applied || !cal.evPositive) return;

    const cfg = this.mds.simulationConfig;
    cfg.volTargetMult          = cal.volTargetMult;
    cfg.volStopMult            = cal.volStopMult;
    cfg.minBullishProbability  = cal.minBullishProbability;
    cal._applied               = true;

    console.log(
      `[Bot] 캘리브레이션 적용 — ` +
      `승률 ${(cal.observedWinRate * 100).toFixed(1)}% | ` +
      `EV ${(cal.ev * 100).toFixed(3)}% | ` +
      `켈리 ${(cal.kellyFraction * 100).toFixed(1)}%`,
    );
  }

  // ─── 서킷브레이커 ────────────────────────────────────

  isHalted() {
    const s = this.dailyStats;
    if (s.realizedPnl < -this.MAX_DAILY_LOSS) {
      console.warn(`[Bot] 일일 손실 한도 도달 (${s.realizedPnl.toFixed(0)}원)`);
      return true;
    }
    if (s.tradeCount >= this.MAX_DAILY_TRADES) {
      console.warn(`[Bot] 일일 최대 거래 횟수 도달 (${s.tradeCount}회)`);
      return true;
    }
    if (s.consLosses >= this.MAX_CONS_LOSSES) {
      console.warn(`[Bot] ${this.MAX_CONS_LOSSES}연속 손절 — 오늘 종료`);
      return true;
    }
    if (this.orderService.halted) {
      console.warn(`[Bot] 주문 엔진 중단: ${this.orderService.haltReason}`);
      return true;
    }
    return false;
  }

  resetDailyStatsIfNeeded(now) {
    const today = new Date(now).toLocaleDateString("ko-KR");
    if (this.dailyStats.date !== today) {
      this.dailyStats = { date: today, realizedPnl: 0, tradeCount: 0, consLosses: 0 };
    }
  }

  // ─── 실거래 프리플라이트 체크 ────────────────────────

  async _preflight() {
    console.log("[Bot] 프리플라이트 체크 시작...");
    const checks = [];

    // 1. API 키 유효성
    const hasKeys = this.orderService.getSummary().hasApiKeys;
    checks.push({ name: "API 키", ok: hasKeys });

    // 2. 계좌 잔고 조회
    let krwBalance = 0;
    try {
      krwBalance = await this.orderService.getBalance("KRW");
      checks.push({ name: `KRW 잔고 (${krwBalance.toLocaleString()}원)`, ok: krwBalance >= 5_000 });
    } catch (e) {
      checks.push({ name: "KRW 잔고 조회", ok: false, reason: e.message });
    }

    // 3. 최소 자본 대비 잔고 확인
    checks.push({
      name: `잔고 ≥ 자본설정(${INITIAL_KRW.toLocaleString()}원)의 50%`,
      ok: krwBalance >= INITIAL_KRW * 0.5,
    });

    // 4. 업비트 API 응답 테스트
    try {
      const res = await fetch("https://api.upbit.com/v1/ticker?markets=KRW-BTC");
      checks.push({ name: "업비트 API 응답", ok: res.ok });
    } catch (e) {
      checks.push({ name: "업비트 API 응답", ok: false });
    }

    // 결과 출력
    let allOk = true;
    console.log("[Bot] ─── 프리플라이트 결과 ───────────────");
    for (const c of checks) {
      const mark = c.ok ? "✅" : "❌";
      console.log(`[Bot]   ${mark} ${c.name}${c.reason ? ` — ${c.reason}` : ""}`);
      if (!c.ok) allOk = false;
    }
    console.log("[Bot] ────────────────────────────────────");

    if (allOk) {
      console.log("[Bot] 프리플라이트 통과 — 실거래 시작");
    } else {
      console.error("[Bot] 프리플라이트 실패 항목 있음");
    }
    return allOk;
  }

  // ─── 종료 ───────────────────────────────────────────

  async shutdown(signal) {
    console.log(`\n[Bot] 종료 (${signal})`);
    if (this.mainLoopId) clearInterval(this.mainLoopId);
    this.calibration.stop();
    this.dashboard.stop();
    this.macroEngine.stop();
    this.regimeEngine.stop();
    this.upbitWs.stop();
    this.dataEngine.stop();
    this.strategyA.stop();
    this.strategyB.stop();

    if (this.livePosition && !DRY_RUN && this.orderService.getSummary().hasApiKeys) {
      console.log("[Bot] 포지션 청산 중...");
      if (this.livePosition.limitSellUuid) {
        await this.orderService.cancelOrder(this.livePosition.limitSellUuid).catch(() => {});
      }
      const bal = await this.orderService
        .getBalance(this.livePosition.market.split("-")[1])
        .catch(() => 0);
      if (bal > 0.00001) {
        await this.orderService.marketSell(this.livePosition.market, bal).catch((e) => {
          console.error("[Bot] 청산 실패 — 수동 확인 필요:", e.message);
        });
      }
    }

    console.log("[Bot] 종료 완료");
    process.exit(0);
  }
}

process.on("uncaughtException", (err) => {
  console.error("[Bot] 처리되지 않은 예외:", err.message, err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Bot] 처리되지 않은 Promise 거부:", reason);
});

const bot = new TradingBot();
bot.start().catch((e) => { console.error(e); process.exit(1); });
