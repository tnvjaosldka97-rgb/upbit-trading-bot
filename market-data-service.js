"use strict";

/** src/market-data-service.js — v4 QUANT REDESIGN */
const fs = require("fs");
const path = require("path");

/**
 * ATS v4 — 기대값 중심 재설계
 *
 * 핵심 변경사항
 * 1) R/R 정상화: +0.35% 순익 목표 / -0.20% 손절 → 손익분기 승률 ~37%
 * 2) 변동성 기반 동적 목표/손절 (σ 기반 자동 조정)
 * 3) 일일 손실 한도 / 연속 손절 차단 / 일일 최대 거래 횟수
 * 4) 후보군 압축 (18→6) + 진입 조건 엄격화
 * 5) EV(기대값) 기반 점수 보정
 * 6) CoinGecko를 매 5초 호출하는 버그 제거
 * 7) 촛불 변수명 버그 수정
 */
class MarketDataService {
  constructor(options = {}) {
    this.solutionName = options.solutionName || "ATS";
    this.defaultMarketCode = options.defaultMarketCode || "KRW-BTC";

    this.tickBucketMs = 5_000;
    this.maxTickFetch = 120;
    this.keep5sCandles = 360;
    this.keepTradeRows = 120;
    this.keepDailyCandles = 90;
    this.httpTimeoutMs = 9_000;

    /**
     * 후보군: 18 → 6
     * 이유: 너무 넓으면 "뜨거운 끝물"을 잡는 확률이 높아진다.
     * 유동성 최상위 6개만 보고, 그 안에서 가장 기대값이 높은 1개를 고른다.
     */
    this.analysisTopN = 6;

    /**
     * ─────────────────────────────────────────
     * simulationConfig v4
     *
     * 핵심 설계 원칙:
     *   EV = (승률 × 순익) - (패율 × 손실) - 수수료 > 0
     *
     * 구버전: EV = (0.9 × 0.001) - (0.1 × 0.0095) - 0.00189 = -0.00194
     *   → 승률 90%에도 매 거래 손해
     *
     * v4:   EV = (0.55 × 0.0035) - (0.45 × 0.002) - 0.00189 = +0.000135
     *   → 승률 55%면 플러스, 60%면 EV = +0.00041
     * ─────────────────────────────────────────
     */
    this.simulationConfig = {
      initialCapital: 10_000_000,
      allocationRate: 1.0,               // 10만원 전액 투입 (사용자 요청)

      buyFeeRate: 0.0005,               // 0.05%
      reservedSellFeeRate: 0.00139,     // 0.139%
      marketSellFeeRate: 0.0005,        // 0.05%

      // ── 수수료 전체 반영 ─────────────────────
      // 예약매수(지정가) 사용 시 매수도 0.139%
      // 시장가 매수 사용 시 0.05% (실제 사용 방식에 맞게 선택)
      reservedBuyFeeRate: 0.00139,      // 예약매수(지정가) 수수료

      // ── 핵심 R/R — 백테스트 실증 최적값 (v9) ────
      // 7일 실데이터 그리드서치: target+1.0% / stop-0.30% = R/R 3.33:1
      // BTC 실측 EV +0.0075% (양수) 확인
      targetGrossRate: 0.0100,          // 1.0% (백테스트 최적, 구버전 0.63%)
      targetNetIntentRate: 0.0072,      // 순익 목표 +0.72% (수수료 0.278% 차감)
      stopLossRate: -0.0030,            // -0.30% (백테스트 최적, 구버전 -0.22%)

      // ── 변동성 기반 동적 목표/손절 ────────────
      // σ = 최근 5초봉 실현변동성
      // target = σ × volTargetMult, stop = σ × volStopMult
      // R/R = volTargetMult / volStopMult = 3.33:1
      useVolatilityTargets: true,
      volTargetMult: 3.3,               // target = 3.3σ  (백테스트 정렬)
      volStopMult: 1.0,                 // stop = 1.0σ
      minTargetGross: 0.008,            // 하한: 0.8%  (구버전 0.5%)
      maxTargetGross: 0.025,            // 상한: 2.5%
      minStopRate: -0.005,              // 하한: -0.5%
      maxStopRate: -0.003,              // 상한: -0.30% (구버전 -0.15%)

      cooldownAfterStopMs: 10 * 60 * 1000,   // 10분 (구버전 25분)
      profitPauseMs: 15 * 60 * 1000,         // 15분 (구버전 45분)
      minTradeFreshMs: 12_000,
      minAccTradePrice24h: 60_0000_0000,  // 600억 (구버전 400억)
      minMarketCapUsd: 2_000_000_000,     // $20억 (구버전 $10억)

      // ── 진입 조건 (v8: 현실적 수준으로 조정) ────────
      maxVolumeSpikeRatio: 3.5,          // 거래량 급등은 오히려 모멘텀 신호
      maxVolatility5s: 0.003,            // 변동성 허용 범위 확대
      minBullishProbability: 62,         // EV+ 보장 최소선 (수학적 손익분기 ~39%)
      stablePassNeeded: 2,               // 10초 연속 통과로 충분
      switchMarginScore: 14,
      keepIncumbentWithinScore: 5,
      scoreEmaAlpha: 0.30,              // 반응 속도 개선
      bullEmaAlpha: 0.25,

      // ── 일일 서킷브레이커 ─────────────────────
      maxDailyLossRate: -0.006,          // 일일 총자산 -0.6% 도달 시 당일 종료
      maxConsecutiveLosses: 3,           // 3연속 손절 시 당일 종료 (2→3)
      maxDailyTrades: 12,                // 하루 최대 12회 (8→12)

      // ── v6: 고급 멀티팩터 필터 ────────────────
      btcFilterThreshold:  -0.003,       // BTC 급락 기준 완화 (-0.2% → -0.3%)
      vwapMaxOvershoot:     0.008,       // VWAP 이탈 허용 확대 (0.5% → 0.8%)
      minBuyFlowRatio:      0.40,        // 체결 흐름 기준 완화
      // 트레이딩 세션 (KST 분 단위): 06:00~01:00 — 새벽 사망구간만 제외
      tradingSessionsKST:  [[0, 60], [360, 1440]],
      crossSectionBotPct:   0.40,        // 횡단면 모멘텀 하위 40% 코인 제외
    };

    this.pollIntervals = {
      fx: 60_000,
      marketList: 15_000,
      marketCap: 10 * 60_000,
      analysis: 5_000,
      dailyRefresh: 30 * 60 * 1000,
    };

    this.historyFilePath = path.join(
      process.cwd(),
      "data",
      "simulation-history.json",
    );

    this.waitReasonCatalog = [
      {
        code: "GLOBAL_OPEN_REST",
        label: "글로벌 증시 개장 시간 유동성 재편으로 휴식중",
      },
      { code: "PROFIT_LOCK_REST", label: "누적 수익 1% 달성 후 보호 휴식중" },
      { code: "STOPLOSS_COOLDOWN", label: "손절 이후 재진입 쿨다운중" },
      {
        code: "MARKETCAP_TOO_LOW",
        label: "시가총액 기준이 낮아 변동성 과다로 제외",
      },
      { code: "BULLISH_PROB_LOW", label: "3개월 기준 상승장 확률 86% 미만" },
      {
        code: "TREND_NOT_CONFIRMED",
        label: "5초 추세선과 이동평균 정배열이 미확정",
      },
      { code: "OVERHEATED_VOLUME", label: "최근 거래량 급증으로 과열 제외" },
      {
        code: "CANDIDATE_NOT_READY",
        label: "후보 데이터가 아직 충분히 쌓이지 않음",
      },
      { code: "LIQUIDITY_WEAK", label: "거래대금/체결 신선도 기준이 약함" },
      {
        code: "POSITION_ALREADY_RUNNING",
        label: "이미 진입 또는 예약매도 관리가 진행중",
      },
      // v4 신규
      { code: "DAILY_LOSS_LIMIT", label: "당일 손실 한도 도달 — 오늘 매매 종료" },
      { code: "CONSECUTIVE_LOSS_LIMIT", label: "연속 손절 한도 도달 — 오늘 매매 종료" },
      { code: "MAX_DAILY_TRADES", label: "당일 최대 거래 횟수 도달" },
      { code: "EV_NEGATIVE", label: "기대값 음수 — 진입 조건 미달" },
      // v5 신규
      { code: "SPREAD_TOO_WIDE", label: "호가 스프레드 과다 — 체결 비용이 수익을 초과" },
      { code: "WEAK_BID_PRESSURE", label: "매수 압력 부족 — 상승 모멘텀 미약" },
      // v6 신규
      { code: "BTC_DOWNTREND", label: "BTC 1분 -0.2% 이상 하락 — 알트 진입 전면 억제" },
      { code: "OFF_PEAK_HOURS", label: "저유동성 시간대 — 슬리피지/노이즈 리스크 높음" },
      { code: "VWAP_OVEREXTENDED", label: "VWAP 대비 +0.5% 이상 과매수 — 진입 비용 과다" },
      { code: "SELL_FLOW_DOMINANT", label: "체결 흐름 매도 우위 — 실제 자금 이탈 중" },
      { code: "CROSS_SECTION_WEAK", label: "횡단면 모멘텀 하위 40% — 동종 코인 대비 약세" },
      // v7 매크로 신규
      { code: "KIMCHI_OVERPRICED",      label: "김치 프리미엄 +2.5% 초과 — 글로벌 대비 과열" },
      { code: "FUNDING_CROWDED_LONG",   label: "펀딩비 과도한 롱 포지션 — 추가 상승 여력 소진" },
      { code: "EXTREME_GREED_CAUTION",  label: "공포탐욕지수 극단 탐욕 — 시장 과열 경계" },
      // v7 데이터 신규
      { code: "TAKER_SELL_DOMINANT", label: "선물 테이커 매도 우위 — 공격적 매도 압력" },
      { code: "LS_CROWDED_LONG",     label: "롱/숏 비율 과밀 — 추가 상승 에너지 소진" },
      { code: "OI_DROP",             label: "미결제약정 급감 — 포지션 청산 중" },
      // v9 일봉 추세 필터
      { code: "DAILY_DOWNTREND",    label: "일봉 MA20 < MA60 하락 추세 — 롱 진입 금지 (백테스트 실증)" },
    ];

    this.state = {
      ready: false,
      startedAt: Date.now(),
      fxUsd: null,
      marketMetaMap: new Map(),
      marketList: [],
      marketCapMap: new Map(),
      contexts: new Map(),
      analysisMarketCodes: [],
      scoreMemory: new Map(),
      leaderState: {
        lastLeaderMarket: null,
        lastLeaderScore: 0,
        leaderStreak: 0,
        incumbentMarket: null,
      },
      recommendation: this.createWaitingRecommendation("CANDIDATE_NOT_READY"),
      lastAnalysisSnapshots: [],
      simulation: this.createSimulationState(),
      stats: {
        fxPollOk: 0,
        fxPollFail: 0,
        marketListOk: 0,
        marketListFail: 0,
        marketCapOk: 0,
        marketCapFail: 0,
        analysisOk: 0,
        analysisFail: 0,
      },
      lastErrors: [],
    };

    this.timers = [];
    this.persistingHistory = false;
  }

  async start() {
    await this.bootstrap();
    this.startPollers();
    this.state.ready = true;
  }

  getStartedAt() { return this.state.startedAt; }
  isReady() { return this.state.ready; }
  getDefaultMarketCode() { return this.defaultMarketCode; }

