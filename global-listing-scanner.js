"use strict";

/**
 * GlobalListingScanner — 멀티 거래소 신규 상장 스캐너
 *
 * Binance, Bybit, Upbit 전체를 30초 간격으로 병렬 스캔하여
 * 새로운 USDT/KRW 페어 등장을 실시간 감지.
 *
 * 우선순위: Binance > Bybit > Upbit (시장 규모 순)
 * 크로스레퍼런스: 다른 거래소에 이미 상장된 코인 표시
 */

// 레버리지/스테이블 토큰 필터
const IGNORE_SUFFIXES = ["UP", "DOWN", "BULL", "BEAR", "3L", "3S", "2L", "2S"];
const STABLECOINS = new Set([
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "FDUSD", "PYUSD", "USDD",
  "FRAX", "USDP", "GUSD", "LUSD", "SUSD", "EUSD", "CUSD",
]);

// 거래소별 우선순위 (높을수록 중요)
const PRIORITY_MAP = {
  binance: 3,
  bybit:   2,
  upbit:   1,
};

class GlobalListingScanner {
  /**
   * @param {Object} opts
   * @param {Array}  opts.exchanges     - ExchangeAdapter 인스턴스 배열
   * @param {Function} opts.onNewListing - 콜백(listing)
   * @param {number} opts.scanInterval  - 스캔 주기 ms (기본 30000)
   */
  constructor({ exchanges = [], onNewListing, scanInterval = 30_000 } = {}) {
    this._exchanges    = exchanges;
    this._onNewListing = onNewListing || (() => {});
    this._scanInterval = scanInterval;
    this._intervalId   = null;
    this._running      = false;

    // 거래소별 알려진 심볼 셋 (base 코인 기준)
    // key: exchange name (lowercase), value: Set<symbol>
    this._knownSymbols = new Map();

    // 전체 알려진 base 코인 → 어느 거래소에 있는지 추적
    // key: base (e.g. "BTC"), value: Set<exchangeName>
    this._coinExchangeMap = new Map();

    // 감지 이력 (최근 50개)
    this._detections = [];

    // 통계
    this._stats = {
      totalScans:      0,
      totalDetections: 0,
      lastScanAt:      null,
      errors:          0,
    };
  }

  // ── 시작/종료 ──────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    console.log(`[GlobalScanner] 초기화 — ${this._exchanges.length}개 거래소 스캔 시작`);

    // 초기 심볼 로드 (병렬)
    await this._initializeKnownSymbols();

    // 주기적 스캔
    this._intervalId = setInterval(
      () => this._scan().catch(e => {
        console.error("[GlobalScanner] 스캔 오류:", e.message);
        this._stats.errors++;
      }),
      this._scanInterval
    );

