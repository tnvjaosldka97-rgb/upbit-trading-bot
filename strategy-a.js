"use strict";

/**
 * Strategy A v3 — 1h Swing Strategy (BTC only)
 *
 * Signal fusion: RSI + MACD + Bollinger Band squeeze
 * Entry: RSI oversold in non-bear regime + volume spike
 * Exit: Kelly-calibrated target profit or trailing stop
 * WebSocket real-time stop-loss (receives price updates)
 *
 * Exports: class StrategyA with evaluate(candles, regime, calibration) method
 */

const { safeFetch } = require("./exchange-adapter");
const CFG = require("./config");
const indicators = require("./lib/indicators");
const mtf = require("./lib/multi-timeframe");
const micro = require("./lib/microstructure");
const sanity = require("./lib/sanity");
const simExec = require("./lib/sim-execution");
const orderFlow = require("./lib/order-flow");

const ORDER_FLOW_ENABLED = process.env.A_ORDER_FLOW_ENABLED !== "false"; // 기본 ON
const UPBIT_API = "https://api.upbit.com";

// Multi-timeframe 통합 — 환경변수로 활성/비활성 제어
const MTF_ENABLED = process.env.A_MTF_ENABLED === "true";
const MTF_CACHE_MS = 5 * 60_000; // 5분 캐시 (4h 캔들 변동 거의 없으므로 충분)

// Microstructure entry guard
const MICRO_GATE_ENABLED = process.env.A_MICRO_GATE_ENABLED === "true";
const MICRO_MAX_SLIPPAGE_PCT = Number(process.env.A_MICRO_MAX_SLIPPAGE_PCT || 0.30); // 0.3%
const MICRO_MIN_LIQUIDITY = process.env.A_MICRO_MIN_LIQUIDITY || "MEDIUM";
const MICRO_BLOCK_SELL_PRESSURE = process.env.A_MICRO_BLOCK_SELL_PRESSURE !== "false"; // 기본 ON

const MARKET         = CFG.A_MARKET;
const RSI_OVERSOLD   = CFG.A_RSI_OVERSOLD;
const RSI_OVERBOUGHT = CFG.A_RSI_OVERBOUGHT;
const ENTRY_THRESHOLD = CFG.A_ENTRY_THRESHOLD;
const DEFAULT_TARGET = CFG.A_DEFAULT_TARGET;
const DEFAULT_STOP   = CFG.A_DEFAULT_STOP;
const PARTIAL_RATE   = CFG.A_PARTIAL_RATE;
const ATR_TRAIL_MULT = CFG.A_ATR_TRAIL_MULT;
const MAX_HOLD_MS    = CFG.A_MAX_HOLD_MS;
const COOLDOWN_MS    = CFG.A_COOLDOWN_MS;

// Multi-factor scoring config
const MACRO_WEIGHT       = CFG.A_MACRO_WEIGHT;
const DATA_WEIGHT        = CFG.A_DATA_WEIGHT;
const TAPE_WEIGHT        = CFG.A_TAPE_WEIGHT;
const HARD_BLOCK_KIMCHI  = CFG.A_HARD_BLOCK_KIMCHI;
const HARD_BLOCK_FUNDING = CFG.A_HARD_BLOCK_FUNDING;
const HARD_BLOCK_GREED   = CFG.A_HARD_BLOCK_GREED;
const MIN_CONFLUENCE     = CFG.A_MIN_CONFLUENCE;
const EV_GATE            = CFG.A_EV_GATE;

class StrategyA {
  constructor(options = {}) {
    this.orderService  = options.orderService  || null;
    this.regimeEngine  = options.regimeEngine  || null;
    this.calibEngine   = options.calibEngine   || null;
    this.macroEngine   = options.macroEngine   || null;
    this.dataAggEngine = options.dataAggEngine || null;
    this.alphaEngine   = options.alphaEngine   || null;
    this.tradeLogger   = options.tradeLogger   || null;
    this.riskManager   = options.riskManager   || null;
    this.rotation      = options.rotation      || null;
    this.dryRun        = options.dryRun ?? true;
    this.initialCapital = options.initialCapital || 100_000;

    // Simulation state
    this.sim = {
      cash:         this.initialCapital,
      position:     null,
      realizedPnl:  0,
      totalTrades:  0,
      wins: 0, losses: 0,
      history:      [],
      tradeReturns: [],
    };

    this.livePosition   = null;
    this._enteringLock  = false;
    this._lastLossAt    = 0;
    this._intervalId    = null;

    // WebSocket real-time price
    this._wsPrice       = null;
    this._wsActive      = false;
    this._stoppingLive  = false;
  }

  // ─── Lifecycle ──────────────────────────────────────