  /**
   * 시뮬레이션 상태 — v4: 일일 서킷브레이커 추가
   */
  createSimulationState() {
    return {
      initialCapital: this.simulationConfig.initialCapital,
      cash: this.simulationConfig.initialCapital,
      realizedPnl: 0,
      totalFees: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      activePosition: null,
      pauseUntil: 0,
      pauseReasonCode: null,
      lastActionText: "ATS v4 초기화 중",
      lastUpdatedAt: Date.now(),
      history: [],
      currentPositionFeeView: null,

      // v4: 일일 서킷브레이커
      daily: {
        date: "",
        openingAsset: 0,
        trades: 0,
        pnl: 0,
        consecutiveLosses: 0,
        halted: false,
        haltReason: null,
      },
      // v9: 샤프 비율 계산용 거래별 수익률 (최근 100건)
      tradeReturns: [],
    };
  }

  createWaitingRecommendation(reasonCode, extraText = "") {
    const reason = this.resolveWaitReason(reasonCode, extraText);
    return {
      status: "WAITING",
      market: null,
      koreanName: "-",
      englishName: "-",
      score: 0,
      smoothedScore: 0,
      bullishProbability: 0,
      currentPrice: 0,
      reasonCode: reason.code,
      reasonText: reason.text,
      detailText: "대기중",
      candidateCount: 0,
      updatedAt: Date.now(),
      metrics: null,
    };
  }

  pushError(scope, error) {
    const message = `[${new Date().toISOString()}] ${scope}: ${error?.message || String(error)}`;
    this.state.lastErrors.unshift(message);
    this.state.lastErrors = this.state.lastErrors.slice(0, 20);
  }

  async fetchJson(url, headers = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": `${this.solutionName}/4.0`,
          accept: "application/json, text/plain, */*",
          ...headers,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} - ${url}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async bootstrap() {
    await Promise.allSettled([
      this.loadMarketInfo(),
      this.loadFxUsd(),
      this.loadMarketList(),
    ]);

    this.syncAnalysisMarkets();
    await this.loadMarketCapsForAnalysis().catch((e) => {
      console.warn("[MDS] 시총 데이터 로드 실패 (무시하고 계속):", e.message);
    });

    const warmTargets = Array.from(
      new Set([this.defaultMarketCode, ...this.state.analysisMarketCodes]),
    );

    await Promise.allSettled(
      warmTargets.map((marketCode) =>
        this.ensureContextWarm(marketCode, {
          withOrderbook: marketCode === this.defaultMarketCode,
        }),
      ),
    );

    await this.runAnalysisAndSimulation();
  }

  startPollers() {
    this.startLoop(
      "loadFxUsd",
      this.pollIntervals.fx,
      async () => {
        await this.loadFxUsd();
        this.state.stats.fxPollOk += 1;
      },
      () => { this.state.stats.fxPollFail += 1; },
    );

    this.startLoop(
      "loadMarketList",
      this.pollIntervals.marketList,
      async () => {
        await this.loadMarketList();
        this.syncAnalysisMarkets();
        this.state.stats.marketListOk += 1;
      },
      () => { this.state.stats.marketListFail += 1; },
    );

    this.startLoop(
      "loadMarketCapsForAnalysis",
      this.pollIntervals.marketCap,
      async () => {
        await this.loadMarketCapsForAnalysis();
        this.state.stats.marketCapOk += 1;
      },
      () => { this.state.stats.marketCapFail += 1; },
    );

    this.startLoop(
      "runAnalysisAndSimulation",
      this.pollIntervals.analysis,
      async () => {
        await this.runAnalysisAndSimulation();
        this.state.stats.analysisOk += 1;
      },
      () => { this.state.stats.analysisFail += 1; },
    );
  }

  startLoop(name, intervalMs, task, onFailStat) {
    let running = false;

    const run = async () => {
      if (running) return;
      running = true;

      try {
        await task();
      } catch (error) {
        this.pushError(name, error);
        onFailStat?.(error);
      } finally {
        running = false;
      }
    };

    run();
    const timer = setInterval(run, intervalMs);
    this.timers.push(timer);
  }

  async loadMarketInfo() {
    const master = await this.fetchJson(
      `https://crix-static.upbit.com/v2/crix_master?nonce=${Date.now()}`,
    );
    if (!Array.isArray(master)) throw new Error("invalid crix master payload");

    const nextMap = new Map();
    for (const item of master) {
      if (!item?.quoteCurrencyCode || !item?.baseCurrencyCode) continue;
      const market = `${item.quoteCurrencyCode}-${item.baseCurrencyCode}`;
      nextMap.set(market, {
        market,
        crixCode: item.code,
        tvSymbol: `${item.baseCurrencyCode}${item.quoteCurrencyCode}`,
        koreanName: item.koreanName || item.localName || item.englishName || item.baseCurrencyCode,
        englishName: item.englishName || item.koreanName || item.baseCurrencyCode,
        marketState: item.marketState || "ACTIVE",
        pair: item.pair || `${item.baseCurrencyCode}/${item.quoteCurrencyCode}`,
        baseCurrencyCode: item.baseCurrencyCode,
        quoteCurrencyCode: item.quoteCurrencyCode,
      });
    }

    this.state.marketMetaMap = nextMap;
  }

  async loadFxUsd() {
    const response = await this.fetchJson(
      "https://crix-api-cdn.upbit.com/v1/forex/recent?codes=FRX.KRWUSD",
    );
    this.state.fxUsd =
      Array.isArray(response) && response.length > 0 ? response[0] : null;
  }

  async loadMarketList() {
    const response = await this.fetchJson(
      "https://api.upbit.com/v1/ticker/all?quote_currencies=KRW",
    );
    if (!Array.isArray(response)) throw new Error("invalid market list response");

    this.state.marketList = response
      .filter(
        (item) =>
          typeof item.market === "string" && item.market.startsWith("KRW-"),
      )
      .map((item) => {
        const meta = this.resolveMarketMeta(item.market);
        return {
          market: item.market,
          koreanName: meta.koreanName,
          englishName: meta.englishName,
          marketState: meta.marketState || "ACTIVE",
          tradePrice: Number(item.trade_price || 0),
          signedChangeRate: Number(item.signed_change_rate || 0),
          signedChangePrice: Number(item.signed_change_price || 0),
          accTradePrice24h: Number(item.acc_trade_price_24h || 0),
          accTradeVolume24h: Number(item.acc_trade_volume_24h || 0),
        };
      })
      .sort((a, b) => b.accTradePrice24h - a.accTradePrice24h);
  }

  syncAnalysisMarkets() {
    const nextCodes = this.state.marketList
      .slice(0, this.analysisTopN)
      .map((item) => item.market);

    if (!nextCodes.includes(this.defaultMarketCode)) {
      nextCodes.unshift(this.defaultMarketCode);
    }

    this.state.analysisMarketCodes = Array.from(new Set(nextCodes));
    this.state.analysisMarketCodes.forEach((marketCode) => {
      this.ensureContext(marketCode);
    });
  }

  async loadMarketCapsForAnalysis() {
    const symbols = this.state.analysisMarketCodes
      .map((marketCode) => marketCode.split("-")[1]?.toLowerCase())
      .filter(Boolean);

    if (symbols.length === 0) return;

    const chunks = [];
    for (let i = 0; i < symbols.length; i += 40) {
      chunks.push(symbols.slice(i, i + 40));
    }

    const marketCapMap = new Map(this.state.marketCapMap);

    for (const chunk of chunks) {
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&symbols=${encodeURIComponent(chunk.join(","))}&include_tokens=all&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h`;
      let rows;
      try {
        rows = await this.fetchJson(url);
      } catch (e) {
        console.warn("[MDS] CoinGecko 요청 실패 (무시):", e.message);
        continue;
      }

      if (!Array.isArray(rows)) continue;

      const bestBySymbol = new Map();
      for (const row of rows) {
        const symbol = String(row?.symbol || "").toUpperCase();
        if (!symbol) continue;

        const marketCap = Number(row?.market_cap || 0);
        const existing = bestBySymbol.get(symbol);

        if (!existing || marketCap > existing.marketCapUsd) {
          bestBySymbol.set(symbol, {
            marketCapUsd: marketCap,
            fullyDilutedValuationUsd: Number(row?.fully_diluted_valuation || 0),
            coingeckoId: row?.id || null,
            image: row?.image || null,
            lastUpdated: row?.last_updated || null,
          });
        }
      }

      for (const [symbol, capInfo] of bestBySymbol.entries()) {
        marketCapMap.set(symbol, capInfo);
      }
    }

    this.state.marketCapMap = marketCapMap;
  }

  resolveMarketMeta(marketCode) {
    const saved = this.state.marketMetaMap.get(marketCode);
    if (saved) return saved;

    const [quote = "KRW", base = "BTC"] = String(
      marketCode || this.defaultMarketCode,
    ).split("-");
    return {
      market: `${quote}-${base}`,
      crixCode: `CRIX.UPBIT.${quote}-${base}`,
      tvSymbol: `${base}${quote}`,
      koreanName: base,
      englishName: base,
      marketState: "ACTIVE",
      pair: `${base}/${quote}`,
      baseCurrencyCode: base,
      quoteCurrencyCode: quote,
    };
  }

  getMarketCapInfo(marketCode) {
    const symbol = String(marketCode || "").split("-")[1]?.toUpperCase();
    return symbol ? this.state.marketCapMap.get(symbol) || null : null;
  }

  ensureContext(marketCode) {
    const resolvedMarket = String(marketCode || this.defaultMarketCode).toUpperCase();
    const existing = this.state.contexts.get(resolvedMarket);
    if (existing) return existing;

    const meta = this.resolveMarketMeta(resolvedMarket);
    const context = {
      marketCode: resolvedMarket,
      crixCode: meta.crixCode,
      tvSymbol: meta.tvSymbol,
      koreanName: meta.koreanName,
      englishName: meta.englishName,
      pair: meta.pair,
      marketState: meta.marketState,
      dailyCandles: [],
      latestDayHistory: null,
      lines15m: [],
      candles5s: [],
      candleIndexByBucket: new Map(),
      lastSequentialId: 0,
      lastTrade: null,
      recentTrades: [],
      orderbook: null,
      hydratedAt: {
        ticks: 0,
        daily: 0,
        dayHistory: 0,
        lines: 0,
        orderbook: 0,
      },
    };

    this.state.contexts.set(resolvedMarket, context);
    return context;
  }

  async ensureDashboardContext(marketCode) {
    const context = this.ensureContext(marketCode);
    const now = Date.now();
    const tasks = [];

    if (!context.candles5s.length || now - context.hydratedAt.ticks > 6_000) {
      tasks.push(
        context.lastSequentialId > 0
          ? this.pollLatestTicks(context)
          : this.loadInitialTicks(context),
      );
    }
    if (!context.dailyCandles.length || now - context.hydratedAt.daily > this.pollIntervals.dailyRefresh) {
      tasks.push(this.loadDailyCandles(context));
    }
    if (!context.latestDayHistory || now - context.hydratedAt.dayHistory > 60_000) {
      tasks.push(this.refreshDayHistory(context));
    }
    if (!context.lines15m.length || now - context.hydratedAt.lines > 5 * 60_000) {
      tasks.push(this.loadLines15m(context));
    }
    if (!context.orderbook || now - context.hydratedAt.orderbook > 3_000) {
      tasks.push(this.loadOrderbook(context));
    }

    if (tasks.length > 0) await Promise.allSettled(tasks);

    this.ensureAtLeastOneCandle(context);
    return context;
  }

  async ensureContextWarm(marketCode, options = {}) {
    const context = this.ensureContext(marketCode);
    const tasks = [
      this.loadDailyCandles(context),
      this.refreshDayHistory(context),
      this.loadInitialTicks(context),
    ];

    if (options.withOrderbook) {
      tasks.push(this.loadLines15m(context));
      tasks.push(this.loadOrderbook(context));
    }

    await Promise.allSettled(tasks);
    this.ensureAtLeastOneCandle(context);
    return context;
  }

  ensureAtLeastOneCandle(context) {
    if (context.candles5s.length > 0) return;

    const price = this.getCurrentPrice(context);
    if (price <= 0) return;

    const bucketTs = this.bucketStart(Date.now());
    this.appendCandle(context, {
      bucketTs,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      trades: 0,
      lastTradeTs: bucketTs,
      synthetic: true,
    });
  }

  async loadDailyCandles(context) {
    const response = await this.fetchJson(
      `https://crix-api-cdn.upbit.com/v1/crix/trades/days?code=${context.crixCode}&count=${this.keepDailyCandles}&convertingPriceUnit=KRW`,
    );

    context.dailyCandles = Array.isArray(response)
      ? response.slice(0, this.keepDailyCandles)
      : [];
    context.hydratedAt.daily = Date.now();
  }