    console.log(
      `[GlobalScanner] 초기화 완료 — ` +
      Array.from(this._knownSymbols.entries())
        .map(([name, set]) => `${name}:${set.size}`)
        .join(", ")
    );
  }

  stop() {
    this._running = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    console.log("[GlobalScanner] 중지됨");
  }

  // ── 초기 심볼 로드 ─────────────────────────────────────────

  async _initializeKnownSymbols() {
    const results = await Promise.allSettled(
      this._exchanges.map(async (ex) => {
        try {
          const markets = await ex.getMarkets();
          const name = ex.name.toLowerCase();
          const symbolSet = new Set();

          for (const m of markets) {
            if (this._shouldIgnore(m.base)) continue;
            symbolSet.add(m.symbol);

            // base 코인 → 거래소 맵핑
            if (!this._coinExchangeMap.has(m.base)) {
              this._coinExchangeMap.set(m.base, new Set());
            }
            this._coinExchangeMap.get(m.base).add(name);
          }

          this._knownSymbols.set(name, symbolSet);
          console.log(`[GlobalScanner] ${ex.name}: ${symbolSet.size}개 마켓 로드`);
        } catch (e) {
          console.error(`[GlobalScanner] ${ex.name} 초기화 실패: ${e.message}`);
          this._knownSymbols.set(ex.name.toLowerCase(), new Set());
        }
      })
    );
  }

  // ── 스캔 루프 ─────────────────────────────────────────────

  async _scan() {
    if (!this._running) return;
    this._stats.totalScans++;
    this._stats.lastScanAt = Date.now();

    // 모든 거래소 병렬 스캔
    const results = await Promise.allSettled(
      this._exchanges.map(ex => this._scanExchange(ex))
    );

    // 결과 집계
    for (const r of results) {
      if (r.status === "rejected") {
        this._stats.errors++;
      }
    }
  }

  async _scanExchange(exchange) {
    const name = exchange.name.toLowerCase();
    const known = this._knownSymbols.get(name) || new Set();

    try {
      const newListings = await exchange.getNewListings(known);

      for (const listing of newListings) {
        if (this._shouldIgnore(listing.base)) continue;

        // 알려진 심볼에 추가
        known.add(listing.symbol);

        // 크로스레퍼런스: 다른 거래소에 이미 있는지 확인
        const existsOn = this._coinExchangeMap.get(listing.base);
        const alreadyOnOther = existsOn ? existsOn.size > 0 : false;
        const alreadyOn = existsOn ? Array.from(existsOn) : [];

        // base 코인 → 거래소 맵핑 갱신
        if (!this._coinExchangeMap.has(listing.base)) {
          this._coinExchangeMap.set(listing.base, new Set());
        }
        this._coinExchangeMap.get(listing.base).add(name);

        // 감지 데이터 생성
        const detection = {
          symbol:         listing.symbol,
          base:           listing.base,
          exchange:        name,
          exchangeName:    exchange.name,
          detectedAt:     Date.now(),
          listedAt:       listing.listedAt,
          alreadyOnOther,
          alreadyOn,
          priority:       PRIORITY_MAP[name] || 0,
        };

        // 이력에 추가 (최대 50개)
        this._detections.unshift(detection);
        if (this._detections.length > 50) {
          this._detections = this._detections.slice(0, 50);
        }
        this._stats.totalDetections++;

        console.log(
          `[GlobalScanner] 신규 상장 감지! ${listing.base} @ ${exchange.name} ` +
          `(우선순위: ${detection.priority}) ` +
          (alreadyOnOther ? `[이미 상장: ${alreadyOn.join(",")}]` : "[최초 상장!]")
        );

        // 콜백 호출
        try {
          this._onNewListing(detection);
        } catch (e) {
          console.error(`[GlobalScanner] onNewListing 콜백 오류:`, e.message);
        }
      }
    } catch (e) {
      console.error(`[GlobalScanner] ${exchange.name} 스캔 실패: ${e.message}`);
      throw e;
    }
  }

  // ── 필터 ──────────────────────────────────────────────────

  _shouldIgnore(base) {
    if (!base) return true;
    const upper = base.toUpperCase();

    // 스테이블코인
    if (STABLECOINS.has(upper)) return true;

    // 레버리지 토큰 (UP/DOWN/BULL/BEAR 접미사)
    for (const suffix of IGNORE_SUFFIXES) {
      if (upper.endsWith(suffix) && upper.length > suffix.length) return true;
    }

    return false;
  }

  // ── 외부 API ──────────────────────────────────────────────

  /** 최근 감지 내역 (대시보드용) */
  getDetections() {
    return this._detections.slice(0, 20);
  }

  /** 요약 통계 (대시보드용) */
  getSummary() {
    const exchangeStatus = {};
    for (const ex of this._exchanges) {
      const name = ex.name.toLowerCase();
      const known = this._knownSymbols.get(name);
      exchangeStatus[name] = {
        name:       ex.name,
        connected:  known ? known.size > 0 : false,
        marketCount: known ? known.size : 0,
      };
    }

    return {
      running:         this._running,
      exchanges:       exchangeStatus,
      totalScans:      this._stats.totalScans,
      totalDetections: this._stats.totalDetections,
      lastScanAt:      this._stats.lastScanAt,
      errors:          this._stats.errors,
      recentDetections: this._detections.slice(0, 10).map(d => ({
        base:           d.base,
        exchange:        d.exchangeName,
        detectedAt:     d.detectedAt,
        alreadyOnOther: d.alreadyOnOther,
        priority:       d.priority,
      })),
    };
  }
}

module.exports = { GlobalListingScanner };
