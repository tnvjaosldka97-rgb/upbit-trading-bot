"use strict";

/**
 * Strategy B v2 — 업비트 신규상장 패턴
 *
 * 엣지: 업비트 신규 상장 코인은 첫 1~6시간 내 평균 +50~300% 펌핑
 * 이유: 한국 리테일 FOMO + 업비트 독점 유동성 집중
 *
 * v2 핵심 변경:
 * 1) DataEngine 우선 연동 — DataEngine이 1분 간격으로 탐지 → 즉시 반응
 *    (구버전: Strategy B 독자 폴링 3분 → DataEngine 발생 후 최대 3분 대기)
 * 2) 중복 탐지 완전 제거 — knownMarkets/actedListings 분리 관리
 * 3) 상장 대기 시간 3초 → 1초 (속도 우선)
 * 4) 상장 유효 창 12h → 2h (초기 펌핑만 노림)
 *
 * 수수료 감안 R/R:
 * 부분청산 시나리오: 0.5×15% + 0.5×30% - 0.278% = 22% 기대수익
 * 손절 시나리오: -8% - 0.278% = -8.28%
 * 승률 27%만 돼도 EV 양수
 */

const MANAGE_INTERVAL_MS  = 20_000;       // 포지션 관리 주기 (20초)
const SYNC_INTERVAL_MS    = 30_000;       // DataEngine 신규 상장 동기화 주기 (30초)
const TARGET_RATE         = 0.30;         // +30% 초기 목표 (부분청산 전까지)
const PARTIAL_AT          = 0.15;         // +15%에서 50% 청산
const STOP_RATE           = -0.08;        // -8% 손절
const TRAIL_PCT           = 0.15;         // 부분청산 후 트레일링 폭 (최고가 -15%)
const MAX_HOLD_MS         = 4 * 60 * 60_000;  // 4시간 타임스탑
const BUDGET_PCT          = 0.40;         // 보유 현금의 40%
const MAX_LISTING_AGE_MS  = 2 * 60 * 60_000; // 상장 후 2시간 이내만 진입

class StrategyB {
  constructor({ orderService, dataEngine, initialCapital, dryRun }) {
    this.orderService   = orderService;
    this.dataEngine     = dataEngine;   // DataEngine 연동 (선택적)
    this.dryRun         = dryRun ?? true;
    this.initialCapital = initialCapital;

    // 독립 폴링용 (DataEngine 없을 때 폴백)
    this.knownMarkets = new Set();

    // DataEngine 탐지 후 이미 진입한 마켓 추적 (중복 방지)
    this.actedListings = new Set();

    this.sim = {
      cash:        initialCapital,
      positions:   new Map(),
      realizedPnl: 0,
      totalTrades: 0,
      wins: 0, losses: 0,
      history:      [],
      tradeReturns: [],
    };

    this.livePositions = new Map();
    this.detections    = [];

    this._syncId   = null;
    this._manageId = null;

    // WebSocket 실시간 감시
    this._ws       = null;
    this._wsActive = false;

    // 텔레그램 알림
    this._notifier = null;
  }

