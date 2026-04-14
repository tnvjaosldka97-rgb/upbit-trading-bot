"use strict";

const http = require("http");

// ── 필터 메타데이터 ─────────────────────────────────────
const FILTER_META = {
  TREND_NOT_CONFIRMED:   { label: "이평 정배열",    group: "trend"  },
  DAILY_DOWNTREND:       { label: "일봉 하락추세",   group: "trend"  },
  BULLISH_PROB_LOW:      { label: "상승확률",        group: "signal" },
  EV_NEGATIVE:           { label: "기대값(EV)",      group: "signal" },
  OVERHEATED_VOLUME:     { label: "거래량 과열",     group: "liquid" },
  LIQUIDITY_WEAK:        { label: "유동성",          group: "liquid" },
  MARKETCAP_TOO_LOW:     { label: "시총",            group: "liquid" },
  SPREAD_TOO_WIDE:       { label: "스프레드",        group: "micro"  },
  WEAK_BID_PRESSURE:     { label: "매수 압력",       group: "micro"  },
  VWAP_OVEREXTENDED:     { label: "VWAP 이탈",       group: "micro"  },
  SELL_FLOW_DOMINANT:    { label: "체결 흐름",       group: "micro"  },
  BTC_DOWNTREND:         { label: "BTC 낙폭",        group: "macro"  },
  KIMCHI_OVERPRICED:     { label: "김치 프리미엄",   group: "macro"  },
  FUNDING_CROWDED_LONG:  { label: "펀딩비",          group: "macro"  },
  EXTREME_GREED_CAUTION: { label: "공포탐욕",        group: "macro"  },
  OFF_PEAK_HOURS:        { label: "거래 시간대",     group: "ops"    },
  STOPLOSS_COOLDOWN:     { label: "손절 쿨다운",     group: "ops"    },
  CANDIDATE_NOT_READY:   { label: "데이터 준비",     group: "ops"    },
};

