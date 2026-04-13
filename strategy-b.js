"use strict";

/**
 * Strategy B — 업비트 신규상장 패턴
 *
 * 엣지: 업비트 신규 상장 코인은 첫 1~6시간 내 평균 +50~300% 펌핑
 * 이유: 한국 리테일 FOMO + 업비트 독점 유동성 집중
 *
 * 실행 전략:
 * 1) 업비트 마켓 리스트 폴링 → 신규 KRW 마켓 감지 (3분 간격)
 * 2) 감지 즉시 시장가 매수 (속도가 수익)
 * 3) +15% 도달 시 50% 부분청산 + 스탑 브레이크이븐 이동
 * 4) 나머지 50% → +30% 또는 4시간 타임스탑
 *
 * 수수료 감안 R/R:
 * 부분청산 시나리오: 0.5×15% + 0.5×30% - 0.278% = 22% 기대수익
 * 손절 시나리오: -8% - 0.278% = -8.28%
 * 승률 27%만 돼도 EV 양수
 */

const SCAN_INTERVAL_MS   = 3 * 60_000;   // 3분 간격 마켓 스캔
const MANAGE_INTERVAL_MS = 20_000;        // 20초마다 포지션 관리
const TARGET_RATE        = 0.30;          // +30% 최종 목표
const PARTIAL_AT         = 0.15;          // +15%에서 50% 청산
const STOP_RATE          = -0.08;         // -8% 손절
const MAX_HOLD_MS        = 4 * 60 * 60_000; // 4시간 타임스탑
const BUDGET_PCT         = 0.40;          // 보유 현금의 40% 투입 (기회가 드물므로 과감하게)

class StrategyB {
  constructor({ orderService, initialCapital, dryRun }) {
    this.orderService   = orderService;
    this.dryRun         = dryRun ?? true;
    this.initialCapital = initialCapital;

    this.knownMarkets = new Set();

    this.sim = {
      cash:        initialCapital,
      positions:   new Map(),   // market -> simPosition
      realizedPnl: 0,
      totalTrades: 0,
      wins: 0, losses: 0,
      history:     [],
      tradeReturns: [],
    };

    this.livePositions = new Map();
    this.detections    = [];  // 감지 이력 (대시보드용)

    this._scanId   = null;
    this._manageId = null;
  }

  // ── 시작/종료 ────────────────────────────────────────
  async start() {
    const markets = await this._fetchMarkets();
    markets.forEach(m => this.knownMarkets.add(m));

    this._scanId   = setInterval(() => this._scan().catch(e => console.error("[B] scan:", e.message)), SCAN_INTERVAL_MS);
    this._manageId = setInterval(() => this._manageAll().catch(e => console.error("[B] manage:", e.message)), MANAGE_INTERVAL_MS);

    console.log(`[StrategyB] 신규상장 스캐너 시작 — ${this.knownMarkets.size}개 마켓 감시 중`);
  }

  stop() {
    if (this._scanId)   clearInterval(this._scanId);
    if (this._manageId) clearInterval(this._manageId);
  }

  // ── 신규상장 스캔 ────────────────────────────────────
  async _scan() {
    const current = await this._fetchMarkets();
    const newKRW  = current.filter(m => m.startsWith("KRW-") && !this.knownMarkets.has(m));

    for (const market of newKRW) {
      console.log(`[B] 🚀 신규상장 감지: ${market}`);
      this.detections.unshift({ market, detectedAt: Date.now(), status: "감지" });
      this.detections = this.detections.slice(0, 20);
      await this._enter(market);
    }

    current.forEach(m => this.knownMarkets.add(m));
  }

