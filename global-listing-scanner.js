'use strict';

/**
 * GlobalListingScanner — 6거래소 신규 상장 감지기
 *
 * 지원: Upbit, Binance, Bybit, OKX, Gate.io, Bithumb
 *
 * 동작:
 *   - 5분마다 각 거래소 마켓 리스트 폴링
 *   - 이전 폴링에 없던 신규 심볼 감지
 *   - 알려진 심볼: 메모리 Set 관리
 *   - 우선순위: Upbit 상장 > 바이낸스 상장 (김치프리미엄 잠재력)
 *
 * 필요: 각 거래소의 getMarkets() API를 제공하는 어댑터
 */

// 레버리지/스테이블 토큰 필터
const IGNORE_SUFFIXES = ['UP', 'DOWN', 'BULL', 'BEAR', '3L', '3S', '2L', '2S'];
const STABLECOINS     = new Set([
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'PYUSD', 'USDD',
  'FRAX', 'USDP', 'GUSD', 'LUSD', 'SUSD',
]);

// 거래소별 우선순위 (높을수록 김프/상장 프리미엄 잠재력)
const PRIORITY_MAP = {
  upbit:   5,   // 최고 — 한국 독점 프리미엄
  bithumb: 4,
  binance: 3,
  bybit:   2,
  okx:     2,
  gate:    1,
};

const SCAN_INTERVAL_MS = 5 * 60_000;  // 5분

class GlobalListingScanner {
  /**
   * @param {Object}   opts
   * @param {Object}   opts.exchanges   - { name: ExchangeAdapter } (getMarkets 구현 필요)
   * @param {Function} opts.onNewListing - 콜백 (listing) => void
   * @param {number}   opts.scanInterval - 스캔 주기 ms
   */
  constructor({
    exchanges    = {},
    onNewListing,
    scanInterval = SCAN_INTERVAL_MS,
  } = {}) {
    this._exchanges    = exchanges;
    this._onNewListing = onNewListing || (() => {});
    this._scanInterval = scanInterval;
    this._intervalId   = null;
    this._running      = false;

    // 거래소별 알려진 심볼 Set (메모리)
    // key: exchange name, value: Set<symbol string>
    this._knownSymbols = new Map();

    // base 코인 → 상장 거래소 Set
    this._coinExchangeMap = new Map();

    // 감지 이력
    this._detections = [];

    this._stats = {
      totalScans:      0,
      totalDetections: 0,
      lastScanAt:      null,
      errors:          0,
    };
  }

  // ── 시작/종료 ──────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    const exchangeNames = Object.keys(this._exchanges);
    console.log(`[GlobalListingScanner] 시작 — ${exchangeNames.length}개 거래소 (${exchangeNames.join(', ')})`);

    // 초기 심볼 로드 (모든 거래소 병렬)
    await this._initializeKnown();

    // 결과 출력
    const counts = [];
    for (const [name, set] of this._knownSymbols) counts.push(`${name}:${set.size}`);
    console.log(`[GlobalListingScanner] 초기화 완료 — ${counts.join(', ')}`);

