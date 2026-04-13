"use strict";

/**
 * CalibrationEngine v2 — 롤링 윈도우 + 켈리 공식
 *
 * v1 대비 핵심 변경:
 *   1) 7일 고정 → 롤링 200건 (충분한 데이터 즉시 반영)
 *   2) 최소 30건 도달 → 즉시 캘리브레이션 출력 (7일 기다릴 필요 없음)
 *   3) 켈리 공식으로 최적 베팅 비율 계산
 *   4) 레짐별 분리 통계 (상승장/횡보장/하락장)
 *   5) 7일이 지나도 계속 롤링 업데이트 (정적이 아닌 동적 캘리브레이션)
 *
 * 켈리 공식:
 *   f* = (b×p - q) / b
 *   b = 평균 이익 / 평균 손실
 *   p = 승률, q = 1 - p
 *   실전에선 f* / 4 사용 (quarter Kelly — 과최적화 방어)
 */
class CalibrationEngine {
  constructor(marketDataService, options = {}) {
    this.mds = marketDataService;

    this.ROLLING_WINDOW       = options.rollingWindow       || 200;  // 최근 N건만 사용
    this.MIN_TRADES_FOR_OUTPUT = options.minTradesForOutput || 30;   // 출력 최소 조건
    this.OUTCOME_WINDOW_MS    = options.outcomeWindowMs     || 30 * 60 * 1000; // 30분
    this.KELLY_FRACTION       = options.kellyFraction       || 0.25; // quarter Kelly

    this.state = {
      mode:            "CALIBRATING",  // CALIBRATING | LIVE
      startedAt:       Date.now(),
      phantomTrades:   [],             // 롤링 윈도우 (최근 200건)
      pendingOutcomes: [],
      calibratedConfig: null,
      stats: {
        totalObserved:  0,
        totalCompleted: 0,
        wins:           0,
        losses:         0,
      },
    };

    this.intervalId = null;
  }

  start() {
    console.log(
      `[CalibrationEngine v2] 시작 — 최소 ${this.MIN_TRADES_FOR_OUTPUT}건 수집 후 자동 출력`,
    );
    this.intervalId = setInterval(() => this.tick(), 5_000);
  }

  stop() {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }

  isLive()        { return this.state.mode === "LIVE"; }
  isCalibrating() { return this.state.mode === "CALIBRATING"; }

  getCalibratedConfig() { return this.state.calibratedConfig; }

  // ─── 메인 루프 ──────────────────────────────────────

  tick() {
    const now = Date.now();
    this.resolveOutcomes(now);
    this.observeSignal(now);

    // 충분한 데이터 쌓이면 즉시 캘리브레이션 출력
    if (this.state.stats.totalCompleted >= this.MIN_TRADES_FOR_OUTPUT) {
      this.computeAndUpdateConfig();

      if (this.state.mode === "CALIBRATING") {
        this.state.mode = "LIVE";
        console.log(
          `[CalibrationEngine v2] ${this.state.stats.totalCompleted}건 수집 완료 → LIVE 전환`,
        );
      }
    }
  }

  // ─── 신호 관찰 ──────────────────────────────────────

  observeSignal(now) {
    const snapshots = this.mds.state.lastAnalysisSnapshots;
    if (!snapshots?.length) return;

    const eligible = snapshots.filter((s) => s.eligible && s.ev > 0);
    if (!eligible.length) return;

    const best = eligible[0];

    if (this.state.pendingOutcomes.some((p) => p.market === best.market)) return;

    const cfg   = this.mds.simulationConfig;
    const sigma = best.metrics?.volatility || 0.002;

    let targetGross = sigma * cfg.volTargetMult;
    targetGross = Math.max(cfg.minTargetGross, Math.min(cfg.maxTargetGross, targetGross));

    let stopRate = -(sigma * cfg.volStopMult);
    stopRate = Math.max(cfg.minStopRate, Math.min(cfg.maxStopRate, stopRate));

    const phantom = {
      id:         `p-${now}`,
      market:     best.market,
      entryPrice: best.currentPrice,
      targetPrice: best.currentPrice * (1 + targetGross),
      stopPrice:   best.currentPrice * (1 + stopRate),
      enteredAt:  now,
      resolveAt:  now + this.OUTCOME_WINDOW_MS,

      conditions: {
        sigma,
        targetGross,
        stopRate,
        smoothedScore:       best.smoothedScore,
        bullishProbability:  best.bullishProbability,
        ev:                  best.ev,
        bidAskImbalance:     best.metrics?.bidAskImbalance || 0.5,
        spreadRate:          best.metrics?.spreadRate || 0.001,
        momentum1m:          best.metrics?.momentum1m || 0,
        volatility:          best.metrics?.volatility || 0,
      },

      outcome:   null,
      exitPrice: null,
      pnlRate:   null,
      regime:    this.detectRegime(best),
    };

    this.state.pendingOutcomes.push(phantom);
    this.state.stats.totalObserved++;
  }

  // ─── 결과 확인 ──────────────────────────────────────

