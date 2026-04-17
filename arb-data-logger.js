'use strict';

const CFG = require("./config");

/**
 * ArbDataLogger — SQLite 아비트라지 데이터 축적 엔진
 *
 * DB: arb-data.db (better-sqlite3)
 *
 * 테이블 5개:
 *   1) price_snapshots   — 30초 간격, 거래소별 가격
 *   2) spread_events     — 차익 기회 감지 이벤트
 *   3) arb_executions    — 실행 결과 (시뮬/실전)
 *   4) orderbook_depth   — 5분 간격, 호가 깊이 (JSON)
 *   5) daily_summary     — 일별 집계
 *
 * WAL 모드 (동시 읽기), 1시간 WAL 백업, 자정 CSV 내보내기
 *
 * 필요 패키지: npm install better-sqlite3
 */

let Database;
try { Database = require('better-sqlite3'); } catch {
  Database = null;
}

const fs   = require('fs');
const path = require('path');

const SNAPSHOT_INTERVAL_MS = 30_000;       // 30초
const DEPTH_INTERVAL_MS    = 5 * 60_000;   // 5분
const WAL_BACKUP_INTERVAL  = 60 * 60_000;  // 1시간
const DAILY_EXPORT_HOUR    = 0;            // 자정

class ArbDataLogger {
  /**
   * @param {Object} opts
   * @param {string} opts.dbPath      - SQLite 파일 경로 (기본: ./arb-data.db)
   * @param {string} opts.backupDir   - CSV 백업 디렉토리 (기본: ./arb-backups)
   * @param {Object} opts.exchanges   - { name: ExchangeAdapter }
   * @param {number} opts.usdKrw      - USD/KRW 환율
   */
  constructor({
    dbPath    = './arb-data.db',
    backupDir = './arb-backups',
    exchanges = {},
    usdKrw    = CFG.DEFAULT_USD_KRW,
  } = {}) {
    this._dbPath    = dbPath;
    this._backupDir = backupDir;
    this._exchanges = exchanges;
    this._usdKrw    = usdKrw;
    this._db        = null;
    this._stmts     = {};
    this._ready     = false;
    this._running   = false;
    this._timers    = [];

    this._stats = {
      snapshots:  0,
      spreads:    0,
      executions: 0,
      depths:     0,
      exports:    0,
      errors:     0,
      startedAt:  null,
    };

    this._init();
  }

  setUsdKrw(rate) { if (rate > 0) this._usdKrw = rate; }

  // ── 초기화 ─────────────────────────────────────────────

  _init() {
    if (!Database) {
      console.warn('[ArbDataLogger] better-sqlite3 없음 — 데이터 축적 비활성화');
      return;
    }

    try {
      // 백업 디렉토리 생성
      if (!fs.existsSync(this._backupDir)) {
        fs.mkdirSync(this._backupDir, { recursive: true });
      }

      this._db = new Database(this._dbPath);
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('synchronous = NORMAL');
      this._migrate();
      this._ready = true;
      console.log(`[ArbDataLogger] 초기화 완료 — ${this._dbPath}`);
    } catch (e) {
      console.error(`[ArbDataLogger] 초기화 실패: ${e.message}`);
    }
  }

  _migrate() {
    const SCHEMA_VERSION = 2;
    const currentVersion = this._db.pragma('user_version', { simple: true });

    if (currentVersion !== SCHEMA_VERSION) {
      // Rename any legacy tables to preserve old data, then recreate fresh
      const legacySuffix = `_legacy_v${currentVersion}_${Date.now()}`;
      const tables = ['price_snapshots', 'spread_events', 'arb_executions', 'orderbook_depth', 'daily_summary'];
      for (const t of tables) {
        const exists = this._db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
        ).get(t);
        if (exists) {
          try {
            this._db.exec(`ALTER TABLE ${t} RENAME TO ${t}${legacySuffix}`);
            console.log(`[ArbDataLogger] legacy table preserved: ${t}${legacySuffix}`);
          } catch (e) {
            console.warn(`[ArbDataLogger] could not rename ${t}: ${e.message} — dropping`);
            this._db.exec(`DROP TABLE IF EXISTS ${t}`);
          }
        }
      }
      this._db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }

    this._db.exec(`
      -- 1) 가격 스냅샷 (30초 간격)
      CREATE TABLE IF NOT EXISTS price_snapshots (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        exchange  TEXT    NOT NULL,
        symbol    TEXT    NOT NULL,
        bid       REAL,
        ask       REAL,
        price     REAL    NOT NULL,
        volume    REAL    DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ps_ts     ON price_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ps_sym_ts ON price_snapshots(symbol, timestamp);

      -- 2) 스프레드 이벤트
      CREATE TABLE IF NOT EXISTS spread_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       INTEGER NOT NULL,
        buy_exchange    TEXT    NOT NULL,
        sell_exchange   TEXT    NOT NULL,
        symbol          TEXT    NOT NULL,
        spread_pct      REAL    NOT NULL,
        net_spread_pct  REAL    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_se_ts ON spread_events(timestamp);

      -- 3) 아비트라지 실행 결과
      CREATE TABLE IF NOT EXISTS arb_executions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       INTEGER NOT NULL,
        buy_exchange    TEXT    NOT NULL,
        sell_exchange   TEXT    NOT NULL,
        symbol          TEXT    NOT NULL,
        amount          REAL    NOT NULL,
        spread_pct      REAL    NOT NULL,
        pnl             REAL    NOT NULL,
        status          TEXT    DEFAULT 'completed'
      );
      CREATE INDEX IF NOT EXISTS idx_ae_ts ON arb_executions(timestamp);

      -- 4) 호가 깊이 (5분 간격, JSON)
      CREATE TABLE IF NOT EXISTS orderbook_depth (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       INTEGER NOT NULL,
        exchange        TEXT    NOT NULL,
        symbol          TEXT    NOT NULL,
        bid_depth_json  TEXT,
        ask_depth_json  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_od_ts ON orderbook_depth(timestamp);

      -- 5) 일별 요약
      CREATE TABLE IF NOT EXISTS daily_summary (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        date                TEXT    NOT NULL UNIQUE,
        total_opportunities INTEGER DEFAULT 0,
        executed            INTEGER DEFAULT 0,
        total_pnl           REAL    DEFAULT 0,
        avg_spread          REAL    DEFAULT 0
      );
    `);

