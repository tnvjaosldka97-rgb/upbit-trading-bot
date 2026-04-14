"use strict";

/**
 * ArbDataLogger — 글로벌 아비트라지 데이터 축적 엔진
 *
 * 24일까지 시뮬레이션 데이터 축적 → 분석 → 실전 투입
 *
 * 수집 데이터:
 *   1) price_snapshots  — 6개 거래소 가격 (30초 간격)
 *   2) spread_events    — 차익 기회 (감지/실행/스킵)
 *   3) arb_executions   — 시뮬 실행 결과 (P&L)
 *   4) orderbook_depth  — 호가 깊이 (5분 간격)
 *   5) daily_summary    — 일별 집계
 *
 * 백업: 1시간마다 SQLite WAL 체크포인트 + 일별 CSV 내보내기
 */

let Database;
try { Database = require("better-sqlite3"); } catch { Database = null; }

const fs   = require("fs");
const path = require("path");

const SNAPSHOT_INTERVAL   = 30_000;   // 30초
const DEPTH_INTERVAL      = 5 * 60_000; // 5분
const BACKUP_INTERVAL     = 60 * 60_000; // 1시간
const DAILY_EXPORT_HOUR   = 0; // 자정에 전일 데이터 CSV 내보내기

class ArbDataLogger {
  /**
   * @param {Object} opts
   * @param {string} opts.dbPath      - SQLite 경로
   * @param {string} opts.backupDir   - 백업 디렉토리
   * @param {Object} opts.exchanges   - { name: ExchangeAdapter }
   * @param {Object} opts.crossArb    - CrossExchangeArb 인스턴스
   * @param {Object} opts.arbExecutor - ArbExecutor 인스턴스
   * @param {number} opts.usdKrw      - 환율
   */
  constructor({
    dbPath = "./arb-data.db",
    backupDir = "./arb-backups",
    exchanges = {},
    crossArb = null,
    arbExecutor = null,
    usdKrw = 1350,
  } = {}) {
    this._dbPath    = dbPath;
    this._backupDir = backupDir;
    this._exchanges = exchanges;
    this._crossArb  = crossArb;
    this._arbExec   = arbExecutor;
    this._usdKrw    = usdKrw;
    this._db        = null;
    this._ready     = false;
    this._timers    = [];
    this._running   = false;

    // 통계
    this._stats = {
      snapshots:    0,
      spreads:      0,
      executions:   0,
      depths:       0,
      exports:      0,
      errors:       0,
      startedAt:    null,
    };

    this._init();
  }

  setUsdKrw(rate) { if (rate > 0) this._usdKrw = rate; }

  _init() {
    if (!Database) {
      console.warn("[ArbData] better-sqlite3 없음 — 데이터 축적 비활성화");
      return;
    }

    try {
      // 백업 디렉토리 생성
      if (!fs.existsSync(this._backupDir)) {
        fs.mkdirSync(this._backupDir, { recursive: true });
      }

      this._db = new Database(this._dbPath);
      this._db.pragma("journal_mode = WAL");
      this._db.pragma("synchronous = NORMAL");
      this._migrate();
      this._ready = true;
      console.log(`[ArbData] 초기화 완료 — ${this._dbPath}`);
    } catch (e) {
      console.error(`[ArbData] 초기화 실패: ${e.message}`);
    }
  }