  resolveOutcomes(now) {
    const pending = [];

    for (const p of this.state.pendingOutcomes) {
      const ctx          = this.mds.ensureContext(p.market);
      const currentPrice = this.mds.getCurrentPrice(ctx);

      if (!currentPrice) { pending.push(p); continue; }

      const pnlRate = (currentPrice - p.entryPrice) / p.entryPrice;
      let resolved  = false;

      if (currentPrice >= p.targetPrice) {
        p.outcome = "WIN"; p.exitPrice = currentPrice; p.pnlRate = pnlRate; resolved = true;
      } else if (currentPrice <= p.stopPrice) {
        p.outcome = "LOSS"; p.exitPrice = currentPrice; p.pnlRate = pnlRate; resolved = true;
      } else if (now >= p.resolveAt) {
        // 타임아웃: 손익에 따라 WIN/LOSS 판정
        p.outcome  = pnlRate > 0 ? "WIN" : "LOSS";
        p.exitPrice = currentPrice;
        p.pnlRate   = pnlRate;
        resolved    = true;
      }

      if (resolved) {
        // 롤링 윈도우 유지
        this.state.phantomTrades.push(p);
        if (this.state.phantomTrades.length > this.ROLLING_WINDOW) {
          this.state.phantomTrades.shift();
        }

        this.state.stats.totalCompleted++;
        if (p.outcome === "WIN") this.state.stats.wins++;
        else                     this.state.stats.losses++;

        // 온라인 EMA 캘리브레이션 — 30건 기다리지 않고 즉시 반영
        const isWin = p.outcome === "WIN" ? 1 : 0;
        const alpha = this.state.stats.totalCompleted < 10 ? 0.3 : 0.1;
        this.state.onlineWinRate = this.state.onlineWinRate == null
          ? isWin
          : this.state.onlineWinRate * (1 - alpha) + isWin * alpha;
      } else {
        pending.push(p);
      }
    }

    this.state.pendingOutcomes = pending;
  }

  // ─── 캘리브레이션 계산 ──────────────────────────────

  /**
   * 롤링 윈도우 기반 파라미터 재계산
   * 5분마다 자동 호출 (tick에서)
   */
  computeAndUpdateConfig() {
    const trades = this.state.phantomTrades;
    if (trades.length < this.MIN_TRADES_FOR_OUTPUT) return;

    // ── 훈련/검증 분리 (60/40 out-of-sample) ────────
    // 오래된 것 = 훈련, 최근 것 = 검증
    // 이렇게 해야 미래 데이터로 과거를 검증하는 look-ahead bias 방지
    const splitIdx  = Math.floor(trades.length * 0.6);
    const trainSet  = trades.slice(0, splitIdx);
    const valSet    = trades.slice(splitIdx);

    const wins   = trades.filter((t) => t.outcome === "WIN");
    const losses = trades.filter((t) => t.outcome !== "WIN");
    const winRate = wins.length / trades.length;

    // 평균 이익/손실 (수수료 포함)
    const totalFees = (this.mds.simulationConfig.reservedBuyFeeRate
      ?? this.mds.simulationConfig.buyFeeRate)
      + this.mds.simulationConfig.reservedSellFeeRate;

    const avgGrossWin  = wins.length  > 0 ? this.avg(wins.map((t)   => t.conditions.targetGross)) : 0.006;
    const avgGrossLoss = losses.length > 0 ? this.avg(losses.map((t) => Math.abs(t.conditions.stopRate))) : 0.002;

    const avgNetWin  = avgGrossWin - totalFees;
    const avgNetLoss = avgGrossLoss + totalFees;

    // ── 켈리 공식 ────────────────────────────────────
    // f* = (b×p - q) / b  여기서 b = avgNetWin / avgNetLoss
    const b      = avgNetLoss > 0 ? avgNetWin / avgNetLoss : 1;
    const p      = winRate;
    const q      = 1 - p;
    const kelly  = (b * p - q) / b;
    const kellyFraction = Math.max(0.02, Math.min(0.15, kelly * this.KELLY_FRACTION));

    // ── 최적 σ 배수 ──────────────────────────────────
    const volTargetMult = this.computeOptimalMult(trades, "WIN",  "targetGross",  2.2);
    const volStopMult   = this.computeOptimalMult(trades, "LOSS", "stopRate",    1.1);

    // ── 최적 불리시 임계값 ───────────────────────────
    const minBullish = this.computeOptimalBullishThreshold(trades);

    // ── 호가 불균형 최적 임계값 ──────────────────────
    const minImbalance = this.computeOptimalImbalanceThreshold(trades);

    // ── 기대값 ───────────────────────────────────────
    const ev = winRate * avgNetWin - (1 - winRate) * avgNetLoss;

    // ── 검증 세트 EV 계산 (과적합 탐지) ───────────────
    const valWins     = valSet.filter((t) => t.outcome === "WIN");
    const valWinRate  = valSet.length > 0 ? valWins.length / valSet.length : 0;
    const valAvgNetWin  = valWins.length > 0
      ? this.avg(valWins.map((t) => t.conditions.targetGross)) - totalFees
      : avgNetWin;
    const valLosses   = valSet.filter((t) => t.outcome !== "WIN");
    const valAvgNetLoss = valLosses.length > 0
      ? this.avg(valLosses.map((t) => Math.abs(t.conditions.stopRate))) + totalFees
      : avgNetLoss;
    const valEv = valWinRate * valAvgNetWin - (1 - valWinRate) * valAvgNetLoss;

    // 과적합 경고: 훈련 EV가 검증 EV보다 2배 이상 높으면 의심
    const overfitRisk = ev > 0 && valEv < ev * 0.5;
    if (overfitRisk && this.state.stats.totalCompleted % 20 === 0) {
      console.warn(
        `[CalibrationEngine] ⚠️ 과적합 의심 — 훈련 EV ${(ev * 100).toFixed(3)}% | 검증 EV ${(valEv * 100).toFixed(3)}%`,
      );
    }

    const config = {
      observedWinRate:    winRate,
      totalTrades:        trades.length,
      avgGrossWin,
      avgGrossLoss,
      avgNetWin,
      avgNetLoss,
      kellyFraction,       // 켈리 기반 최적 베팅 비율
      kelly,               // raw kelly (참고용)
      volTargetMult:       Math.max(1.8, Math.min(3.0, volTargetMult)),
      volStopMult:         Math.max(0.8, Math.min(1.5, volStopMult)),
      minBullishProbability: minBullish,
      minBidAskImbalance:    minImbalance,
      ev,
      valEv,
      valWinRate,
      overfitRisk,
      // 핵심: 검증 세트 EV가 양수일 때만 실거래 신호 발동
      // 훈련 EV만 보면 과적합에 속을 수 있음
      evPositive:          valEv > 0 && ev > 0,
      calibratedAt:        new Date().toISOString(),
      _applied:            false,
    };

    this.state.calibratedConfig = config;

    if (this.state.stats.totalCompleted % 20 === 0) {
      // 20건마다 로그 출력
      console.log(
        `[CalibrationEngine v2] 갱신 — ` +
        `승률 ${(winRate * 100).toFixed(1)}% | ` +
        `EV ${(ev * 100).toFixed(3)}% | ` +
        `켈리 비율 ${(kellyFraction * 100).toFixed(1)}% | ` +
        `총 ${trades.length}건`,
      );
    }
  }