  // ── 시작/종료 ────────────────────────────────────────
  async start() {
    if (!this.dataEngine) {
      // 독립 폴링 모드 (DataEngine 없을 때)
      const markets = await this._fetchMarkets();
      markets.forEach(m => this.knownMarkets.add(m));
      console.log(`[StrategyB] DataEngine 없음 — 독립 폴링 모드 (${this.knownMarkets.size}개 기존 마켓)`);
    } else {
      // DataEngine 이벤트 직결 — 감지 즉시 반응 (30초 폴링 대기 제거)
      if (this.dataEngine.onNewListing) {
        this.dataEngine.onNewListing((market, listedAt) => {
          if (this.actedListings.has(market)) return;
          const age = (Date.now() - listedAt) / 60_000;
          console.log(`[B] ⚡ 신규상장 즉시 반응: ${market} (${age.toFixed(1)}분 전)`);
          this.actedListings.add(market);
          this.detections.unshift({ market, detectedAt: listedAt, status: "이벤트감지" });
          this.detections = this.detections.slice(0, 20);
          this._notifier?.notifyNewListing(market);
          this._enter(market).catch(e => console.error("[B] 즉시진입 오류:", e.message));
        });
        console.log("[StrategyB] DataEngine 이벤트 직결 — 신규상장 즉시 반응 활성화");
      } else {
        console.log("[StrategyB] DataEngine 연동 모드 — 30초 동기화");
      }
    }

    // 폴백 동기화 (이벤트 놓쳤을 때 보험)
    this._syncId = setInterval(
      () => this._syncListings().catch(e => console.error("[B] sync:", e.message)),
      this.dataEngine ? SYNC_INTERVAL_MS : 60_000
    );

    this._manageId = setInterval(
      () => this._manageAll().catch(e => console.error("[B] manage:", e.message)),
      MANAGE_INTERVAL_MS
    );

    // 크래시 복구 — 재시작 시 기존 포지션 복원 (실거래 모드)
    await this._recoverLivePositions();

    console.log("[StrategyB v2] 신규상장 스캐너 시작");
  }

  stop() {
    if (this._syncId)   clearInterval(this._syncId);
    if (this._manageId) clearInterval(this._manageId);
  }

  /**
   * WebSocket 주입 (trading-bot.js에서 호출)
   * 신규상장 포지션 손절/목표/트레일링을 20초 폴링 → ~100ms 실시간으로 전환
   */
  setWebSocket(ws) {
    this._ws       = ws;
    this._wsActive = true;
    ws.onPrice((market, price) => this._onWsPrice(market, price));
    console.log("[StrategyB] WebSocket 활성화 — 신규상장 포지션 실시간(~100ms) 감시");
  }

  setNotifier(notifier) {
    this._notifier = notifier;
  }

  /**
   * 크래시 복구 — 봇 재시작 시 Upbit 잔고 스캔하여 기존 포지션 복원
   * 실거래 모드에서만 동작
   */
  async _recoverLivePositions() {
    if (this.dryRun || !this.orderService?.getSummary().hasApiKeys) return;
    try {
      const accounts = await this.orderService.getAccounts().catch(() => null);
      if (!accounts) return;

      let recovered = 0;
      for (const acc of accounts) {
        const { currency, balance, avg_buy_price } = acc;
        if (currency === "KRW" || parseFloat(balance) < 0.00001) continue;

        const market     = `KRW-${currency}`;
        if (this.livePositions.has(market)) continue;

        const entryPrice = parseFloat(avg_buy_price) || 0;
        const qty        = parseFloat(balance);
        if (!entryPrice || !qty) continue;

        const lp = {
          market,
          quantity:    qty,
          entryPrice,
          budget:      qty * entryPrice,
          targetPrice: entryPrice * (1 + TARGET_RATE),
          stopPrice:   entryPrice * (1 + STOP_RATE),
          peakPrice:   entryPrice,
          partialDone: false,
          trailActive: false,
          openedAt:    Date.now() - 30 * 60_000,  // 30분 전 추정
        };
        this.livePositions.set(market, lp);
        if (this._ws) this._ws.subscribe(market);
        console.log(
          `[B] 🔄 포지션 복구 — ${market} qty:${qty.toFixed(4)} ` +
          `@${Math.round(entryPrice).toLocaleString()}원`
        );
        recovered++;
      }
      if (recovered > 0) {
        console.log(`[B] 크래시 복구 완료 — ${recovered}개 포지션 복원`);
      }
    } catch (e) {
      console.warn(`[B] 크래시 복구 실패: ${e.message}`);
    }
  }