  _migrate() {
    this._db.exec(`
      -- 가격 스냅샷 (6개 거래소, 30초 간격)
      CREATE TABLE IF NOT EXISTS price_snapshots (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        coin       TEXT    NOT NULL,
        exchange   TEXT    NOT NULL,
        price_raw  REAL    NOT NULL,
        price_usd  REAL    NOT NULL,
        quote_ccy  TEXT    NOT NULL,
        volume_24h REAL    DEFAULT NULL,
        ts         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snap_coin_ts ON price_snapshots(coin, ts);
      CREATE INDEX IF NOT EXISTS idx_snap_ts ON price_snapshots(ts);

      -- 스프레드 이벤트 (차익 기회 감지)
      CREATE TABLE IF NOT EXISTS spread_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        coin           TEXT    NOT NULL,
        buy_exchange   TEXT    NOT NULL,
        sell_exchange  TEXT    NOT NULL,
        buy_price_usd  REAL    NOT NULL,
        sell_price_usd REAL    NOT NULL,
        spread_pct     REAL    NOT NULL,
        net_profit_pct REAL    NOT NULL,
        source         TEXT    DEFAULT 'rest',
        action         TEXT    DEFAULT 'detected',
        skip_reason    TEXT    DEFAULT NULL,
        ts             INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spread_ts ON spread_events(ts);
      CREATE INDEX IF NOT EXISTS idx_spread_coin ON spread_events(coin);

      -- 아비트라지 실행 결과 (시뮬/실전)
      CREATE TABLE IF NOT EXISTS arb_executions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        coin            TEXT    NOT NULL,
        buy_exchange    TEXT    NOT NULL,
        sell_exchange   TEXT    NOT NULL,
        buy_price_usd   REAL    NOT NULL,
        sell_price_usd  REAL    NOT NULL,
        quantity        REAL    NOT NULL,
        position_usd    REAL    NOT NULL,
        spread_pct      REAL    NOT NULL,
        profit_usd      REAL    NOT NULL,
        profit_pct      REAL    NOT NULL,
        slippage_pct    REAL    DEFAULT 0,
        dry_run         INTEGER DEFAULT 1,
        ts              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_exec_ts ON arb_executions(ts);

      -- 호가 깊이 (5분 간격)
      CREATE TABLE IF NOT EXISTS orderbook_depth (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        coin         TEXT    NOT NULL,
        exchange     TEXT    NOT NULL,
        bid_depth_usd REAL   NOT NULL,
        ask_depth_usd REAL   NOT NULL,
        bid_count    INTEGER DEFAULT 0,
        ask_count    INTEGER DEFAULT 0,
        spread_bps   REAL    DEFAULT NULL,
        ts           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_depth_ts ON orderbook_depth(ts);

      -- 일별 요약
      CREATE TABLE IF NOT EXISTS daily_summary (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        date            TEXT    NOT NULL UNIQUE,
        total_snapshots INTEGER DEFAULT 0,
        total_spreads   INTEGER DEFAULT 0,
        total_execs     INTEGER DEFAULT 0,
        avg_kimchi_prem REAL    DEFAULT NULL,
        max_spread_pct  REAL    DEFAULT 0,
        total_profit_usd REAL   DEFAULT 0,
        win_count       INTEGER DEFAULT 0,
        loss_count      INTEGER DEFAULT 0,
        best_coin       TEXT    DEFAULT NULL,
        exchanges_active INTEGER DEFAULT 0
      );
    `);

    // 프리페어드 스테이트먼트
    this._stmts = {
      insertSnap: this._db.prepare(`
        INSERT INTO price_snapshots (coin, exchange, price_raw, price_usd, quote_ccy, volume_24h, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      insertSpread: this._db.prepare(`
        INSERT INTO spread_events (coin, buy_exchange, sell_exchange, buy_price_usd, sell_price_usd, spread_pct, net_profit_pct, source, action, skip_reason, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertExec: this._db.prepare(`
        INSERT INTO arb_executions (coin, buy_exchange, sell_exchange, buy_price_usd, sell_price_usd, quantity, position_usd, spread_pct, profit_usd, profit_pct, slippage_pct, dry_run, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertDepth: this._db.prepare(`
        INSERT INTO orderbook_depth (coin, exchange, bid_depth_usd, ask_depth_usd, bid_count, ask_count, spread_bps, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      upsertDaily: this._db.prepare(`
        INSERT INTO daily_summary (date, total_snapshots, total_spreads, total_execs, avg_kimchi_prem, max_spread_pct, total_profit_usd, win_count, loss_count, best_coin, exchanges_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          total_snapshots = excluded.total_snapshots,
          total_spreads   = excluded.total_spreads,
          total_execs     = excluded.total_execs,
          avg_kimchi_prem = excluded.avg_kimchi_prem,
          max_spread_pct  = excluded.max_spread_pct,
          total_profit_usd = excluded.total_profit_usd,
          win_count       = excluded.win_count,
          loss_count      = excluded.loss_count,
          best_coin       = excluded.best_coin,
          exchanges_active = excluded.exchanges_active
      `),
    };
  }

  // ── 시작/종료 ──────────────────────────────────────────────

  async start() {
    if (!this._ready || this._running) return;
    this._running = true;
    this._stats.startedAt = Date.now();

    console.log(`[ArbData] 데이터 축적 시작 — 스냅샷:${SNAPSHOT_INTERVAL/1000}초, 호가:${DEPTH_INTERVAL/60000}분, 백업:${BACKUP_INTERVAL/3600000}시간`);

    // 가격 스냅샷 (30초)
    this._timers.push(setInterval(() => this._captureSnapshots().catch(this._err), SNAPSHOT_INTERVAL));

    // 호가 깊이 (5분)
    this._timers.push(setInterval(() => this._captureDepth().catch(this._err), DEPTH_INTERVAL));

    // 백업 (1시간)
    this._timers.push(setInterval(() => this._backup(), BACKUP_INTERVAL));

    // 일별 CSV 내보내기 (1분마다 체크, 자정에 실행)
    this._timers.push(setInterval(() => this._checkDailyExport(), 60_000));

    // 즉시 1회 스냅샷
    await this._captureSnapshots().catch(this._err);
  }

  stop() {
    this._running = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];

    // 종료 전 WAL 체크포인트 (백업은 DB 열려 있을 때만)
    if (this._db) {
      try { this._db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
      try { this._db.close(); } catch {}
    }
    console.log(`[ArbData] 종료 — 스냅샷:${this._stats.snapshots}, 스프레드:${this._stats.spreads}, 실행:${this._stats.executions}`);
  }

  _err = (e) => {
    this._stats.errors++;
    console.error(`[ArbData] ${e.message}`);
  }

  // ── 가격 스냅샷 수집 ──────────────────────────────────────

  async _captureSnapshots() {
    if (!this._ready) return;
    const now = Date.now();
    // 핵심 코인만 (메모리 절약)
    const coins = ["BTC", "ETH", "XRP", "SOL", "DOGE"];
    const exchangeList = Object.entries(this._exchanges);

    // 거래소별 순차 처리 (동시 요청 폭발 방지)
    const allRows = [];
    for (const [name, ex] of exchangeList) {
      const batch = await Promise.allSettled(
        coins.map(coin =>
          ex.getTicker(coin)
            .then(t => ({
              coin, exchange: name,
              priceRaw: t.price,
              priceUsd: ex.quoteCurrency === "KRW" ? t.price / this._usdKrw : t.price,
              quoteCcy: ex.quoteCurrency,
              volume: t.volume24h,
            }))
            .catch(() => null)
        )
      );
      for (const r of batch) {
        if (r.status === "fulfilled" && r.value) allRows.push(r.value);
      }
      // 거래소 간 100ms 간격 (rate limit 보호)
      await new Promise(r => setTimeout(r, 100));
    }

    if (allRows.length > 0) {
      const insertMany = this._db.transaction((rows) => {
        for (const r of rows) {
          this._stmts.insertSnap.run(
            r.coin, r.exchange, r.priceRaw, r.priceUsd, r.quoteCcy, r.volume, now
          );
        }
      });
      insertMany(allRows);
      this._stats.snapshots += allRows.length;
    }
  }

  // ── 스프레드 이벤트 기록 ──────────────────────────────────

  logSpreadEvent(event) {
    if (!this._ready) return;
    try {
      this._stmts.insertSpread.run(
        event.coin,
        event.buyExchange,
        event.sellExchange,
        event.buyPrice,
        event.sellPrice,
        event.spreadPct,
        event.netProfitPct || 0,
        event.source || "rest",
        event.action || "detected",
        event.skipReason || null,
        event.ts || Date.now()
      );
      this._stats.spreads++;
    } catch (e) { this._err(e); }
  }

  // ── 실행 결과 기록 ────────────────────────────────────────

  logExecution(result) {
    if (!this._ready || !result.executed) return;
    try {
      this._stmts.insertExec.run(
        result.coin,
        result.buyExchange,
        result.sellExchange,
        result.buyPrice,
        result.sellPrice,
        result.quantity || 0,
        result.positionUsd || 0,
        result.spreadPct || 0,
        result.profitUsd || 0,
        result.profitPct || 0,
        result.slippage || 0,
        result.dryRun ? 1 : 0,
        result.timestamp || Date.now()
      );
      this._stats.executions++;
    } catch (e) { this._err(e); }
  }

  // ── 호가 깊이 수집 ────────────────────────────────────────

  async _captureDepth() {
    if (!this._ready) return;
    const now = Date.now();
    const coins = ["BTC", "ETH"];  // 핵심 2개만 (메모리 절약)

    const allRows = [];
    for (const [name, ex] of Object.entries(this._exchanges)) {
      const batch = await Promise.allSettled(
        coins.map(coin =>
          ex.getOrderbook(coin, 5)  // depth 5로 축소
            .then(ob => {
              const bidDepth = ob.bids.reduce((s, b) => {
                const p = ex.quoteCurrency === "KRW" ? b.price / this._usdKrw : b.price;
                return s + p * b.qty;
              }, 0);
              const askDepth = ob.asks.reduce((s, a) => {
                const p = ex.quoteCurrency === "KRW" ? a.price / this._usdKrw : a.price;
                return s + p * a.qty;
              }, 0);
              const bestBid = ob.bids[0]?.price || 0;
              const bestAsk = ob.asks[0]?.price || 0;
              const spreadBps = bestBid > 0 ? (bestAsk - bestBid) / bestBid * 10000 : 0;
              return { coin, exchange: name, bidDepth, askDepth, bidCount: ob.bids.length, askCount: ob.asks.length, spreadBps };
            })
            .catch(() => null)
        )
      );
      for (const r of batch) {
        if (r.status === "fulfilled" && r.value) allRows.push(r.value);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (allRows.length > 0) {
      const insertMany = this._db.transaction((rows) => {
        for (const r of rows) {
          this._stmts.insertDepth.run(r.coin, r.exchange, r.bidDepth, r.askDepth, r.bidCount, r.askCount, r.spreadBps, now);
        }
      });
      insertMany(allRows);
      this._stats.depths += allRows.length;
    }
  }

  // ── 백업 ──────────────────────────────────────────────────

  _backup() {
    if (!this._db) return;
    try {
      this._db.pragma("wal_checkpoint(TRUNCATE)");

      // DB 파일 복사
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
      const dest = path.join(this._backupDir, `arb-data-${ts}.db`);
      this._db.backup(dest).then(() => {
        console.log(`[ArbData] 백업 완료 → ${dest}`);

        // 오래된 백업 정리 (7일 이상)
        this._cleanOldBackups();
      }).catch(e => console.error(`[ArbData] 백업 실패: ${e.message}`));
    } catch (e) {
      console.error(`[ArbData] 백업 오류: ${e.message}`);
    }
  }

  _cleanOldBackups() {
    try {
      const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
      const files = fs.readdirSync(this._backupDir);
      for (const f of files) {
        const fp = path.join(this._backupDir, f);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
        }
      }
    } catch {}
  }

  // ── 일별 CSV 내보내기 ─────────────────────────────────────

  _checkDailyExport() {
    const now = new Date();
    if (now.getHours() === DAILY_EXPORT_HOUR && now.getMinutes() === 0) {
      this._exportDailyCSV();
      this._updateDailySummary();
    }
  }

  _exportDailyCSV() {
    if (!this._db) return;
    try {
      const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      const startTs = new Date(yesterday + "T00:00:00").getTime();
      const endTs   = startTs + 86400_000;

      // 스프레드 이벤트 CSV
      const spreads = this._db.prepare(
        `SELECT * FROM spread_events WHERE ts >= ? AND ts < ? ORDER BY ts`
      ).all(startTs, endTs);

      if (spreads.length > 0) {
        const csvPath = path.join(this._backupDir, `spreads-${yesterday}.csv`);
        const header = "ts,coin,buy_exchange,sell_exchange,buy_price,sell_price,spread_pct,net_profit_pct,source,action,skip_reason\n";
        const rows = spreads.map(r =>
          `${r.ts},${r.coin},${r.buy_exchange},${r.sell_exchange},${r.buy_price_usd},${r.sell_price_usd},${r.spread_pct},${r.net_profit_pct},${r.source},${r.action},${r.skip_reason || ""}`
        ).join("\n");
        fs.writeFileSync(csvPath, header + rows);
        this._stats.exports++;
        console.log(`[ArbData] CSV 내보내기 → ${csvPath} (${spreads.length}건)`);
      }

      // 실행 결과 CSV
      const execs = this._db.prepare(
        `SELECT * FROM arb_executions WHERE ts >= ? AND ts < ? ORDER BY ts`
      ).all(startTs, endTs);

      if (execs.length > 0) {
        const csvPath = path.join(this._backupDir, `executions-${yesterday}.csv`);
        const header = "ts,coin,buy_exchange,sell_exchange,buy_price,sell_price,qty,position_usd,spread_pct,profit_usd,profit_pct,slippage,dry_run\n";
        const rows = execs.map(r =>
          `${r.ts},${r.coin},${r.buy_exchange},${r.sell_exchange},${r.buy_price_usd},${r.sell_price_usd},${r.quantity},${r.position_usd},${r.spread_pct},${r.profit_usd},${r.profit_pct},${r.slippage_pct},${r.dry_run}`
        ).join("\n");
        fs.writeFileSync(csvPath, header + rows);
      }
    } catch (e) {
      console.error(`[ArbData] CSV 내보내기 실패: ${e.message}`);
    }
  }

  _updateDailySummary() {
    if (!this._db) return;
    try {
      const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      const startTs = new Date(yesterday + "T00:00:00").getTime();
      const endTs   = startTs + 86400_000;

      const snapCount = this._db.prepare(
        `SELECT COUNT(*) as cnt FROM price_snapshots WHERE ts >= ? AND ts < ?`
      ).get(startTs, endTs)?.cnt || 0;

      const spreadCount = this._db.prepare(
        `SELECT COUNT(*) as cnt FROM spread_events WHERE ts >= ? AND ts < ?`
      ).get(startTs, endTs)?.cnt || 0;

      const execStats = this._db.prepare(`
        SELECT
          COUNT(*) as cnt,
          SUM(profit_usd) as totalProfit,
          MAX(spread_pct) as maxSpread,
          SUM(CASE WHEN profit_usd >= 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN profit_usd < 0 THEN 1 ELSE 0 END) as losses
        FROM arb_executions WHERE ts >= ? AND ts < ?
      `).get(startTs, endTs);

      // 김치프리미엄 평균 계산
      const kimchi = this._db.prepare(`
        SELECT AVG(s1.price_usd / s2.price_usd - 1) * 100 as avg_prem
        FROM price_snapshots s1
        JOIN price_snapshots s2 ON s1.coin = s2.coin AND s1.ts = s2.ts
        WHERE s1.exchange = 'upbit' AND s2.exchange = 'binance'
          AND s1.ts >= ? AND s1.ts < ?
          AND s1.coin = 'BTC'
      `).get(startTs, endTs);

      const activeExchanges = this._db.prepare(`
        SELECT COUNT(DISTINCT exchange) as cnt
        FROM price_snapshots WHERE ts >= ? AND ts < ?
      `).get(startTs, endTs)?.cnt || 0;

      this._stmts.upsertDaily.run(
        yesterday,
        snapCount,
        spreadCount,
        execStats?.cnt || 0,
        kimchi?.avg_prem || null,
        execStats?.maxSpread || 0,
        execStats?.totalProfit || 0,
        execStats?.wins || 0,
        execStats?.losses || 0,
        null,
        activeExchanges
      );
    } catch (e) {
      console.error(`[ArbData] 일별 요약 실패: ${e.message}`);
    }
  }

  // ── 조회 API (분석용) ─────────────────────────────────────

  /** 특정 코인의 거래소별 가격 히스토리 */
  getPriceHistory(coin, hours = 24) {
    if (!this._db) return [];
    const since = Date.now() - hours * 3600_000;
    return this._db.prepare(`
      SELECT exchange, price_usd, ts
      FROM price_snapshots
      WHERE coin = ? AND ts >= ?
      ORDER BY ts
    `).all(coin, since);
  }

  /** 스프레드 분포 (분석용) */
  getSpreadDistribution(hours = 24) {
    if (!this._db) return [];
    const since = Date.now() - hours * 3600_000;
    return this._db.prepare(`
      SELECT
        coin,
        buy_exchange,
        sell_exchange,
        COUNT(*) as count,
        AVG(spread_pct) as avgSpread,
        MAX(spread_pct) as maxSpread,
        MIN(spread_pct) as minSpread,
        AVG(net_profit_pct) as avgNetProfit
      FROM spread_events
      WHERE ts >= ?
      GROUP BY coin, buy_exchange, sell_exchange
      ORDER BY avgSpread DESC
    `).all(since);
  }

  /** 김치프리미엄 히스토리 */
  getKimchiPremiumHistory(hours = 24) {
    if (!this._db) return [];
    const since = Date.now() - hours * 3600_000;
    return this._db.prepare(`
      SELECT
        s1.ts,
        s1.price_usd as upbit_usd,
        s2.price_usd as binance_usd,
        (s1.price_usd / s2.price_usd - 1) * 100 as premium_pct
      FROM price_snapshots s1
      JOIN price_snapshots s2 ON s1.coin = s2.coin AND s1.ts = s2.ts
      WHERE s1.exchange = 'upbit' AND s2.exchange = 'binance'
        AND s1.coin = 'BTC'
        AND s1.ts >= ?
      ORDER BY s1.ts
    `).all(since);
  }

  /** 수익성 분석 */
  getProfitAnalysis(days = 7) {
    if (!this._db) return {};
    const since = Date.now() - days * 86400_000;
    return this._db.prepare(`
      SELECT
        coin,
        COUNT(*) as trades,
        SUM(profit_usd) as totalProfit,
        AVG(profit_pct) as avgProfitPct,
        MAX(profit_pct) as bestTradePct,
        AVG(spread_pct) as avgSpread,
        SUM(CASE WHEN profit_usd >= 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN profit_usd < 0 THEN 1 ELSE 0 END) as losses
      FROM arb_executions
      WHERE ts >= ?
      GROUP BY coin
      ORDER BY totalProfit DESC
    `).all(since);
  }

  /** 대시보드 요약 */
  getSummary() {
    const uptime = this._stats.startedAt
      ? Math.round((Date.now() - this._stats.startedAt) / 3600_000 * 10) / 10
      : 0;

    let dbSize = 0;
    try { dbSize = fs.statSync(this._dbPath).size; } catch {}

    return {
      running:    this._running,
      uptimeHrs:  uptime,
      stats:      { ...this._stats },
      dbSizeMb:   +(dbSize / 1024 / 1024).toFixed(2),
      backupDir:  this._backupDir,
    };
  }
}

module.exports = { ArbDataLogger };