    // 프리페어드 스테이트먼트
    this._stmts = {
      insertSnapshot: this._db.prepare(`
        INSERT INTO price_snapshots (timestamp, exchange, symbol, bid, ask, price, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      insertSpread: this._db.prepare(`
        INSERT INTO spread_events (timestamp, buy_exchange, sell_exchange, symbol, spread_pct, net_spread_pct)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      insertExecution: this._db.prepare(`
        INSERT INTO arb_executions (timestamp, buy_exchange, sell_exchange, symbol, amount, spread_pct, pnl, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertDepth: this._db.prepare(`
        INSERT INTO orderbook_depth (timestamp, exchange, symbol, bid_depth_json, ask_depth_json)
        VALUES (?, ?, ?, ?, ?)
      `),
      upsertDaily: this._db.prepare(`
        INSERT INTO daily_summary (date, total_opportunities, executed, total_pnl, avg_spread)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          total_opportunities = excluded.total_opportunities,
          executed            = excluded.executed,
          total_pnl           = excluded.total_pnl,
          avg_spread          = excluded.avg_spread
      `),
    };
  }

  // ── 시작/종료 ──────────────────────────────────────────

  async start() {
    if (!this._ready || this._running) return;
    this._running = true;
    this._stats.startedAt = Date.now();

    console.log(
      `[ArbDataLogger] 데이터 축적 시작 — ` +
      `스냅샷:${SNAPSHOT_INTERVAL_MS / 1000}초, 호가:${DEPTH_INTERVAL_MS / 60_000}분, ` +
      `WAL백업:${WAL_BACKUP_INTERVAL / 3600_000}시간`
    );

    // 가격 스냅샷 (30초)
    this._timers.push(setInterval(() => this._captureSnapshots().catch(this._onErr), SNAPSHOT_INTERVAL_MS));

    // 호가 깊이 (5분)
    this._timers.push(setInterval(() => this._captureDepth().catch(this._onErr), DEPTH_INTERVAL_MS));

    // WAL 백업 (1시간)
    this._timers.push(setInterval(() => this._walBackup(), WAL_BACKUP_INTERVAL));

    // 일별 CSV 내보내기 (1분 체크, 자정 실행)
    this._timers.push(setInterval(() => this._checkMidnightExport(), 60_000));

    // 즉시 1회 스냅샷
    await this._captureSnapshots().catch(this._onErr);
  }

  stop() {
    this._running = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];

    if (this._db) {
      try { this._db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
      try { this._db.close(); } catch {}
    }
    console.log(
      `[ArbDataLogger] 종료 — 스냅샷:${this._stats.snapshots}, ` +
      `스프레드:${this._stats.spreads}, 실행:${this._stats.executions}`
    );
  }

  _onErr = (e) => {
    this._stats.errors++;
    console.error(`[ArbDataLogger] ${e.message}`);
  };

  // ── 가격 스냅샷 수집 (30초) ────────────────────────────

  async _captureSnapshots() {
    if (!this._ready) return;
    const now = Date.now();
    // 실전 데이터 기반: ARB/OP가 실제 스프레드 발생 코인 (BTC/ETH 아님)
    const coins = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'ADA', 'AVAX', 'ARB', 'OP'];
    const exchangeList = Object.entries(this._exchanges);

    const rows = [];
    const failures = {};
    for (const [name, ex] of exchangeList) {
      const batch = await Promise.allSettled(
        coins.map(coin =>
          ex.getTicker(coin).then(t => ({
            exchange: name, symbol: coin,
            bid:    t.bid    || t.price,
            ask:    t.ask    || t.price,
            price:  t.price,
            volume: t.volume24h || 0,
          }))
        )
      );
      for (let i = 0; i < batch.length; i++) {
        const r = batch[i];
        if (r.status === 'fulfilled' && r.value) {
          rows.push(r.value);
        } else {
          failures[name] = failures[name] || [];
          failures[name].push(`${coins[i]}:${r.reason?.message || 'null'}`);
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (Object.keys(failures).length > 0 && this._stats.snapshots === 0) {
      console.warn('[ArbDataLogger] snapshot failures:', JSON.stringify(failures));
    }

    if (rows.length > 0) {
      const insertMany = this._db.transaction((items) => {
        for (const r of items) {
          this._stmts.insertSnapshot.run(now, r.exchange, r.symbol, r.bid, r.ask, r.price, r.volume);
        }
      });
      insertMany(rows);
      this._stats.snapshots += rows.length;
    }
  }

  // ── 스프레드 이벤트 기록 ───────────────────────────────

  logSpreadEvent(event) {
    if (!this._ready) return;
    try {
      this._stmts.insertSpread.run(
        event.timestamp || Date.now(),
        event.buyExchange,
        event.sellExchange,
        event.symbol,
        event.spread      || event.spreadPct || 0,
        event.netSpread   || event.netSpreadPct || 0,
      );
      this._stats.spreads++;
    } catch (e) { this._onErr(e); }
  }

  // ── 실행 결과 기록 ─────────────────────────────────────

  logExecution(result) {
    if (!this._ready || !result.executed) return;
    try {
      this._stmts.insertExecution.run(
        result.timestamp || Date.now(),
        result.buyExchange,
        result.sellExchange,
        result.coin || result.symbol,
        result.positionUsd || result.amount || 0,
        result.spreadPct   || 0,
        result.profitUsd   || result.pnl || 0,
        result.dryRun ? 'dry_run' : 'completed',
      );
      this._stats.executions++;
    } catch (e) { this._onErr(e); }
  }

  // ── 호가 깊이 수집 (5분) ──────────────────────────────

  async _captureDepth() {
    if (!this._ready) return;
    const now = Date.now();
    const coins = ['BTC', 'ETH'];

    const rows = [];
    for (const [name, ex] of Object.entries(this._exchanges)) {
      if (!ex.getOrderbook) continue;
      const batch = await Promise.allSettled(
        coins.map(coin =>
          ex.getOrderbook(coin, 5)
            .then(ob => ({
              exchange:     name,
              symbol:       coin,
              bidDepthJson: JSON.stringify(ob.bids || []),
              askDepthJson: JSON.stringify(ob.asks || []),
            }))
            .catch(() => null)
        )
      );
      for (const r of batch) {
        if (r.status === 'fulfilled' && r.value) rows.push(r.value);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (rows.length > 0) {
      const insertMany = this._db.transaction((items) => {
        for (const r of items) {
          this._stmts.insertDepth.run(now, r.exchange, r.symbol, r.bidDepthJson, r.askDepthJson);
        }
      });
      insertMany(rows);
      this._stats.depths += rows.length;
    }
  }

  // ── WAL 백업 (1시간) ──────────────────────────────────

  _walBackup() {
    if (!this._db) return;
    try {
      this._db.pragma('wal_checkpoint(TRUNCATE)');

      const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const dest = path.join(this._backupDir, `arb-data-${ts}.db`);
      this._db.backup(dest)
        .then(() => {
          console.log(`[ArbDataLogger] WAL 백업 완료 → ${dest}`);
          this._cleanOldBackups();
        })
        .catch(e => console.error(`[ArbDataLogger] 백업 실패: ${e.message}`));
    } catch (e) {
      console.error(`[ArbDataLogger] WAL 체크포인트 오류: ${e.message}`);
    }
  }

  _cleanOldBackups() {
    try {
      const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
      const files  = fs.readdirSync(this._backupDir);
      for (const f of files) {
        if (!f.endsWith('.db')) continue;
        const fp   = path.join(this._backupDir, f);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
      }
    } catch {}
  }

  // ── 자정 CSV 내보내기 ──────────────────────────────────

  _checkMidnightExport() {
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
      const startTs   = new Date(yesterday + 'T00:00:00').getTime();
      const endTs     = startTs + 86400_000;

      // spread_events CSV
      const spreads = this._db.prepare(
        'SELECT * FROM spread_events WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp'
      ).all(startTs, endTs);

      if (spreads.length > 0) {
        const csvPath = path.join(this._backupDir, `spreads-${yesterday}.csv`);
        const header  = 'timestamp,buy_exchange,sell_exchange,symbol,spread_pct,net_spread_pct\n';
        const rows    = spreads.map(r =>
          `${r.timestamp},${r.buy_exchange},${r.sell_exchange},${r.symbol},${r.spread_pct},${r.net_spread_pct}`
        ).join('\n');
        fs.writeFileSync(csvPath, header + rows);
        console.log(`[ArbDataLogger] CSV 내보내기 → ${csvPath} (${spreads.length}건)`);
      }

      // arb_executions CSV
      const execs = this._db.prepare(
        'SELECT * FROM arb_executions WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp'
      ).all(startTs, endTs);

      if (execs.length > 0) {
        const csvPath = path.join(this._backupDir, `executions-${yesterday}.csv`);
        const header  = 'timestamp,buy_exchange,sell_exchange,symbol,amount,spread_pct,pnl,status\n';
        const rows    = execs.map(r =>
          `${r.timestamp},${r.buy_exchange},${r.sell_exchange},${r.symbol},${r.amount},${r.spread_pct},${r.pnl},${r.status}`
        ).join('\n');
        fs.writeFileSync(csvPath, header + rows);
      }

      // price_snapshots CSV
      const snaps = this._db.prepare(
        'SELECT * FROM price_snapshots WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp'
      ).all(startTs, endTs);

      if (snaps.length > 0) {
        const csvPath = path.join(this._backupDir, `prices-${yesterday}.csv`);
        const header  = 'timestamp,exchange,symbol,bid,ask,price,volume\n';
        const rows    = snaps.map(r =>
          `${r.timestamp},${r.exchange},${r.symbol},${r.bid},${r.ask},${r.price},${r.volume}`
        ).join('\n');
        fs.writeFileSync(csvPath, header + rows);
      }

      this._stats.exports++;
    } catch (e) {
      console.error(`[ArbDataLogger] CSV 내보내기 실패: ${e.message}`);
    }
  }

  _updateDailySummary() {
    if (!this._db) return;
    try {
      const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      const startTs   = new Date(yesterday + 'T00:00:00').getTime();
      const endTs     = startTs + 86400_000;

      const spreadCount = this._db.prepare(
        'SELECT COUNT(*) as cnt FROM spread_events WHERE timestamp >= ? AND timestamp < ?'
      ).get(startTs, endTs)?.cnt || 0;

      const execStats = this._db.prepare(`
        SELECT
          COUNT(*) as cnt,
          SUM(pnl) as totalPnl,
          AVG(spread_pct) as avgSpread
        FROM arb_executions WHERE timestamp >= ? AND timestamp < ?
      `).get(startTs, endTs);

      this._stmts.upsertDaily.run(
        yesterday,
        spreadCount,
        execStats?.cnt || 0,
        execStats?.totalPnl || 0,
        execStats?.avgSpread || 0,
      );
    } catch (e) {
      console.error(`[ArbDataLogger] 일별 요약 실패: ${e.message}`);
    }
  }

  // ── 조회 API ───────────────────────────────────────────

  /** 특정 코인의 거래소별 가격 히스토리 */
  getPriceHistory(symbol, hours = 24) {
    if (!this._db) return [];
    const since = Date.now() - hours * 3600_000;
    return this._db.prepare(
      'SELECT exchange, price, timestamp FROM price_snapshots WHERE symbol = ? AND timestamp >= ? ORDER BY timestamp'
    ).all(symbol, since);
  }

  /** 스프레드 분포 분석 */
  getSpreadDistribution(hours = 24) {
    if (!this._db) return [];
    const since = Date.now() - hours * 3600_000;
    return this._db.prepare(`
      SELECT symbol, buy_exchange, sell_exchange,
        COUNT(*) as count, AVG(spread_pct) as avg_spread,
        MAX(spread_pct) as max_spread, AVG(net_spread_pct) as avg_net
      FROM spread_events WHERE timestamp >= ?
      GROUP BY symbol, buy_exchange, sell_exchange
      ORDER BY avg_spread DESC
    `).all(since);
  }

  /** 수익성 분석 */
  getProfitAnalysis(days = 7) {
    if (!this._db) return [];
    const since = Date.now() - days * 86400_000;
    return this._db.prepare(`
      SELECT symbol, COUNT(*) as trades, SUM(pnl) as total_pnl,
        AVG(spread_pct) as avg_spread,
        SUM(CASE WHEN pnl >= 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
      FROM arb_executions WHERE timestamp >= ?
      GROUP BY symbol ORDER BY total_pnl DESC
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
      running:   this._running,
      uptimeHrs: uptime,
      stats:     { ...this._stats },
      dbSizeMb:  +(dbSize / 1024 / 1024).toFixed(2),
      backupDir: this._backupDir,
    };
  }
}

module.exports = { ArbDataLogger };
