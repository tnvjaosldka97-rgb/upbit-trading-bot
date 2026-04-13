"use strict";

/**
 * Strategy A — 1시간봉 스윙 트레이딩
 *
 * 엣지: 1h MA8 > MA21 골든크로스 + 일봉 상승추세 + RSI 회복
 * 수수료 0.278% 감안 → 목표 +3.5%, 손절 -1.5%, R/R 2.3:1
 * 손익분기 승률: 1.5/(1.5+3.22) = 31.8% → 달성 가능한 현실적 수치
 *
 * 핵심 원칙:
 * 1) 일봉 상승추세 + 1h 골든크로스 + 거래량 확인 = 3중 확인
 * 2) RSI 35~68 구간만 진입 (과매수/과매도 극단 회피)
 * 3) 공포탐욕 30 미만 = 전면 대기 (하락장 모멘텀 무의미)
 * 4) 동시 1포지션만 (집중)
 */

// 백테스트 2구간 검증: ETH는 불장/하락장 모두 EV 음수 → BTC만 트레이드
const MARKETS      = ["KRW-BTC"];
const TARGET_RATE  = 0.035;              // +3.5% gross
const NET_TARGET   = TARGET_RATE - 0.00139; // 수수료 차감 순이익
const STOP_RATE    = -0.015;             // -1.5%
const MAX_HOLD_MS  = 20 * 60 * 60_000;  // 20시간 타임스탑
const MIN_FG       = 30;                 // 공포탐욕 하한
const TICK_MS      = 5 * 60_000;        // 5분마다 체크

class StrategyA {
  constructor({ orderService, macroEngine, initialCapital, dryRun }) {
    this.orderService    = orderService;
    this.macroEngine     = macroEngine;
    this.dryRun          = dryRun ?? true;
    this.initialCapital  = initialCapital;

    this.sim = {
      cash: initialCapital,
      position: null,
      realizedPnl: 0,
      totalTrades: 0,
      wins: 0, losses: 0,
      history: [],
      tradeReturns: [],
    };

    this.livePosition  = null;
    this.enteringLock  = false;
    this._intervalId   = null;
    this._prevMA       = {};  // market -> { ma8, ma21 }
  }

  start() {
    this._tick();
    this._intervalId = setInterval(() => this._tick(), TICK_MS);
    console.log("[StrategyA] 1h 스윙 시작 — BTC/ETH 모니터링");
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
  }

  // ── 메인 틱 ─────────────────────────────────────────
  async _tick() {
    try {
      const fg = this.macroEngine?.state?.fearGreed?.value ?? 50;
      if (fg < MIN_FG) return;

      // 포지션 관리 우선
      if (this.sim.position)   await this._manageSimPos();
      if (this.livePosition)   await this._manageLivePos();

      // 진입 탐색
      if (!this.sim.position && !this.livePosition && !this.enteringLock) {
        for (const market of MARKETS) {
          const sig = await this._signal(market);
          if (sig) { await this._enter(market, sig); break; }
        }
      }
    } catch (e) {
      console.error("[A] tick 오류:", e.message);
    }
  }

  // ── 신호 생성 ────────────────────────────────────────
  async _signal(market) {
    const candles = await this._fetch1h(market, 65);
    if (!candles || candles.length < 30) return null;

    const closes  = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    const ma8      = this._sma(closes, 8);
    const ma21     = this._sma(closes, 21);
    const ma8p     = this._sma(closes.slice(0, -1), 8);
    const ma21p    = this._sma(closes.slice(0, -1), 21);
    const ma55     = this._sma(closes, 55);  // 일봉 대용 추세 (55h ≈ 2.3일)

    if (!ma8 || !ma21 || !ma8p || !ma21p) return null;

    // 1. 골든크로스: 이전 봉 MA8 < MA21, 현재 봉 MA8 > MA21
    const golden = ma8p < ma21p && ma8 > ma21;
    if (!golden) {
      this._prevMA[market] = { ma8, ma21 };
      return null;
    }

    const price  = closes[closes.length - 1];
    const rsi    = this._rsi(closes, 14);

    // 2. RSI 필터: 35~68 (과매수 아닌 상태에서 크로스)
    if (rsi < 35 || rsi > 68) return null;

    // 3. 거래량 확인: 최근 3봉 > 이전 15봉 평균 × 1.2
    const recentVol = this._avg(volumes.slice(-3));
    const baseVol   = this._avg(volumes.slice(-18, -3));
    if (baseVol > 0 && recentVol < baseVol * 1.2) return null;

    // 4. 장기 추세 (55h MA 위에 있어야 — 하락추세 역행 방지)
    if (ma55 && price < ma55 * 0.995) return null;

    const atr = this._atr(candles.slice(-14));

    console.log(`[A] 🎯 골든크로스 — ${market} RSI:${rsi.toFixed(0)} 가격:${price.toLocaleString()}`);
    return { type: "GOLDEN_CROSS", price, rsi, ma8, ma21, atr };
  }