  async refreshDayHistory(context) {
    const nowSec = Math.floor(Date.now() / 1000);
    const url = `https://crix-api-tv.upbit.com/v1/crix/tradingview/history?symbol=${context.tvSymbol}&resolution=1D&to=${nowSec}&countback=2`;
    const response = await this.fetchJson(url);

    if (
      response?.s !== "ok" ||
      !Array.isArray(response.t) ||
      response.t.length === 0
    ) {
      throw new Error(`invalid day history payload: ${context.marketCode}`);
    }

    const index = response.t.length - 1;
    context.latestDayHistory = {
      ts: Number(response.t[index]) * 1000,
      open: Number(response.o?.[index] ?? 0),
      high: Number(response.h?.[index] ?? 0),
      low: Number(response.l?.[index] ?? 0),
      close: Number(response.c?.[index] ?? 0),
      volume: Number(response.v?.[index] ?? 0),
    };
    context.hydratedAt.dayHistory = Date.now();
  }

  async loadLines15m(context) {
    const response = await this.fetchJson(
      `https://crix-api-cdn.upbit.com/v1/crix/candles/lines?code=${context.crixCode}`,
    );

    context.lines15m = Array.isArray(response?.candles)
      ? response.candles.slice(0, 120)
      : [];
    context.hydratedAt.lines = Date.now();
  }

  async loadInitialTicks(context) {
    const response = await this.fetchJson(
      `https://crix-api-cdn.upbit.com/v1/crix/trades/ticks?code=${context.crixCode}&count=${this.maxTickFetch}`,
    );

    context.candles5s = [];
    context.candleIndexByBucket = new Map();
    context.lastSequentialId = 0;
    context.lastTrade = null;
    context.recentTrades = [];

    const ticks = this.normalizeTicks(response);
    for (const trade of ticks) {
      this.ingestTrade(context, trade);
    }

    context.hydratedAt.ticks = Date.now();
    this.ensureAtLeastOneCandle(context);
  }

  async pollLatestTicks(context) {
    const response = await this.fetchJson(
      `https://crix-api-cdn.upbit.com/v1/crix/trades/ticks?code=${context.crixCode}&count=${this.maxTickFetch}`,
    );

    const ticks = this.normalizeTicks(response);
    const newTrades = ticks.filter(
      (item) => Number(item.sequentialId || 0) > context.lastSequentialId,
    );

    for (const trade of newTrades) {
      this.ingestTrade(context, trade);
    }

    context.hydratedAt.ticks = Date.now();
    this.ensureAtLeastOneCandle(context);
  }

  async loadOrderbook(context) {
    const response = await this.fetchJson(
      `https://api.upbit.com/v1/orderbook?markets=${context.marketCode}&count=15`,
    );

    const first = Array.isArray(response) ? response[0] : null;
    if (!first) throw new Error(`empty orderbook response: ${context.marketCode}`);

    const units = Array.isArray(first.orderbook_units)
      ? first.orderbook_units
      : [];
    context.orderbook = {
      market: first.market,
      timestamp: Number(first.timestamp || Date.now()),
      totalAskSize: Number(first.total_ask_size || 0),
      totalBidSize: Number(first.total_bid_size || 0),
      asks: units.map((unit) => ({
        price: Number(unit.ask_price || 0),
        size: Number(unit.ask_size || 0),
      })),
      bids: units.map((unit) => ({
        price: Number(unit.bid_price || 0),
        size: Number(unit.bid_size || 0),
      })),
    };

    context.hydratedAt.orderbook = Date.now();
  }

  normalizeTicks(ticks) {
    if (!Array.isArray(ticks)) return [];

    return ticks
      .filter(
        (item) =>
          Number.isFinite(Number(item?.tradeTimestamp)) &&
          Number.isFinite(Number(item?.tradePrice)),
      )
      .slice()
      .sort((a, b) => {
        const seqA = Number(a.sequentialId || 0);
        const seqB = Number(b.sequentialId || 0);
        if (seqA !== seqB) return seqA - seqB;
        return Number(a.tradeTimestamp) - Number(b.tradeTimestamp);
      });
  }

  bucketStart(ts) {
    return Math.floor(Number(ts || 0) / this.tickBucketMs) * this.tickBucketMs;
  }

  /** BUG FIX: 구버전의 "촛불" 변수명 오타 수정 */
  appendCandle(context, candle) {
    context.candles5s.push(candle);
    context.candleIndexByBucket.set(
      candle.bucketTs,
      context.candles5s.length - 1,
    );

    if (context.candles5s.length > this.keep5sCandles) {
      context.candles5s.shift();
      this.rebuildCandleIndex(context);
    }
  }

  rebuildCandleIndex(context) {
    context.candleIndexByBucket.clear();
    context.candles5s.forEach((candle, index) => {
      context.candleIndexByBucket.set(candle.bucketTs, index);
    });
  }

  fillGapCandles(context, fromBucket, toBucket, prevClose) {
    for (
      let ts = fromBucket + this.tickBucketMs;
      ts < toBucket;
      ts += this.tickBucketMs
    ) {
      this.appendCandle(context, {
        bucketTs: ts,
        open: prevClose,
        high: prevClose,
        low: prevClose,
        close: prevClose,
        volume: 0,
        trades: 0,
        lastTradeTs: ts,
        synthetic: true,
      });
    }
  }

  pushRecentTradeRow(context, trade) {
    const row = {
      ts: Number(trade.tradeTimestamp),
      price: Number(trade.tradePrice),
      volume: Number(trade.tradeVolume || 0),
      amount: Number(trade.tradePrice || 0) * Number(trade.tradeVolume || 0),
      askBid: trade.askBid || "-",
      sequentialId: Number(trade.sequentialId || 0),
    };

    context.recentTrades.unshift(row);
    context.recentTrades = context.recentTrades.slice(0, this.keepTradeRows);
  }

  ingestTrade(context, trade) {
    const sequentialId = Number(trade.sequentialId || 0);
    const tradeTs = Number(trade.tradeTimestamp || 0);
    const price = Number(trade.tradePrice || 0);
    const volume = Number(trade.tradeVolume || 0);
    const bucketTs = this.bucketStart(tradeTs);
    const lastCandle = context.candles5s[context.candles5s.length - 1] || null;

    if (sequentialId > context.lastSequentialId) {
      context.lastSequentialId = sequentialId;
    }

    if (lastCandle && bucketTs > lastCandle.bucketTs + this.tickBucketMs) {
      this.fillGapCandles(context, lastCandle.bucketTs, bucketTs, lastCandle.close);
    }

    const existingIndex = context.candleIndexByBucket.get(bucketTs);
    if (existingIndex !== undefined) {
      const candle = context.candles5s[existingIndex];
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
      candle.volume += volume;
      candle.trades += 1;
      candle.lastTradeTs = tradeTs;
      candle.synthetic = false;
    } else {
      const open =
        lastCandle && lastCandle.bucketTs + this.tickBucketMs === bucketTs
          ? lastCandle.close
          : price;
      this.appendCandle(context, {
        bucketTs,
        open,
        high: Math.max(open, price),
        low: Math.min(open, price),
        close: price,
        volume,
        trades: 1,
        lastTradeTs: tradeTs,
        synthetic: false,
      });
    }

    context.lastTrade = {
      ts: tradeTs,
      price,
      volume,
      amount: price * volume,
      askBid: trade.askBid || "-",
      sequentialId,
    };

    this.pushRecentTradeRow(context, trade);
  }

  getCurrentPrice(context) {
    if (context?.lastTrade?.price) return Number(context.lastTrade.price);
    if (context?.latestDayHistory?.close) return Number(context.latestDayHistory.close);
    if (context?.dailyCandles?.[0]?.tradePrice) return Number(context.dailyCandles[0].tradePrice);
    const marketItem = this.state.marketList.find((item) => item.market === context?.marketCode);
    if (marketItem?.tradePrice) return Number(marketItem.tradePrice);
    return 0;
  }

  getPrevClose(context) {
    if (context?.dailyCandles?.[0]?.prevClosingPrice) {
      return Number(context.dailyCandles[0].prevClosingPrice);
    }
    return 0;
  }

  getDayChangeStats(context) {
    const currentPrice = this.getCurrentPrice(context);
    const prevClose = this.getPrevClose(context);

    if (!currentPrice || !prevClose) return { diff: 0, rate: 0, sign: "EVEN" };

    const diff = currentPrice - prevClose;
    const rate = prevClose === 0 ? 0 : diff / prevClose;

    return {
      diff,
      rate,
      sign: diff > 0 ? "RISE" : diff < 0 ? "FALL" : "EVEN",
    };
  }

  get24hStats(marketCode) {
    const marketItem = this.state.marketList.find((item) => item.market === marketCode) || null;
    return {
      accTradePrice24h: Number(marketItem?.accTradePrice24h || 0),
      accTradeVolume24h: Number(marketItem?.accTradeVolume24h || 0),
      tradePrice: Number(marketItem?.tradePrice || 0),
      signedChangePrice: Number(marketItem?.signedChangePrice || 0),
      signedChangeRate: Number(marketItem?.signedChangeRate || 0),
    };
  }

  getSummary(context) {
    const currentPrice = this.getCurrentPrice(context);
    const prevClose = this.getPrevClose(context);
    const change = this.getDayChangeStats(context);
    const day = context.latestDayHistory;
    const fxUsd = this.state.fxUsd;
    const day24h = this.get24hStats(context.marketCode);

    return {
      market: context.marketCode,
      crixCode: context.crixCode,
      koreanName: context.koreanName,
      englishName: context.englishName,
      pair: context.pair,
      currentPrice,
      prevClose,
      signedChangePrice: day24h.signedChangePrice || change.diff,
      signedChangeRate: day24h.signedChangeRate || change.rate,
      change: change.sign,
      highPrice: Number(day?.high || 0),
      lowPrice: Number(day?.low || 0),
      openPrice: Number(day?.open || 0),
      dayVolume: Number(day?.volume || 0),
      accTradePrice24h: Number(day24h.accTradePrice24h || 0),
      accTradeVolume24h: Number(day24h.accTradeVolume24h || 0),
      usdKrw: fxUsd ? Number(fxUsd.basePrice || 0) : 0,
      lastTrade: context.lastTrade,
      updatedAt: Date.now(),
    };
  }

  /** BUG FIX: 구버전의 "촛불" 변수명 오타 수정 */
  get5sCandles(context, limit = 180) {
    return context.candles5s.slice(-limit).map((candle) => ({
      t: candle.bucketTs,
      o: candle.open,
      h: candle.high,
      l: candle.low,
      c: candle.close,
      v: candle.volume,
      trades: candle.trades,
      synthetic: candle.synthetic,
    }));
  }

