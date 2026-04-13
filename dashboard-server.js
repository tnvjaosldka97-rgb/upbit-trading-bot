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
    this.port = Number(process.env.PORT || 3000);
    this.sseClients = new Set();
    setInterval(() => this._broadcast(), 2000);
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.url === "/health")      return this._health(res);
      if (req.url === "/api/status")  return this._status(res);
      if (req.url === "/api/stream")  return this._sse(req, res);
      return this._page(res);
    });
    this.server.listen(this.port, () =>
      console.log(`[Dashboard] http://localhost:${this.port}`));
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

  // ── 데이터 수집 ─────────────────────────────────────────
  _getData() {
    const bot   = this.bot;
    const sim   = bot.mds?.state?.simulation;
    const cal   = bot.calibration?.getSummary();
    const snaps = (bot.mds?.state?.lastAnalysisSnapshots || []).slice(0, 6);
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
      history: hist.slice(0, 10).map(h => ({
        market: h.marketCode || h.market || "?",
        outcome: h.outcome,
        pnlRate: h.realizedRate != null ? +(h.realizedRate * 100).toFixed(3) : 0,
        ts: h.exitedAt || h.closedAt || 0,
      })),
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
  --text:#e2e8f0;--muted:#4a5568;--dim:#2d3748;
  --blue:#3b82f6;--cyan:#06b6d4;--green:#10b981;--red:#ef4444;
  --yellow:#f59e0b;--purple:#8b5cf6;--orange:#f97316;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'SF Pro Display',sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden;display:flex;flex-direction:column}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--dim);border-radius:2px}

/* ─── 탑바 ─── */
.topbar{
  display:flex;align-items:center;gap:0;
  height:50px;border-bottom:1px solid var(--border);
  background:linear-gradient(90deg,#060b14,#0a1020);
  flex-shrink:0;padding:0 16px;gap:12px;
}
.logo{font-size:1rem;font-weight:800;color:var(--cyan);letter-spacing:1px;white-space:nowrap}
.tb-sep{width:1px;height:24px;background:var(--border)}
.tb-stat{display:flex;flex-direction:column;align-items:center;padding:0 12px;cursor:default}
.tb-stat .lbl{font-size:.6rem;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.tb-stat .val{font-size:.95rem;font-weight:700;line-height:1.2}
.tb-right{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:.72rem;color:var(--muted)}
.live-ring{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.mode-pill{padding:2px 9px;border-radius:99px;font-size:.68rem;font-weight:700;border:1px solid}
.pill-sim{color:var(--yellow);border-color:var(--yellow);background:rgba(245,158,11,.08)}
.pill-live{color:var(--green);border-color:var(--green);background:rgba(16,185,129,.08)}

/* ─── 메인 그리드 ─── */
.main{display:grid;grid-template-columns:260px 1fr 300px;flex:1;overflow:hidden;gap:0}

/* ─── 패널 공통 ─── */
.panel{border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column;gap:0}
.panel:last-child{border-right:none}
.sec{padding:12px 14px;border-bottom:1px solid var(--border)}
.sec-title{font-size:.6rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between}

/* ─── 스캐너 ─── */
.scan-row{
  display:flex;align-items:center;gap:6px;
  padding:6px 8px;border-radius:6px;cursor:pointer;
  transition:background .12s;border:1px solid transparent;margin-bottom:2px;
}
.scan-row:hover{background:rgba(255,255,255,.03)}
.scan-row.active{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.25)}
.scan-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.scan-name{font-size:.82rem;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.scan-score{font-size:.7rem;color:var(--muted);width:32px;text-align:right}
.scan-ev{font-size:.7rem;font-weight:600;width:50px;text-align:right}
.scan-badge{font-size:.6rem;padding:1px 5px;border-radius:4px;white-space:nowrap}
.go{background:rgba(16,185,129,.15);color:var(--green)}
.wait{background:rgba(74,85,104,.15);color:var(--muted)}
.block{background:rgba(239,68,68,.1);color:var(--red)}

/* ─── 히스토리 ─── */
.hist-row{display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(26,39,68,.5);font-size:.75rem}
.hist-row:last-child{border-bottom:none}

/* ─── 리스크 바 ─── */
.risk-bar{height:5px;background:var(--dim);border-radius:3px;overflow:hidden;margin-top:5px}
.risk-fill{height:100%;border-radius:3px;transition:width .5s}

/* ─── 차트 영역 ─── */
.chart-panel{display:flex;flex-direction:column;overflow:hidden}
.chart-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 14px;border-bottom:1px solid var(--border);flex-shrink:0;
}
.chart-info{display:flex;flex-direction:column}
.chart-mkt{font-size:.95rem;font-weight:700}
.chart-px{font-size:.72rem;color:var(--muted);margin-top:1px}
.tf-group{display:flex;gap:3px}
.tf-btn{padding:3px 9px;border-radius:5px;font-size:.7rem;cursor:pointer;border:1px solid var(--border);color:var(--muted);background:transparent;transition:all .12s}
.tf-btn.on{background:var(--blue);border-color:var(--blue);color:#fff}
#tv-chart{flex:1;min-height:0}
.equity-strip{height:90px;border-top:1px solid var(--border);flex-shrink:0;padding:8px 14px 6px}
.eq-lbl{font-size:.58rem;color:var(--muted);margin-bottom:3px}
#eq-svg{width:100%;height:62px}

/* ─── 예측 패널 ─── */
.pred-panel{display:flex;flex-direction:column;overflow-y:auto}

/* 포지션 / 대기 */
.pos-block{padding:12px 14px;border-bottom:1px solid var(--border)}
.pos-mkt{font-size:1rem;font-weight:800;color:var(--cyan)}
.pos-sub{font-size:.7rem;color:var(--muted);margin-top:2px}
.unreal{font-size:1.6rem;font-weight:800;margin:6px 0 4px}
.pos-prog{height:4px;background:var(--dim);border-radius:2px;overflow:hidden}
.pos-fill{height:100%;border-radius:2px;transition:width .4s}
.wait-block{padding:14px;border-bottom:1px solid var(--border);text-align:center;color:var(--muted);font-size:.82rem}

/* 신호 점수 게이지 */
.gauge-wrap{padding:14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px}
.gauge-svg-wrap{flex-shrink:0}
.gauge-info{flex:1}
.gauge-title{font-size:.6rem;color:var(--muted);text-transform:uppercase;letter-spacing:.7px}
.gauge-mkt{font-size:.9rem;font-weight:700;margin-top:2px}
.gauge-sub{font-size:.72rem;color:var(--muted);margin-top:2px}
.gauge-ev{font-size:.82rem;font-weight:700;margin-top:4px}

/* 팩터 바 */
.factor-row{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.factor-lbl{font-size:.68rem;color:var(--muted);width:60px;flex-shrink:0;text-align:right}
.factor-bar{flex:1;height:5px;background:var(--dim);border-radius:3px;overflow:hidden}
.factor-fill{height:100%;border-radius:3px;transition:width .5s}
.factor-val{font-size:.65rem;width:28px;text-align:right;color:var(--muted)}

/* 필터 체크리스트 */
.checklist{padding:10px 14px;border-bottom:1px solid var(--border)}
.check-group{margin-bottom:6px}
.check-glbl{font-size:.58rem;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
.checks{display:flex;flex-wrap:wrap;gap:4px}
.ck{display:flex;align-items:center;gap:3px;font-size:.65rem;padding:2px 6px;border-radius:4px;border:1px solid}
.ck.ok{color:var(--green);border-color:rgba(16,185,129,.25);background:rgba(16,185,129,.06)}
.ck.fail{color:var(--red);border-color:rgba(239,68,68,.25);background:rgba(239,68,68,.06)}
.ck.warn{color:var(--yellow);border-color:rgba(245,158,11,.25);background:rgba(245,158,11,.06)}
.ck-dot{font-size:.6rem}

/* 공포탐욕 */
.fg-section{padding:10px 14px;border-bottom:1px solid var(--border)}
.fg-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.fg-lbl{font-size:.85rem;font-weight:700}
.fg-num{font-size:1.4rem;font-weight:800}
.fg-bar{height:8px;border-radius:4px;background:linear-gradient(90deg,#ef4444 0%,#f97316 20%,#eab308 40%,#10b981 60%,#3b82f6 80%,#8b5cf6 100%);position:relative}
.fg-needle{position:absolute;top:-4px;width:3px;height:16px;background:#fff;border-radius:1px;transform:translateX(-50%);transition:left .6s ease;box-shadow:0 0 4px rgba(0,0,0,.5)}

/* 캘리브레이션 */
.cal-section{padding:10px 14px;border-bottom:1px solid var(--border)}
.cal-row{display:flex;align-items:center;gap:10px}
.cal-stats{flex:1}
.stat-line{display:flex;justify-content:space-between;font-size:.72rem;padding:2px 0}
.sl-lbl{color:var(--muted)}
.sl-val{font-weight:600}

/* 반응형 */
@media(max-width:900px){
  .main{grid-template-columns:1fr}
  .chart-panel,.pred-panel{display:none}
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
    <span class="lbl">레짐</span>
    <span class="val" id="tb-regime">—</span>
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
  chartEl.style.height = (window.innerHeight - 50 - 90 - 40) + "px";
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