  // ── 진입 ─────────────────────────────────────────────
  async _enter(market, sig) {
    if (this.enteringLock) return;
    this.enteringLock = true;
    try {
      const price  = sig.price;
      const budget = this.sim.cash * 0.95;

      // 변동성 기반 동적 목표 (ATR × 2.5, 최소 3.5% 보장)
      const dynTarget = sig.atr > 0
        ? Math.max(TARGET_RATE, (sig.atr / price) * 2.5)
        : TARGET_RATE;
      const dynStop = sig.atr > 0
        ? Math.max(STOP_RATE, -((sig.atr / price) * 1.2))
        : STOP_RATE;

      this.sim.position = {
        market,
        entryPrice:  price,
        quantity:    budget / price,
        budget,
        targetPrice: price * (1 + dynTarget),
        stopPrice:   price * (1 + dynStop),
        trailStop:   false,
        openedAt:    Date.now(),
        signal:      sig.type,
        rsiAtEntry:  sig.rsi,
      };
      this.sim.cash -= budget;

      console.log(`[A] 진입 — ${market} @${price.toLocaleString()} 목표:+${(dynTarget*100).toFixed(1)}% 손절:${(dynStop*100).toFixed(1)}%`);

      // 실거래
      if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
        const krw = await this.orderService.getBalance("KRW").catch(() => 0);
        const liveBudget = Math.min(krw * 0.9, this.initialCapital * 0.6);
        if (liveBudget >= 5000) {
          const res = await this.orderService.smartLimitBuy(market, liveBudget);
          if (res.filled) {
            const ep  = res.avgPrice;
            const lp  = {
              market, quantity: res.executedVolume,
              entryPrice: ep, budget: liveBudget,
              targetPrice: ep * (1 + dynTarget),
              stopPrice:   ep * (1 + dynStop),
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

    // 트레일링 스탑: +2%부터 스탑을 수익의 50% 위치로 올림
    if (!pos.trailStop && move >= 0.02) {
      pos.stopPrice = pos.entryPrice * (1 + move * 0.5);
      pos.trailStop = true;
    } else if (pos.trailStop && cur * (1 + move * 0.5) > pos.stopPrice) {
      pos.stopPrice = pos.entryPrice * (1 + move * 0.5);
    }

    const hitTarget = cur >= pos.targetPrice;
    const hitStop   = cur <= pos.stopPrice;

    if (hitTarget || hitStop || timeout) {
      const pnlRate = (cur - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      this._recordSimClose(pos, cur, pnlRate, pnlKrw,
        hitTarget ? "목표" : hitStop ? "손절" : "타임");
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
      pnlRate: +pnlRate.toFixed(4), reason, closedAt: Date.now(),
    });
    this.sim.history = this.sim.history.slice(0, 30);
    this.sim.position = null;
    console.log(`[A] 청산(${reason}) — ${pos.market} ${pnlRate >= 0 ? "+" : ""}${(pnlRate*100).toFixed(2)}% (${Math.round(pnlKrw).toLocaleString()}원)`);
  }

  // ── 실거래 포지션 관리 ───────────────────────────────
  async _manageLivePos() {
    if (!this.livePosition) return;
    const pos = this.livePosition;
    const ctx = { market: pos.market };

    // 현재가 조회
    let cur;
    try {
      const res  = await fetch(`https://api.upbit.com/v1/ticker?markets=${pos.market}`);
      const data = await res.json();
      cur = data[0]?.trade_price;
    } catch { return; }
    if (!cur) return;

    if (cur <= pos.stopPrice) {
      console.warn(`[A] 손절 트리거 — ${pos.market} ${cur.toLocaleString()} ≤ ${pos.stopPrice.toLocaleString()}`);
      if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
        if (pos.limitSellUuid) await this.orderService.cancelOrder(pos.limitSellUuid).catch(() => {});
        const bal = await this.orderService.getBalance(pos.market.split("-")[1]).catch(() => 0);
        if (bal > 0.00001) await this.orderService.marketSell(pos.market, bal).catch(e => console.error("[A]", e.message));
      }
      this._closeLive("손절");
    }
  }

  _closeLive(reason) {
    if (!this.livePosition) return;
    console.log(`[A] 실거래 청산(${reason}) — ${this.livePosition.market}`);
    this.livePosition = null;
  }

  // ── 유틸 ─────────────────────────────────────────────
  async _fetch1h(market, count = 55) {
    const url = `https://api.upbit.com/v1/candles/minutes/60?market=${market}&count=${count}`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.reverse().map(c => ({
      time:   new Date(c.candle_date_time_utc).getTime(),
      open:   c.opening_price, high: c.high_price,
      low:    c.low_price,     close: c.trade_price,
      volume: c.candle_acc_trade_volume,
    }));
  }

  _sma(arr, n) {
    if (!arr || arr.length < n) return null;
    return arr.slice(-n).reduce((s, v) => s + v, 0) / n;
  }

  _avg(arr) {
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
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
      Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close))
    );
    return trs.reduce((s, v) => s + v, 0) / trs.length;
  }

  // ── 대시보드용 요약 ──────────────────────────────────
  getSummary() {
    const pos  = this.sim.position;
    const init = this.initialCapital;
    const inPos = pos ? pos.budget : 0;
    const total = this.sim.cash + inPos;
    return {
      name: "A — 1h 스윙",
      pnlRate:     +((total - init) / init * 100).toFixed(3),
      totalAsset:  Math.round(total),
      realizedPnl: Math.round(this.sim.realizedPnl),
      totalTrades: this.sim.totalTrades,
      wins:   this.sim.wins,
      losses: this.sim.losses,
      winRate: this.sim.totalTrades > 0
        ? +(this.sim.wins / this.sim.totalTrades * 100).toFixed(1) : null,
      position: pos ? {
        market:      pos.market,
        entryPrice:  Math.round(pos.entryPrice),
        targetPrice: Math.round(pos.targetPrice),
        stopPrice:   Math.round(pos.stopPrice),
        openedAt:    pos.openedAt,
        trailStop:   pos.trailStop,
      } : null,
      livePosition: this.livePosition,
      history:     this.sim.history.slice(0, 8),
      tradeReturns: this.sim.tradeReturns,
    };
  }
}

module.exports = { StrategyA };