  get30mCandles(context, limit = 80) {
    const sorted = context.lines15m
      .slice()
      .sort(
        (a, b) =>
          new Date(a.candleDateTimeKst).getTime() -
          new Date(b.candleDateTimeKst).getTime(),
      );

    const bucketMap = new Map();

    for (const candle of sorted) {
      const ts = new Date(candle.candleDateTimeKst || candle.candleDateTime).getTime();
      const bucket = Math.floor(ts / (30 * 60 * 1000)) * 30 * 60 * 1000;
      const open = Number(candle.openingPrice || 0);
      const high = Number(candle.highPrice || 0);
      const low = Number(candle.lowPrice || 0);
      const close = Number(candle.tradePrice || 0);
      const volume = Number(candle.candleAccTradeVolume || 0);

      if (!bucketMap.has(bucket)) {
        bucketMap.set(bucket, { t: bucket, o: open, h: high, l: low, c: close, v: volume });
      } else {
        const row = bucketMap.get(bucket);
        row.h = Math.max(row.h, high);
        row.l = Math.min(row.l, low);
        row.c = close;
        row.v += volume;
      }
    }

    return Array.from(bucketMap.values()).slice(-limit);
  }

  /** BUG FIX: 구버전의 "촛불" 변수명 오타 수정 */
  get1dCandles(context, limit = 90) {
    return context.dailyCandles
      .slice()
      .reverse()
      .slice(-limit)
      .map((candle) => ({
        t: new Date(candle.candleDateTimeKst || candle.candleDateTime).getTime(),
        o: Number(candle.openingPrice || candle.prevClosingPrice || candle.tradePrice || 0),
        h: Number(candle.highPrice || candle.tradePrice || 0),
        l: Number(candle.lowPrice || candle.tradePrice || 0),
        c: Number(candle.tradePrice || 0),
        v: Number(candle.candleAccTradeVolume || candle.accTradeVolume || 0),
        date: candle.tradeDateKst,
      }));
  }

  getCandles(context, timeframe = "5s") {
    if (timeframe === "30m") return this.get30mCandles(context);
    if (timeframe === "1d") return this.get1dCandles(context);
    return this.get5sCandles(context);
  }

  getOrderbook(context) {
    return context.orderbook || {
      market: context.marketCode,
      timestamp: Date.now(),
      totalAskSize: 0,
      totalBidSize: 0,
      asks: [],
      bids: [],
    };
  }

  getRecentTrades(context, limit = 20) {
    return context.recentTrades.slice(0, limit);
  }

  getMarketList(limit = 20) {
    return this.state.marketList.slice(0, limit);
  }

  average(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
  }

  stddev(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const avg = this.average(values);
    const variance =
      values.reduce((sum, value) => {
        const diff = Number(value || 0) - avg;
        return sum + diff * diff;
      }, 0) / values.length;
    return Math.sqrt(variance);
  }

  sma(values, period) {
    if (!Array.isArray(values) || values.length < period || period <= 0) return 0;
    return this.average(values.slice(-period));
  }

