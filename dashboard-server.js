"use strict";

const http = require("http");

/**
 * DashboardServer — 실시간 봇 상태 웹 대시보드
 * Railway에서 PORT 환경변수로 자동 노출됨
 */
class DashboardServer {
  constructor(bot) {
    this.bot = bot;
    this.server = null;
    this.port = Number(process.env.PORT || 3000);
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.url === "/health") return this.handleHealth(res);
      if (req.url === "/api/status") return this.handleStatus(res);
      return this.handleDashboard(res);
    });

    this.server.listen(this.port, () => {
      console.log(`[Dashboard] 대시보드 시작: http://localhost:${this.port}`);
    });
  }

  stop() {
    this.server?.close();
  }

  handleHealth(res) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  }

  handleStatus(res) {
    const data = this.getStatusData();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data, null, 2));
  }

  getStatusData() {
    const bot = this.bot;
    const sim = bot.mds?.state?.simulation;
    const cal = bot.calibration?.getSummary();
    const macro = bot.macroEngine?.getSummary();
    const data  = bot.dataEngine?.getSummary();
    const snapshots = bot.mds?.state?.lastAnalysisSnapshots || [];

    const totalAsset = bot.mds?.getSimulationTotalAsset?.() || 0;
    const initialCap = sim?.initialCapital || 100000;
    const pnlRate    = totalAsset > 0 ? ((totalAsset - initialCap) / initialCap * 100) : 0;

    return {
      updatedAt:   new Date().toISOString(),
      bot: {
        mode:       process.env.BOT_MODE || "CALIBRATION",
        dryRun:     process.env.DRY_RUN !== "false",
        uptime:     process.uptime().toFixed(0) + "s",
        halted:     bot.orderService?.halted || false,
      },
      portfolio: {
        initialCapital: initialCap,
        totalAsset:     Math.round(totalAsset),
        pnlRate:        pnlRate.toFixed(3) + "%",
        realizedPnl:    Math.round(sim?.realizedPnl || 0),
        totalTrades:    sim?.totalTrades || 0,
        wins:           sim?.wins || 0,
        losses:         sim?.losses || 0,
        winRate:        sim?.totalTrades > 0
          ? ((sim.wins / sim.totalTrades) * 100).toFixed(1) + "%"
          : "-",
      },
      position: sim?.activePosition ? {
        market:        sim.activePosition.marketCode,
        entryPrice:    Math.round(sim.activePosition.averageBuyPrice),
        targetPrice:   Math.round(sim.activePosition.targetSellPrice),
        stopRate:      (sim.activePosition.dynamicStopRate * 100).toFixed(2) + "%",
        openedAt:      new Date(sim.activePosition.openedAt).toLocaleTimeString("ko-KR"),
      } : null,
      daily: {
        trades:           sim?.daily?.trades || 0,
        pnl:              Math.round(sim?.daily?.pnl || 0),
        consecutiveLosses: sim?.daily?.consecutiveLosses || 0,
        halted:           sim?.daily?.halted || false,
      },
      calibration: {
        mode:        cal?.mode || "-",
        completed:   cal?.totalCompleted || 0,
        winRate:     cal?.currentWinRate != null
          ? (cal.currentWinRate * 100).toFixed(1) + "%" : "-",
        ev:          cal?.calibratedConfig?.ev != null
          ? (cal.calibratedConfig.ev * 100).toFixed(3) + "%" : "-",
        kelly:       cal?.calibratedConfig?.kellyFraction != null
          ? (cal.calibratedConfig.kellyFraction * 100).toFixed(1) + "%" : "-",
        evPositive:  cal?.calibratedConfig?.evPositive || false,
      },
      topCandidates: snapshots.slice(0, 3).map((s) => ({
        market:      s.market,
        score:       s.smoothedScore?.toFixed(1),
        bullish:     s.bullishProbability?.toFixed(1) + "%",
        eligible:    s.eligible,
        ev:          s.ev != null ? (s.ev * 100).toFixed(3) + "%" : "-",
        reasons:     s.reasons || [],
      })),
      macro: macro || null,
      dataEngine: data || null,
    };
  }

  handleDashboard(res) {
    const d = this.getStatusData();
    const pos = d.position;
    const cal = d.calibration;

    const posHtml = pos ? `
      <div class="card green">
        <h3>📈 포지션 보유 중</h3>
        <p>${pos.market} | 진입가 ${pos.entryPrice?.toLocaleString()}원</p>
        <p>목표가 ${pos.targetPrice?.toLocaleString()}원 | 손절 ${pos.stopRate}</p>
        <p>진입 시각 ${pos.openedAt}</p>
      </div>` : `<div class="card"><h3>⏳ 포지션 없음 — 신호 대기 중</h3></div>`;

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="10">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ATS v7 대시보드</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #0d1117; color: #e6edf3; padding: 20px; }
    h1 { font-size: 1.4rem; margin-bottom: 20px; color: #58a6ff; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; }
    .card.green { border-color: #238636; background: #0d2818; }
    .card.yellow { border-color: #9e6a03; background: #271d03; }
    h3 { font-size: 0.85rem; color: #8b949e; margin-bottom: 10px; text-transform: uppercase; }
    .big { font-size: 1.8rem; font-weight: 700; color: #58a6ff; }
    .big.green { color: #3fb950; }
    .big.red { color: #f85149; }
    p { font-size: 0.9rem; line-height: 1.8; color: #c9d1d9; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; margin: 2px; }
    .badge.ok { background: #238636; color: #fff; }
    .badge.no { background: #6e7681; color: #fff; }
    .badge.warn { background: #9e6a03; color: #fff; }
    .ts { font-size: 0.7rem; color: #6e7681; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>🤖 ATS v7 — 실시간 대시보드</h1>
  <div class="grid">

    <div class="card">
      <h3>포트폴리오</h3>
      <div class="big ${Number(d.portfolio.realizedPnl) >= 0 ? 'green' : 'red'}">
        ${d.portfolio.pnlRate}
      </div>
      <p>총 자산: ${d.portfolio.totalAsset?.toLocaleString()}원</p>
      <p>실현 손익: ${d.portfolio.realizedPnl >= 0 ? '+' : ''}${d.portfolio.realizedPnl?.toLocaleString()}원</p>
      <p>승률: ${d.portfolio.winRate} (${d.portfolio.wins}승 ${d.portfolio.losses}패)</p>
    </div>

    <div class="card">
      <h3>봇 상태</h3>
      <div class="big">${d.bot.mode}</div>
      <p>DRY RUN: <span class="badge ${d.bot.dryRun ? 'warn' : 'ok'}">${d.bot.dryRun ? '시뮬레이션' : '실거래'}</span></p>
      <p>가동 시간: ${d.bot.uptime}</p>
      <p>오늘: ${d.daily.trades}회 거래 | ${d.daily.pnl >= 0 ? '+' : ''}${d.daily.pnl?.toLocaleString()}원</p>
    </div>

    <div class="card ${cal.evPositive ? 'green' : 'yellow'}">
      <h3>캘리브레이션</h3>
      <div class="big">${cal.completed}건</div>
      <p>모드: ${cal.mode}</p>
      <p>승률: ${cal.winRate} | EV: ${cal.ev}</p>
      <p>켈리: ${cal.kelly} | EV+: <span class="badge ${cal.evPositive ? 'ok' : 'warn'}">${cal.evPositive ? '양수' : '음수'}</span></p>
    </div>

    ${posHtml}

    <div class="card">
      <h3>상위 후보</h3>
      ${d.topCandidates.map((c) => `
        <p>
          <span class="badge ${c.eligible ? 'ok' : 'no'}">${c.eligible ? '진입가능' : '대기'}</span>
          ${c.market} — 점수 ${c.score} | EV ${c.ev}
        </p>
      `).join('')}
    </div>

    <div class="card">
      <h3>매크로 신호</h3>
      ${d.macro ? `
        <p>공포탐욕: ${d.macro.fearGreed?.value ?? '-'} (${d.macro.fearGreed?.classification ?? '-'})</p>
        <p>펀딩비 수: ${d.macro.fundingRateCount ?? 0}개 모니터링</p>
      ` : '<p>로딩 중...</p>'}
    </div>

  </div>
  <p class="ts">마지막 갱신: ${d.updatedAt} | 10초마다 자동 새로고침</p>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }
}

module.exports = { DashboardServer };