  // ── 진입 ─────────────────────────────────────────────
  async _enter(market) {
    // 상장 직후 호가창 안정 대기 (3초)
    await new Promise(r => setTimeout(r, 3000));

    const price = await this._ticker(market);
    if (!price) {
      console.warn(`[B] ${market} 가격 조회 실패`);
      return;
    }

    const budget = this.sim.cash * BUDGET_PCT;
    if (budget < 5000) { console.warn("[B] 예산 부족"); return; }

    const pos = {
      market,
      entryPrice:  price,
      quantity:    budget / price,
      budget,
      targetPrice: price * (1 + TARGET_RATE),
      stopPrice:   price * (1 + STOP_RATE),
      partialDone: false,
      openedAt:    Date.now(),
    };

    this.sim.cash -= budget;
    this.sim.positions.set(market, pos);

    this._updateDetection(market, "진입완료");
    console.log(`[B] 진입 — ${market} @${price.toLocaleString()} 목표:+30% 손절:-8%`);

    // 실거래
    if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
      try {
        const krw = await this.orderService.getBalance("KRW").catch(() => 0);
        const liveBudget = Math.min(krw * BUDGET_PCT, this.initialCapital * 0.4);
        if (liveBudget >= 5000) {
          // 신규상장 = 속도가 생명 → 시장가 매수
          const result = await this.orderService.smartLimitBuy(market, liveBudget);
          if (result.filled) {
            const ep  = result.avgPrice;
            const lp  = {
              market,
              quantity:    result.executedVolume,
              entryPrice:  ep,
              budget:      liveBudget,
              targetPrice: ep * (1 + TARGET_RATE),
              stopPrice:   ep * (1 + STOP_RATE),
              partialDone: false,
              openedAt:    Date.now(),
            };
            const sell = await this.orderService.limitSell(market, result.executedVolume, lp.targetPrice);
            lp.limitSellUuid = sell.uuid;
            this.livePositions.set(market, lp);
            console.log(`[B] 실거래 진입 — ${market} @${ep.toLocaleString()}`);
          }
        }
      } catch (e) {
        console.error("[B] 실거래 진입 실패:", e.message);
      }
    }
  }

  // ── 포지션 관리 ──────────────────────────────────────
  async _manageAll() {
    for (const [market] of this.sim.positions) {
      await this._manageSimPos(market).catch(() => {});
    }
    for (const [market] of this.livePositions) {
      await this._manageLivePos(market).catch(() => {});
    }
  }

  async _manageSimPos(market) {
    const pos = this.sim.positions.get(market);
    if (!pos) return;

    const cur  = await this._ticker(market);
    if (!cur) return;

    const move    = (cur - pos.entryPrice) / pos.entryPrice;
    const timeout = Date.now() - pos.openedAt > MAX_HOLD_MS;

    // 부분청산: +15% → 50% 매도 + 스탑 브레이크이븐
    if (!pos.partialDone && move >= PARTIAL_AT) {
      const half    = pos.budget * 0.5;
      const halfPnl = half * move;
      this.sim.cash        += half + halfPnl;
      this.sim.realizedPnl += halfPnl;
      pos.budget   *= 0.5;
      pos.quantity *= 0.5;
      pos.stopPrice  = pos.entryPrice * 1.001; // 진입가 바로 위로 스탑
      pos.partialDone = true;
      console.log(`[B] 부분청산(+${(move*100).toFixed(0)}%) — ${market} 50% 매도, 스탑→브레이크이븐`);
      this._updateDetection(market, `+${(move*100).toFixed(0)}% 부분청산`);
    }

    const hitTarget = cur >= pos.targetPrice;
    const hitStop   = cur <= pos.stopPrice;

    if (hitTarget || hitStop || timeout) {
      const pnlRate = (cur - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;

      this.sim.cash        += pos.budget * (1 + pnlRate);
      this.sim.realizedPnl += pnlKrw;
      this.sim.totalTrades++;
      if (pnlKrw >= 0) this.sim.wins++; else this.sim.losses++;
      this.sim.tradeReturns.push(pnlRate);
      if (this.sim.tradeReturns.length > 100) this.sim.tradeReturns.shift();

      const reason = hitTarget ? "목표" : hitStop ? "손절" : "타임";
      this.sim.history.unshift({
        market, entryPrice: pos.entryPrice, exitPrice: cur,
        pnlRate: +pnlRate.toFixed(4), reason, closedAt: Date.now(),
        partialDone: pos.partialDone,
      });
      this.sim.history = this.sim.history.slice(0, 30);
      this.sim.positions.delete(market);

      const det = this.detections.find(d => d.market === market);
      if (det) { det.status = `청산(${reason})`; det.finalPnl = +(pnlRate*100).toFixed(1); }

      console.log(`[B] 청산(${reason}) — ${market} ${pnlRate >= 0 ? "+" : ""}${(pnlRate*100).toFixed(1)}%`);
    }
  }

  async _manageLivePos(market) {
    const pos = this.livePositions.get(market);
    if (!pos) return;

    const cur = await this._ticker(market);
    if (!cur) return;

    const move = (cur - pos.entryPrice) / pos.entryPrice;

    // 부분청산: +15%
    if (!pos.partialDone && move >= PARTIAL_AT && !this.dryRun && this.orderService?.getSummary().hasApiKeys) {
      const halfQty = pos.quantity * 0.5;
      await this.orderService.marketSell(market, halfQty).catch(e => console.error("[B]", e.message));
      pos.quantity   *= 0.5;
      pos.stopPrice   = pos.entryPrice * 1.001;
      pos.partialDone = true;
      console.log(`[B] 실거래 부분청산 — ${market} 50%`);
    }

    // 손절
    if (cur <= pos.stopPrice) {
      if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
        if (pos.limitSellUuid) await this.orderService.cancelOrder(pos.limitSellUuid).catch(() => {});
        const bal = await this.orderService.getBalance(market.split("-")[1]).catch(() => 0);
        if (bal > 0.00001) await this.orderService.marketSell(market, bal).catch(e => console.error("[B]", e.message));
      }
      this.livePositions.delete(market);
      console.log(`[B] 실거래 손절 — ${market}`);
    }
  }

  // ── 유틸 ─────────────────────────────────────────────
  async _fetchMarkets() {
    try {
      const res  = await fetch("https://api.upbit.com/v1/market/all?isDetails=false");
      const data = await res.json();
      return Array.isArray(data) ? data.map(m => m.market) : [];
    } catch { return []; }
  }

  async _ticker(market) {
    try {
      const res  = await fetch(`https://api.upbit.com/v1/ticker?markets=${market}`);
      const data = await res.json();
      return data[0]?.trade_price || null;
    } catch { return null; }
  }

  _updateDetection(market, status) {
    const det = this.detections.find(d => d.market === market);
    if (det) det.status = status;
  }

  // ── 대시보드용 요약 ──────────────────────────────────
  getSummary() {
    const init   = this.initialCapital;
    const inPos  = Array.from(this.sim.positions.values()).reduce((s, p) => s + p.budget, 0);
    const total  = this.sim.cash + inPos;
    const posList = Array.from(this.sim.positions.values()).map(p => ({
      market:      p.market,
      entryPrice:  Math.round(p.entryPrice),
      targetPrice: Math.round(p.targetPrice),
      stopPrice:   Math.round(p.stopPrice),
      openedAt:    p.openedAt,
      partialDone: p.partialDone,
    }));

    return {
      name: "B — 신규상장",
      pnlRate:      +((total - init) / init * 100).toFixed(3),
      totalAsset:   Math.round(total),
      realizedPnl:  Math.round(this.sim.realizedPnl),
      totalTrades:  this.sim.totalTrades,
      wins:   this.sim.wins,
      losses: this.sim.losses,
      winRate: this.sim.totalTrades > 0
        ? +(this.sim.wins / this.sim.totalTrades * 100).toFixed(1) : null,
      positions:        posList,
      livePositions:    Array.from(this.livePositions.values()),
      monitoringCount:  this.knownMarkets.size,
      detections:       this.detections.slice(0, 8),
      history:          this.sim.history.slice(0, 8),
      tradeReturns:     this.sim.tradeReturns,
    };
  }
}

module.exports = { StrategyB };