  /**
   * WebSocket 가격 수신 시 실시간 호출 (~100ms)
   * 손절/부분청산/트레일링/타임스탑 즉시 처리
   */
  _onWsPrice(market, price) {
    const pos = this.sim.positions.get(market);
    if (!pos) return;

    // 최고가 갱신
    if (price > pos.peakPrice) pos.peakPrice = price;
    const move = (price - pos.entryPrice) / pos.entryPrice;

    // ── 부분청산: +15% 달성 시 50% 매도, 트레일링 시작 ──
    if (!pos.partialDone && move >= PARTIAL_AT) {
      const half    = pos.budget * 0.5;
      const halfPnl = half * move;
      this.sim.cash        += half + halfPnl;
      this.sim.realizedPnl += halfPnl;
      pos.budget      *= 0.5;
      pos.quantity    *= 0.5;
      pos.stopPrice    = pos.entryPrice * 1.001;   // 브레이크이븐
      pos.partialDone  = true;
      pos.trailActive  = true;
      pos.peakPrice    = price;
      pos.targetPrice  = Infinity;   // 하드 목표 제거 → 트레일링으로만 청산
      console.log(
        `[B] 부분청산(WS) +${(move * 100).toFixed(1)}% — ${market} ` +
        `50% 매도, 스탑→브레이크이븐, 트레일링 ${TRAIL_PCT * 100}% 시작`
      );
      this._updateDetection(market, `+${(move * 100).toFixed(1)}% 부분청산`);
      this._notifier?.notifyPartial("B", market, move * 100);
    }

    // ── 트레일링 스탑 갱신 ────────────────────────────
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - TRAIL_PCT);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    const hitStop   = price <= pos.stopPrice;
    const hitTarget = !pos.partialDone && price >= pos.targetPrice;
    const timeout   = Date.now() - pos.openedAt > MAX_HOLD_MS;