class DashboardServer {
  constructor(bot) {
    this.bot  = bot;
    this.server = null;
    this.port = Number(process.env.PORT || 4020);
    this.sseClients = new Set();
    setInterval(() => this._broadcast(), 2000);
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.url === "/health")      return this._health(res);
      if (req.url === "/api/status")  return this._status(res);
      if (req.url === "/api/stream")  return this._sse(req, res);
      if (req.url === "/api/trades")  return this._trades(res);
      if (req.url === "/api/trade-stats") return this._tradeStats(res);
      return this._page(res);
    });

    // 포트 충돌 시 자동으로 다음 포트 시도 (최대 10회)
    const tryListen = (port, attempt = 0) => {
      this.server.listen(port, () => {
        this.port = port;
        console.log(`[Dashboard] http://localhost:${port}`);
      }).once("error", (err) => {
        if (err.code === "EADDRINUSE" && attempt < 10) {
          tryListen(port + 1, attempt + 1);
        } else {
          console.warn(`[Dashboard] 포트 할당 실패 — 대시보드 없이 계속`);
        }
      });
    };
    tryListen(this.port);
  }

  stop() { this.server?.close(); }

  _sse(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("retry: 2000\n\n");
    this.sseClients.add(res);
    req.on("close", () => this.sseClients.delete(res));
  }

  _broadcast() {
    if (!this.sseClients.size) return;
    const data = JSON.stringify(this._getData());
    for (const c of this.sseClients) {
      try { c.write(`data: ${data}\n\n`); }
      catch { this.sseClients.delete(c); }
    }
  }

  _health(res) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  }

  _status(res) {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(this._getData(), null, 2));
  }

  _trades(res) {
    const trades = this.bot.tradeLogger?.getRecent(100) || [];
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(trades));
  }

  _tradeStats(res) {
    const logger = this.bot.tradeLogger;
    const stats = {
      all: logger?.getStats() || {},
      A: logger?.getStats("A") || {},
      B: logger?.getStats("B") || {},
      daily: logger?.getDailyPnl(30) || [],
    };
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(stats));
  }

  // ── 데이터 수집 ─────────────────────────────────────────
  _getData() {
    const bot   = this.bot;
    const sim   = bot.mds?.state?.simulation;
    const cal   = bot.calibration?.getSummary();
    const snaps = (bot.mds?.state?.lastAnalysisSnapshots || []).slice(0, 6);

    // Strategy A/B 요약
    const sA = bot.strategyA?.getSummary() || null;
    const sB = bot.strategyB?.getSummary() || null;
    const hist  = bot.mds?.state?.simulation?.history?.slice(0, 20) || [];

    const totalAsset = bot.mds?.getSimulationTotalAsset?.() || 0;
    const initCap    = sim?.initialCapital || 100000;
    const pnlRate    = totalAsset > 0 ? (totalAsset - initCap) / initCap * 100 : 0;
    const fearGreed  = bot.macroEngine?.state?.fearGreed?.value ?? 50;

    // 자본곡선
    const returns = sim?.tradeReturns || [];
    let eq = 1;
    const equityCurve = [1, ...returns.slice(-60).map(r => {
      eq = +(eq * (1 + r * 0.08)).toFixed(5); return eq;
    })];

    // 포지션 미실현
    const pos = sim?.activePosition;
    let unrealPnl = 0, posProgress = 0;
    if (pos) {
      const ctx = bot.mds?.ensureContext?.(pos.marketCode);
      const cur = bot.mds?.getCurrentPrice?.(ctx) || 0;
      if (cur > 0) {
        unrealPnl = (cur - pos.averageBuyPrice) / pos.averageBuyPrice * 100;
        const range = pos.targetSellPrice - pos.averageBuyPrice;
        posProgress = range > 0
          ? Math.max(0, Math.min(100, (cur - pos.averageBuyPrice) / range * 100))
          : 0;
      }
    }

    // 최상위 후보 상세 분석
    const topSnap = snaps[0] || null;
    const filterChecks = topSnap ? this._buildFilterChecks(topSnap) : [];
    const signalFactors = topSnap ? this._buildSignalFactors(topSnap) : [];

    // 일일 리스크 잔여
    const dailyLossUsed = Math.abs(Math.min(0, sim?.daily?.pnl || 0));
    const dailyLossMax  = initCap * 0.006;
    const dailyRiskPct  = dailyLossMax > 0 ? dailyLossUsed / dailyLossMax * 100 : 0;

    return {
      ts: Date.now(),
      pnlRate:     +pnlRate.toFixed(3),
      totalAsset:  Math.round(totalAsset),
      initCap,
      realizedPnl: Math.round(sim?.realizedPnl || 0),
      totalTrades: sim?.totalTrades || 0,
      wins:        sim?.wins || 0,
      losses:      sim?.losses || 0,
      winRate:     sim?.totalTrades > 0 ? +(sim.wins / sim.totalTrades * 100).toFixed(1) : null,
      sharpe:      sim?.sharpeRatio != null ? +sim.sharpeRatio.toFixed(2) : null,
      mode:        process.env.BOT_MODE || "CALIBRATION",
      dryRun:      process.env.DRY_RUN !== "false",
      uptime:      Math.floor(process.uptime()),
      halted:      bot.orderService?.halted || false,
      fearGreed,
      regime:      fearGreed < 25 ? "극단공포" : fearGreed < 45 ? "공포" : fearGreed < 55 ? "중립" : fearGreed < 75 ? "탐욕" : "극단탐욕",
      regimeColor: fearGreed < 25 ? "#ef4444" : fearGreed < 45 ? "#f97316" : fearGreed < 55 ? "#6b7280" : fearGreed < 75 ? "#10b981" : "#3b82f6",
      daily: {
        trades:    sim?.daily?.trades || 0,
        pnl:       Math.round(sim?.daily?.pnl || 0),
        consLosses: sim?.daily?.consecutiveLosses || 0,
        halted:    sim?.daily?.halted || false,
        riskPct:   +dailyRiskPct.toFixed(1),
      },
      cal: {
        completed:    cal?.totalCompleted || 0,
        minNeeded:    20,
        winRate:      cal?.currentWinRate != null ? +(cal.currentWinRate * 100).toFixed(1) : null,
        onlineWinRate: cal?.onlineWinRate != null ? +(cal.onlineWinRate * 100).toFixed(1) : null,
        ev:           cal?.calibratedConfig?.ev != null ? +(cal.calibratedConfig.ev * 100).toFixed(3) : null,
        kelly:        cal?.calibratedConfig?.kellyFraction != null ? +(cal.calibratedConfig.kellyFraction * 100).toFixed(1) : null,
        evPositive:   cal?.calibratedConfig?.evPositive || false,
        mode:         cal?.mode || "CALIBRATING",
        pending:      bot.calibration?.state?.pendingOutcomes?.length || 0,
      },
      position: pos ? {
        market:      pos.marketCode,
        entryPrice:  Math.round(pos.averageBuyPrice),
        targetPrice: Math.round(pos.targetSellPrice),
        stopRate:    +(pos.dynamicStopRate * 100).toFixed(2),
        openedAt:    pos.openedAt,
        unrealPnl:   +unrealPnl.toFixed(3),
        posProgress: +posProgress.toFixed(1),
        ev:          pos.ev != null ? +(pos.ev * 100).toFixed(3) : null,
      } : null,
      candidates: snaps.map(s => ({
        market:   s.market,
        name:     (s.koreanName || s.market.replace("KRW-","")).slice(0, 8),
        score:    s.smoothedScore != null ? +s.smoothedScore.toFixed(0) : 0,
        bull:     s.bullishProbability != null ? +s.bullishProbability.toFixed(0) : 0,
        ev:       s.ev != null ? +(s.ev * 100).toFixed(3) : 0,
        eligible: s.eligible,
        price:    s.currentPrice || 0,
        reasons:  (s.reasons || []).slice(0, 3),
        momentum: s.metrics?.momentum1m != null ? +(s.metrics.momentum1m * 100).toFixed(3) : 0,
        vol:      s.metrics?.volatility != null ? +(s.metrics.volatility * 100).toFixed(3) : 0,
        flow:     s.metrics?.buyFlowRatio != null ? +s.metrics.buyFlowRatio.toFixed(2) : null,
      })),
      topSnap: topSnap ? {
        market:    topSnap.market,
        name:      topSnap.koreanName || topSnap.market,
        score:     +(topSnap.smoothedScore || 0).toFixed(0),
        bull:      +(topSnap.bullishProbability || 0).toFixed(0),
        ev:        +(((topSnap.ev || 0)) * 100).toFixed(3),
        eligible:  topSnap.eligible,
        reasons:   topSnap.reasons || [],
        price:     topSnap.currentPrice || 0,
        metrics:   topSnap.metrics || {},
      } : null,
      filterChecks,
      signalFactors,
      equityCurve,
      strategyA: sA,
      strategyB: sB,
      // ── BTC 레짐 ─────────────────────────────────────────
      btcRegime: (() => {
        const r = bot.regimeEngine?.state;
        if (!r) return null;
        return {
          regime:     r.regime     || "UNKNOWN",
          confidence: r.confidence != null ? +(r.confidence * 100).toFixed(0) : null,
          btcVsSma200: r.btcVsSma200 != null ? +(r.btcVsSma200 * 100).toFixed(1) : null,
          sma50Trend:  r.sma50Trend  || null,
        };
      })(),
      // ── 펀딩비 파밍 ──────────────────────────────────────
      funding: bot.fundingEngine?.getSummary() || null,
      // ── 전략 활성 상태 ───────────────────────────────────
      stratStatus: {
        A: { active: bot.regimeEngine?.state?.regime === "BULL", reason: bot.regimeEngine?.state?.regime !== "BULL" ? `${bot.regimeEngine?.state?.regime || "?"} 레짐` : "정상가동" },
        B: { active: true, reason: "신규상장 모니터링" },
        farming: { active: (() => { const f = bot.fundingEngine?.state; return f?.signal && f.signal !== "NEUTRAL"; })(), signal: bot.fundingEngine?.state?.signal || "NEUTRAL" },
      },
      // ── 합산 포트폴리오 ──────────────────────────────────
      portfolio: {
        totalAsset: Math.round(totalAsset) + (sA?.totalAsset || 0) + (sB?.totalAsset || 0),
        pnlA: sA?.pnlRate ?? 0,
        pnlB: sB?.pnlRate ?? 0,
      },
      history: hist.slice(0, 10).map(h => ({
        market: h.marketCode || h.market || "?",
        outcome: h.outcome,
        pnlRate: h.realizedRate != null ? +(h.realizedRate * 100).toFixed(3) : 0,
        ts: h.exitedAt || h.closedAt || 0,
      })),
      // ── 거래 로그 ──────────────────────────────────────────
      recentTrades: (bot.tradeLogger?.getRecent(20) || []).map(t => ({
        id: t.id,
        strategy: t.strategy,
        market: t.market,
        side: t.side,
        price: t.price,
        quantity: t.quantity,
        budget: t.budget,
        reason: t.reason,
        pnlRate: t.pnl_rate,
        pnlKrw: t.pnl_krw,
        qualityScore: t.quality_score,
        partial: t.partial,
        trail: t.trail,
        dryRun: t.dry_run,
        createdAt: t.created_at,
      })),
      tradeStats: bot.tradeLogger?.getStats() || {},
      alpha: bot.alphaEngine?.getSummary() || null,
      // ── 글로벌 거래소 ──────────────────────────────────────
      globalListings: bot.listingScanner?.getSummary() || null,
      crossArb:       bot.crossArb?.getSummary() || null,
      arbExecutor:    bot.arbExecutor?.getSummary() || null,
    };
  }

  _buildFilterChecks(snap) {
    const reasons = new Set(snap.reasons || []);
    return Object.entries(FILTER_META).map(([code, meta]) => ({
      code,
      label: meta.label,
      group: meta.group,
      pass:  !reasons.has(code),
    }));
  }

  _buildSignalFactors(snap) {
    const m = snap.metrics || {};
    return [
      { label: "이평 정배열", value: m.ma5 > 0 && m.ma20 > 0 ? (m.ma5 > m.ma20 && m.ma20 > m.ma60 ? 100 : m.ma5 > m.ma20 ? 50 : 0) : 0, max: 100 },
      { label: "상승확률",    value: snap.bullishProbability || 0, max: 100 },
      { label: "모멘텀 1m",   value: Math.min(100, Math.max(0, ((m.momentum1m || 0) * 10000 + 50))), max: 100 },
      { label: "매수 흐름",   value: Math.min(100, Math.max(0, ((m.buyFlowRatio || 0.5) * 100))), max: 100 },
      { label: "매크로",      value: Math.min(100, Math.max(0, 50 + (m.macroScore || 0) * 5)), max: 100 },
      { label: "EV",          value: Math.min(100, Math.max(0, 50 + (snap.ev || 0) * 2000)), max: 100 },
    ];
  }

  // ── HTML ─────────────────────────────────────────────────
  _page(res) {
    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ATS v9 — Quant Dashboard</title>
<script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>
<style>
:root{
  --bg:#060b14;--s1:#0d1421;--s2:#111c2d;--border:#1a2744;
  --text:#e2e8f0;--muted:#64748b;--dim:#2d3748;
  --blue:#3b82f6;--cyan:#06b6d4;--green:#10b981;--red:#ef4444;
  --yellow:#f59e0b;--purple:#8b5cf6;--orange:#f97316;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'SF Pro Display','Pretendard',sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden;display:flex;flex-direction:column}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--dim);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#4a5568}

/* ─── 탑바 ─── */
.topbar{
  display:flex;align-items:center;
  height:48px;border-bottom:1px solid var(--border);
  background:linear-gradient(90deg,#060b14,#0a1020);
  flex-shrink:0;padding:0 16px;gap:6px;
  overflow-x:auto;overflow-y:hidden;
  scrollbar-width:none;
}
.topbar::-webkit-scrollbar{display:none}
.logo{font-size:1.05rem;font-weight:800;color:var(--cyan);letter-spacing:1px;white-space:nowrap;margin-right:4px}
.tb-sep{width:1px;height:22px;background:var(--border);flex-shrink:0}
.tb-stat{display:flex;flex-direction:column;align-items:center;padding:0 8px;cursor:default;flex-shrink:0;white-space:nowrap}
.tb-stat .lbl{font-size:.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;line-height:1.3}
.tb-stat .val{font-size:.9rem;font-weight:700;line-height:1.3}
.tb-right{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:.72rem;color:var(--muted);flex-shrink:0}
.live-ring{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.mode-pill{padding:2px 10px;border-radius:99px;font-size:.7rem;font-weight:700;border:1px solid;white-space:nowrap}
.pill-sim{color:var(--yellow);border-color:var(--yellow);background:rgba(245,158,11,.08)}
.pill-live{color:var(--green);border-color:var(--green);background:rgba(16,185,129,.08)}

/* ─── 인포 바 (레짐/펀딩/전략) ─── */
.info-bar{
  display:grid;grid-template-columns:repeat(4,1fr);
  border-bottom:1px solid var(--border);flex-shrink:0;background:var(--s2);
}
.info-cell{padding:8px 14px;border-right:1px solid var(--border);min-width:0}
.info-cell:last-child{border-right:none}
.info-label{font-size:.62rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ─── 전략 바 ─── */
.strat-bar{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--border);flex-shrink:0}
.strat-cell{padding:10px 14px;background:var(--s1);min-width:0;overflow:hidden}
.strat-cell:first-child{border-right:1px solid var(--border)}
.strat-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:8px}
.strat-name{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.7px;white-space:nowrap}
.strat-body{display:flex;gap:12px;align-items:center}
.strat-pnl{font-size:1.25rem;font-weight:800;white-space:nowrap}
.strat-sub{font-size:.7rem;color:var(--muted);white-space:nowrap}
.strat-info{flex:1;min-width:0;font-size:.72rem;color:var(--muted);padding:6px 10px;background:var(--bg);border-radius:6px;border:1px solid var(--border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.strat-tags{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}
.strat-tag{font-size:.64rem;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.3);border:1px solid;white-space:nowrap}

/* ─── 메인 그리드 ─── */
.main{display:grid;grid-template-columns:280px 1fr 300px;flex:1;overflow:hidden;gap:0}

/* ─── 패널 공통 ─── */
.panel{border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column;gap:0}
.panel:last-child{border-right:none}
.sec{padding:12px 14px;border-bottom:1px solid var(--border)}
.sec-title{font-size:.64rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between}

/* ─── 스캐너 ─── */
.scan-row{
  display:flex;align-items:center;gap:6px;
  padding:6px 8px;border-radius:6px;cursor:pointer;
  transition:background .12s;border:1px solid transparent;margin-bottom:2px;
}
.scan-row:hover{background:rgba(255,255,255,.04)}
.scan-row.active{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.25)}
.scan-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.scan-name{font-size:.8rem;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scan-score{font-size:.72rem;color:var(--muted);width:32px;text-align:right;flex-shrink:0}
.scan-ev{font-size:.72rem;font-weight:600;width:52px;text-align:right;flex-shrink:0}
.scan-badge{font-size:.62rem;padding:2px 6px;border-radius:4px;white-space:nowrap;flex-shrink:0}
.go{background:rgba(16,185,129,.15);color:var(--green)}
.wait{background:rgba(74,85,104,.15);color:var(--muted)}
.block{background:rgba(239,68,68,.1);color:var(--red)}

/* ─── 히스토리 ─── */
.hist-row{display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(26,39,68,.5);font-size:.76rem;gap:6px}
.hist-row:last-child{border-bottom:none}

/* ─── 리스크 바 ─── */
.risk-bar{height:6px;background:var(--dim);border-radius:3px;overflow:hidden;margin-top:5px}
.risk-fill{height:100%;border-radius:3px;transition:width .5s}

/* ─── 차트 영역 ─── */
.chart-panel{display:flex;flex-direction:column;overflow:hidden}
.chart-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 14px;border-bottom:1px solid var(--border);flex-shrink:0;
}
.chart-info{display:flex;flex-direction:column}
.chart-mkt{font-size:1rem;font-weight:700}
.chart-px{font-size:.74rem;color:var(--muted);margin-top:1px}
.tf-group{display:flex;gap:3px}
.tf-btn{padding:4px 10px;border-radius:5px;font-size:.72rem;cursor:pointer;border:1px solid var(--border);color:var(--muted);background:transparent;transition:all .12s}
.tf-btn.on{background:var(--blue);border-color:var(--blue);color:#fff}
#tv-chart{flex:1;min-height:0}
.equity-strip{height:90px;border-top:1px solid var(--border);flex-shrink:0;padding:8px 14px 6px}
.eq-lbl{font-size:.62rem;color:var(--muted);margin-bottom:3px}
#eq-svg{width:100%;height:62px}

/* ─── 예측 패널 ─── */
.pred-panel{display:flex;flex-direction:column;overflow-y:auto}

/* 포지션 / 대기 */
.pos-block{padding:12px 14px;border-bottom:1px solid var(--border)}
.pos-mkt{font-size:1.05rem;font-weight:800;color:var(--cyan)}
.pos-sub{font-size:.72rem;color:var(--muted);margin-top:2px}
.unreal{font-size:1.6rem;font-weight:800;margin:6px 0 4px}
.pos-prog{height:5px;background:var(--dim);border-radius:3px;overflow:hidden}
.pos-fill{height:100%;border-radius:3px;transition:width .4s}
.wait-block{padding:16px;border-bottom:1px solid var(--border);text-align:center;color:var(--muted);font-size:.84rem}

/* 신호 점수 게이지 */
.gauge-wrap{padding:14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px}
.gauge-svg-wrap{flex-shrink:0}
.gauge-info{flex:1;min-width:0}
.gauge-title{font-size:.64rem;color:var(--muted);text-transform:uppercase;letter-spacing:.7px}
.gauge-mkt{font-size:.92rem;font-weight:700;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gauge-sub{font-size:.74rem;color:var(--muted);margin-top:2px}
.gauge-ev{font-size:.84rem;font-weight:700;margin-top:4px}

/* 팩터 바 */
.factor-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.factor-lbl{font-size:.7rem;color:var(--muted);width:64px;flex-shrink:0;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.factor-bar{flex:1;height:6px;background:var(--dim);border-radius:3px;overflow:hidden}
.factor-fill{height:100%;border-radius:3px;transition:width .5s}
.factor-val{font-size:.68rem;width:30px;text-align:right;color:var(--muted);flex-shrink:0}

/* 필터 체크리스트 */
.checklist{padding:10px 14px;border-bottom:1px solid var(--border)}
.check-group{margin-bottom:6px}
.check-glbl{font-size:.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
.checks{display:flex;flex-wrap:wrap;gap:4px}
.ck{display:flex;align-items:center;gap:3px;font-size:.68rem;padding:2px 7px;border-radius:4px;border:1px solid;white-space:nowrap}
.ck.ok{color:var(--green);border-color:rgba(16,185,129,.25);background:rgba(16,185,129,.06)}
.ck.fail{color:var(--red);border-color:rgba(239,68,68,.25);background:rgba(239,68,68,.06)}
.ck.warn{color:var(--yellow);border-color:rgba(245,158,11,.25);background:rgba(245,158,11,.06)}
.ck-dot{font-size:.62rem}

/* 공포탐욕 */
.fg-section{padding:10px 14px;border-bottom:1px solid var(--border)}
.fg-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.fg-lbl{font-size:.88rem;font-weight:700}
.fg-num{font-size:1.4rem;font-weight:800}
.fg-bar{height:8px;border-radius:4px;background:linear-gradient(90deg,#ef4444 0%,#f97316 20%,#eab308 40%,#10b981 60%,#3b82f6 80%,#8b5cf6 100%);position:relative}
.fg-needle{position:absolute;top:-4px;width:3px;height:16px;background:#fff;border-radius:1px;transform:translateX(-50%);transition:left .6s ease;box-shadow:0 0 4px rgba(0,0,0,.5)}

/* 캘리브레이션 */
.cal-section{padding:10px 14px;border-bottom:1px solid var(--border)}
.cal-row{display:flex;align-items:center;gap:10px}
.cal-stats{flex:1}
.stat-line{display:flex;justify-content:space-between;font-size:.74rem;padding:2px 0}
.sl-lbl{color:var(--muted)}
.sl-val{font-weight:600}

/* 거래 로그 */
.trade-row{display:grid;grid-template-columns:32px 48px 1fr auto auto;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(26,39,68,.4);font-size:.72rem;transition:background .1s}
.trade-row:hover{background:rgba(255,255,255,.03)}
.trade-row:last-child{border-bottom:none}
.trade-side{font-size:.62rem;font-weight:800;padding:2px 0;border-radius:3px;text-align:center}
.side-buy{color:#3b82f6;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.3)}
.side-sell{color:#ef4444;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3)}
.trade-mkt{font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trade-detail{display:flex;align-items:center;gap:5px;overflow:hidden;min-width:0}
.trade-price{color:var(--muted);white-space:nowrap}
.trade-pnl{font-weight:700;white-space:nowrap}
.trade-reason{font-size:.62rem;color:var(--muted);padding:1px 5px;border-radius:3px;background:var(--dim);white-space:nowrap}
.trade-meta{display:flex;align-items:center;gap:4px;flex-shrink:0}
.trade-time{color:var(--muted);font-size:.64rem;white-space:nowrap;flex-shrink:0}
.trade-badge{font-size:.58rem;padding:1px 5px;border-radius:3px;font-weight:700;white-space:nowrap}
.badge-partial{color:var(--yellow);border:1px solid rgba(245,158,11,.3);background:rgba(245,158,11,.05)}
.badge-trail{color:var(--cyan);border:1px solid rgba(6,182,212,.3);background:rgba(6,182,212,.05)}
.badge-dry{color:var(--muted);border:1px solid var(--dim);background:rgba(45,55,72,.3)}

/* ─── 반응형 ─── */
@media(max-width:1400px){
  .main{grid-template-columns:260px 1fr 280px}
}
@media(max-width:1100px){
  .main{grid-template-columns:240px 1fr}
  .pred-panel{display:none}
  .info-bar{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:768px){
  .main{grid-template-columns:1fr}
  .chart-panel{display:none}
  .strat-bar{grid-template-columns:1fr}
  .strat-cell:first-child{border-right:none;border-bottom:1px solid var(--border)}
  .info-bar{grid-template-columns:1fr 1fr}
  .topbar{gap:4px;padding:0 10px}
  .tb-stat{padding:0 6px}
  .tb-stat .val{font-size:.82rem}
}
</style>
</head>
<body>

<!-- ─── 탑바 ─── -->
<div class="topbar">
  <div class="logo">⚡ ATS v9</div>
  <div class="tb-sep"></div>
  <div class="tb-stat">
    <span class="lbl">수익률</span>
    <span class="val" id="tb-pnl" style="color:var(--green)">—</span>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-stat">
    <span class="lbl">총자산</span>
    <span class="val" id="tb-asset">—</span>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-stat">
    <span class="lbl">승률</span>
    <span class="val" id="tb-wr">—</span>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-stat">
    <span class="lbl">샤프</span>
    <span class="val" id="tb-sharpe">—</span>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-stat">
    <span class="lbl">공포탐욕</span>
    <span class="val" id="tb-regime">—</span>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-stat">
    <span class="lbl">BTC 레짐</span>
    <span class="val" id="tb-btc-regime" style="font-size:.82rem">—</span>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-stat">
    <span class="lbl">펀딩비/8h</span>
    <span class="val" id="tb-funding" style="font-size:.82rem">—</span>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-stat">
    <span class="lbl">캘리브</span>
    <span class="val" id="tb-cal">—</span>
  </div>
  <div class="tb-right">
    <div class="live-ring"></div>
    <span id="tb-uptime">—</span>
    <span id="tb-mode" class="mode-pill pill-sim">SIM</span>
  </div>
</div>

<!-- ─── 레짐 + 펀딩비 파밍 바 ─── -->
<div class="info-bar">
  <div class="info-cell">
    <div class="info-label">BTC 마켓 레짐</div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div id="regime-pill" style="padding:3px 10px;border-radius:99px;font-size:.78rem;font-weight:800;border:1px solid var(--muted);color:var(--muted);white-space:nowrap">—</div>
      <div id="regime-conf" style="font-size:.72rem;color:var(--muted);white-space:nowrap">—</div>
    </div>
    <div id="regime-detail" style="font-size:.68rem;color:var(--muted);margin-top:3px">SMA200 대비 —</div>
  </div>

  <div class="info-cell">
    <div class="info-label">Bybit 펀딩비 (BTC)</div>
    <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap">
      <span id="funding-rate" style="font-size:1.1rem;font-weight:800;color:var(--text)">—</span>
      <span style="font-size:.68rem;color:var(--muted)">/8h</span>
      <span id="funding-apr" style="font-size:.74rem;font-weight:700;color:var(--muted)">APR —</span>
    </div>
    <div id="funding-next" style="font-size:.68rem;color:var(--muted);margin-top:2px">다음 정산 —</div>
  </div>

  <div class="info-cell">
    <div class="info-label">펀딩비 파밍 신호</div>
    <div id="farming-signal" style="padding:3px 10px;border-radius:99px;font-size:.76rem;font-weight:800;border:1px solid var(--muted);color:var(--muted);display:inline-block;white-space:nowrap">대기 중</div>
    <div id="farming-desc" style="font-size:.66rem;color:var(--muted);margin-top:3px">|rate| >= 0.03% 시 활성</div>
  </div>

  <div class="info-cell">
    <div class="info-label">Global Exchanges</div>
    <div style="display:flex;flex-direction:column;gap:3px">
      <div style="display:flex;align-items:center;gap:6px">
        <div id="ex-binance-dot" style="width:7px;height:7px;border-radius:50%;background:var(--muted);flex-shrink:0"></div>
        <span style="font-size:.72rem;color:var(--muted)">Binance:</span>
        <span id="ex-binance-status" style="font-size:.72rem;font-weight:700;color:var(--muted)">—</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <div id="ex-bybit-dot" style="width:7px;height:7px;border-radius:50%;background:var(--muted);flex-shrink:0"></div>
        <span style="font-size:.72rem;color:var(--muted)">Bybit:</span>
        <span id="ex-bybit-status" style="font-size:.72rem;font-weight:700;color:var(--muted)">—</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <div id="ex-upbit-dot" style="width:7px;height:7px;border-radius:50%;background:var(--green);flex-shrink:0;box-shadow:0 0 5px var(--green)"></div>
        <span style="font-size:.72rem;color:var(--muted)">Upbit:</span>
        <span id="ex-upbit-status" style="font-size:.72rem;font-weight:700;color:var(--green)">연결됨</span>
      </div>
      <div id="ex-arb-spread" style="font-size:.66rem;color:var(--yellow);margin-top:1px">—</div>
    </div>
  </div>
</div>

<!-- ─── 아비트라지 실행 엔진 패널 ─── -->
<div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
    <span style="font-size:.78rem;font-weight:700;color:var(--text)">Arb Executor</span>
    <span id="arb-mode" style="font-size:.64rem;padding:1px 6px;border-radius:3px;background:var(--muted);color:var(--bg)">—</span>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 10px">
    <div style="font-size:.66rem;color:var(--muted)">오늘 실행</div>
    <div style="font-size:.66rem;color:var(--muted)">오늘 수익</div>
    <div style="font-size:.66rem;color:var(--muted)">승률</div>
    <div id="arb-daily-trades" style="font-size:.82rem;font-weight:700;color:var(--text)">0</div>
    <div id="arb-daily-profit" style="font-size:.82rem;font-weight:700;color:var(--green)">$0</div>
    <div id="arb-winrate" style="font-size:.82rem;font-weight:700;color:var(--text)">—</div>
    <div style="font-size:.66rem;color:var(--muted)">누적 거래</div>
    <div style="font-size:.66rem;color:var(--muted)">누적 수익</div>
    <div style="font-size:.66rem;color:var(--muted)">평균 스프레드</div>
    <div id="arb-total-trades" style="font-size:.82rem;font-weight:700;color:var(--text)">0</div>
    <div id="arb-total-profit" style="font-size:.82rem;font-weight:700;color:var(--green)">$0</div>
    <div id="arb-avg-spread" style="font-size:.82rem;font-weight:700;color:var(--yellow)">—</div>
  </div>
  <div id="arb-history" style="margin-top:6px;font-size:.62rem;color:var(--muted);max-height:60px;overflow-y:auto"></div>
</div>

<!-- ─── 전략 패널 ─── -->
<div id="strategy-bar" class="strat-bar">
  <div class="strat-cell">
    <div class="strat-header">
      <span class="strat-name" style="color:var(--cyan)">Strategy A — 1h 스윙</span>
      <span id="sa-wr" style="font-size:.7rem;color:var(--muted)">승률 —</span>
    </div>
    <div class="strat-body">
      <div>
        <div id="sa-pnl" class="strat-pnl" style="color:var(--green)">—</div>
        <div id="sa-asset" class="strat-sub">—</div>
      </div>
      <div id="sa-pos" class="strat-info">포지션 없음 — 신호 대기</div>
    </div>
    <div id="sa-hist" class="strat-tags"></div>
  </div>

  <div class="strat-cell">
    <div class="strat-header">
      <span class="strat-name" style="color:var(--purple)">Strategy B — 신규상장</span>
      <span id="sb-monitor" style="font-size:.7rem;color:var(--muted)">—개 감시</span>
    </div>
    <div class="strat-body">
      <div>
        <div id="sb-pnl" class="strat-pnl" style="color:var(--green)">—</div>
        <div id="sb-asset" class="strat-sub">—</div>
      </div>
      <div id="sb-detect" class="strat-info">신규상장 감시 중...</div>
    </div>
    <div id="sb-positions" style="margin-top:6px"></div>
    <div id="sb-hist" class="strat-tags" style="margin-top:4px"></div>
  </div>
</div>

<!-- ─── 메인 ─── -->
<div class="main">

  <!-- ── 좌: 스캐너 ── -->
  <div class="panel" id="panel-left">

    <!-- 시장 스캐너 -->
    <div class="sec">
      <div class="sec-title">
        <span>마켓 스캐너</span>
        <span id="scan-count" style="color:var(--cyan);font-weight:700">0/0</span>
      </div>
      <div id="scanner"></div>
    </div>

    <!-- 일일 리스크 -->
    <div class="sec">
      <div class="sec-title">일일 리스크</div>
      <div class="stat-line">
        <span class="sl-lbl">오늘 거래</span><span class="sl-val" id="d-trades">—</span>
      </div>
      <div class="stat-line">
        <span class="sl-lbl">오늘 손익</span><span class="sl-val" id="d-pnl">—</span>
      </div>
      <div class="stat-line">
        <span class="sl-lbl">연속 손절</span><span class="sl-val" id="d-cons">—</span>
      </div>
      <div class="stat-line" style="margin-top:4px">
        <span class="sl-lbl" style="font-size:.6rem">일일 손실 한도</span>
        <span class="sl-val" id="d-risk-pct" style="font-size:.7rem">—</span>
      </div>
      <div class="risk-bar">
        <div id="d-risk-bar" class="risk-fill" style="width:0%;background:var(--green)"></div>
      </div>
    </div>

    <!-- 최근 거래 -->
    <div class="sec" style="flex:1">
      <div class="sec-title">최근 거래</div>
      <div id="hist-list"></div>
    </div>

    <!-- 매수/매도 로그 -->
    <div class="sec" style="flex:2;overflow-y:auto">
      <div class="sec-title">
        <span>거래 로그 (매수/매도)</span>
        <span id="trade-stats" style="color:var(--cyan);font-weight:700">0건</span>
      </div>
      <div id="trade-log"></div>
    </div>

  </div>

  <!-- ── 중: 차트 ── -->
  <div class="chart-panel">
    <div class="chart-header">
      <div class="chart-info">
        <div class="chart-mkt" id="chart-mkt">KRW-BTC</div>
        <div class="chart-px" id="chart-px">—</div>
      </div>
      <div class="tf-group">
        <button class="tf-btn on" onclick="setTf(1,this)">1m</button>
        <button class="tf-btn"   onclick="setTf(3,this)">3m</button>
        <button class="tf-btn"   onclick="setTf(5,this)">5m</button>
        <button class="tf-btn"   onclick="setTf(15,this)">15m</button>
        <button class="tf-btn"   onclick="setTf(60,this)">1h</button>
      </div>
    </div>
    <div id="tv-chart"></div>
    <div class="equity-strip">
      <div class="eq-lbl">자본 곡선 (최근 60거래)</div>
      <svg id="eq-svg" preserveAspectRatio="none"></svg>
    </div>
  </div>

  <!-- ── 우: 예측 엔진 ── -->
  <div class="pred-panel">

    <!-- 포지션 / 대기 -->
    <div id="pos-block" class="pos-block" style="display:none">
      <div class="sec-title" style="margin-bottom:6px">📈 포지션</div>
      <div id="p-mkt" class="pos-mkt">—</div>
      <div id="p-sub" class="pos-sub">—</div>
      <div id="p-unreal" class="unreal">—</div>
      <div class="pos-prog"><div id="p-prog" class="pos-fill" style="width:0%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--muted);margin-top:4px">
        <span id="p-entry">진입</span><span id="p-target">목표</span>
      </div>
    </div>
    <div id="wait-block" class="wait-block">⏳ 진입 신호 대기 중</div>

    <!-- 신호 점수 게이지 -->
    <div class="gauge-wrap">
      <div class="gauge-svg-wrap">
        <svg width="72" height="72" viewBox="0 0 72 72">
          <circle cx="36" cy="36" r="28" fill="none" stroke="var(--dim)" stroke-width="6"/>
          <circle id="gauge-ring" cx="36" cy="36" r="28" fill="none" stroke="var(--cyan)" stroke-width="6"
            stroke-dasharray="175.9" stroke-dashoffset="175.9" stroke-linecap="round"
            transform="rotate(-90 36 36)" style="transition:all .5s ease"/>
          <text x="36" y="40" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="800" id="gauge-num">0</text>
        </svg>
      </div>
      <div class="gauge-info">
        <div class="gauge-title">신호 점수</div>
        <div id="g-mkt"  class="gauge-mkt">—</div>
        <div id="g-bull" class="gauge-sub">상승확률: —</div>
        <div id="g-ev"   class="gauge-ev">EV: —</div>
      </div>
    </div>

    <!-- 팩터 분석 -->
    <div class="sec">
      <div class="sec-title">신호 팩터 분석</div>
      <div id="factors"></div>
    </div>

    <!-- 필터 체크리스트 -->
    <div class="checklist">
      <div class="sec-title" style="margin-bottom:8px">진입 필터 체크리스트</div>
      <div id="checks-trend"  class="check-group"><div class="check-glbl">추세</div><div class="checks" id="cg-trend"></div></div>
      <div id="checks-signal" class="check-group"><div class="check-glbl">신호</div><div class="checks" id="cg-signal"></div></div>
      <div id="checks-liquid" class="check-group"><div class="check-glbl">유동성</div><div class="checks" id="cg-liquid"></div></div>
      <div id="checks-micro"  class="check-group"><div class="check-glbl">미세구조</div><div class="checks" id="cg-micro"></div></div>
      <div id="checks-macro"  class="check-group"><div class="check-glbl">매크로</div><div class="checks" id="cg-macro"></div></div>
      <div id="checks-ops"    class="check-group"><div class="check-glbl">운영</div><div class="checks" id="cg-ops"></div></div>
    </div>

    <!-- 알파 퍼포먼스 -->
    <div class="cal-section" id="alpha-section" style="display:none">
      <div class="sec-title">Alpha Performance</div>
      <div class="cal-stats" style="width:100%">
        <div class="stat-line"><span class="sl-lbl">Tape 정확도</span><span class="sl-val" id="al-tape">—</span></div>
        <div class="stat-line"><span class="sl-lbl">평균 진입타이밍</span><span class="sl-val" id="al-timing">—</span></div>
        <div class="stat-line"><span class="sl-lbl">김치 엣지</span><span class="sl-val" id="al-kimchi">—</span></div>
        <div class="stat-line"><span class="sl-lbl">추적 거래</span><span class="sl-val" id="al-trades">—</span></div>
        <div class="stat-line"><span class="sl-lbl">최고 신호</span><span class="sl-val" id="al-best">—</span></div>
        <div class="stat-line"><span class="sl-lbl">평균 PnL</span><span class="sl-val" id="al-pnl">—</span></div>
        <div class="stat-line"><span class="sl-lbl">승률</span><span class="sl-val" id="al-wr">—</span></div>
      </div>
    </div>

    <!-- 공포탐욕 -->
    <div class="fg-section">
      <div class="fg-top">
        <div id="fg-lbl" class="fg-lbl">—</div>
        <div id="fg-num" class="fg-num">—</div>
      </div>
      <div class="fg-bar"><div id="fg-needle" class="fg-needle" style="left:50%"></div></div>
    </div>

    <!-- 캘리브레이션 -->
    <div class="cal-section">
      <div class="sec-title">캘리브레이션</div>
      <div class="cal-row">
        <svg width="52" height="52" viewBox="0 0 52 52">
          <circle cx="26" cy="26" r="20" fill="none" stroke="var(--dim)" stroke-width="5"/>
          <circle id="cal-arc" cx="26" cy="26" r="20" fill="none" stroke="var(--blue)" stroke-width="5"
            stroke-dasharray="125.7" stroke-dashoffset="125.7" stroke-linecap="round"
            transform="rotate(-90 26 26)" style="transition:stroke-dashoffset .6s"/>
          <text x="26" y="30" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="700" id="cal-n">0</text>
        </svg>
        <div class="cal-stats">
          <div class="stat-line"><span class="sl-lbl">EMA 승률</span><span class="sl-val" id="c-ema">—</span></div>
          <div class="stat-line"><span class="sl-lbl">누적 승률</span><span class="sl-val" id="c-wr">—</span></div>
          <div class="stat-line"><span class="sl-lbl">EV</span><span class="sl-val" id="c-ev">—</span></div>
          <div class="stat-line"><span class="sl-lbl">켈리</span><span class="sl-val" id="c-kelly">—</span></div>
          <div class="stat-line"><span class="sl-lbl">팬텀 대기</span><span class="sl-val" id="c-pend">—</span></div>
        </div>
      </div>
    </div>

  </div><!-- /pred-panel -->
</div><!-- /main -->

<script>
// ── 차트 ─────────────────────────────────────────────────
const {createChart, CandlestickSeries, LineSeries, ColorType, LineStyle, PriceLineSource} = LightweightCharts;
const chartEl = document.getElementById("tv-chart");

function resizeChart(){
  const sb = document.getElementById("strategy-bar");
  const sbH = sb ? sb.offsetHeight : 80;
  chartEl.style.height = (window.innerHeight - 50 - sbH - 90 - 40) + "px";
}
resizeChart();
window.addEventListener("resize", resizeChart);

const chart = createChart(chartEl, {
  layout:{ background:{type:ColorType.Solid,color:"#0d1421"}, textColor:"#4a5568" },
  grid:{ vertLines:{color:"#1a2744"}, horzLines:{color:"#1a2744"} },
  crosshair:{mode:1},
  rightPriceScale:{borderColor:"#1a2744"},
  timeScale:{borderColor:"#1a2744",timeVisible:true,secondsVisible:false},
});

const cSeries = chart.addSeries(CandlestickSeries,{
  upColor:"#10b981",downColor:"#ef4444",
  borderUpColor:"#10b981",borderDownColor:"#ef4444",
  wickUpColor:"#10b981",wickDownColor:"#ef4444",
});

let entryLine=null, targetLine=null, stopLine=null;
let curMarket="KRW-BTC", curTf=1;

async function loadChart(market, tf){
  curMarket = market;
  curTf     = tf;
  document.getElementById("chart-mkt").textContent = market;
  try{
    const tf2 = tf < 60 ? \`minutes/\${tf}\` : \`hours/1\`;
    const url = \`https://api.upbit.com/v1/candles/\${tf2}?market=\${market}&count=200\`;
    const data = await fetch(url).then(r=>r.json());
    if(!Array.isArray(data)) return;
    const candles = data.reverse().map(c=>({
      time: Math.floor(new Date(c.candle_date_time_utc).getTime()/1000),
      open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price,
    }));
    cSeries.setData(candles);
    chart.timeScale().fitContent();
    const last = candles[candles.length-1];
    if(last) document.getElementById("chart-px").textContent =
      last.close.toLocaleString()+"원  "+(last.close>=last.open?"▲":"▼");
  }catch(e){ console.warn(e); }
}

function setTf(tf, btn){
  document.querySelectorAll(".tf-btn").forEach(b=>b.classList.remove("on"));
  btn.classList.add("on");
  loadChart(curMarket, tf);
}

function setPositionLines(entry, target, stop){
  if(entryLine)  { try{cSeries.removePriceLine(entryLine)} catch{} entryLine=null; }
  if(targetLine) { try{cSeries.removePriceLine(targetLine)} catch{} targetLine=null; }
  if(stopLine)   { try{cSeries.removePriceLine(stopLine)}  catch{} stopLine=null; }
  if(!entry) return;
  entryLine  = cSeries.createPriceLine({price:entry,  color:"#3b82f6",lineWidth:1,lineStyle:0,axisLabelVisible:true,title:"진입"});
  targetLine = cSeries.createPriceLine({price:target, color:"#10b981",lineWidth:1,lineStyle:2,axisLabelVisible:true,title:"목표"});
  stopLine   = cSeries.createPriceLine({price:stop,   color:"#ef4444",lineWidth:1,lineStyle:2,axisLabelVisible:true,title:"손절"});
}

setInterval(()=>loadChart(curMarket,curTf), 20000);
loadChart(curMarket, curTf);

// ── 자본곡선 SVG ─────────────────────────────────────────
function drawEquity(curve){
  const svg=document.getElementById("eq-svg");
  const W=svg.clientWidth||600,H=62;
  if(curve.length<2){svg.innerHTML="";return;}
  const mn=Math.min(...curve),mx=Math.max(...curve),rng=mx-mn||0.0001;
  const pts=curve.map((v,i)=>{
    const x=(i/(curve.length-1))*W;
    const y=H-((v-mn)/rng)*(H-10)-5;
    return x.toFixed(1)+","+y.toFixed(1);
  }).join(" ");
  const last=curve[curve.length-1];
  const c=last>=1?"#10b981":"#ef4444";
  svg.innerHTML=\`<defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="\${c}" stop-opacity=".2"/>
    <stop offset="100%" stop-color="\${c}" stop-opacity="0"/>
  </linearGradient></defs>
  <polygon points="\${pts} \${W},\${H} 0,\${H}" fill="url(#eg)"/>
  <polyline points="\${pts}" fill="none" stroke="\${c}" stroke-width="1.5"/>\`;
}

// ── SSE ──────────────────────────────────────────────────
const es = new EventSource("/api/stream");
es.onmessage = e => update(JSON.parse(e.data));
es.onerror   = () => setTimeout(()=>location.reload(), 4000);

function c(id){ return document.getElementById(id); }
function fmt(n){ return n!=null ? n.toLocaleString() : "—"; }
function fmtPct(n){ return n!=null ? (n>=0?"+":"")+n+"%" : "—"; }
function pad(n){ return String(n).padStart(2,"0"); }

let selectedMarket = null;

function update(d){
  // ─ 탑바
  const pnlC = d.pnlRate>=0?"var(--green)":"var(--red)";
  c("tb-pnl").textContent = fmtPct(d.pnlRate);
  c("tb-pnl").style.color = pnlC;
  c("tb-asset").textContent = fmt(d.totalAsset)+"원";
  c("tb-wr").textContent = d.winRate!=null ? d.winRate+"%": "—";
  c("tb-sharpe").textContent = d.sharpe!=null ? d.sharpe : "—";
  c("tb-regime").textContent = d.regime;
  c("tb-regime").style.color = d.regimeColor;

  // ─ BTC 레짐 (탑바)
  if (d.btcRegime) {
    const rc = d.btcRegime.regime;
    const rcolor = rc==="BULL"?"var(--green)":rc==="BEAR"?"var(--red)":"var(--yellow)";
    const ricon  = rc==="BULL"?"🟢":rc==="BEAR"?"🔴":"🟡";
    c("tb-btc-regime").textContent = ricon+" "+rc;
    c("tb-btc-regime").style.color = rcolor;
  }

  // ─ 펀딩비 (탑바)
  if (d.funding?.ratePct != null) {
    const fp = d.funding.ratePct;
    const fc = fp>0?"var(--red)":fp<0?"var(--green)":"var(--muted)";
    c("tb-funding").textContent = (fp>=0?"+":"")+fp+"%";
    c("tb-funding").style.color = fc;
  }

  // ─ 레짐+파밍 상세 바
  if (d.btcRegime) {
    const rc = d.btcRegime.regime;
    const rcolor = rc==="BULL"?"#10b981":rc==="BEAR"?"#ef4444":"#f59e0b";
    const rbg    = rc==="BULL"?"rgba(16,185,129,.12)":rc==="BEAR"?"rgba(239,68,68,.12)":"rgba(245,158,11,.12)";
    const ricon  = rc==="BULL"?"🟢 BULL":rc==="BEAR"?"🔴 BEAR":"🟡 NEUTRAL";
    c("regime-pill").textContent   = ricon;
    c("regime-pill").style.color   = rcolor;
    c("regime-pill").style.borderColor = rcolor;
    c("regime-pill").style.background  = rbg;
    c("regime-conf").textContent   = (d.btcRegime.confidence??"-")+"% 신뢰도";
    const vs = d.btcRegime.btcVsSma200;
    c("regime-detail").textContent = vs!=null ? "SMA200 대비 "+(vs>=0?"+":"")+vs+"%" : "SMA200 대비 —";
    c("regime-detail").style.color = vs>=0?"var(--green)":"var(--red)";
  }

  // ─ 글로벌 거래소 상태
  if (d.globalListings) {
    const gl = d.globalListings;
    const exs = gl.exchanges || {};
    for (const key of ["binance","bybit","upbit"]) {
      const ex = exs[key];
      const dot = c("ex-"+key+"-dot");
      const st  = c("ex-"+key+"-status");
      if (ex && ex.connected) {
        dot.style.background = "var(--green)";
        dot.style.boxShadow  = "0 0 5px var(--green)";
        st.textContent       = ex.marketCount+"개 마켓";
        st.style.color       = "var(--green)";
      } else {
        dot.style.background = "var(--muted)";
        dot.style.boxShadow  = "none";
        st.textContent       = "대기중";
        st.style.color       = "var(--muted)";
      }
    }
  }
  if (d.crossArb && d.crossArb.topOpportunity) {
    const top = d.crossArb.topOpportunity;
    c("ex-arb-spread").textContent = "Arb: "+top.coin+" "+top.spreadPct+"% ("+top.buy+"->"+top.sell+")";
    c("ex-arb-spread").style.color = "var(--yellow)";
  } else {
    c("ex-arb-spread").textContent = "차익 기회 없음";
    c("ex-arb-spread").style.color = "var(--muted)";
  }

  // ── ArbExecutor 통계 ──────────────────────────────────────
  if (d.arbExecutor) {
    const a = d.arbExecutor;
    c("arb-mode").textContent  = a.dryRun ? "시뮬" : "실거래";
    c("arb-mode").style.background = a.dryRun ? "var(--yellow)" : "var(--green)";
    c("arb-daily-trades").textContent = a.dailyTrades;
    c("arb-daily-profit").textContent = "$"+a.dailyProfitUsd.toFixed(2);
    c("arb-daily-profit").style.color = a.dailyProfitUsd>=0?"var(--green)":"var(--red)";
    c("arb-total-trades").textContent = a.totalTrades;
    c("arb-total-profit").textContent = "$"+a.totalProfitUsd.toFixed(2);
    c("arb-total-profit").style.color = a.totalProfitUsd>=0?"var(--green)":"var(--red)";
    c("arb-winrate").textContent = a.winRate!=null ? a.winRate+"%" : "—";
    c("arb-winrate").style.color = a.winRate>=80?"var(--green)":a.winRate>=50?"var(--yellow)":"var(--red)";
    c("arb-avg-spread").textContent = a.avgSpread>0 ? a.avgSpread+"%" : "—";
    // 최근 거래 내역
    const hEl = c("arb-history");
    if (a.history && a.history.length>0) {
      hEl.innerHTML = a.history.map(function(h){
        var col = h.profitUsd>=0?"var(--green)":"var(--red)";
        var t = new Date(h.timestamp).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"});
        return '<div style="display:flex;justify-content:space-between;padding:1px 0">'+
          '<span>'+t+' '+h.coin+' '+h.buyExchange+'→'+h.sellExchange+'</span>'+
          '<span style="color:'+col+'">$'+(h.profitUsd>=0?"+":"")+h.profitUsd.toFixed(2)+' ('+h.spreadPct+'%)</span></div>';
      }).join("");
    } else {
      hEl.innerHTML = '<div style="text-align:center;padding:4px">실행 내역 없음</div>';
    }
  }

  if (d.funding) {
    const fp  = d.funding.ratePct;
    const fc  = fp>0?"var(--red)":fp<0?"var(--green)":"var(--muted)";
    if (fp!=null) {
      c("funding-rate").textContent   = (fp>=0?"+":"")+fp+"%";
      c("funding-rate").style.color   = fc;
      c("funding-apr").textContent    = "APR "+(d.funding.apr>=0?"+":"")+d.funding.apr+"%";
      c("funding-apr").style.color    = fc;
    }
    c("funding-next").textContent = "다음 정산 "+d.funding.nextLabel;

    // 파밍 신호
    const sig   = d.funding.signal;
    const sigEl = c("farming-signal");
    const descEl= c("farming-desc");
    if (sig==="SHORT_COLLECT") {
      sigEl.textContent="🔴 숏 수취 기회";sigEl.style.color="var(--red)";sigEl.style.borderColor="var(--red)";sigEl.style.background="rgba(239,68,68,.1)";
      descEl.textContent="펀딩비 +"+fp+"% — 롱이 숏에 지불";descEl.style.color="var(--red)";
    } else if (sig==="LONG_COLLECT") {
      sigEl.textContent="🟢 롱 수취 기회";sigEl.style.color="var(--green)";sigEl.style.borderColor="var(--green)";sigEl.style.background="rgba(16,185,129,.1)";
      descEl.textContent="펀딩비 "+fp+"% — 숏이 롱에 지불";descEl.style.color="var(--green)";
    } else {
      sigEl.textContent="⚪ 대기 중";sigEl.style.color="var(--muted)";sigEl.style.borderColor="var(--muted)";sigEl.style.background="transparent";
      descEl.textContent="|rate| < 0.03% — 수익성 낮음";descEl.style.color="var(--muted)";
    }
  }

  c("tb-cal").textContent = d.cal.completed+"/"+d.cal.minNeeded;
  c("tb-cal").style.color = d.cal.evPositive?"var(--green)":"var(--yellow)";
  const s=d.uptime;
  c("tb-uptime").textContent = pad(Math.floor(s/3600))+":"+pad(Math.floor(s%3600/60))+":"+pad(s%60);
  c("tb-mode").textContent = d.dryRun?"SIM":"LIVE";
  c("tb-mode").className = "mode-pill "+(d.dryRun?"pill-sim":"pill-live");

  // ─ 스캐너
  const eligible = d.candidates.filter(c=>c.eligible).length;
  c("scan-count").textContent = eligible+"/"+d.candidates.length;
  const sm = selectedMarket || (d.position?.market) || (d.candidates[0]?.market);
  c("scanner").innerHTML = d.candidates.map(ca=>{
    const dot = ca.eligible?"var(--green)":ca.ev>0?"var(--yellow)":"var(--dim)";
    const ev  = ca.ev>0?\`<span style="color:var(--green)">+\${ca.ev}%</span>\`
                       :\`<span style="color:var(--red)">\${ca.ev}%</span>\`;
    const badge = ca.eligible
      ? '<span class="scan-badge go">진입</span>'
      : ca.reasons.length===0
        ? '<span class="scan-badge wait">대기</span>'
        : \`<span class="scan-badge block" title="\${ca.reasons.join(',')}">\${ca.reasons[0]?.replace(/_/g,' ')}</span>\`;
    return \`<div class="scan-row\${ca.market===sm?" active":""}" onclick="selectMarket('\${ca.market}')">
      <div class="scan-dot" style="background:\${dot}"></div>
      <div class="scan-name">\${ca.name}</div>
      <div class="scan-score">\${ca.score}</div>
      <div class="scan-ev">\${ev}</div>
      \${badge}
    </div>\`;
  }).join("");

  // ─ 일일 리스크
  c("d-trades").textContent = d.daily.trades+"회";
  c("d-pnl").textContent    = (d.daily.pnl>=0?"+":"")+fmt(d.daily.pnl)+"원";
  c("d-pnl").style.color    = d.daily.pnl>=0?"var(--green)":"var(--red)";
  c("d-cons").textContent   = d.daily.consLosses+"연속";
  c("d-cons").style.color   = d.daily.consLosses>=2?"var(--red)":d.daily.consLosses===1?"var(--yellow)":"var(--muted)";
  c("d-risk-pct").textContent = d.daily.riskPct.toFixed(1)+"%";
  const riskFill = c("d-risk-bar");
  riskFill.style.width = d.daily.riskPct+"%";
  riskFill.style.background = d.daily.riskPct>80?"var(--red)":d.daily.riskPct>50?"var(--yellow)":"var(--green)";

  // ─ 히스토리
  c("hist-list").innerHTML = d.history.length
    ? d.history.map(h=>{
        const col = h.outcome==="WIN"?"var(--green)":"var(--red)";
        const sym = h.outcome==="WIN"?"▲":"▼";
        return \`<div class="hist-row">
          <span style="color:var(--muted)">\${h.market.replace("KRW-","")}</span>
          <span style="color:\${col}">\${sym} \${fmtPct(h.pnlRate)}</span>
          <span style="color:var(--muted);font-size:.65rem">\${new Date(h.ts).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})}</span>
        </div>\`;
      }).join("")
    : '<div style="color:var(--muted);font-size:.75rem;text-align:center;padding:8px">거래 없음</div>';

  // ─ 포지션
  if(d.position){
    c("pos-block").style.display="";
    c("wait-block").style.display="none";
    const p=d.position;
    c("p-mkt").textContent    = p.market;
    c("p-sub").textContent    = "진입 "+fmt(p.entryPrice)+"원 → 목표 "+fmt(p.targetPrice)+"원";
    c("p-unreal").textContent = fmtPct(p.unrealPnl);
    c("p-unreal").style.color = p.unrealPnl>=0?"var(--green)":"var(--red)";
    c("p-prog").style.width   = p.posProgress+"%";
    c("p-prog").style.background = p.unrealPnl>=0?"var(--green)":"var(--red)";
    c("p-entry").textContent  = "진입 "+fmt(p.entryPrice);
    c("p-target").textContent = "목표 "+fmt(p.targetPrice);

    const stopPrice = p.entryPrice * (1 + p.stopRate/100);
    setPositionLines(p.entryPrice, p.targetPrice, stopPrice);
    if(p.market !== curMarket) loadChart(p.market, curTf);
  } else {
    c("pos-block").style.display="none";
    c("wait-block").style.display="";
    setPositionLines(null);
  }

  // ─ 신호 게이지
  const top = d.topSnap;
  if(top){
    const score = Math.max(0,Math.min(200,top.score));
    const pct   = score/200;
    const circ  = 175.9;
    c("gauge-ring").setAttribute("stroke-dashoffset", circ-pct*circ);
    c("gauge-ring").setAttribute("stroke", top.eligible?"var(--green)":score>100?"var(--yellow)":"var(--red)");
    c("gauge-num").textContent = top.score;
    c("g-mkt").textContent     = top.name;
    c("g-bull").textContent    = "상승확률: "+top.bull+"%";
    c("g-ev").textContent      = "EV: "+(top.ev>0?"+":"")+top.ev+"%";
    c("g-ev").style.color      = top.ev>0?"var(--green)":"var(--red)";
  }

  // ─ 팩터 바
  if(d.signalFactors.length){
    c("factors").innerHTML = d.signalFactors.map(f=>{
      const w = Math.max(0,Math.min(100,f.value)).toFixed(0);
      const col = f.value>60?"var(--green)":f.value>35?"var(--yellow)":"var(--red)";
      return \`<div class="factor-row">
        <div class="factor-lbl">\${f.label}</div>
        <div class="factor-bar"><div class="factor-fill" style="width:\${w}%;background:\${col}"></div></div>
        <div class="factor-val">\${w}</div>
      </div>\`;
    }).join("");
  }

  // ─ 필터 체크리스트
  const groups = {trend:[],signal:[],liquid:[],micro:[],macro:[],ops:[]};
  for(const ck of d.filterChecks){
    const el = \`<span class="ck \${ck.pass?"ok":"fail"}">
      <span class="ck-dot">\${ck.pass?"●":"✕"}</span>\${ck.label}
    </span>\`;
    groups[ck.group]?.push(el);
  }
  for(const [g,els] of Object.entries(groups)){
    const el = c("cg-"+g);
    if(el) el.innerHTML = els.join("");
  }

  // ─ 공포탐욕
  c("fg-lbl").textContent = d.regime;
  c("fg-lbl").style.color = d.regimeColor;
  c("fg-num").textContent = d.fearGreed;
  c("fg-num").style.color = d.regimeColor;
  c("fg-needle").style.left = d.fearGreed+"%";

  // ─ 캘리브레이션
  const calPct = Math.min(d.cal.completed/d.cal.minNeeded, 1);
  c("cal-arc").setAttribute("stroke-dashoffset", 125.7-calPct*125.7);
  c("cal-arc").setAttribute("stroke", d.cal.evPositive?"var(--green)":"var(--yellow)");
  c("cal-n").textContent  = d.cal.completed;
  c("c-ema").textContent  = d.cal.onlineWinRate!=null ? d.cal.onlineWinRate+"%" : "—";
  c("c-wr").textContent   = d.cal.winRate!=null ? d.cal.winRate+"%" : "—";
  c("c-ev").textContent   = d.cal.ev!=null ? fmtPct(d.cal.ev) : "—";
  c("c-ev").style.color   = d.cal.ev!=null && d.cal.ev>0 ? "var(--green)" : "var(--red)";
  c("c-kelly").textContent = d.cal.kelly!=null ? d.cal.kelly+"%" : "—";
  c("c-pend").textContent  = d.cal.pending+"건";

  // ─ Alpha Performance
  if(d.alpha){
    const al = d.alpha;
    c("alpha-section").style.display = "";
    c("al-tape").textContent = al.tapeAccuracy!=null ? al.tapeAccuracy+"%" : "—";
    c("al-tape").style.color = al.tapeAccuracy!=null && al.tapeAccuracy>=60 ? "var(--green)" : al.tapeAccuracy!=null && al.tapeAccuracy<40 ? "var(--red)" : "var(--text)";
    c("al-timing").textContent = al.avgEntryTiming>0 ? al.avgEntryTiming+"분" : "—";
    c("al-kimchi").textContent = al.kimchiEdge!=null ? (al.kimchiEdge>=0?"+":"")+al.kimchiEdge+"%" : "—";
    c("al-kimchi").style.color = al.kimchiEdge!=null && al.kimchiEdge>0 ? "var(--green)" : al.kimchiEdge!=null && al.kimchiEdge<0 ? "var(--red)" : "var(--text)";
    c("al-trades").textContent = al.totalTrades+"건";
    c("al-best").textContent = al.bestStrategy || "—";
    c("al-best").style.color = al.bestStrategy==="STRONG_BUY" ? "var(--green)" : al.bestStrategy==="BUY" ? "var(--cyan)" : "var(--text)";
    c("al-pnl").textContent = al.avgPnl!=null ? (al.avgPnl>=0?"+":"")+al.avgPnl+"%" : "—";
    c("al-pnl").style.color = al.avgPnl>0 ? "var(--green)" : al.avgPnl<0 ? "var(--red)" : "var(--text)";
    c("al-wr").textContent = al.winRate>0 ? al.winRate+"%" : "—";
    c("al-wr").style.color = al.winRate>=50 ? "var(--green)" : al.winRate>0 ? "var(--red)" : "var(--text)";
  } else {
    c("alpha-section").style.display = "none";
  }

  // ─ Strategy A
  if(d.strategyA){
    const sA = d.strategyA;
    const aColor = sA.pnlRate>=0?"var(--green)":"var(--red)";
    c("sa-pnl").textContent = (sA.pnlRate>=0?"+":"")+sA.pnlRate+"%";
    c("sa-pnl").style.color = aColor;
    c("sa-asset").textContent = fmt(sA.totalAsset)+"원 | "+sA.totalTrades+"회";
    c("sa-wr").textContent = sA.winRate!=null ? "승률 "+sA.winRate+"%" : "승률 —";
    if(sA.position){
      const p=sA.position;
      c("sa-pos").innerHTML = \`<span style="color:var(--cyan);font-weight:700">\${p.market}</span>
        &nbsp;진입 \${fmt(p.entryPrice)}→목표 \${fmt(p.targetPrice)}
        \${p.trailStop?'<span style="color:var(--yellow)"> 🔒트레일</span>':""}\`;
    } else {
      c("sa-pos").textContent = "포지션 없음 — 신호 대기";
    }
    c("sa-hist").innerHTML = (sA.history||[]).slice(0,6).map(h=>{
      const col=h.pnlRate>=0?"var(--green)":"var(--red)";
      return \`<span class="strat-tag" style="border-color:\${col};color:\${col}">\${h.market.replace("KRW-","")}&nbsp;\${h.pnlRate>=0?"+":""}\${(h.pnlRate*100).toFixed(1)}%</span>\`;
    }).join("");
  }

  // ─ Strategy B
  if(d.strategyB){
    const sB = d.strategyB;
    const bColor = sB.pnlRate>=0?"var(--green)":"var(--red)";
    c("sb-pnl").textContent = (sB.pnlRate>=0?"+":"")+sB.pnlRate+"%";
    c("sb-pnl").style.color = bColor;
    c("sb-asset").textContent = fmt(sB.totalAsset)+"원 | "+sB.totalTrades+"회";
    c("sb-monitor").textContent = (sB.monitoringCount||0)+"개 감시";
    const det = (sB.detections||[])[0];
    if(det){
      const stCol = det.status.includes("청산")?"var(--muted)":det.status==="진입완료"?"var(--cyan)":"var(--purple)";
      c("sb-detect").innerHTML = \`<span style="color:var(--purple);font-weight:700">\${det.market}</span>
        &nbsp;<span style="color:\${stCol}">\${det.status}</span>
        \${det.finalPnl!=null?'&nbsp;<span style="color:'+(det.finalPnl>=0?"var(--green)":"var(--red)")+'">'+det.finalPnl+'%</span>':""}\`;
    } else {
      c("sb-detect").textContent = "🔍 신규상장 감시 중...";
    }
    // 오픈 포지션 실시간 손익
    const positions = sB.positions||[];
    if(positions.length>0){
      c("sb-positions").innerHTML = positions.map(p=>{
        const uPct = p.unrealizedPct;
        const uCol = uPct==null?"var(--muted)":uPct>=0?"var(--green)":"var(--red)";
        const trail = p.trailActive ? \`<span style="color:var(--cyan);font-size:.6rem"> 트레일 🟢</span>\` : "";
        const partial = p.partialDone ? \`<span style="color:var(--yellow);font-size:.6rem"> 50%청산완료</span>\` : "";
        const stopDist = p.currentPrice && p.stopPrice
          ? ((p.currentPrice - p.stopPrice)/p.stopPrice*100).toFixed(1)
          : null;
        return \`<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:var(--bg);border-radius:5px;border:1px solid var(--border);margin-bottom:3px;font-size:.68rem">
          <span style="color:var(--purple);font-weight:700">\${p.market.replace("KRW-","")}</span>
          <span style="color:var(--muted)">@\${(p.entryPrice||0).toLocaleString()}</span>
          <span style="color:\${uCol};font-weight:700">\${uPct!=null?(uPct>=0?"+":"")+uPct+"%":"—"}</span>
          \${stopDist?'<span style="color:var(--muted)">손절까지 '+stopDist+'%</span>':""}
          \${partial}\${trail}
        </div>\`;
      }).join("");
    } else {
      c("sb-positions").innerHTML = "";
    }
    c("sb-hist").innerHTML = (sB.history||[]).slice(0,8).map(h=>{
      const col=h.pnlRate>=0?"var(--green)":"var(--red)";
      return \`<span class="strat-tag" style="border-color:\${col};color:\${col}">\${h.market.replace("KRW-","")}&nbsp;\${h.pnlRate>=0?"+":""}\${(h.pnlRate*100).toFixed(1)}%</span>\`;
    }).join("");
  }

  // ─ 거래 로그
  if(d.recentTrades && d.recentTrades.length){
    c("trade-stats").textContent = (d.tradeStats?.total||0)+"건 | "+(d.tradeStats?.winRate!=null?d.tradeStats.winRate+"%":"—")+" 승률";
    c("trade-log").innerHTML = d.recentTrades.map(t=>{
      const isBuy = t.side==="BUY";
      const sideClass = isBuy?"side-buy":"side-sell";
      const sideLabel = isBuy?"매수":"매도";
      const pnlHtml = !isBuy && t.pnlRate!=null
        ? \`<span class="trade-pnl" style="color:\${t.pnlRate>=0?"var(--green)":"var(--red)"}">\${t.pnlRate>=0?"+":""}\${(t.pnlRate*100).toFixed(1)}%</span>\`
        : (isBuy && t.qualityScore!=null ? \`<span class="trade-pnl" style="color:var(--purple)">Q:\${t.qualityScore}</span>\` : '<span></span>');
      const badges = [];
      if(t.partial) badges.push('<span class="trade-badge badge-partial">부분</span>');
      if(t.trail)   badges.push('<span class="trade-badge badge-trail">트레일</span>');
      if(t.dryRun)  badges.push('<span class="trade-badge badge-dry">SIM</span>');
      const reasonHtml = t.reason ? \`<span class="trade-reason">\${t.reason}</span>\` : "";
      const timeStr = t.createdAt ? new Date(t.createdAt).toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "";
      return \`<div class="trade-row">
        <span class="trade-side \${sideClass}">\${sideLabel}</span>
        <span class="trade-mkt">\${t.market.replace("KRW-","")}</span>
        <span class="trade-detail">
          <span class="trade-price">\${Math.round(t.price).toLocaleString()}원</span>
          \${pnlHtml}
          \${reasonHtml}
        </span>
        <span class="trade-meta">\${badges.join("")}</span>
        <span class="trade-time">\${timeStr}</span>
      </div>\`;
    }).join("");
  } else {
    c("trade-log").innerHTML = '<div style="color:var(--muted);font-size:.74rem;text-align:center;padding:16px">아직 거래 기록이 없습니다</div>';
  }

  // ─ 자본곡선
  drawEquity(d.equityCurve);

  // ─ 차트 마켓 전환
  if(!d.position && sm && sm !== curMarket && !selectedMarket){
    loadChart(sm, curTf);
  }
}

function selectMarket(mkt){
  selectedMarket = mkt;
  loadChart(mkt, curTf);
  document.querySelectorAll(".scan-row").forEach(r=>{
    r.classList.toggle("active", r.textContent.includes(mkt.replace("KRW-","")));
  });
}
</script>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }
}

module.exports = { DashboardServer };