  start(intervalMs = 5 * 60_000) {
    this._tick();
    this._intervalId = setInterval(() => this._tick(), intervalMs);
    console.log(`[StrategyA] started -- 1h candles, market: ${MARKET}, evaluate every ${intervalMs / 60_000}min`);
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  // ─── WebSocket Integration ──────────────────────────

  /**
   * Receive real-time price updates for stop-loss monitoring.
   * Call from trading-bot.js when ws price arrives for KRW-BTC.
   */
  onPriceUpdate(price) {
    this._wsPrice  = price;
    this._wsActive = true;
    this._checkRealTimeExit(price);
  }

  // ─── Core Evaluate Method ───────────────────────────

  /**
   * evaluate(candles, regime, calibration)
   *
   * @param {Array} candles - 1h candles with { open, high, low, close, volume }
   * @param {{ regime: string, confidence: number }} regime - from RegimeEngine
   * @param {{ suggestedPositionPct: number, expectedValue: number }} calibration - from CalibrationEngine
   * @returns {{ action: string, reason: string, confidence: number, stopLoss: number, takeProfit: number } | null}
   */
  evaluate(candles, regime, calibration, externalSignals = {}) {
    if (!candles || candles.length < 50) {
      return { action: "HOLD", reason: "insufficient data", confidence: 0 };
    }

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const price   = closes[closes.length - 1];

    // ── SELL check (existing position) ────────────────
    if (this.sim.position) {
      return this._evaluateExit(price, regime);
    }

    // ── Cooldown check ────────────────────────────────
    if (Date.now() - this._lastLossAt < COOLDOWN_MS) {
      return { action: "HOLD", reason: "loss cooldown active", confidence: 0 };
    }

    // ── BEAR regime hard block ────────────────────────
    const regimeStr = regime?.regime || "RANGE";
    if (regimeStr === "BEAR_STRONG") {
      return { action: "HOLD", reason: "BEAR_STRONG regime block", confidence: 0 };
    }

    // ═══════════════════════════════════════════════════
    //  HARD FILTERS — 구조적 위험 시 무조건 차단
    // ═══════════════════════════════════════════════════
    const macro = externalSignals.macro || null;
    const data  = externalSignals.data  || null;
    const tape  = externalSignals.tape  || null;

    if (macro) {
      if (macro.kimchiPremium !== null && macro.kimchiPremium > HARD_BLOCK_KIMCHI) {
        return { action: "HOLD", reason: `BLOCKED: kimchi ${(macro.kimchiPremium * 100).toFixed(1)}% > ${HARD_BLOCK_KIMCHI * 100}%`, confidence: 0 };
      }
      if (macro.fundingRate !== null && macro.fundingRate > HARD_BLOCK_FUNDING) {
        return { action: "HOLD", reason: `BLOCKED: funding ${(macro.fundingRate * 10000).toFixed(1)}bps crowded long`, confidence: 0 };
      }
      if (macro.fearGreedValue !== null && macro.fearGreedValue > HARD_BLOCK_GREED) {
        return { action: "HOLD", reason: `BLOCKED: extreme greed ${macro.fearGreedValue}`, confidence: 0 };
      }
    }

    // EV Gate — 캘리브레이션 EV가 마이너스면 거래 안 함
    if (calibration?.sufficient && calibration.expectedValue <= EV_GATE) {
      return { action: "HOLD", reason: `BLOCKED: EV ${(calibration.expectedValue * 100).toFixed(3)}% too low`, confidence: 0 };
    }

    // ═══════════════════════════════════════════════════
    //  CATEGORY 1: TA (기술지표) — max ~88 points
    // ═══════════════════════════════════════════════════
    let taScore = 0;
    const reasons = [];

    // 1) RSI14
    const rsi = this._rsi(closes, 14);
    if (rsi < RSI_OVERSOLD) {
      taScore += 15;
      reasons.push(`RSI_OVERSOLD(${rsi.toFixed(0)})`);
    } else if (rsi > RSI_OVERBOUGHT) {
      taScore -= 10;
      reasons.push(`RSI_OVERBOUGHT(${rsi.toFixed(0)})`);
    } else if (rsi >= 42 && rsi <= 58) {
      taScore += 5;
      reasons.push(`RSI_NEUTRAL(${rsi.toFixed(0)})`);
    }

    // 2) MACD(12, 26, 9)
    const macd = this._macd(closes);
    if (macd) {
      if (macd.histogram > 0 && macd.histogram > macd.prevHistogram) {
        taScore += 12;
        reasons.push("MACD_BULLISH_MOMENTUM");
      } else if (macd.histogram <= 0) {
        taScore -= 5;
        reasons.push("MACD_NEGATIVE");
      }
    }

    // 3) Bollinger Band squeeze
    const bb = this._bollingerBands(closes, 20, 2);
    if (bb) {
      const bbWidth = (bb.upper - bb.lower) / bb.middle;
      if (bbWidth < 0.02 && price > bb.middle) {
        taScore += 10;
        reasons.push("BB_SQUEEZE_BREAKOUT");
      } else if (bbWidth < 0.02) {
        taScore += 5;
        reasons.push("BB_SQUEEZE");
      }
      if (price < bb.lower) {
        taScore += 8;
        reasons.push("BB_OVERSOLD");
      }
    }

    // 4) Volume spike
    const recentVol = this._mean(volumes.slice(-3));
    const baseVol   = this._mean(volumes.slice(-23, -3));
    if (baseVol > 0 && recentVol > baseVol * 1.5) {
      taScore += 8;
      reasons.push("VOLUME_SPIKE");
    }

    // 5) Golden cross (MA8 > MA21)
    const ma8  = this._sma(closes, 8);
    const ma21 = this._sma(closes, 21);
    if (ma8 && ma21 && ma8 > ma21) {
      taScore += 10;
      reasons.push("GOLDEN_CROSS");
    }

    // 6) EMA200 position
    const ema200 = this._ema(closes, 200);
    if (ema200 && price > ema200) {
      taScore += 8;
      reasons.push("ABOVE_EMA200");
    } else if (ema200) {
      taScore -= 15;
      reasons.push("BELOW_EMA200");
    }

    // 7) Regime contribution
    const regimeScore = this._regimeScore(regimeStr);
    taScore += regimeScore;
    if (regimeScore > 0) reasons.push(`REGIME_${regimeStr}`);

    // ═══════════════════════════════════════════════════
    //  CATEGORY 2: MACRO (구조적 알파) — max ~30 points
    // ═══════════════════════════════════════════════════
    let macroScore = 0;
    if (macro) {
      macroScore = Math.round(macro.macroScore * MACRO_WEIGHT * 10) / 10;
      if (macroScore > 0) reasons.push(`MACRO_BULLISH(${macroScore.toFixed(0)})`);
      else if (macroScore < -3) reasons.push(`MACRO_BEARISH(${macroScore.toFixed(0)})`);
    }

    // ═══════════════════════════════════════════════════
    //  CATEGORY 3: DATA (파생상품/온체인) — max ~25 points
    // ═══════════════════════════════════════════════════
    let dataScore = 0;
    if (data) {
      dataScore = Math.round(data.dataScore * DATA_WEIGHT * 10) / 10;
      if (dataScore > 0) reasons.push(`DATA_BULLISH(${dataScore.toFixed(0)})`);
      else if (dataScore < -3) reasons.push(`DATA_BEARISH(${dataScore.toFixed(0)})`);
    }

    // ═══════════════════════════════════════════════════
    //  CATEGORY 4: TAPE (체결 미시구조) — max ~16 points
    // ═══════════════════════════════════════════════════
    let tapeScore = 0;
    if (tape) {
      switch (tape.signal) {
        case "STRONG_BUY": tapeScore = 12; break;
        case "BUY":        tapeScore = 8;  break;
        case "NEUTRAL":    tapeScore = 0;  break;
        case "AVOID":      tapeScore = -10; break;
      }
      if (tape.largeTradeRatio > 0.3) tapeScore += 4;
      tapeScore = Math.round(tapeScore * TAPE_WEIGHT * 10) / 10;
      if (tapeScore > 0) reasons.push(`TAPE_${tape.signal}(${tapeScore.toFixed(0)})`);
      else if (tapeScore < 0) reasons.push(`TAPE_AVOID(${tapeScore.toFixed(0)})`);
    }

    // ═══════════════════════════════════════════════════
    //  CATEGORY 6: ORDER FLOW TOXICITY (큰 손 vs 개미) — max ±15
    // ═══════════════════════════════════════════════════
    let flowScore = 0;
    if (externalSignals.flow) {
      flowScore = externalSignals.flow.scoreContribution || 0;
      if (flowScore !== 0) {
        reasons.push(`FLOW_${externalSignals.flow.signal}(${flowScore})`);
      }
    }

    // ═══════════════════════════════════════════════════
    //  CATEGORY 5: MULTI-TIMEFRAME (4h+1h+15m+5m 정합) — max ±25
    // ═══════════════════════════════════════════════════
    let mtfScore = 0;
    if (externalSignals.mtf) {
      mtfScore = mtf.toScoreContribution(externalSignals.mtf);
      if (mtfScore > 10) reasons.push(`MTF_STRONG_${externalSignals.mtf.direction}(${mtfScore})`);
      else if (mtfScore > 0) reasons.push(`MTF_${externalSignals.mtf.direction}(${mtfScore})`);
      else if (mtfScore < -10) reasons.push(`MTF_BEAR_BLOCK(${mtfScore})`);
      else if (mtfScore < 0) reasons.push(`MTF_WEAK_BEAR(${mtfScore})`);
    }

    // ═══════════════════════════════════════════════════
    //  CONFLUENCE GATE + FINAL DECISION
    // ═══════════════════════════════════════════════════
    const score = taScore + macroScore + dataScore + tapeScore + mtfScore + flowScore;

    let confluence = 0;
    if (taScore > 0) confluence++;
    if (macroScore > 0) confluence++;
    if (dataScore > 0) confluence++;
    if (tapeScore > 0) confluence++;
    if (mtfScore > 0) confluence++;
    if (flowScore > 0) confluence++;

    const confidence = Math.min(Math.max(score / 120, 0), 1);

    // Kelly-calibrated targets
    const atr = this._atr(highs, lows, closes, 14);
    const atrPct = price > 0 ? atr / price : 0;
    const calPct = calibration?.suggestedPositionPct || 0.05;

    const targetRate = atrPct > 0
      ? Math.max(DEFAULT_TARGET, atrPct * 2.5 * (1 + calPct))
      : DEFAULT_TARGET;
    const stopRate = atrPct > 0
      ? Math.min(DEFAULT_STOP, -(atrPct * 1.2))
      : DEFAULT_STOP;

    const takeProfit = Math.round(price * (1 + targetRate));
    const stopLoss   = Math.round(price * (1 + stopRate));

    if (score >= ENTRY_THRESHOLD && confluence >= MIN_CONFLUENCE) {
      console.log(
        `[StrategyA] BUY signal -- ${MARKET} score:${score} ` +
        `confluence:${confluence}/6 ` +
        `[TA:${taScore} MACRO:${macroScore} DATA:${dataScore} TAPE:${tapeScore} MTF:${mtfScore} FLOW:${flowScore}] ` +
        `[${reasons.join(",")}]`
      );
      return {
        action: "BUY",
        reason: reasons.join(", "),
        confidence,
        stopLoss,
        takeProfit,
        score,
        _meta: { rsi, atr, atrPct, targetRate, stopRate, calPct, taScore, macroScore, dataScore, tapeScore, mtfScore, confluence },
      };
    }

    const holdReason = score < ENTRY_THRESHOLD
      ? `score ${score} < threshold ${ENTRY_THRESHOLD}`
      : `confluence ${confluence}/${MIN_CONFLUENCE} insufficient`;

    return {
      action: "HOLD",
      reason: holdReason,
      confidence,
      stopLoss,
      takeProfit,
      score,
    };
  }

  // ─── Exit Evaluation ────────────────────────────────

  _evaluateExit(price, regime) {
    const pos = this.sim.position;
    if (!pos) return { action: "HOLD", reason: "no position", confidence: 0 };

    const move = (price - pos.entryPrice) / pos.entryPrice;
    const holdTime = Date.now() - pos.openedAt;

    // Regime shift: BULL -> BEAR_STRONG = immediate exit
    const regimeStr = regime?.regime || "RANGE";
    if (pos.regime && (pos.regime.startsWith("BULL")) && regimeStr === "BEAR_STRONG") {
      return {
        action: "SELL",
        reason: "regime shift to BEAR_STRONG",
        confidence: 0.9,
        stopLoss: 0,
        takeProfit: 0,
      };
    }

    // Target hit
    if (price >= pos.targetPrice) {
      return {
        action: "SELL",
        reason: `target hit +${(move * 100).toFixed(2)}%`,
        confidence: 1.0,
        stopLoss: 0,
        takeProfit: 0,
      };
    }

    // Stop hit
    if (price <= pos.stopPrice) {
      return {
        action: "SELL",
        reason: `stop loss ${(move * 100).toFixed(2)}%`,
        confidence: 1.0,
        stopLoss: 0,
        takeProfit: 0,
      };
    }

    // Time stop
    if (holdTime > MAX_HOLD_MS) {
      return {
        action: "SELL",
        reason: `time stop (${(holdTime / 3_600_000).toFixed(1)}h)`,
        confidence: 0.7,
        stopLoss: 0,
        takeProfit: 0,
      };
    }

    return { action: "HOLD", reason: "position active", confidence: 0 };
  }

  // ─── Real-time WebSocket Exit Check ─────────────────

  _checkRealTimeExit(price) {
    if (!this.sim.position) return;
    const pos = this.sim.position;

    // Update peak
    if (price > pos.peakPrice) pos.peakPrice = price;
    const move = (price - pos.entryPrice) / pos.entryPrice;

    // Partial take-profit at +2%
    if (!pos.partialDone && move >= PARTIAL_RATE) {
      const halfBudget = pos.budget * 0.5;
      const halfPnl    = halfBudget * move;
      this.sim.cash        += halfBudget + halfPnl;
      this.sim.realizedPnl += halfPnl;
      pos.budget      *= 0.5;
      pos.quantity    *= 0.5;
      pos.partialDone  = true;
      pos.stopPrice    = pos.entryPrice * 1.001; // move stop to breakeven
      pos.trailActive  = true;
      console.log(`[StrategyA] partial TP +${(move * 100).toFixed(2)}% -- 50% sold, stop -> breakeven`);
    }

    // ATR trailing stop
    if (!pos.trailActive && move >= 0.02) pos.trailActive = true;
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - pos.atrStop);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    // Check exits
    const hitTarget = price >= pos.targetPrice;
    const hitStop   = price <= pos.stopPrice;
    const timeout   = Date.now() - pos.openedAt > MAX_HOLD_MS;

    if (hitTarget || hitStop || timeout) {
      const pnlRate = (price - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      const reason   = hitTarget ? "target" : hitStop ? "stop" : "timeout";
      if (hitStop && pnlRate < 0) this._lastLossAt = Date.now();
      this._closeSimPosition(pos, price, pnlRate, pnlKrw, reason);
    }

    // Live position stop
    if (this.livePosition && !this._stoppingLive && price <= this.livePosition.stopPrice) {
      this._stoppingLive = true;
      this._executeLiveStop(this.livePosition, price)
        .finally(() => { this._stoppingLive = false; });
    }
  }

  // ─── Internal Tick ──────────────────────────────────

  async _tick() {
    try {
      if (Date.now() - this._lastLossAt < COOLDOWN_MS) return;

      // Manage existing position via polling (backup for no-WS)
      if (!this._wsActive && this.sim.position) {
        await this._manageSimPosition();
      }

      // Entry evaluation
      if (!this.sim.position && !this.livePosition && !this._enteringLock) {
        // 1h candle 캐시 — 1시간 안에 같은 봉 fetch 반복 방지
        const now = Date.now();
        const cacheTtlMs = 5 * 60_000; // 5분 캐시 (5분 tick에서 매번 fetch X)
        if (!this._candleCache || (now - this._candleCache.ts) > cacheTtlMs) {
          const candles = await this._fetchCandles(MARKET, 200);
          if (!candles) return;
          this._candleCache = { ts: now, candles };
        }
        const candles = this._candleCache.candles;

        const regime = this.regimeEngine
          ? await this.regimeEngine.detect(MARKET)
          : { regime: "RANGE", confidence: 0 };
        const calibration = this.calibEngine
          ? this.calibEngine.getResult()
          : null;

        // Multi-factor signal gathering
        const macroSignals = this.macroEngine
          ? this.macroEngine.getSignals(MARKET)
          : null;
        const dataSignals = this.dataAggEngine
          ? this.dataAggEngine.getSignals(MARKET)
          : null;
        let tapeSignals = null;
        try {
          if (this.alphaEngine) tapeSignals = await this.alphaEngine.analyzeTape(MARKET);
        } catch {}

        // Order Flow Toxicity (1분 캐시)
        let flowResult = null;
        if (ORDER_FLOW_ENABLED) {
          if (!this._flowCache || (now - this._flowCache.ts) > 60_000) {
            try {
              flowResult = await orderFlow.analyze(MARKET);
              this._flowCache = { ts: now, result: flowResult };
            } catch (e) {
              console.warn("[StrategyA] order-flow:", e.message);
            }
          } else {
            flowResult = this._flowCache.result;
          }
        }

        // Multi-timeframe 정합 (옵션, 5분 캐시)
        let mtfResult = null;
        if (MTF_ENABLED) {
          if (!this._mtfCache || (now - this._mtfCache.ts) > MTF_CACHE_MS) {
            try {
              mtfResult = await mtf.analyze(MARKET);
              this._mtfCache = { ts: now, result: mtfResult };
            } catch (e) {
              console.warn("[StrategyA] MTF analyze failed:", e.message);
            }
          } else {
            mtfResult = this._mtfCache.result;
          }
        }

        const signal = this.evaluate(candles, regime, calibration, {
          macro: macroSignals,
          data:  dataSignals,
          tape:  tapeSignals,
          mtf:   mtfResult,
          flow:  flowResult,
        });
        if (signal && signal.action === "BUY") {
          // Rotation 게이트 — 전략 비활성 시 차단
          if (this.rotation && !this.rotation.isStrategyActive("A")) {
            console.warn("[StrategyA] BUY blocked — rotation engine deactivated");
            return;
          }

          // Risk Manager 게이트 — 한도 + VaR 검증
          if (this.riskManager) {
            const budgetEstimate = Math.floor(this.initialCapital * 0.6); // Strategy A 자본 한도
            const check = this.riskManager.checkEntry({
              strategy: "A",
              budgetKrw: budgetEstimate,
              currentPositions: { A: this.sim.position },
            });
            if (!check.allowed) {
              console.warn(`[StrategyA] BUY blocked by RiskManager — ${check.reason}`);
              return;
            }
          }

          // Microstructure entry gate — 진입 직전 슬리피지 + 호가창 검증
          if (MICRO_GATE_ENABLED) {
            try {
              const microResult = await micro.analyze(MARKET, { simulatedBudgetKrw: 100_000 });
              const passes = micro.passesEntryGate(microResult, {
                maxSlippagePct: MICRO_MAX_SLIPPAGE_PCT,
                minLiquidity:   MICRO_MIN_LIQUIDITY,
              });
              if (!passes) {
                console.warn(
                  `[StrategyA] BUY blocked by microstructure gate -- ` +
                  `liq:${microResult.liquidityClass} slip:${microResult.buySlippagePct}% ` +
                  `imb:${microResult.bidAskImbalance} signal:${microResult.microSignal}`
                );
                return;
              }
              if (MICRO_BLOCK_SELL_PRESSURE && microResult.microSignal === "SELL_PRESSURE") {
                console.warn(
                  `[StrategyA] BUY blocked by SELL_PRESSURE -- imb:${microResult.bidAskImbalance}`
                );
                return;
              }
            } catch (e) {
              console.warn("[StrategyA] micro gate error:", e.message);
              // 게이트 에러는 진입 차단 X (페일세이프) — 보수적이려면 차단으로 변경 가능
            }
          }
          await this._enter(MARKET, signal, regime, calibration);
        }
      }
    } catch (e) {
      console.error("[StrategyA] tick error:", e.message);
    }
  }

  // ─── Entry Execution ────────────────────────────────

  async _enter(market, signal, regime, calibration) {
    if (this._enteringLock) return;
    this._enteringLock = true;
    try {
      const price = signal._meta?.rsi ? await this._getPrice(market) : signal.takeProfit / (1 + DEFAULT_TARGET);
      if (!price) return;

      const kellyMult = this.regimeEngine?.getKellyMultiplier?.() ?? 1.0;
      const calPct    = calibration?.suggestedPositionPct || 0.05;
      const budget    = Math.floor(this.sim.cash * Math.min(calPct * kellyMult * 10, 0.95));

      if (budget < 5000) {
        console.warn("[StrategyA] insufficient budget");
        return;
      }

      // Sanity check — 봇 뻘짓 방지 마지막 게이트
      const sane = sanity.checkOrder({
        price,
        marketPrice: price,
        quantity: budget / price,
        budgetKrw: budget,
        totalCapital: this.initialCapital,
      });
      if (!sane.ok) {
        console.error(`[StrategyA] BUY blocked by SANITY — ${sane.reason}`);
        return;
      }

      // 시뮬 실행 — 라우팅 + 레이턴시 + 슬리피지 시뮬
      const simResult = await simExec.simulateExecution({
        market,
        side: "BUY",
        requestedQty: budget / price,
        requestedPrice: price,
        exchange: "upbit",
        useOrderbook: true,
      });
      if (simResult.reason === "rejected_simulated") {
        console.warn(`[StrategyA] sim 진입 rejected (${simResult.latencyMs}ms)`);
        return;
      }
      // 시뮬 결과 반영 (실제 평균체결가 + 부분체결)
      const simPrice = simResult.avgPrice || price;
      const simQty   = simResult.executedQty || (budget / price);
      const simBudget = simQty * simPrice;
      console.log(
        `[StrategyA] sim exec — ${market} ${simResult.partial ? "PARTIAL" : "FILLED"} ` +
        `${simQty.toFixed(8)}@${simPrice.toLocaleString()} ` +
        `(slip:${simResult.slippagePct.toFixed(3)}% lat:${simResult.latencyMs}ms)`
      );

      const atr = signal._meta?.atr || price * 0.01;
      const atrStop = atr > 0 ? (atr / price) * ATR_TRAIL_MULT : 0.015;

      this.sim.position = {
        market,
        entryPrice:  simPrice,           // 시뮬 평균체결가 (슬리피지 반영)
        quantity:    simQty,             // 시뮬 실제 체결 수량 (부분체결 반영)
        budget:      simBudget,
        targetPrice: simPrice * (1 + ((signal.takeProfit / price - 1) || DEFAULT_TARGET)),
        stopPrice:   simPrice * (1 + ((signal.stopLoss   / price - 1) || DEFAULT_STOP)),
        atrStop,
        peakPrice:   simPrice,
        trailActive: false,
        partialDone: simResult.partial || false,
        openedAt:    Date.now(),
        entryScore:  signal.score,
        regime:      regime?.regime || "RANGE",
        slippagePct: simResult.slippagePct,
        latencyMs:   simResult.latencyMs,
      };
      this.sim.cash -= simBudget;

      console.log(
        `[StrategyA] ENTERED -- ${market} @${price.toLocaleString()} ` +
        `budget:${budget.toLocaleString()} regime:${regime?.regime} ` +
        `target:${this.sim.position.targetPrice.toLocaleString()} ` +
        `stop:${this.sim.position.stopPrice.toLocaleString()}`
      );

      this.tradeLogger?.logBuy({
        strategy: "A",
        market,
        price,
        quantity: this.sim.position.quantity,
        budget,
        qualityScore: signal.score,
        qualityFlags: signal._meta?.flags || null,
        dryRun: true,
      });

      // Live order execution
      if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
        const krw = await this.orderService.getBalance("KRW").catch(() => 0);
        const liveBudget = Math.min(krw * 0.9, this.initialCapital * 0.6 * kellyMult);
        if (liveBudget >= 5000) {
          const res = await this.orderService.smartLimitBuy(market, Math.floor(liveBudget));
          if (res.filled) {
            const ep = res.avgPrice;
            this.livePosition = {
              market, quantity: res.executedVolume,
              entryPrice: ep, budget: liveBudget,
              targetPrice: ep * (1 + (signal._meta?.targetRate || DEFAULT_TARGET)),
              stopPrice:   ep * (1 + (signal._meta?.stopRate || DEFAULT_STOP)),
              atrStop, peakPrice: ep, trailActive: false,
              openedAt: Date.now(),
            };
            this.tradeLogger?.logBuy({
              strategy: "A",
              market,
              price: ep,
              quantity: res.executedVolume,
              budget: liveBudget,
              qualityScore: signal.score,
              qualityFlags: signal._meta?.flags || null,
              dryRun: false,
            });
            const sell = await this.orderService.limitSell(market, res.executedVolume, this.livePosition.targetPrice);
            this.livePosition.limitSellUuid = sell.uuid;
            this.orderService
              .waitForFillOrMarketSell(sell.uuid, market, res.executedVolume)
              .then(() => this._closeLive("TARGET"))
              .catch(e => console.error("[StrategyA] sell monitor:", e.message));
          }
        }
      }
    } catch (e) {
      console.error("[StrategyA] entry error:", e.message);
    } finally {
      this._enteringLock = false;
    }
  }