    // 주기적 스캔 (5분)
    this._intervalId = setInterval(
      () => this._scan().catch(e => {
        console.error('[GlobalListingScanner] 스캔 오류:', e.message);
        this._stats.errors++;
      }),
      this._scanInterval,
    );
  }

  stop() {
    this._running = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    console.log('[GlobalListingScanner] 종료');
  }

  // ── 초기 심볼 로드 ─────────────────────────────────────

  async _initializeKnown() {
    await Promise.allSettled(
      Object.entries(this._exchanges).map(async ([name, ex]) => {
        try {
          const markets = await ex.getMarkets();
          const symbolSet = new Set();

          for (const m of markets) {
            const base = m.base || m.symbol?.split(/[-_/]/)[0];
            if (this._shouldIgnore(base)) continue;
            symbolSet.add(m.symbol || `${base}-USDT`);

            // 코인 → 거래소 맵핑
            if (!this._coinExchangeMap.has(base)) this._coinExchangeMap.set(base, new Set());
            this._coinExchangeMap.get(base).add(name);
          }

          this._knownSymbols.set(name, symbolSet);
          console.log(`[GlobalListingScanner] ${name}: ${symbolSet.size}개 마켓 로드`);
        } catch (e) {
          console.error(`[GlobalListingScanner] ${name} 초기화 실패: ${e.message}`);
          this._knownSymbols.set(name, new Set());
        }
      })
    );
  }

  // ── 스캔 루프 ──────────────────────────────────────────

  async _scan() {
    if (!this._running) return;
    this._stats.totalScans++;
    this._stats.lastScanAt = Date.now();

    // 모든 거래소 병렬 스캔
    await Promise.allSettled(
      Object.entries(this._exchanges).map(([name, ex]) =>
        this._scanExchange(name, ex).catch(e => {
          this._stats.errors++;
          console.error(`[GlobalListingScanner] ${name} 스캔 실패: ${e.message}`);
        })
      )
    );
  }

  async _scanExchange(name, adapter) {
    // BUG FIX: 기존 코드는 fallback Set을 _knownSymbols에 저장하지 않아
    // 새 상장 감지 이후에도 known에 기록이 안 남아 같은 심볼 반복 감지 가능
    let known = this._knownSymbols.get(name);
    if (!known) {
      known = new Set();
      this._knownSymbols.set(name, known);
    }

    let markets;
    try {
      markets = await adapter.getMarkets();
    } catch (e) {
      throw new Error(`${name} getMarkets 실패: ${e.message}`);
    }

    for (const m of markets) {
      const base   = m.base || m.symbol?.split(/[-_/]/)[0];
      const symbol = m.symbol || `${base}-USDT`;

      if (this._shouldIgnore(base)) continue;
      if (known.has(symbol)) continue;

      // 신규 발견!
      known.add(symbol);

      // 크로스 레퍼런스: 다른 거래소에 이미 있는지
      const existsOn = this._coinExchangeMap.get(base);
      const alreadyOn = existsOn ? Array.from(existsOn).filter(ex => ex !== name) : [];

      // 코인 → 거래소 맵핑 갱신
      if (!this._coinExchangeMap.has(base)) this._coinExchangeMap.set(base, new Set());
      this._coinExchangeMap.get(base).add(name);

      const priority = PRIORITY_MAP[name] || 0;

      const detection = {
        symbol,
        base,
        exchange:       name,
        priority,
        alreadyOnOther: alreadyOn.length > 0,
        alreadyOn,
        detectedAt:     Date.now(),
      };

      // 이력 저장
      this._detections.unshift(detection);
      if (this._detections.length > 100) this._detections = this._detections.slice(0, 100);
      this._stats.totalDetections++;

      // 콘솔 알림 (Upbit 상장은 강조)
      const tag = name === 'upbit' ? '[UPBIT LISTING]' : `[${name}]`;
      console.log(
        `[GlobalListingScanner] ${tag} 신규 상장 감지! ${base} (${symbol}) | ` +
        `우선순위: ${priority} | ` +
        (alreadyOn.length > 0 ? `이미 상장: ${alreadyOn.join(',')}` : '최초 상장!')
      );

      // 콜백
      try { this._onNewListing(detection); } catch (e) {
        console.error(`[GlobalListingScanner] onNewListing 콜백 오류: ${e.message}`);
      }
    }
  }

  // ── 필터 ───────────────────────────────────────────────

  _shouldIgnore(base) {
    if (!base) return true;
    const upper = base.toUpperCase();
    if (STABLECOINS.has(upper)) return true;
    for (const suffix of IGNORE_SUFFIXES) {
      if (upper.endsWith(suffix) && upper.length > suffix.length) return true;
    }
    return false;
  }

  // ── 외부 API ──────────────────────────────────────────

  getDetections(limit = 20) { return this._detections.slice(0, limit); }

  getSummary() {
    const exchangeStatus = {};
    for (const [name] of Object.entries(this._exchanges)) {
      const known = this._knownSymbols.get(name);
      exchangeStatus[name] = {
        marketCount: known ? known.size : 0,
        priority:    PRIORITY_MAP[name] || 0,
      };
    }

    return {
      running:          this._running,
      exchanges:        exchangeStatus,
      totalScans:       this._stats.totalScans,
      totalDetections:  this._stats.totalDetections,
      lastScanAt:       this._stats.lastScanAt,
      errors:           this._stats.errors,
      recentDetections: this._detections.slice(0, 10).map(d => ({
        base:     d.base,
        exchange: d.exchange,
        priority: d.priority,
        alreadyOn: d.alreadyOn,
        detectedAt: d.detectedAt,
      })),
    };
  }
}

module.exports = { GlobalListingScanner };