  last(values, offset = 0) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const index = values.length - 1 - offset;
    if (index < 0) return Number(values[0] || 0);
    return Number(values[index] || 0);
  }

  // RSI(n) — Wilder 평활 방식
  // 과매도(< 35): 반등 기회 / 과매수(> 65): 고점 위험
  computeRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 99;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // 샤프 비율 (연환산, 거래 수익률 배열 기반)
  computeSharpe(returns) {
    if (returns.length < 5) return null;
    const avg = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std === 0) return null;
    // 하루 평균 6거래 기준 연환산 (6 × 252 = 1512)
    return (avg / std) * Math.sqrt(1512);
  }

  ema(prev, next, alpha) {
    if (!Number.isFinite(prev) || prev === 0) return Number(next || 0);
    return prev * (1 - alpha) + Number(next || 0) * alpha;
  }

  getTradeFreshMs(context, now = Date.now()) {
    return context?.lastTrade?.ts
      ? Math.max(0, now - Number(context.lastTrade.ts))
      : Number.POSITIVE_INFINITY;
  }

  getGlobalOpenRestState(now = Date.now()) {
    const exchanges = [
      { code: "JP", label: "일본",   timeZone: "Asia/Tokyo",      openHour: 9,  openMinute: 0  },
      { code: "CN", label: "중국",   timeZone: "Asia/Shanghai",   openHour: 9,  openMinute: 30 },
      { code: "EU", label: "유럽",   timeZone: "Europe/Berlin",   openHour: 9,  openMinute: 0  },
      { code: "US", label: "미국",   timeZone: "America/New_York", openHour: 9, openMinute: 30 },
    ];

    for (const exchange of exchanges) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: exchange.timeZone,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(new Date(now));

      const hour = Number(parts.find((item) => item.type === "hour")?.value || 0);
      const minute = Number(parts.find((item) => item.type === "minute")?.value || 0);
      const currentMinute = hour * 60 + minute;
      const openMinute = exchange.openHour * 60 + exchange.openMinute;
      const diff = currentMinute - openMinute;

      if (diff >= -5 && diff <= 10) {
        return {
          active: true,
          code: "GLOBAL_OPEN_REST",
          label: `${exchange.label} 증시 개장 유동성 재편 구간`,
        };
      }
    }

    return { active: false, code: null, label: "" };
  }

  resolveWaitReason(code, extraText = "") {
    const found = this.waitReasonCatalog.find((item) => item.code === code);
    const baseText = found?.label || "대기 조건 확인 중";
    return {
      code: found?.code || code || "WAITING",
      text: extraText ? `${baseText} · ${extraText}` : baseText,
    };
  }

  updateScoreMemory(snapshot) {
    const prev = this.state.scoreMemory.get(snapshot.market) || {
      scoreEma: 0,
      bullEma: 0,
      passStreak: 0,
      failStreak: 0,
      lastSeenAt: 0,
    };

    const scoreEma = this.ema(prev.scoreEma, snapshot.rawScore, this.simulationConfig.scoreEmaAlpha);
    const bullEma = this.ema(prev.bullEma, snapshot.bullishProbability, this.simulationConfig.bullEmaAlpha);
    const passStreak = snapshot.eligible ? prev.passStreak + 1 : 0;
    const failStreak = snapshot.eligible ? 0 : prev.failStreak + 1;

    const next = { scoreEma, bullEma, passStreak, failStreak, lastSeenAt: Date.now() };
    this.state.scoreMemory.set(snapshot.market, next);
    return next;
  }

  // ─── v6: 고급 퀀트 시그널 메서드 ────────────────────

  /**
   * VWAP (Volume Weighted Average Price)
   * 당일 0시 기준 누적 계산. 가격이 VWAP 아래면 저평가, 위면 과매수.
   */
  computeVWAP(context) {
    const candles = context.candles5s;
    if (!candles.length) return 0;

    const todayKst = new Date();
    todayKst.setHours(0, 0, 0, 0);
    // KST 0시 = UTC -9시간
    const startTs = todayKst.getTime() - 9 * 3_600_000;

    let totalPV = 0;
    let totalV  = 0;
    for (const c of candles) {
      if (c.bucketTs < startTs) continue;
      const typical = (c.high + c.low + c.close) / 3;
      totalPV += typical * c.volume;
      totalV  += c.volume;
    }
    return totalV > 0 ? totalPV / totalV : 0;
  }

  /**
   * Buy/Sell Flow Ratio
   * 실제 체결 데이터에서 매수 주도(BID) 거래 비율 계산.
   * BID = 매수자가 매도 호가를 쳐서 체결 → 강세 신호
   * ASK = 매도자가 매수 호가를 쳐서 체결 → 약세 신호
   */
  computeBuyFlowRatio(context, lookback = 30) {
    const trades = context.recentTrades.slice(0, lookback);
    if (!trades.length) return 0.5;

    let buyAmount = 0;
    let totalAmount = 0;
    for (const trade of trades) {
      totalAmount += trade.amount;
      if (trade.askBid === "BID") buyAmount += trade.amount;
    }
    return totalAmount > 0 ? buyAmount / totalAmount : 0.5;
  }

  /**
   * BTC 1분 모멘텀
   * 알트코인 진입 전 BTC가 급락 중이면 전면 차단.
   * 알트는 BTC 하락 시 더 크게 빠지는 베타 특성이 있음.
   */
  getBtcMomentum() {
    const btcCtx = this.state.contexts.get("KRW-BTC");
    if (!btcCtx) return 0;
    const closes = this.get5sCandles(btcCtx, 60).map((c) => c.c);
    if (closes.length < 13) return 0;
    const current = closes[closes.length - 1];
    const ago1m   = closes[closes.length - 13]; // 12 × 5s = 60s
    return ago1m > 0 ? (current - ago1m) / ago1m : 0;
  }

  /**
   * 트레이딩 세션 체크 (KST)
   * 고유동성 구간에만 진입. 새벽 시간대는 스프레드 넓고 슬리피지 크다.
   */
  /**
   * 매크로 신호 엔진 연결 (선택적)
   * TradingBot이 MacroSignalEngine 인스턴스를 주입
   */
  setMacroEngine(engine) {
    this.macroEngine = engine;
  }

  setDataEngine(engine) {
    this.dataEngine = engine;
  }

  isInTradingSession(now = Date.now()) {
    const cfg = this.simulationConfig;
    const utcMs = now % (24 * 3_600_000);
    const kstMinutes = Math.floor((utcMs + 9 * 3_600_000) % (24 * 3_600_000) / 60_000);
    return cfg.tradingSessionsKST.some(
      ([start, end]) => kstMinutes >= start && kstMinutes < end,
    );
  }

  /**
   * ─────────────────────────────────────────
   * v4 서킷브레이커
   *
   * 일일 손실 한도 / 연속 손절 / 최대 거래 횟수
   * 이 3개 조건 중 하나라도 걸리면 당일 매매 종료.
   * ─────────────────────────────────────────
   */
  checkDailyReset(now) {
    const today = new Date(now).toLocaleDateString("ko-KR");
    const sim = this.state.simulation;

    if (sim.daily.date !== today) {
      sim.daily.date = today;
      sim.daily.openingAsset = this.getSimulationTotalAsset();
      sim.daily.trades = 0;
      sim.daily.pnl = 0;
      sim.daily.consecutiveLosses = 0;
      sim.daily.halted = false;
      sim.daily.haltReason = null;
    }
  }

  checkCircuitBreakers(now) {
    const sim = this.state.simulation;
    const cfg = this.simulationConfig;

    this.checkDailyReset(now);

    if (sim.daily.halted) {
      return { halt: true, reason: sim.daily.haltReason };
    }

    const totalAsset = this.getSimulationTotalAsset();
    const openingAsset = sim.daily.openingAsset || totalAsset;
    const dailyReturn = openingAsset > 0
      ? (totalAsset - openingAsset) / openingAsset
      : 0;

    if (dailyReturn <= cfg.maxDailyLossRate) {
      sim.daily.halted = true;
      sim.daily.haltReason = "DAILY_LOSS_LIMIT";
      sim.lastActionText = `일일 손실 한도 도달 (${(dailyReturn * 100).toFixed(2)}%) — 오늘 매매 종료`;
      return { halt: true, reason: "DAILY_LOSS_LIMIT" };
    }

    if (sim.daily.consecutiveLosses >= cfg.maxConsecutiveLosses) {
      sim.daily.halted = true;
      sim.daily.haltReason = "CONSECUTIVE_LOSS_LIMIT";
      sim.lastActionText = `${cfg.maxConsecutiveLosses}연속 손절 — 오늘 매매 종료`;
      return { halt: true, reason: "CONSECUTIVE_LOSS_LIMIT" };
    }

    if (sim.daily.trades >= cfg.maxDailyTrades) {
      sim.daily.halted = true;
      sim.daily.haltReason = "MAX_DAILY_TRADES";
      sim.lastActionText = `일일 최대 거래 횟수(${cfg.maxDailyTrades}회) 도달 — 오늘 매매 종료`;
      return { halt: true, reason: "MAX_DAILY_TRADES" };
    }

    return { halt: false };
  }

  /**
   * ─────────────────────────────────────────
   * 핵심 후보 평가 — v4
   *
   * 변경사항:
   * 1) 기대값(EV) 점수 반영
   * 2) bullishProbability를 win rate 추정치로 활용
   * 3) 진입 조건 강화 (volatility, volume spike, market cap)
   * ─────────────────────────────────────────
   */
  evaluateMarketSnapshot(marketCode, now = Date.now()) {
    const context = this.ensureContext(marketCode);
    const market24h = this.get24hStats(marketCode);
    const marketCapInfo = this.getMarketCapInfo(marketCode);
    const candles5s = this.get5sCandles(context, 120);
    const candles1d = this.get1dCandles(context, 90);
    const closes5s = candles5s.map((item) => Number(item.c || 0));
    const volumes5s = candles5s.map((item) => Number(item.v || 0));
    const closes1d = candles1d.map((item) => Number(item.c || 0));
    const opens1d = candles1d.map((item) => Number(item.o || 0));
    const trades5s = candles5s.map((item) => Number(item.trades || 0));

    const reasons = [];

    if (candles5s.length < 36 || candles1d.length < 45) {
      reasons.push("CANDIDATE_NOT_READY");
    }

    const ma5  = this.sma(closes5s, 5);
    const ma20 = this.sma(closes5s, 20);
    const ma60 = this.sma(closes5s, 60);
    const lastPrice   = this.getCurrentPrice(context);
    const price1mAgo  = this.last(closes5s, 12);
    const price2mAgo  = this.last(closes5s, 24);
    const momentum1m  = price1mAgo > 0 ? (lastPrice - price1mAgo) / price1mAgo : 0;
    const momentum2m  = price2mAgo > 0 ? (lastPrice - price2mAgo) / price2mAgo : 0;

    const returns5s = closes5s.slice(-24).map((value, index, array) => {
      if (index === 0 || !array[index - 1]) return 0;
      return (value - array[index - 1]) / array[index - 1];
    });

    const volatility = this.stddev(returns5s);
    const shortVolume = this.average(volumes5s.slice(-6));
    const baseVolume  = this.average(volumes5s.slice(-36, -6));
    const volumeSpikeRatio =
      baseVolume > 0 ? shortVolume / baseVolume : Number.POSITIVE_INFINITY;
    const tradeFreshMs = this.getTradeFreshMs(context, now);
    const recentTradeCount = trades5s.slice(-12).reduce((sum, value) => sum + value, 0);

    const upDayCount = candles1d.reduce(
      (sum, candle) =>
        sum + (Number(candle.c || 0) > Number(candle.o || 0) ? 1 : 0),
      0,
    );
    const upDayRatio = candles1d.length > 0 ? upDayCount / candles1d.length : 0;
    const dailyShort = this.average(closes1d.slice(-20));
    const dailyLong  = this.average(closes1d.slice(-60));
    const todayBias =
      opens1d.length > 0 && closes1d.length > 0
        ? (this.last(closes1d) - this.last(opens1d)) / Math.max(1, this.last(opens1d))
        : 0;

    // RSI(14) — 과매도/과매수 신호
    const rsi = this.computeRSI(closes5s, 14);
    const rsiScore = rsi < 25 ? 18    // 극단 과매도 → 강한 반등 기회
      : rsi < 35  ? 12
      : rsi < 45  ?  5
      : rsi > 80  ? -15   // 극단 과매수 → 고점 위험
      : rsi > 70  ?  -8
      : rsi > 60  ?  -3
      : 0;

    let bullishProbability = 28;
    if (dailyShort > dailyLong)             bullishProbability += 18;
    if (upDayRatio >= 0.55)                 bullishProbability += 16;
    if (ma5 > ma20 && ma20 > ma60)          bullishProbability += 18;
    if (momentum1m > 0)                     bullishProbability += 8;
    if (momentum2m > 0)                     bullishProbability += 10;
    if (market24h.signedChangeRate > 0)     bullishProbability += 8;
    if (todayBias > 0)                      bullishProbability += 5;
    if (volatility <= 0.0015)               bullishProbability += 7;
    else if (volatility <= 0.0025)          bullishProbability += 3;
    if (shortVolume > 0 && shortVolume < baseVolume * 1.8) bullishProbability += 5;
    bullishProbability += rsiScore;  // RSI 반영
    bullishProbability = Math.max(0, Math.min(99, bullishProbability));

    // ── 일봉 장기 추세 하드 필터 (v9) ────────────────────
    // price < MA20 AND MA20 < MA60 → 확실한 하락 추세 → 롱 진입 전면 차단
    // 백테스트 실증: 하락 추세에서 롱 진입 시 실측 승률 2~8%, EV 항상 음수
    if (closes1d.length >= 20) {
      const dailyCur = closes1d[closes1d.length - 1];
      if (dailyCur > 0 && dailyCur < dailyShort && dailyShort < dailyLong) {
        reasons.push("DAILY_DOWNTREND");
      }
    }

    const marketCapUsd = Number(marketCapInfo?.marketCapUsd || 0);
    // marketCapUsd=0 은 CoinGecko 429/미수신 → 데이터 없는 것이지 실제 저시총이 아님
    // 실제로 값이 있을 때만 차단
    if (marketCapUsd > 0 && marketCapUsd < this.simulationConfig.minMarketCapUsd) {
      reasons.push("MARKETCAP_TOO_LOW");
    }

    if (volumeSpikeRatio > this.simulationConfig.maxVolumeSpikeRatio) {
      reasons.push("OVERHEATED_VOLUME");
    }

    if (
      market24h.accTradePrice24h < this.simulationConfig.minAccTradePrice24h ||
      tradeFreshMs > this.simulationConfig.minTradeFreshMs
    ) {
      reasons.push("LIQUIDITY_WEAK");
    }

    if (
      !(
        ma5 > ma20 &&
        ma20 > ma60 &&
        momentum1m > 0 &&
        momentum2m > -0.0003 &&
        volatility <= this.simulationConfig.maxVolatility5s
      )
    ) {
      reasons.push("TREND_NOT_CONFIRMED");
    }

    // 레짐 적응 임계값: 공포탐욕 지수에 따라 진입 기준 동적 조정
    // 극단 공포(< 25): 과매도 반등 기회 → 기준 완화
    // 극단 탐욕(> 75): FOMO 구간 → 기준 강화
    const fearGreedNow = this.macroEngine?.state?.fearGreed?.value ?? 50;
    let dynamicMinBullish = this.simulationConfig.minBullishProbability;
    if (fearGreedNow < 25)      dynamicMinBullish -= 10; // 극단 공포: 과매도 반등
    else if (fearGreedNow < 40) dynamicMinBullish -= 5;  // 공포: 약간 완화
    else if (fearGreedNow > 75) dynamicMinBullish += 8;  // 극단 탐욕: 강화
    else if (fearGreedNow > 60) dynamicMinBullish += 4;  // 탐욕: 약간 강화
    dynamicMinBullish = Math.max(45, Math.min(80, dynamicMinBullish));

    if (bullishProbability < dynamicMinBullish) {
      reasons.push("BULLISH_PROB_LOW");
    }

    // ── v6: BTC 매크로 필터 ──────────────────────────
    // BTC가 급락 중이면 알트도 무조건 같이 빠진다 (베타 효과).
    // KRW-BTC 자체 평가는 제외.
    if (marketCode !== "KRW-BTC") {
      const btcMomentum = this.getBtcMomentum();
      if (btcMomentum < this.simulationConfig.btcFilterThreshold) {
        reasons.push("BTC_DOWNTREND");
      }
    }

    // ── v6: 트레이딩 세션 필터 ───────────────────────
    if (!this.isInTradingSession(now)) {
      reasons.push("OFF_PEAK_HOURS");
    }

    // ── v6: 체결 흐름 (Buy/Sell Flow) ─────────────────
    // 실제 체결 데이터 기반. 호가창보다 신뢰도 높음.
    const buyFlowRatio = this.computeBuyFlowRatio(context);
    if (buyFlowRatio < this.simulationConfig.minBuyFlowRatio) {
      reasons.push("SELL_FLOW_DOMINANT");
    }

    // ── v6: VWAP 이탈 필터 ───────────────────────────
    // VWAP 대비 너무 올라간 코인은 이미 고점에서 사는 것.
    const vwap = this.computeVWAP(context);
    let vwapDeviation = 0;
    let vwapScore = 0;
    if (vwap > 0 && lastPrice > 0) {
      vwapDeviation = (lastPrice - vwap) / vwap;
      if (vwapDeviation > this.simulationConfig.vwapMaxOvershoot) {
        reasons.push("VWAP_OVEREXTENDED");
      }
      // VWAP 아래면 진입 우호적 (+점수), 위면 페널티
      vwapScore = Math.max(-15, Math.min(12, -vwapDeviation * 2_000));
    }

    // ── v7: 구조적 매크로 알파 ───────────────────────
    // 기술 지표가 아닌 시장 구조 비효율에서 신호 추출
    let macroScore = 0;
    let macroFlags = [];
    let macroSignals = null;
    if (this.macroEngine) {
      macroSignals = this.macroEngine.getSignals(marketCode);
      macroScore = macroSignals.macroScore;
      macroFlags = macroSignals.flags;

      if (macroFlags.includes("KIMCHI_OVERPRICED")) reasons.push("KIMCHI_OVERPRICED");
      if (macroFlags.includes("FUNDING_CROWDED_LONG")) reasons.push("FUNDING_CROWDED_LONG");
      if (macroFlags.includes("EXTREME_GREED_CAUTION")) reasons.push("EXTREME_GREED_CAUTION");
    }

    // ── v7: 빅데이터 신호 ──────────────────────────────
    let dataScore = 0;
    let dataSignals = null;
    if (this.dataEngine) {
      dataSignals = this.dataEngine.getSignals(marketCode);
      dataScore   = dataSignals.dataScore;

      if (dataSignals.flags.includes("TAKER_SELL_DOMINANT")) reasons.push("TAKER_SELL_DOMINANT");
      if (dataSignals.flags.includes("LS_CROWDED_LONG"))     reasons.push("LS_CROWDED_LONG");
      if (dataSignals.flags.includes("OI_DROP"))             reasons.push("OI_DROP");
    }

    // ── v5: 호가창 불균형 + 스프레드 게이트 ─────────
    // 이건 MA와 달리 선행 지표다.
    // 지금 실제로 사려는 사람이 팔려는 사람보다 많냐가 핵심.
    const orderbook = context.orderbook;
    let bidAskImbalance = 0.5;
    let spreadRate = 0.005; // 기본값: 넓다고 보수적으로 가정

    if (orderbook?.bids?.length >= 3 && orderbook?.asks?.length >= 3) {
      const bidValue = orderbook.bids
        .slice(0, 5)
        .reduce((sum, b) => sum + b.size * b.price, 0);
      const askValue = orderbook.asks
        .slice(0, 5)
        .reduce((sum, a) => sum + a.size * a.price, 0);
      const totalValue = bidValue + askValue;
      if (totalValue > 0) bidAskImbalance = bidValue / totalValue;

      const bestBid = orderbook.bids[0]?.price;
      const bestAsk = orderbook.asks[0]?.price;
      if (bestBid && bestAsk && bestAsk > 0) {
        spreadRate = (bestAsk - bestBid) / bestAsk;
      }
    }

    // 스프레드 게이트: 0.2% 고정 상한 (대부분 알트 커버)
    // 구버전: targetNetIntentRate × 0.20 = 0.07% → 너무 좁아서 전부 차단
    const MAX_SPREAD_RATE = 0.002;
    if (spreadRate > MAX_SPREAD_RATE) {
      reasons.push("SPREAD_TOO_WIDE");
    }

    // 매수 압력 게이트: 43% 미만이면 강한 매도 우위 확정
    if (bidAskImbalance < 0.43) {
      reasons.push("WEAK_BID_PRESSURE");
    }

    // 호가 불균형이 bullishProbability에도 반영
    if (bidAskImbalance >= 0.65) bullishProbability += 8;
    else if (bidAskImbalance >= 0.60) bullishProbability += 4;
    else if (bidAskImbalance < 0.50) bullishProbability -= 5;
    bullishProbability = Math.max(0, Math.min(99, bullishProbability));

    /**
     * v4: 기대값(EV) 필터
     *
     * 진입 후 기대값이 음수면 진입하지 않는다.
     * 승률 추정: bullishProbability / 100 (최대 0.72로 보수적 캡)
     * EV = (estimatedWinRate × targetNet) - (estimatedLossRate × |stop|) - totalFees
     */
    // estimatedWinRate 캡: bullishProbability 스케일과 일치 (0.85)
    const estimatedWinRate = Math.min(0.85, bullishProbability / 100);
    const estimatedLossRate = 1 - estimatedWinRate;
    // targetNetIntentRate는 이미 수수료 제외 순수익 → 수수료 이중 차감 금지
    const ev =
      estimatedWinRate * this.simulationConfig.targetNetIntentRate -
      estimatedLossRate * Math.abs(this.simulationConfig.stopLossRate);

    if (ev < 0) {
      reasons.push("EV_NEGATIVE");
    }

    const liquidityScore = Math.min(
      18,
      Math.log10(Math.max(1, market24h.accTradePrice24h)) * 2,
    );
    const trendScore =
      (ma5 > ma20 ? 8 : 0) +
      (ma20 > ma60 ? 8 : 0) +
      (momentum1m > 0 ? 5 : 0) +
      (momentum2m > 0 ? 5 : 0);
    const stabilityScore = Math.max(0, 16 - Math.min(16, volatility * 10_000));
    const marketCapScore = marketCapUsd > 0
      ? Math.min(18, Math.log10(marketCapUsd) * 2)
      : 0;

    // v5: 호가 불균형 점수 (선행 알파 직접 반영)
    const imbalanceScore = Math.max(-12, Math.min(18, (bidAskImbalance - 0.5) * 120));

    // v5: 스프레드 페널티 (진입 비용 반영)
    const spreadPenalty = spreadRate > 0.0003
      ? Math.min(15, spreadRate * 15000)
      : 0;

    // v4: EV 보너스 점수
    const evBonus = ev > 0
      ? Math.min(20, ev * 5000)
      : Math.max(-20, ev * 5000);

    // v6: 체결 흐름 점수 — 매수 주도 체결이 많을수록 강세
    const flowScore = Math.max(-10, Math.min(15, (buyFlowRatio - 0.5) * 80));

    // 모멘텀 가속 점수: 1분 모멘텀이 2분보다 강하면 추세가 붙는 중
    // 가속 = momentum1m - momentum2m > 0 이면 추세 강화 중
    const momentumAcceleration = momentum1m - momentum2m;
    const accelScore = (momentum1m > 0 && momentum2m > 0 && momentumAcceleration > 0)
      ? Math.min(15, momentumAcceleration * 3000)
      : (momentum1m < 0 && momentumAcceleration < 0)
        ? Math.max(-10, momentumAcceleration * 2000)
        : 0;

    let rawScore =
      bullishProbability +
      liquidityScore +
      trendScore +
      stabilityScore +
      marketCapScore +
      imbalanceScore -
      spreadPenalty +
      evBonus +
      vwapScore +
      flowScore +
      macroScore +
      dataScore +
      accelScore +
      rsiScore;   // RSI 과매도/과매수 보정
    rawScore -= reasons.length * 8;
    rawScore = Math.max(0, Number(rawScore.toFixed(2)));

    const memory = this.updateScoreMemory({
      market: context.marketCode,
      rawScore,
      bullishProbability,
      eligible: reasons.length === 0,
    });

    const smoothedScore = Number(memory.scoreEma.toFixed(2));
    const smoothedBullishProbability = Number(memory.bullEma.toFixed(2));
    const eligible = reasons.length === 0 && memory.passStreak >= 1;

    return {
      market: context.marketCode,
      koreanName: context.koreanName,
      englishName: context.englishName,
      currentPrice: lastPrice,
      rawScore,
      smoothedScore,
      bullishProbability: smoothedBullishProbability,
      eligible,
      reasons,
      ev: Number(ev.toFixed(6)),
      metrics: {
        ma5, ma20, ma60,
        momentum1m, momentum2m,
        volatility,
        volumeSpikeRatio: Number.isFinite(volumeSpikeRatio)
          ? Number(volumeSpikeRatio.toFixed(3))
          : 0,
        upDayRatio: Number(upDayRatio.toFixed(3)),
        accTradePrice24h: market24h.accTradePrice24h,
        accTradeVolume24h: market24h.accTradeVolume24h,
        signedChangeRate: market24h.signedChangeRate,
        tradeFreshMs,
        recentTradeCount,
        marketCapUsd,
        passStreak: memory.passStreak,
        ev: Number(ev.toFixed(6)),
        // v5 신규
        bidAskImbalance: Number(bidAskImbalance.toFixed(3)),
        spreadRate: Number(spreadRate.toFixed(5)),
        imbalanceScore: Number(imbalanceScore.toFixed(2)),
        // v6 신규
        buyFlowRatio: Number(buyFlowRatio.toFixed(3)),
        vwap: Number(vwap.toFixed(0)),
        vwapDeviation: Number(vwapDeviation.toFixed(5)),
        btcMomentum: marketCode !== "KRW-BTC" ? Number(this.getBtcMomentum().toFixed(5)) : 0,
        // v7 매크로
        macroScore,
        macroFlags,
        kimchiPremium:  macroSignals?.kimchiPremium ?? null,
        fundingRate:    macroSignals?.fundingRate ?? null,
        fearGreedValue: macroSignals?.fearGreedValue ?? null,
        // v7 데이터
        dataScore,
        oiChangeRate:      dataSignals?.oiChangeRate ?? null,
        lsRatio:           dataSignals?.lsRatio ?? null,
        takerRatio:        dataSignals?.takerRatio ?? null,
        dataFlags:         dataSignals?.flags ?? [],
        isNewListing:      dataSignals?.flags?.includes("NEW_LISTING") ?? false,
        hoursSinceListing: dataSignals?.hoursSinceListing ?? null,
      },
    };
  }

  async refreshAnalysisContexts() {
    const tasks = this.state.analysisMarketCodes.map(async (marketCode) => {
      const context = this.ensureContext(marketCode);
      const now = Date.now();
      const jobList = [];

      if (!context.candles5s.length || now - context.hydratedAt.ticks > 6_000) {
        jobList.push(
          context.lastSequentialId > 0
            ? this.pollLatestTicks(context)
            : this.loadInitialTicks(context),
        );
      }
      if (!context.dailyCandles.length || now - context.hydratedAt.daily > this.pollIntervals.dailyRefresh) {
        jobList.push(this.loadDailyCandles(context));
      }
      if (!context.latestDayHistory || now - context.hydratedAt.dayHistory > 90_000) {
        jobList.push(this.refreshDayHistory(context));
      }

      await Promise.allSettled(jobList);
      this.ensureAtLeastOneCandle(context);
    });

    await Promise.allSettled(tasks);

    // v5: 상위 후보 3개에 대해 호가창도 갱신
    // 호가 불균형 신호(선행 알파)를 위해 필요
    const topCodes = this.state.analysisMarketCodes.slice(0, 3);
    await Promise.allSettled(
      topCodes.map(async (marketCode) => {
        const ctx = this.ensureContext(marketCode);
        const now = Date.now();
        if (!ctx.orderbook || now - ctx.hydratedAt.orderbook > 4_500) {
          await this.loadOrderbook(ctx).catch(() => {});
        }
      }),
    );
  }

  chooseStableCandidate(eligibleSnapshots) {
    if (eligibleSnapshots.length === 0) {
      this.state.leaderState.lastLeaderMarket = null;
      this.state.leaderState.lastLeaderScore = 0;
      this.state.leaderState.leaderStreak = 0;
      return null;
    }

    const leader = eligibleSnapshots[0];
    const leaderState = this.state.leaderState;

    if (leaderState.lastLeaderMarket === leader.market) {
      leaderState.leaderStreak += 1;
    } else {
      leaderState.lastLeaderMarket = leader.market;
      leaderState.lastLeaderScore = leader.smoothedScore;
      leaderState.leaderStreak = 1;
    }

    leaderState.lastLeaderScore = leader.smoothedScore;

    const incumbentMarket = leaderState.incumbentMarket;
    const incumbent = incumbentMarket
      ? eligibleSnapshots.find((item) => item.market === incumbentMarket) || null
      : null;

    const leaderMemory = this.state.scoreMemory.get(leader.market);
    const leaderReady =
      leaderState.leaderStreak >= 2 &&
      (leaderMemory?.passStreak || 0) >= this.simulationConfig.stablePassNeeded;

    if (!incumbent) {
      if (leaderReady) {
        leaderState.incumbentMarket = leader.market;
        return leader;
      }
      return null;
    }

    const scoreGap = leader.smoothedScore - incumbent.smoothedScore;
    if (
      incumbent.eligible &&
      leader.market !== incumbent.market &&
      scoreGap < this.simulationConfig.switchMarginScore
    ) {
      return incumbent;
    }

    if (leader.market === incumbent.market) return incumbent;

    if (leaderReady && scoreGap >= this.simulationConfig.switchMarginScore) {
      leaderState.incumbentMarket = leader.market;
      return leader;
    }

    return incumbent;
  }

  /**
   * ─────────────────────────────────────────
   * 자동 진입 — v4
   *
   * 핵심 변경:
   * 변동성 기반 동적 목표가 / 손절가 계산
   * sigma(최근 5초봉 실현변동성)을 기반으로
   *   target = avgBuyPrice × (1 + σ × 2.2)
   *   stop   = avgBuyPrice × (1 - σ × 1.1)
   * 단, 고정 min/max 범위로 클램프
   * ─────────────────────────────────────────
   */
  openMarketPosition(now, snapshot) {
    const sim = this.state.simulation;
    if (sim.activePosition) return;

    const totalAsset = this.getSimulationTotalAsset();
    const budget = Math.min(
      sim.cash,
      totalAsset * this.simulationConfig.allocationRate,
    );
    if (budget <= 0) return;

    const price = Number(snapshot.currentPrice || 0);
    if (price <= 0) return;

    const cfg = this.simulationConfig;

    // 변동성 기반 동적 목표/손절
    const sigma = snapshot.metrics?.volatility || 0.002;
    let dynamicTargetGross;
    let dynamicStopRate;

    if (cfg.useVolatilityTargets && sigma > 0.0005) {
      dynamicTargetGross = sigma * cfg.volTargetMult;
      dynamicTargetGross = Math.max(cfg.minTargetGross, Math.min(cfg.maxTargetGross, dynamicTargetGross));

      dynamicStopRate = -(sigma * cfg.volStopMult);
      dynamicStopRate = Math.max(cfg.minStopRate, Math.min(cfg.maxStopRate, dynamicStopRate));
    } else {
      dynamicTargetGross = cfg.targetGrossRate;
      dynamicStopRate = cfg.stopLossRate;
    }

    // 예약매수(지정가) 수수료 우선 적용, 없으면 시장가 수수료
    const effectiveBuyFeeRate = cfg.reservedBuyFeeRate ?? cfg.buyFeeRate;
    const tradeValue = budget / (1 + effectiveBuyFeeRate);
    const buyFee = budget - tradeValue;
    const quantity = tradeValue / price;
    const avgBuyPrice = quantity > 0 ? tradeValue / quantity : price;
    const targetSellPrice = avgBuyPrice * (1 + dynamicTargetGross);
    const dynamicNetTarget =
      dynamicTargetGross - cfg.buyFeeRate - cfg.reservedSellFeeRate;

    sim.cash -= budget;
    sim.totalFees += buyFee;
    sim.activePosition = {
      marketCode: snapshot.market,
      koreanName: snapshot.koreanName,
      englishName: snapshot.englishName,
      openedAt: now,
      status: "HOLDING",
      quantity,
      totalSpentCash: budget,
      averageBuyPrice: avgBuyPrice,
      entryPrice: price,
      buyFee,
      reservedSellFeeRate: cfg.reservedSellFeeRate,
      buyFeeRate: cfg.buyFeeRate,
      targetSellPrice,
      targetGrossRate: dynamicTargetGross,
      targetNetIntentRate: Math.max(cfg.targetNetIntentRate, dynamicNetTarget),
      dynamicStopRate,      // v4: 동적 손절가 저장
      score: snapshot.smoothedScore,
      bullishProbability: snapshot.bullishProbability,
      ev: snapshot.ev,
    };

    sim.lastActionText = `${snapshot.market} 시장가 매수 · 목표 +${(dynamicTargetGross * 100).toFixed(2)}% · 손절 ${(dynamicStopRate * 100).toFixed(2)}%`;

    this.appendSimulationRecord({
      type: "BUY_MARKET_FILLED",
      market: snapshot.market,
      koreanName: snapshot.koreanName,
      price,
      quantity,
      tradeValue,
      buyFee,
      totalSpentCash: budget,
      targetSellPrice,
      targetGrossRate: dynamicTargetGross,
      dynamicStopRate,
      bullishProbability: snapshot.bullishProbability,
      score: snapshot.smoothedScore,
      ev: snapshot.ev,
    });
  }

  refreshCurrentPositionFeeView(now = Date.now()) {
    const sim = this.state.simulation;
    const position = sim.activePosition;

    if (!position) {
      sim.currentPositionFeeView = null;
      return;
    }

    const context = this.ensureContext(position.marketCode);
    const currentPrice = this.getCurrentPrice(context);

    if (!currentPrice || !position.averageBuyPrice) {
      sim.currentPositionFeeView = null;
      return;
    }

    const currentGrossMoveRate =
      (currentPrice - position.averageBuyPrice) / position.averageBuyPrice;
    const reservedNetRate =
      currentGrossMoveRate -
      this.simulationConfig.buyFeeRate -
      this.simulationConfig.reservedSellFeeRate;
    const marketNetRate =
      currentGrossMoveRate -
      this.simulationConfig.buyFeeRate -
      this.simulationConfig.marketSellFeeRate;
    const targetRemainRate = Math.max(
      0,
      position.targetGrossRate - currentGrossMoveRate,
    );
    const targetProgress =
      position.targetGrossRate > 0
        ? Math.max(
            0,
            Math.min(1, currentGrossMoveRate / position.targetGrossRate),
          )
        : 0;

    sim.currentPositionFeeView = {
      marketCode: position.marketCode,
      currentPrice,
      averageBuyPrice: position.averageBuyPrice,
      currentGrossMoveRate,
      buyFeeRate: this.simulationConfig.buyFeeRate,
      reservedSellFeeRate: this.simulationConfig.reservedSellFeeRate,
      marketSellFeeRate: this.simulationConfig.marketSellFeeRate,
      reservedNetRate,
      marketNetRate,
      targetGrossRate: position.targetGrossRate,
      dynamicStopRate: position.dynamicStopRate,
      targetRemainRate,
      targetProgress,
      updatedAt: now,
    };
  }

  /**
   * v4: 동적 손절가 사용
   */
  advanceSimulation(now = Date.now()) {
    const sim = this.state.simulation;
    const position = sim.activePosition;

    if (!position) {
      sim.lastUpdatedAt = now;
      sim.currentPositionFeeView = null;
      return;
    }

    const context = this.ensureContext(position.marketCode);
    const currentPrice = this.getCurrentPrice(context);
    if (!currentPrice) {
      sim.lastUpdatedAt = now;
      return;
    }

    this.refreshCurrentPositionFeeView(now);

    const reservedNetValue =
      position.quantity *
      currentPrice *
      (1 - this.simulationConfig.reservedSellFeeRate);
    const marketNetValue =
      position.quantity *
      currentPrice *
      (1 - this.simulationConfig.marketSellFeeRate);
    const marketPnlRate =
      position.totalSpentCash > 0
        ? marketNetValue / position.totalSpentCash - 1
        : 0;
    const grossMoveRate =
      position.averageBuyPrice > 0
        ? (currentPrice - position.averageBuyPrice) / position.averageBuyPrice
        : 0;

    // ── 부분 익절: 목표의 60% 도달 시 50% 청산 ────────
    // 수익을 일부 확정하고 잔여 50%를 브레이크이븐 스톱으로 추적
    // 기대값: 전체 WIN보다 작지만 실현 빈도가 크게 올라감
    if (!position.partialExitDone && grossMoveRate >= position.targetGrossRate * 0.60) {
      const halfQty   = position.quantity * 0.5;
      const sellFee   = halfQty * currentPrice * this.simulationConfig.reservedSellFeeRate;
      const netRecv   = halfQty * currentPrice - sellFee;
      const halfCost  = position.totalSpentCash * 0.5;

      sim.cash        += netRecv;
      sim.realizedPnl += netRecv - halfCost;
      sim.totalFees   += sellFee;

      position.quantity        -= halfQty;
      position.totalSpentCash  -= halfCost;
      position.partialExitDone  = true;
      position.partialExitPrice = currentPrice;

      // 잔여 50%: 손절을 브레이크이븐으로 이동
      const beStop = -(
        (this.simulationConfig.reservedBuyFeeRate ?? this.simulationConfig.buyFeeRate) +
        this.simulationConfig.marketSellFeeRate + 0.0002
      );
      position.dynamicStopRate   = beStop;
      position.breakevenActivated = true;

      sim.lastActionText = `${position.marketCode} 부분 익절 50% ·잔여 브레이크이븐 추적`;
    }

    // ── 브레이크이븐 트레일링 스톱 (부분 익절 없이 +0.2% 도달 시) ──
    const BREAKEVEN_TRIGGER = 0.002;
    if (
      grossMoveRate >= BREAKEVEN_TRIGGER &&
      !position.breakevenActivated
    ) {
      const breakEvenStop = -(
        (this.simulationConfig.reservedBuyFeeRate ?? this.simulationConfig.buyFeeRate) +
        this.simulationConfig.marketSellFeeRate
      );
      if ((position.dynamicStopRate ?? this.simulationConfig.stopLossRate) < breakEvenStop) {
        position.dynamicStopRate    = breakEvenStop;
        position.breakevenActivated = true;
      }
    }

    // ── 타임스톱: 20분 경과 후 손실 중이면 철수 ──────
    // 방향성 없는 포지션이 자본 묶는 것 방지
    const holdingMs = now - position.openedAt;
    if (holdingMs > 20 * 60 * 1000 && marketPnlRate < -0.0005) {
      this.closePosition(now, currentPrice, "TIME_STOP");
      return;
    }

    // v4: position에 저장된 동적 손절가 사용
    const effectiveStopRate =
      position.dynamicStopRate ?? this.simulationConfig.stopLossRate;

    if (marketPnlRate <= effectiveStopRate) {
      this.closePosition(now, currentPrice, "STOP_LOSS");
      return;
    }

    if (
      currentPrice >= position.targetSellPrice ||
      reservedNetValue >=
        position.totalSpentCash * (1 + position.targetNetIntentRate)
    ) {
      this.closePosition(now, currentPrice, "TARGET_RESERVED_HIT");
      return;
    }

    sim.lastUpdatedAt = now;
  }

  /**
   * v4: 일일 서킷브레이커 통계 갱신
   */
  closePosition(now, sellPrice, reason) {
    const sim = this.state.simulation;
    const position = sim.activePosition;
    if (!position) return;

    const sellFeeRate =
      reason === "TARGET_RESERVED_HIT"
        ? this.simulationConfig.reservedSellFeeRate
        : this.simulationConfig.marketSellFeeRate;

    const grossSellValue = position.quantity * sellPrice;
    const sellFee = grossSellValue * sellFeeRate;
    const netSellValue = grossSellValue - sellFee;
    const realizedPnl = netSellValue - position.totalSpentCash;
    const realizedRate =
      position.totalSpentCash > 0 ? realizedPnl / position.totalSpentCash : 0;

    sim.cash += netSellValue;
    sim.realizedPnl += realizedPnl;
    sim.totalFees += sellFee;
    sim.totalTrades += 1;

    if (realizedPnl >= 0) {
      sim.wins += 1;
    } else {
      sim.losses += 1;
    }

    // v9: 샤프 비율 추적
    sim.tradeReturns = sim.tradeReturns || [];
    sim.tradeReturns.push(realizedRate);
    if (sim.tradeReturns.length > 100) sim.tradeReturns.shift();

    // v4: 일일 서킷브레이커 통계 갱신
    sim.daily.trades += 1;
    sim.daily.pnl += realizedPnl;
    if (realizedPnl < 0) {
      sim.daily.consecutiveLosses += 1;
    } else {
      sim.daily.consecutiveLosses = 0;  // 이기면 연속 손절 카운터 리셋
    }

    const reasonLabel = reason === "STOP_LOSS" ? "시장가 손절"
      : reason === "TIME_STOP" ? "타임스톱 청산"
      : "예약매도 체결";
    sim.lastActionText = `${position.marketCode} ${reasonLabel} · ${realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(0)}원`;

    this.appendSimulationRecord({
      type: "POSITION_CLOSED",
      reason,
      market: position.marketCode,
      koreanName: position.koreanName,
      closedAt: now,
      averageBuyPrice: position.averageBuyPrice,
      sellPrice,
      quantity: position.quantity,
      totalSpentCash: position.totalSpentCash,
      buyFee: position.buyFee,
      sellFee,
      sellFeeRate,
      grossSellValue,
      netSellValue,
      realizedPnl,
      realizedRate,
      totalAssetAfterClose: this.getSimulationTotalAsset({ extraCash: netSellValue }),
    });

    sim.activePosition = null;
    sim.currentPositionFeeView = null;

    if (reason === "STOP_LOSS" || reason === "TIME_STOP") {
      sim.pauseUntil = now + this.simulationConfig.cooldownAfterStopMs;
      sim.pauseReasonCode = "STOPLOSS_COOLDOWN";
      return;
    }

    const cumulativeReturn =
      (this.getSimulationTotalAsset() - sim.initialCapital) / sim.initialCapital;
    if (cumulativeReturn >= 0.01) {
      sim.pauseUntil = now + this.simulationConfig.profitPauseMs;
      sim.pauseReasonCode = "PROFIT_LOCK_REST";
    } else {
      sim.pauseUntil = 0;
      sim.pauseReasonCode = null;
    }
  }

  getSimulationTotalAsset(options = {}) {
    const sim = this.state.simulation;
    let total = Number(sim.cash || 0) + Number(options.extraCash || 0);

    if (sim.activePosition) {
      const context = this.ensureContext(sim.activePosition.marketCode);
      const currentPrice = this.getCurrentPrice(context);
      if (currentPrice > 0) {
        total +=
          sim.activePosition.quantity *
          currentPrice *
          (1 - this.simulationConfig.marketSellFeeRate);
      }
    }

    return total;
  }

  appendSimulationRecord(record) {
    const sim = this.state.simulation;
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...record,
    };

    sim.history.unshift(item);
    sim.history = sim.history.slice(0, 1000);
    this.persistSimulationHistory();
  }

  persistSimulationHistory() {
    if (this.persistingHistory) return;
    this.persistingHistory = true;

    const payload = {
      savedAt: new Date().toISOString(),
      solutionName: this.solutionName,
      simulation: this.getSimulationSummary(),
      history: this.state.simulation.history,
    };

    fs.promises
      .mkdir(path.dirname(this.historyFilePath), { recursive: true })
      .then(() =>
        fs.promises.writeFile(
          this.historyFilePath,
          JSON.stringify(payload, null, 2),
          "utf8",
        ),
      )
      .catch((error) => { this.pushError("persistSimulationHistory", error); })
      .finally(() => { this.persistingHistory = false; });
  }

  /**
   * ─────────────────────────────────────────
   * 전체 분석 + 자동 시뮬레이션 — v4
   *
   * 변경사항:
   * 1) loadMarketCapsForAnalysis 제거
   *    (구버전은 매 5초마다 CoinGecko API를 호출 → rate limit 크래시)
   *    (이제 10분 주기 폴러에서만 호출)
   * 2) 서킷브레이커 체크 추가
   * ─────────────────────────────────────────
   */
  async runAnalysisAndSimulation() {
    await this.refreshAnalysisContexts();
    // v4: loadMarketCapsForAnalysis 제거 (10분 폴러에서 처리)

    const now = Date.now();
    const snapshots = this.state.analysisMarketCodes
      .map((marketCode) => this.evaluateMarketSnapshot(marketCode, now))
      .sort((a, b) => b.smoothedScore - a.smoothedScore);

    // ── v6: 횡단면 모멘텀 랭킹 ──────────────────────────
    // 같은 시간에 다른 코인들이 오르는데 이 코인만 안 오른다면
    // 약세 코인이므로 제외. 상대적 강세 코인만 진입 후보로.
    if (snapshots.length >= 3) {
      const sorted = snapshots
        .slice()
        .sort((a, b) => (b.metrics?.momentum1m || 0) - (a.metrics?.momentum1m || 0));

      sorted.forEach((snap, idx) => {
        const rank = idx / (sorted.length - 1); // 0 = 최강, 1 = 최약
        if (snap.metrics) snap.metrics.crossSectionalRank = Number(rank.toFixed(2));

        // 하위 40% → CROSS_SECTION_WEAK 추가, eligible 무효화
        if (rank > (1 - this.simulationConfig.crossSectionBotPct)) {
          if (!snap.reasons.includes("CROSS_SECTION_WEAK")) {
            snap.reasons.push("CROSS_SECTION_WEAK");
          }
          snap.eligible = false;
        }
      });
    }

    this.state.lastAnalysisSnapshots = snapshots;

    this.advanceSimulation(now);

    const sim = this.state.simulation;
    const restState = this.getGlobalOpenRestState(now);
    const eligibleSnapshots = snapshots.filter((item) => item.eligible);
    const stableBest = this.chooseStableCandidate(eligibleSnapshots);

    // v4: 서킷브레이커 체크
    const circuitBreaker = this.checkCircuitBreakers(now);

    let recommendation = null;

    if (sim.activePosition) {
      const positionContext = this.ensureContext(sim.activePosition.marketCode);
      const currentPrice = this.getCurrentPrice(positionContext);
      const feeView = sim.currentPositionFeeView;

      recommendation = {
        status: "HOLDING",
        market: sim.activePosition.marketCode,
        koreanName: sim.activePosition.koreanName,
        englishName: sim.activePosition.englishName,
        score: Number(sim.activePosition.score || 0),
        smoothedScore: Number(sim.activePosition.score || 0),
        bullishProbability: Number(sim.activePosition.bullishProbability || 0),
        currentPrice,
        reasonCode: "POSITION_ALREADY_RUNNING",
        reasonText: "기존 포지션과 예약매도를 관리중",
        detailText: `${sim.activePosition.marketCode} 보유중 · 목표가 ${Number(sim.activePosition.targetSellPrice).toLocaleString("ko-KR")} · 손절 ${((sim.activePosition.dynamicStopRate || this.simulationConfig.stopLossRate) * 100).toFixed(2)}%`,
        candidateCount: snapshots.length,
        updatedAt: now,
        metrics: {
          quantity: sim.activePosition.quantity,
          averageBuyPrice: sim.activePosition.averageBuyPrice,
          targetSellPrice: sim.activePosition.targetSellPrice,
          dynamicStopRate: sim.activePosition.dynamicStopRate,
          feeView,
        },
      };
    } else if (circuitBreaker.halt) {
      // v4: 서킷브레이커 우선
      recommendation = this.createWaitingRecommendation(circuitBreaker.reason);
      recommendation.candidateCount = snapshots.length;
      recommendation.updatedAt = now;
    } else if (restState.active) {
      recommendation = this.createWaitingRecommendation("GLOBAL_OPEN_REST", restState.label);
      recommendation.candidateCount = snapshots.length;
      recommendation.updatedAt = now;
    } else if (sim.pauseUntil > now && sim.pauseReasonCode) {
      const remainSec = Math.max(0, Math.ceil((sim.pauseUntil - now) / 1000));
      recommendation = this.createWaitingRecommendation(sim.pauseReasonCode, `잔여 ${remainSec}초`);
      recommendation.candidateCount = snapshots.length;
      recommendation.updatedAt = now;
    } else if (stableBest) {
      this.openMarketPosition(now, stableBest);
      const active = this.state.simulation.activePosition;

      recommendation = {
        status: active ? "HOLDING" : "BUY_READY",
        market: stableBest.market,
        koreanName: stableBest.koreanName,
        englishName: stableBest.englishName,
        score: stableBest.rawScore,
        smoothedScore: stableBest.smoothedScore,
        bullishProbability: stableBest.bullishProbability,
        currentPrice: stableBest.currentPrice,
        reasonCode: null,
        reasonText: active ? "시장가 진입 후 예약매도 관리 시작" : "진입 가능",
        detailText: active
          ? `${stableBest.market} 시장가 진입 · 목표 +${((active.targetGrossRate || 0) * 100).toFixed(2)}% · 손절 ${((active.dynamicStopRate || 0) * 100).toFixed(2)}%`
          : `${stableBest.market} 최종 추천 · EV ${(stableBest.ev * 10000).toFixed(1)}bp`,
        candidateCount: snapshots.length,
        updatedAt: now,
        metrics: stableBest.metrics,
      };
    } else {
      const reasonCountMap = new Map();
      for (const snapshot of snapshots) {
        for (const reason of snapshot.reasons) {
          reasonCountMap.set(reason, (reasonCountMap.get(reason) || 0) + 1);
        }
      }
      const dominantReason =
        Array.from(reasonCountMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ||
        "CANDIDATE_NOT_READY";

      recommendation = this.createWaitingRecommendation(dominantReason);
      recommendation.candidateCount = snapshots.length;
      recommendation.updatedAt = now;
    }

    this.state.recommendation = recommendation;
    this.state.simulation.lastUpdatedAt = now;
    this.refreshCurrentPositionFeeView(now);
  }

  getRecommendationPayload() {
    return {
      ...this.state.recommendation,
      waitReasonCatalog: this.waitReasonCatalog,
      topCandidates: this.state.lastAnalysisSnapshots
        .slice(0, 6)
        .map((item) => ({
          market: item.market,
          koreanName: item.koreanName,
          score: item.rawScore,
          smoothedScore: item.smoothedScore,
          bullishProbability: item.bullishProbability,
          eligible: item.eligible,
          reasons: item.reasons,
          ev: item.ev,
          marketCapUsd: item.metrics.marketCapUsd,
          passStreak: item.metrics.passStreak,
        })),
    };
  }

  getSimulationSummary() {
    const sim = this.state.simulation;
    const totalAsset = this.getSimulationTotalAsset();
    const cumulativeReturn =
      sim.initialCapital > 0
        ? (totalAsset - sim.initialCapital) / sim.initialCapital
        : 0;

    return {
      solutionName: this.solutionName,
      version: "v4",
      initialCapital: sim.initialCapital,
      cash: sim.cash,
      totalAsset,
      realizedPnl: sim.realizedPnl,
      totalFees: sim.totalFees,
      totalTrades: sim.totalTrades,
      wins: sim.wins,
      losses: sim.losses,
      winRate: sim.totalTrades > 0 ? sim.wins / sim.totalTrades : 0,
      cumulativeReturn,
      activePosition: sim.activePosition
        ? {
            marketCode: sim.activePosition.marketCode,
            koreanName: sim.activePosition.koreanName,
            status: sim.activePosition.status,
            quantity: sim.activePosition.quantity,
            averageBuyPrice: sim.activePosition.averageBuyPrice,
            entryPrice: sim.activePosition.entryPrice,
            totalSpentCash: sim.activePosition.totalSpentCash,
            targetSellPrice: sim.activePosition.targetSellPrice,
            targetGrossRate: sim.activePosition.targetGrossRate,
            dynamicStopRate: sim.activePosition.dynamicStopRate,
            buyFee: sim.activePosition.buyFee,
            ev: sim.activePosition.ev,
          }
        : null,
      currentPositionFeeView: sim.currentPositionFeeView,
      pauseUntil: sim.pauseUntil,
      pauseReasonCode: sim.pauseReasonCode,
      pauseReasonText: sim.pauseReasonCode
        ? this.resolveWaitReason(sim.pauseReasonCode).text
        : "",
      lastActionText: sim.lastActionText,
      lastUpdatedAt: sim.lastUpdatedAt,
      // v4: 일일 서킷브레이커 상태
      daily: { ...sim.daily },
      // v9: 샤프 비율
      sharpeRatio: this.computeSharpe(sim.tradeReturns || []),
      tradeCount: (sim.tradeReturns || []).length,
    };
  }

  getSimulationHistory(limit = 100) {
    return this.state.simulation.history.slice(0, limit);
  }

  async getDashboardPayload(marketCode) {
    const context = await this.ensureDashboardContext(marketCode);

    return {
      ok: true,
      now: Date.now(),
      solutionName: this.solutionName,
      version: "v4",
      viewedMarket: context.marketCode,
      summary: this.getSummary(context),
      candles: {
        "5s": this.get5sCandles(context),
        "30m": this.get30mCandles(context),
        "1d": this.get1dCandles(context),
      },
      orderbook: this.getOrderbook(context),
      trades: this.getRecentTrades(context, 24),
      markets: this.getMarketList(30),
      recommendation: this.getRecommendationPayload(),
      simulation: this.getSimulationSummary(),
      history: this.getSimulationHistory(40),
      fx: this.state.fxUsd,
      stats: this.state.stats,
      lastErrors: this.state.lastErrors,
    };
  }

  getRawState() {
    return {
      ready: this.state.ready,
      startedAt: this.state.startedAt,
      solutionName: this.solutionName,
      version: "v4",
      fxUsd: this.state.fxUsd,
      marketListCount: this.state.marketList.length,
      marketCapCount: this.state.marketCapMap.size,
      contextsCount: this.state.contexts.size,
      analysisMarketCodes: this.state.analysisMarketCodes,
      leaderState: this.state.leaderState,
      recommendation: this.state.recommendation,
      simulation: this.getSimulationSummary(),
      lastAnalysisSnapshots: this.state.lastAnalysisSnapshots.slice(0, 10),
      stats: this.state.stats,
      lastErrors: this.state.lastErrors,
      historyFilePath: this.historyFilePath,
    };
  }
}

module.exports = { MarketDataService };