  async _executeLiveStop(pos, price) {
    console.warn(
      `[StrategyA] live stop triggered -- ${pos.market} ` +
      `price:${price.toLocaleString()} <= stop:${pos.stopPrice.toLocaleString()}`
    );
    if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
      if (pos.limitSellUuid) {
        await this.orderService.cancelOrder(pos.limitSellUuid).catch(() => {});
      }
      const bal = await this.orderService.getBalance(pos.market.split("-")[1]).catch(() => 0);
      if (bal > 0.00001) {
        await this.orderService.marketSell(pos.market, bal)
          .catch(e => console.error("[StrategyA] stop sell failed:", e.message));
      }
    }
    this._closeLive("STOP", price);
  }

  _closeLive(reason, exitPrice = null) {
    if (!this.livePosition) return;
    const pos = this.livePosition;
    const exit = exitPrice || pos.targetPrice;
    const pnlRate = (exit - pos.entryPrice) / pos.entryPrice;
    const pnlKrw  = pnlRate * pos.budget;

    console.log(
      `[StrategyA] live position closed (${reason}) -- ${pos.market} ` +
      `${pnlRate >= 0 ? "+" : ""}${(pnlRate * 100).toFixed(2)}%`
    );

    this.tradeLogger?.logSell({
      strategy: "A",
      market: pos.market,
      price: exit,
      quantity: pos.quantity,
      budget: pos.budget,
      reason: reason.toLowerCase(),
      pnlRate,
      pnlKrw,
      partial: false,
      trail: pos.trailActive || false,
      dryRun: false,
    });

    this.livePosition = null;
  }

  // ─── Sim Position Management (polling fallback) ─────

  async _manageSimPosition() {
    const pos = this.sim.position;
    if (!pos) return;

    const cur = await this._getPrice(pos.market);
    if (!cur) return;

    if (cur > pos.peakPrice) pos.peakPrice = cur;
    const move = (cur - pos.entryPrice) / pos.entryPrice;

    if (!pos.trailActive && move >= 0.02) pos.trailActive = true;
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - pos.atrStop);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    const hitTarget = cur >= pos.targetPrice;
    const hitStop   = cur <= pos.stopPrice;
    const timeout   = Date.now() - pos.openedAt > MAX_HOLD_MS;

    if (hitTarget || hitStop || timeout) {
      const pnlRate = (cur - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      const reason   = hitTarget ? "target" : hitStop ? "stop" : "timeout";
      if (hitStop && pnlRate < 0) this._lastLossAt = Date.now();
      this._closeSimPosition(pos, cur, pnlRate, pnlKrw, reason);
    }
  }

  _closeSimPosition(pos, exitPrice, pnlRate, pnlKrw, reason) {
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
      `[StrategyA] closed (${reason}) -- ${pos.market} ` +
      `${pnlRate >= 0 ? "+" : ""}${(pnlRate * 100).toFixed(2)}% ` +
      `(${Math.round(pnlKrw).toLocaleString()} KRW)`
    );

    this.tradeLogger?.logSell({
      strategy: "A",
      market: pos.market,
      price: exitPrice,
      quantity: pos.quantity,
      budget: pos.budget,
      reason,
      pnlRate,
      pnlKrw,
      partial: false,
      trail: pos.trailActive || false,
      dryRun: true,
    });

    // Risk Manager 거래 결과 기록
    this.riskManager?.recordTrade({ pnlKrw, isLoss: pnlRate < 0 });

    // Record for CalibrationEngine
    if (this.calibEngine) {
      this.calibEngine.recordTrade({ pnlRate, market: pos.market, reason });
    }
  }

  // ─── Data Fetching ──────────────────────────────────

  async _fetchCandles(market, count) {
    try {
      const res = await safeFetch(
        `${UPBIT_API}/v1/candles/minutes/60?market=${market}&count=${count}`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.reverse().map(c => ({
        time:   new Date(c.candle_date_time_utc).getTime(),
        open:   c.opening_price,
        high:   c.high_price,
        low:    c.low_price,
        close:  c.trade_price,
        volume: c.candle_acc_trade_volume,
      }));
    } catch (e) {
      console.error("[StrategyA] fetch candles error:", e.message);
      return null;
    }
  }

  async _getPrice(market) {
    if (this._wsPrice && market === MARKET) return this._wsPrice;
    try {
      const res  = await safeFetch(`${UPBIT_API}/v1/ticker?markets=${market}`);
      const data = await res.json();
      return data[0]?.trade_price || null;
    } catch (e) { console.warn("[StrategyA] _getPrice:", e.message); return null; }
  }

  // ─── Technical Indicators (delegated to lib/indicators.js) ──

  _sma(arr, n)     { return indicators.sma(arr, n); }
  _ema(arr, n)     { return indicators.ema(arr, n); }
  _emaArr(arr, n)  { return indicators.emaArr(arr, n); }
  _rsi(closes, p)  { return indicators.rsi(closes, p); }
  _macd(closes, fast, slow, sig) { return indicators.macd(closes, fast, slow, sig); }
  _bollingerBands(closes, period, mult) { return indicators.bollingerBands(closes, period, mult); }
  _atr(highs, lows, closes, period) { return indicators.atr(highs, lows, closes, period); }
  _mean(arr)       { return indicators.mean(arr); }

  _regimeScore(regime) {
    switch (regime) {
      case "BULL_STRONG": return 25;
      case "BULL_WEAK":   return 15;
      case "RANGE":       return 0;
      case "BEAR_WEAK":   return -10;
      case "BEAR_STRONG": return -999;
      default:            return 0;
    }
  }

  // ─── Dashboard Summary ──────────────────────────────

  getSummary() {
    const pos  = this.sim.position;
    const init = this.initialCapital;
    const inPos = pos ? pos.budget : 0;
    const total = this.sim.cash + inPos;
    return {
      name: "A -- 1h Swing v3 (BTC)",
      pnlRate:     +((total - init) / init * 100).toFixed(3),
      totalAsset:  Math.round(total),
      realizedPnl: Math.round(this.sim.realizedPnl),
      totalTrades: this.sim.totalTrades,
      wins: this.sim.wins, losses: this.sim.losses,
      winRate: this.sim.totalTrades > 0
        ? +(this.sim.wins / this.sim.totalTrades * 100).toFixed(1) : null,
      position: pos ? {
        market:      pos.market,
        entryPrice:  Math.round(pos.entryPrice),
        targetPrice: Math.round(pos.targetPrice),
        stopPrice:   Math.round(pos.stopPrice),
        peakPrice:   Math.round(pos.peakPrice),
        trailActive: pos.trailActive,
        openedAt:    pos.openedAt,
        entryScore:  pos.entryScore,
        regime:      pos.regime,
      } : null,
      livePosition: this.livePosition ? {
        market:     this.livePosition.market,
        entryPrice: Math.round(this.livePosition.entryPrice),
        stopPrice:  Math.round(this.livePosition.stopPrice),
      } : null,
      history:      this.sim.history.slice(0, 8),
      wsActive:     this._wsActive,
    };
  }
}

module.exports = { StrategyA };