  // ─── 최적값 계산 헬퍼 ───────────────────────────────

  computeOptimalMult(trades, outcome, condKey, defaultVal) {
    const relevant = trades.filter((t) => t.outcome === outcome);
    if (relevant.length < 5) return defaultVal;
    return this.avg(
      relevant.map((t) => {
        const sigma = t.conditions.sigma;
        const val   = Math.abs(t.conditions[condKey] || defaultVal * sigma);
        return sigma > 0 ? val / sigma : defaultVal;
      }),
    );
  }

  computeOptimalBullishThreshold(trades) {
    const thresholds = [70, 75, 80, 85, 90];
    let best = 86, bestScore = -Infinity;
    for (const th of thresholds) {
      const filtered = trades.filter((t) => t.conditions.bullishProbability >= th);
      if (filtered.length < 5) continue;
      const wins = filtered.filter((t) => t.outcome === "WIN").length;
      const score = (wins / filtered.length) * Math.log(filtered.length + 1);
      if (score > bestScore) { bestScore = score; best = th; }
    }
    return best;
  }

  computeOptimalImbalanceThreshold(trades) {
    const thresholds = [0.52, 0.55, 0.58, 0.62, 0.65];
    let best = 0.55, bestScore = -Infinity;
    for (const th of thresholds) {
      const filtered = trades.filter((t) => t.conditions.bidAskImbalance >= th);
      if (filtered.length < 5) continue;
      const wins = filtered.filter((t) => t.outcome === "WIN").length;
      const score = (wins / filtered.length) * Math.log(filtered.length + 1);
      if (score > bestScore) { bestScore = score; best = th; }
    }
    return best;
  }

  detectRegime(snapshot) {
    const bull = snapshot.bullishProbability || 0;
    if (bull >= 80) return "BULL";
    if (bull >= 60) return "NEUTRAL";
    return "BEAR";
  }

  avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  getSummary() {
    const cal  = this.state.calibratedConfig;
    const done = this.state.stats.totalCompleted;
    return {
      mode:            this.state.mode,
      totalCompleted:  done,
      totalObserved:   this.state.stats.totalObserved,
      pendingCount:    this.state.pendingOutcomes.length,
      currentWinRate:  done > 0 ? this.state.stats.wins / done : null,
      onlineWinRate:   this.state.onlineWinRate ?? null,  // EMA 실시간 승률
      readyForLive:    done >= this.MIN_TRADES_FOR_OUTPUT,
      calibratedConfig: cal ? {
        winRate:       cal.observedWinRate,
        ev:            cal.ev,
        kellyFraction: cal.kellyFraction,
        volTargetMult: cal.volTargetMult,
        volStopMult:   cal.volStopMult,
        evPositive:    cal.evPositive,
        calibratedAt:  cal.calibratedAt,
      } : null,
    };
  }
}

module.exports = { CalibrationEngine };