    if (hitStop || hitTarget || timeout) {
      const pnlRate = (price - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      this.sim.cash        += pos.budget * (1 + pnlRate);
      this.sim.realizedPnl += pnlKrw;
      this.sim.totalTrades++;
      if (pnlKrw >= 0) this.sim.wins++; else this.sim.losses++;
      this.sim.tradeReturns.push(pnlRate);
      if (this.sim.tradeReturns.length > 100) this.sim.tradeReturns.shift();

      const reason = hitTarget ? "목표" : hitStop ? "손절" : "타임";
      this.sim.history.unshift({
        market, entryPrice: pos.entryPrice, exitPrice: price,
        pnlRate: +pnlRate.toFixed(4), reason, closedAt: Date.now(),
        partialDone: pos.partialDone,
      });
      this.sim.history = this.sim.history.slice(0, 30);
      this.sim.positions.delete(market);

      const det = this.detections.find(d => d.market === market);
      if (det) { det.status = `청산(${reason})`; det.finalPnl = +(pnlRate * 100).toFixed(1); }

      this._notifier?.notifyExit("B", market, pnlRate, reason, pos.partialDone);
      console.log(
        `[B] 청산(${reason})(WS) — ${market} ` +
        `${pnlRate >= 0 ? "+" : ""}${(pnlRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── 신규 상장 동기화 ─────────────────────────────────
  async _syncListings() {
    if (this.dataEngine?.state?.newListings) {
      // ── DataEngine 연동 경로 ─────────────────────────
      const now = Date.now();
      for (const [market, listedAt] of this.dataEngine.state.newListings.entries()) {
        if (this.actedListings.has(market)) continue;      // 이미 진입
        if (now - listedAt > MAX_LISTING_AGE_MS) continue; // 너무 오래됨

        this.actedListings.add(market);
        console.log(
          `[B] 🚀 DataEngine 신규상장 감지: ${market} ` +
          `(${((now - listedAt) / 60_000).toFixed(1)}분 전 상장)`
        );
        this.detections.unshift({ market, detectedAt: listedAt, status: "감지" });
        this.detections = this.detections.slice(0, 20);
        await this._enter(market);
      }
    } else {
      // ── 폴백: 독립 폴링 경로 ────────────────────────
      const current = await this._fetchMarkets();
      const newKRW  = current.filter(m => m.startsWith("KRW-") && !this.knownMarkets.has(m));

      for (const market of newKRW) {
        console.log(`[B] 🚀 신규상장 감지(폴링): ${market}`);
        this.detections.unshift({ market, detectedAt: Date.now(), status: "감지" });
        this.detections = this.detections.slice(0, 20);
        await this._enter(market);
      }
      current.forEach(m => this.knownMarkets.add(m));
    }
  }

  // ── 진입 ─────────────────────────────────────────────
  async _enter(market) {
    // 상장 직후 호가창 안정 대기 (1초)
    await new Promise(r => setTimeout(r, 1000));

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
      peakPrice:   price,
      partialDone: false,
      trailActive: false,
      openedAt:    Date.now(),
    };

    this.sim.cash -= budget;
    this.sim.positions.set(market, pos);
    this._updateDetection(market, "진입완료");

    // WebSocket 구독 → 실시간 가격 수신 시작
    if (this._ws) this._ws.subscribe(market);

    // 텔레그램 알림
    this._notifier?.notifyEntry("B", market, price, budget, TARGET_RATE, STOP_RATE);

    console.log(`[B] 진입 — ${market} @${price.toLocaleString()} 목표:+30% 손절:-8% 트레일:${TRAIL_PCT * 100}%`);

    // 실거래
    if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
      try {
        const krw = await this.orderService.getBalance("KRW").catch(() => 0);
        const liveBudget = Math.min(krw * BUDGET_PCT, this.initialCapital * 0.4);
        if (liveBudget >= 5000) {
          const result = await this.orderService.smartLimitBuy(market, liveBudget);
          if (result.filled) {
            const ep = result.avgPrice;
            const lp = {
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

    // WS 활성 시 실시간으로 처리됨 — 폴링은 보험용
    const cur = this._wsActive
      ? (this._ws?.getPrice(market) ?? await this._ticker(market))
      : await this._ticker(market);
    if (!cur) return;

    // 최고가 갱신
    if (cur > pos.peakPrice) pos.peakPrice = cur;
    const move    = (cur - pos.entryPrice) / pos.entryPrice;
    const timeout = Date.now() - pos.openedAt > MAX_HOLD_MS;

    // 부분청산: +15% → 50% 매도, 트레일링 시작
    if (!pos.partialDone && move >= PARTIAL_AT) {
      const half    = pos.budget * 0.5;
      const halfPnl = half * move;
      this.sim.cash        += half + halfPnl;
      this.sim.realizedPnl += halfPnl;
      pos.budget      *= 0.5;
      pos.quantity    *= 0.5;
      pos.stopPrice    = pos.entryPrice * 1.001;
      pos.partialDone  = true;
      pos.trailActive  = true;
      pos.peakPrice    = cur;
      pos.targetPrice  = Infinity;   // 하드 목표 제거 → 트레일링으로만 청산
      console.log(
        `[B] 부분청산(+${(move * 100).toFixed(0)}%) — ${market} ` +
        `50% 매도, 스탑→브레이크이븐, 트레일링 ${TRAIL_PCT * 100}% 시작`
      );
      this._updateDetection(market, `+${(move * 100).toFixed(0)}% 부분청산`);
    }

    // 트레일링 스탑 갱신
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - TRAIL_PCT);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    const hitTarget = !pos.partialDone && cur >= pos.targetPrice;
    const hitStop   = cur <= pos.stopPrice;

    if (hitTarget || hitStop || timeout) {
      const pnlRate = (cur - pos.entryPrice) / pos.entryPrice;
      const pnlKrw  = pnlRate * pos.budget;
      this.sim.cash += pos.budget * (1 + pnlRate);
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
      if (det) { det.status = `청산(${reason})`; det.finalPnl = +(pnlRate * 100).toFixed(1); }

      this._notifier?.notifyExit("B", market, pnlRate, reason, pos.partialDone);
      console.log(`[B] 청산(${reason}) — ${market} ${pnlRate >= 0 ? "+" : ""}${(pnlRate * 100).toFixed(1)}%`);
    }
  }

  async _manageLivePos(market) {
    const pos = this.livePositions.get(market);
    if (!pos) return;

    const cur = this._wsActive
      ? (this._ws?.getPrice(market) ?? await this._ticker(market))
      : await this._ticker(market);
    if (!cur) return;

    if (!pos.peakPrice || cur > pos.peakPrice) pos.peakPrice = cur;
    const move = (cur - pos.entryPrice) / pos.entryPrice;

    if (!pos.partialDone && move >= PARTIAL_AT && !this.dryRun && this.orderService?.getSummary().hasApiKeys) {
      const halfQty = pos.quantity * 0.5;
      await this.orderService.marketSell(market, halfQty).catch(e => console.error("[B]", e.message));
      pos.quantity    *= 0.5;
      pos.stopPrice    = pos.entryPrice * 1.001;
      pos.partialDone  = true;
      pos.trailActive  = true;
      pos.peakPrice    = cur;
      console.log(`[B] 실거래 부분청산 — ${market} 50%, 트레일링 시작`);
    }

    // 트레일링 스탑 갱신
    if (pos.trailActive) {
      const newStop = pos.peakPrice * (1 - TRAIL_PCT);
      if (newStop > pos.stopPrice) pos.stopPrice = newStop;
    }

    if (cur <= pos.stopPrice) {
      if (!this.dryRun && this.orderService?.getSummary().hasApiKeys) {
        if (pos.limitSellUuid) await this.orderService.cancelOrder(pos.limitSellUuid).catch(() => {});
        const bal = await this.orderService.getBalance(market.split("-")[1]).catch(() => 0);
        if (bal > 0.00001) {
          await this.orderService.marketSell(market, bal).catch(e => console.error("[B]", e.message));
        }
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

  // ── 대시보드 요약 ────────────────────────────────────
  getSummary() {
    const init   = this.initialCapital;
    const inPos  = Array.from(this.sim.positions.values()).reduce((s, p) => s + p.budget, 0);
    const total  = this.sim.cash + inPos;

    const positions = Array.from(this.sim.positions.values()).map(p => {
      // WS 실시간 가격으로 미실현 손익 계산
      const curPrice = this._ws?.getPrice(p.market) ?? null;
      const unrealizedPct = curPrice
        ? +((curPrice - p.entryPrice) / p.entryPrice * 100).toFixed(2)
        : null;
      return {
        market:         p.market,
        entryPrice:     Math.round(p.entryPrice),
        targetPrice:    p.targetPrice === Infinity ? null : Math.round(p.targetPrice),
        stopPrice:      Math.round(p.stopPrice),
        peakPrice:      Math.round(p.peakPrice),
        openedAt:       p.openedAt,
        partialDone:    p.partialDone,
        trailActive:    p.trailActive,
        unrealizedPct,
        currentPrice:   curPrice ? Math.round(curPrice) : null,
      };
    });

    return {
      name: "B — 신규상장 v2",
      pnlRate:     +((total - init) / init * 100).toFixed(3),
      totalAsset:  Math.round(total),
      realizedPnl: Math.round(this.sim.realizedPnl),
      totalTrades: this.sim.totalTrades,
      wins: this.sim.wins, losses: this.sim.losses,
      winRate: this.sim.totalTrades > 0
        ? +(this.sim.wins / this.sim.totalTrades * 100).toFixed(1) : null,
      positions,
      livePositions:   Array.from(this.livePositions.values()),
      monitoringCount: this.knownMarkets.size || this.actedListings.size,
      detections:      this.detections.slice(0, 8),
      history:         this.sim.history.slice(0, 8),
      tradeReturns:    this.sim.tradeReturns,
      dataEngineMode:  !!this.dataEngine,
      wsActive:        this._wsActive,
    };
  }
}

module.exports = { StrategyB };
