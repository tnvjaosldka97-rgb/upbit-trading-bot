"use strict";

const http = require("http");

class DashboardServer {
  constructor(bot) {
    this.bot = bot;
    this.server = null;
    this.port = Number(process.env.PORT || 3000);
    this.sseClients = new Set();

    // SSE 브로드캐스트 — 3초마다 푸시
    setInterval(() => this._broadcast(), 3000);
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.url === "/health")       return this._handleHealth(res);
      if (req.url === "/api/status")   return this._handleStatus(res);
      if (req.url === "/api/stream")   return this._handleSSE(req, res);
      return this._handleDashboard(res);
    });
    this.server.listen(this.port, () => {
      console.log(`[Dashboard] http://localhost:${this.port}`);
    });
  }

  stop() { this.server?.close(); }

  // ── SSE ─────────────────────────────────────────────────
  _handleSSE(req, res) {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("retry: 3000\n\n");
    this.sseClients.add(res);
    req.on("close", () => this.sseClients.delete(res));
  }

  _broadcast() {
    if (!this.sseClients.size) return;
    const payload = JSON.stringify(this._getData());
    for (const client of this.sseClients) {
      try { client.write(`data: ${payload}\n\n`); } catch { this.sseClients.delete(client); }
    }
  }

  // ── Data ────────────────────────────────────────────────
  _getData() {
    const bot  = this.bot;
    const sim  = bot.mds?.state?.simulation;
    const cal  = bot.calibration?.getSummary();
    const snaps = bot.mds?.state?.lastAnalysisSnapshots || [];

    const totalAsset  = bot.mds?.getSimulationTotalAsset?.() || 0;
    const initialCap  = sim?.initialCapital || 100000;
    const pnlRate     = totalAsset > 0 ? (totalAsset - initialCap) / initialCap * 100 : 0;
    const fearGreed   = bot.macroEngine?.state?.fearGreed?.value ?? 50;

    // 자본곡선: 최근 50건 거래 수익률 누적
    const returns     = sim?.tradeReturns || [];
    const equityCurve = (() => {
      let v = 1;
      return [1, ...returns.slice(-50).map(r => { v *= (1 + r * 0.08); return +v.toFixed(5); })];
    })();

    // 포지션 미실현 손익
    let unrealizedPnl = 0;
    const pos = sim?.activePosition;
    if (pos) {
      const cur = bot.mds?.getCurrentPrice?.(bot.mds?.ensureContext?.(pos.marketCode)) || 0;
      if (cur > 0) unrealizedPnl = (cur - pos.averageBuyPrice) / pos.averageBuyPrice * 100;
    }

    return {
      ts:        Date.now(),
      pnlRate:   +pnlRate.toFixed(3),
      totalAsset: Math.round(totalAsset),
      initialCap,
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
      regimeColor: fearGreed < 25 ? "#f85149" : fearGreed < 45 ? "#ff7b72" : fearGreed < 55 ? "#8b949e" : fearGreed < 75 ? "#3fb950" : "#58a6ff",
      daily: {
        trades: sim?.daily?.trades || 0,
        pnl:    Math.round(sim?.daily?.pnl || 0),
        consLosses: sim?.daily?.consecutiveLosses || 0,
        halted: sim?.daily?.halted || false,
      },
      cal: {
        completed:   cal?.totalCompleted || 0,
        winRate:     cal?.currentWinRate != null ? +(cal.currentWinRate * 100).toFixed(1) : null,
        onlineWinRate: cal?.onlineWinRate != null ? +(cal.onlineWinRate * 100).toFixed(1) : null,
        ev:          cal?.calibratedConfig?.ev != null ? +(cal.calibratedConfig.ev * 100).toFixed(3) : null,
        kelly:       cal?.calibratedConfig?.kellyFraction != null ? +(cal.calibratedConfig.kellyFraction * 100).toFixed(1) : null,
        evPositive:  cal?.calibratedConfig?.evPositive || false,
      },
      position: pos ? {
        market:       pos.marketCode,
        entryPrice:   Math.round(pos.averageBuyPrice),
        targetPrice:  Math.round(pos.targetSellPrice),
        stopRate:     +(pos.dynamicStopRate * 100).toFixed(2),
        openedAt:     pos.openedAt,
        unrealizedPnl: +unrealizedPnl.toFixed(3),
      } : null,
      candidates: snaps.slice(0, 5).map(s => ({
        market:    s.market,
        name:      s.koreanName || s.market.replace("KRW-", ""),
        score:     s.smoothedScore != null ? +s.smoothedScore.toFixed(1) : 0,
        bull:      s.bullishProbability != null ? +s.bullishProbability.toFixed(1) : 0,
        ev:        s.ev != null ? +(s.ev * 100).toFixed(3) : 0,
        eligible:  s.eligible,
        price:     s.currentPrice || 0,
        reasons:   (s.reasons || []).slice(0, 2),
      })),
      equityCurve,
      tvMarket: pos?.marketCode || snaps[0]?.market || "KRW-BTC",
    };
  }

  _handleHealth(res) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  }

  _handleStatus(res) {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(this._getData(), null, 2));
  }

  // ── HTML ────────────────────────────────────────────────
  _handleDashboard(res) {
    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ATS v9 대시보드</title>
  <script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    :root {
      --bg:      #0a0e1a;
      --surface: #111827;
      --border:  #1f2937;
      --text:    #e2e8f0;
      --muted:   #6b7280;
      --blue:    #3b82f6;
      --green:   #10b981;
      --red:     #ef4444;
      --yellow:  #f59e0b;
      --purple:  #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Pro Display', -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }

    /* ── 헤더 ── */
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 24px; border-bottom: 1px solid var(--border);
      background: linear-gradient(90deg, #0a0e1a 0%, #111827 100%);
    }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .logo { font-size: 1.1rem; font-weight: 700; color: var(--blue); letter-spacing: .5px; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.5; transform:scale(1.3); } }
    .header-right { display: flex; align-items: center; gap: 16px; font-size: .78rem; color: var(--muted); }
    .mode-badge { padding: 3px 10px; border-radius: 99px; font-size: .72rem; font-weight: 600; border: 1px solid; }
    .mode-sim  { color: var(--yellow); border-color: var(--yellow); background: rgba(245,158,11,.08); }
    .mode-live { color: var(--green);  border-color: var(--green);  background: rgba(16,185,129,.08); }

    /* ── 레이아웃 ── */
    .main { display: grid; grid-template-columns: 340px 1fr; gap: 0; height: calc(100vh - 57px); }
    .sidebar { border-right: 1px solid var(--border); overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .chart-area { display: flex; flex-direction: column; }

    /* ── 카드 ── */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
    .card-title { font-size: .68rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; margin-bottom: 10px; }

    /* ── PnL 메인 ── */
    .pnl-main { font-size: 2.4rem; font-weight: 800; letter-spacing: -1px; line-height: 1; }
    .pnl-sub  { font-size: .82rem; color: var(--muted); margin-top: 4px; }
    .stat-row { display: flex; justify-content: space-between; font-size: .8rem; padding: 4px 0; border-bottom: 1px solid var(--border); }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: var(--muted); }
    .stat-value { font-weight: 600; }

    /* ── 포지션 ── */
    .pos-card { border-color: var(--green); background: rgba(16,185,129,.04); }
    .pos-market { font-size: 1rem; font-weight: 700; color: var(--green); }
    .pos-price  { font-size: .8rem; color: var(--muted); margin-top: 2px; }
    .unreal { font-size: 1.5rem; font-weight: 700; margin: 6px 0; }
    .progress-bar { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; margin-top: 8px; }
    .progress-fill { height: 100%; border-radius: 2px; transition: width .5s ease; }

    /* ── 후보 ── */
    .cand-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); cursor: pointer; transition: background .15s; border-radius: 6px; padding-left: 4px; }
    .cand-row:hover { background: rgba(255,255,255,.03); }
    .cand-row:last-child { border-bottom: none; }
    .cand-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .cand-name { font-size: .85rem; font-weight: 600; flex: 1; }
    .cand-score { font-size: .75rem; color: var(--muted); }
    .cand-ev { font-size: .75rem; font-weight: 600; }
    .cand-badge { font-size: .65rem; padding: 1px 6px; border-radius: 99px; font-weight: 600; }
    .badge-go  { background: rgba(16,185,129,.15); color: var(--green); }
    .badge-wait { background: rgba(107,114,128,.12); color: var(--muted); }

    /* ── 차트 ── */
    .chart-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--border); }
    .chart-market { font-size: 1rem; font-weight: 700; }
    .chart-tabs { display: flex; gap: 4px; }
    .tab { padding: 4px 12px; border-radius: 6px; font-size: .75rem; cursor: pointer; border: 1px solid var(--border); color: var(--muted); background: transparent; transition: all .15s; }
    .tab.active { background: var(--blue); border-color: var(--blue); color: #fff; }
    #tv-chart { flex: 1; }

    /* ── 자본 곡선 ── */
    .equity-wrap { padding: 12px 20px; border-top: 1px solid var(--border); height: 110px; }
    .equity-label { font-size: .65rem; color: var(--muted); margin-bottom: 4px; }
    #equity-svg { width: 100%; height: 72px; }

    /* ── 공포탐욕 게이지 ── */
    .fg-bar { height: 6px; border-radius: 3px; margin-top: 6px; background: linear-gradient(90deg, #ef4444 0%, #f59e0b 33%, #10b981 66%, #3b82f6 100%); position: relative; }
    .fg-needle { position: absolute; top: -4px; width: 2px; height: 14px; background: #fff; border-radius: 1px; transform: translateX(-50%); transition: left .5s ease; }

    /* ── 캘리브레이션 ── */
    .cal-ring { display: flex; align-items: center; gap: 12px; }
    .ring-svg { flex-shrink: 0; }
    .cal-stats { flex: 1; }

    /* ── 반응형 ── */
    @media (max-width: 900px) {
      .main { grid-template-columns: 1fr; }
      .chart-area { display: none; }
    }
  </style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="live-dot"></div>
    <div class="logo">⚡ ATS v9</div>
  </div>
  <div class="header-right">
    <span id="h-uptime">—</span>
    <span id="h-mode" class="mode-badge mode-sim">SIM</span>
    <span id="h-ts" style="font-size:.7rem">—</span>
  </div>
</div>

<div class="main">
  <!-- ── 사이드바 ── -->
  <div class="sidebar">

    <!-- PnL 메인 -->
    <div class="card">
      <div class="card-title">포트폴리오</div>
      <div id="pnl-main" class="pnl-main" style="color:var(--green)">—</div>
      <div id="pnl-sub"  class="pnl-sub">총 자산 로딩 중...</div>
      <div style="margin-top:10px">
        <div class="stat-row"><span class="stat-label">실현 손익</span><span id="s-rpnl" class="stat-value">—</span></div>
        <div class="stat-row"><span class="stat-label">총 거래</span><span id="s-trades" class="stat-value">—</span></div>
        <div class="stat-row"><span class="stat-label">승률</span><span id="s-winrate" class="stat-value">—</span></div>
        <div class="stat-row"><span class="stat-label">샤프</span><span id="s-sharpe" class="stat-value">—</span></div>
        <div class="stat-row"><span class="stat-label">오늘</span><span id="s-daily" class="stat-value">—</span></div>
      </div>
    </div>

    <!-- 포지션 -->
    <div id="pos-card" class="card" style="display:none">
      <div class="card-title">📈 포지션</div>
      <div id="pos-market" class="pos-market">—</div>
      <div id="pos-price"  class="pos-price">—</div>
      <div id="pos-unreal" class="unreal">—</div>
      <div class="progress-bar"><div id="pos-bar" class="progress-fill" style="width:0%;background:var(--green)"></div></div>
    </div>
    <div id="nopos-card" class="card" style="color:var(--muted);font-size:.85rem;text-align:center;padding:10px">
      ⏳ 신호 대기 중
    </div>

    <!-- 공포탐욕 -->
    <div class="card">
      <div class="card-title">시장 레짐</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div id="fg-label" style="font-size:1.1rem;font-weight:700">—</div>
        <div id="fg-val"   style="font-size:1.5rem;font-weight:800;color:var(--blue)">—</div>
      </div>
      <div class="fg-bar"><div id="fg-needle" class="fg-needle" style="left:50%"></div></div>
    </div>

    <!-- 캘리브레이션 -->
    <div class="card">
      <div class="card-title">캘리브레이션</div>
      <div class="cal-ring">
        <svg class="ring-svg" width="56" height="56" viewBox="0 0 56 56">
          <circle cx="28" cy="28" r="22" fill="none" stroke="var(--border)" stroke-width="5"/>
          <circle id="cal-ring" cx="28" cy="28" r="22" fill="none" stroke="var(--blue)" stroke-width="5"
            stroke-dasharray="138.2" stroke-dashoffset="138.2" stroke-linecap="round"
            transform="rotate(-90 28 28)" style="transition:stroke-dashoffset .6s ease"/>
          <text x="28" y="33" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="700" id="cal-num">0</text>
        </svg>
        <div class="cal-stats">
          <div class="stat-row"><span class="stat-label">EMA 승률</span><span id="c-ema" class="stat-value">—</span></div>
          <div class="stat-row"><span class="stat-label">EV</span><span id="c-ev" class="stat-value">—</span></div>
          <div class="stat-row"><span class="stat-label">켈리</span><span id="c-kelly" class="stat-value">—</span></div>
        </div>
      </div>
    </div>

    <!-- 상위 후보 -->
    <div class="card">
      <div class="card-title">상위 후보</div>
      <div id="candidates"></div>
    </div>

  </div><!-- /sidebar -->

  <!-- ── 차트 영역 ── -->
  <div class="chart-area">
    <div class="chart-header">
      <div>
        <div id="chart-market" class="chart-market">KRW-BTC</div>
        <div id="chart-price"  style="font-size:.8rem;color:var(--muted)">—</div>
      </div>
      <div class="chart-tabs">
        <button class="tab active" onclick="setTf(1,  this)">1m</button>
        <button class="tab"        onclick="setTf(3,  this)">3m</button>
        <button class="tab"        onclick="setTf(5,  this)">5m</button>
        <button class="tab"        onclick="setTf(15, this)">15m</button>
      </div>
    </div>
    <div id="tv-chart"></div>
    <div class="equity-wrap">
      <div class="equity-label">자본 곡선 (최근 50거래)</div>
      <svg id="equity-svg" preserveAspectRatio="none"></svg>
    </div>
  </div>

</div>

<script>
// ── 차트 초기화 ──────────────────────────────────────────
const { createChart, CandlestickSeries, LineSeries, ColorType } = LightweightCharts;

const chartEl = document.getElementById("tv-chart");
chartEl.style.height = (window.innerHeight - 57 - 110 - 50) + "px";

const chart = createChart(chartEl, {
  layout: { background: { type: ColorType.Solid, color: "#111827" }, textColor: "#6b7280" },
  grid:   { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
  crosshair: { mode: 1 },
  rightPriceScale: { borderColor: "#1f2937" },
  timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
  handleScroll: true,
  handleScale:  true,
});

const candleSeries = chart.addSeries(CandlestickSeries, {
  upColor: "#10b981", downColor: "#ef4444",
  borderUpColor: "#10b981", borderDownColor: "#ef4444",
  wickUpColor: "#10b981", wickDownColor: "#ef4444",
});

let currentMarket = "KRW-BTC";
let currentTf     = 1;

async function loadChart(market, tf) {
  currentMarket = market;
  currentTf     = tf;
  document.getElementById("chart-market").textContent = market;
  try {
    const url = \`https://api.upbit.com/v1/candles/minutes/\${tf}?market=\${market}&count=200\`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data)) return;
    const candles = data.reverse().map(c => ({
      time:  Math.floor(new Date(c.candle_date_time_utc).getTime() / 1000),
      open:  c.opening_price,
      high:  c.high_price,
      low:   c.low_price,
      close: c.trade_price,
    }));
    candleSeries.setData(candles);
    chart.timeScale().fitContent();
    const last = candles[candles.length - 1];
    if (last) document.getElementById("chart-price").textContent =
      last.close.toLocaleString() + "원  " + (last.close >= last.open ? "▲" : "▼");
  } catch(e) { console.warn("차트 로드 실패:", e); }
}

function setTf(tf, btn) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  loadChart(currentMarket, tf);
}

// 30초마다 차트 자동 갱신
setInterval(() => loadChart(currentMarket, currentTf), 30000);
loadChart(currentMarket, currentTf);

// ── 자본곡선 SVG ─────────────────────────────────────────
function drawEquity(curve) {
  const svg = document.getElementById("equity-svg");
  if (curve.length < 2) return;
  const W = svg.clientWidth || 600, H = 72;
  const min = Math.min(...curve), max = Math.max(...curve);
  const range = max - min || 0.0001;
  const pts = curve.map((v, i) => {
    const x = (i / (curve.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 8) - 4;
    return \`\${x.toFixed(1)},\${y.toFixed(1)}\`;
  }).join(" ");
  const last = curve[curve.length - 1];
  const color = last >= 1 ? "#10b981" : "#ef4444";
  svg.innerHTML = \`
    <defs>
      <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="\${color}" stop-opacity=".25"/>
        <stop offset="100%" stop-color="\${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="\${pts} \${W},\${H} 0,\${H}" fill="url(#eg)"/>
    <polyline points="\${pts}" fill="none" stroke="\${color}" stroke-width="1.5"/>\`;
}

// ── SSE 실시간 업데이트 ──────────────────────────────────
const evtSource = new EventSource("/api/stream");

evtSource.onmessage = (e) => {
  const d = JSON.parse(e.data);
  updateUI(d);
};

evtSource.onerror = () => {
  document.getElementById("h-ts").textContent = "⚠ 연결 끊김";
  setTimeout(() => location.reload(), 5000);
};

function fmt(n) { return n != null ? n.toLocaleString() : "—"; }
function fmtPct(n, suffix="%") { return n != null ? (n >= 0 ? "+" : "") + n + suffix : "—"; }

function updateUI(d) {
  // 헤더
  const pad = n => String(n).padStart(2,"0");
  const s = d.uptime; document.getElementById("h-uptime").textContent = pad(Math.floor(s/3600))+":"+pad(Math.floor(s%3600/60))+":"+pad(s%60);
  document.getElementById("h-ts").textContent = new Date(d.ts).toLocaleTimeString("ko-KR");
  const modeEl = document.getElementById("h-mode");
  modeEl.textContent = d.dryRun ? "SIM" : "LIVE";
  modeEl.className = "mode-badge " + (d.dryRun ? "mode-sim" : "mode-live");

  // PnL
  const col = d.pnlRate >= 0 ? "var(--green)" : "var(--red)";
  document.getElementById("pnl-main").style.color = col;
  document.getElementById("pnl-main").textContent = (d.pnlRate >= 0 ? "+" : "") + d.pnlRate + "%";
  document.getElementById("pnl-sub").textContent  = "총 자산 " + fmt(d.totalAsset) + "원";
  document.getElementById("s-rpnl").textContent    = (d.realizedPnl >= 0 ? "+" : "") + fmt(d.realizedPnl) + "원";
  document.getElementById("s-rpnl").style.color    = d.realizedPnl >= 0 ? "var(--green)" : "var(--red)";
  document.getElementById("s-trades").textContent  = d.totalTrades + "건";
  document.getElementById("s-winrate").textContent = d.winRate != null ? d.winRate + "% (" + d.wins + "승/" + d.losses + "패)" : "—";
  document.getElementById("s-sharpe").textContent  = d.sharpe != null ? d.sharpe : "—";
  document.getElementById("s-daily").textContent   = d.daily.trades + "회 " + (d.daily.pnl >= 0 ? "+" : "") + fmt(d.daily.pnl) + "원";

  // 공포탐욕
  document.getElementById("fg-label").textContent = d.regime;
  document.getElementById("fg-label").style.color = d.regimeColor;
  document.getElementById("fg-val").textContent   = d.fearGreed;
  document.getElementById("fg-val").style.color   = d.regimeColor;
  document.getElementById("fg-needle").style.left = d.fearGreed + "%";

  // 캘리브레이션 링
  const pct = Math.min(d.cal.completed / 30, 1);
  const circ = 138.2;
  document.getElementById("cal-ring").setAttribute("stroke-dashoffset", circ - pct * circ);
  document.getElementById("cal-ring").setAttribute("stroke", d.cal.evPositive ? "var(--green)" : "var(--yellow)");
  document.getElementById("cal-num").textContent = d.cal.completed;
  document.getElementById("c-ema").textContent   = d.cal.onlineWinRate != null ? d.cal.onlineWinRate + "%" : "—";
  document.getElementById("c-ev").textContent    = d.cal.ev != null ? fmtPct(d.cal.ev) : "—";
  document.getElementById("c-kelly").textContent  = d.cal.kelly != null ? d.cal.kelly + "%" : "—";

  // 포지션
  if (d.position) {
    document.getElementById("pos-card").style.display   = "";
    document.getElementById("nopos-card").style.display = "none";
    const p = d.position;
    document.getElementById("pos-market").textContent  = p.market;
    document.getElementById("pos-price").textContent   = "진입 " + fmt(p.entryPrice) + " → 목표 " + fmt(p.targetPrice) + "원";
    const upnl = document.getElementById("pos-unreal");
    upnl.textContent    = fmtPct(p.unrealizedPnl);
    upnl.style.color    = p.unrealizedPnl >= 0 ? "var(--green)" : "var(--red)";
    // 진행률: 0 = 진입가, 100 = 목표가
    const range = p.targetPrice - p.entryPrice;
    const cur   = (p.unrealizedPnl / 100) * p.entryPrice + p.entryPrice;
    const prog  = range > 0 ? Math.max(0, Math.min(100, (cur - p.entryPrice) / range * 100)) : 0;
    document.getElementById("pos-bar").style.width      = prog + "%";
    document.getElementById("pos-bar").style.background = p.unrealizedPnl >= 0 ? "var(--green)" : "var(--red)";

    // 포지션 마켓으로 차트 전환
    if (p.market !== currentMarket) loadChart(p.market, currentTf);
  } else {
    document.getElementById("pos-card").style.display   = "none";
    document.getElementById("nopos-card").style.display = "";
  }

  // 후보
  const cEl = document.getElementById("candidates");
  cEl.innerHTML = d.candidates.map(c => {
    const dot  = c.eligible ? "var(--green)" : c.ev > 0 ? "var(--yellow)" : "var(--border)";
    const evC  = c.ev > 0 ? "var(--green)" : "var(--red)";
    return \`<div class="cand-row" onclick="loadChart('\${c.market}', \${currentTf})">
      <div class="cand-dot" style="background:\${dot}"></div>
      <div class="cand-name">\${c.name}</div>
      <div class="cand-score" style="color:var(--muted)">점수 \${c.score}</div>
      <div class="cand-ev" style="color:\${evC}">EV \${c.ev > 0 ? "+" : ""}\${c.ev}%</div>
      <span class="cand-badge \${c.eligible ? "badge-go" : "badge-wait"}">\${c.eligible ? "진입" : "대기"}</span>
    </div>\`;
  }).join("");

  // 자본곡선
  drawEquity(d.equityCurve);

  // 차트 마켓 레이블
  if (d.tvMarket && !d.position && d.tvMarket !== currentMarket) {
    loadChart(d.tvMarket, currentTf);
  }
}
</script>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }
}

module.exports = { DashboardServer };
