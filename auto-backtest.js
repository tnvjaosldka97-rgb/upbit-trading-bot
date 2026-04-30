"use strict";

/**
 * AutoBacktest — 봇 내장 자동 백테스트 스케줄러
 *
 * 매주 일요일 03:00 KST 실행:
 *   - 최근 30일 데이터로 backtest-multi 계열 자동 실행
 *   - EV+ 코인 / EV- 코인 자동 분류
 *   - performance.db에 backtest_runs 테이블 기록
 *   - Telegram 알림 (어떤 코인이 활성화/비활성화 후보인지)
 *
 * 인간 개입 0 — 매주 자동.
 */

let Database;
try { Database = require("better-sqlite3"); } catch { Database = null; }

const { spawn } = require("child_process");
const path = require("path");

const SCHEDULE_HOUR_KST = 3;
const SCHEDULE_DAY = 0; // Sunday

class AutoBacktest {
  constructor(opts = {}) {
    this.notifier = opts.notifier || null;
    this.dbPath   = opts.dbPath || "./performance.db";
    this._db = null;
    this._intervalId = null;

    if (Database) {
      try {
        this._db = new Database(this.dbPath);
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS backtest_runs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            run_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            type        TEXT NOT NULL,
            results_json TEXT,
            ev_plus_count INTEGER,
            ev_minus_count INTEGER,
            top_coin    TEXT,
            top_ev      REAL
          );
        `);
      } catch (e) {
        console.warn(`[AutoBacktest] DB init: ${e.message}`);
      }
    }
  }

  start() {
    // 1시간마다 체크 (정확한 시각이면 실행)
    this._intervalId = setInterval(() => {
      const now = new Date();
      const kstHour = (now.getUTCHours() + 9) % 24;
      const kstDay  = (now.getUTCDay() + (kstHour < 9 && now.getUTCHours() < 9 ? 0 : 0)) % 7;
      // 일요일 03시 (KST) — 5분 윈도우
      if (kstDay === SCHEDULE_DAY && kstHour === SCHEDULE_HOUR_KST && now.getUTCMinutes() < 5) {
        this.runBacktest("multi").catch(e =>
          console.error("[AutoBacktest] runBacktest:", e.message)
        );
      }
    }, 5 * 60_000);

    console.log("[AutoBacktest] 시작 — 매주 일요일 03:00(KST) 자동 백테스트");
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = null;
  }

  /**
   * 백테스트 실행 (외부에서 즉시 호출도 가능)
   */
  async runBacktest(type = "multi") {
    console.log(`[AutoBacktest] 시작 — type:${type}`);
    const startTs = Date.now();

    return new Promise((resolve) => {
      const script = type === "multi" ? "backtest-multi.js" : "backtest.js";
      const child = spawn("node", [script], {
        cwd: __dirname,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30 * 60_000, // 30분 max
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", d => { stdout += d.toString(); });
      child.stderr.on("data", d => { stderr += d.toString(); });

      child.on("close", (code) => {
        const durationMs = Date.now() - startTs;
        const summary = this._parseBacktestOutput(stdout);
        console.log(
          `[AutoBacktest] 완료 — code:${code} duration:${(durationMs/1000).toFixed(0)}s ` +
          `EV+:${summary.evPlusCount} EV-:${summary.evMinusCount}`
        );

        // DB 기록
        if (this._db) {
          try {
            this._db.prepare(`
              INSERT INTO backtest_runs (type, results_json, ev_plus_count, ev_minus_count, top_coin, top_ev)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              type,
              JSON.stringify({ summary, durationMs, exitCode: code }),
              summary.evPlusCount,
              summary.evMinusCount,
              summary.topCoin,
              summary.topEv
            );
          } catch {}
        }

        // Telegram 알림
        if (this.notifier?.send) {
          this.notifier.send(
            `🔬 <b>주간 자동 백테스트 완료</b>\n` +
            `타입: ${type}\n` +
            `소요: ${(durationMs / 60000).toFixed(1)}분\n` +
            `EV+ 코인: <b>${summary.evPlusCount}개</b>\n` +
            `EV- 코인: ${summary.evMinusCount}개\n` +
            (summary.topCoin ? `최고: ${summary.topCoin} (EV ${(summary.topEv * 100).toFixed(3)}%)\n` : "") +
            `→ /api/backtest-history 에서 상세 확인`
          );
        }

        resolve({ code, summary, durationMs });
      });
    });
  }

  _parseBacktestOutput(stdout) {
    // backtest-multi.js 출력 파싱:
    //   "수익성 있는 코인: 1/17개"
    //   "EV  +0.5%"
    let evPlusCount = 0;
    let evMinusCount = 0;
    let topCoin = null;
    let topEv = 0;

    const lines = stdout.split("\n");
    for (const line of lines) {
      const profitMatch = line.match(/수익성 있는 코인:\s*(\d+)\/(\d+)개/);
      if (profitMatch) {
        evPlusCount  = +profitMatch[1];
        evMinusCount = +profitMatch[2] - evPlusCount;
      }
      // 결과 행: KRW-XXX  N건  R% +EV%
      const rowMatch = line.match(/KRW-(\w+)\s+(\d+)건\s+([\d.]+)%\s+([+-]?[\d.]+)%/);
      if (rowMatch) {
        const ev = parseFloat(rowMatch[4]) / 100;
        if (ev > topEv) {
          topEv = ev;
          topCoin = rowMatch[1];
        }
      }
    }
    return { evPlusCount, evMinusCount, topCoin, topEv };
  }

  getRecentRuns(limit = 10) {
    if (!this._db) return [];
    try {
      return this._db.prepare(`
        SELECT * FROM backtest_runs ORDER BY run_at DESC LIMIT ?
      `).all(limit);
    } catch { return []; }
  }

  close() {
    try { this._db?.close(); } catch {}
  }
}

module.exports = { AutoBacktest };
