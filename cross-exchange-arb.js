'use strict';

/**
 * CrossExchangeArb — 듀얼 모드 크로스 거래소 차익 감지기
 *
 * 모드:
 *   1) REST 모드: 6개 거래소 15초 폴링
 *   2) WS 모드:   WebSocket 실시간 가격 수신 (~100ms 레이턴시)
 *
 * 비교: 6개 거래소 중 6C2 = 15쌍 모든 조합 비교
 * KRW/USD 교차 비교 시 환율 적용
 *
 * 환경변수:
 *   ARB_MIN_SPREAD_PCT — 최소 스프레드 % (기본 1.2)
 */

const { EventEmitter } = require('events');

require('dotenv').config();

// 6개 거래소 이름
const ALL_EXCHANGES = ['upbit', 'binance', 'bybit', 'okx', 'gate', 'bithumb'];

// 기본 모니터링 코인
const DEFAULT_COINS = [
  'BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOGE', 'AVAX',
  'DOT', 'LINK', 'MATIC', 'NEAR', 'APT', 'ARB', 'OP',
  'AAVE', 'UNI', 'ATOM', 'FIL', 'ICP', 'HBAR',
];

const CFG = require("./config");

// 거래소별 편도 수수료
const FEE_MAP = {
  upbit:   CFG.ARB_FEE_UPBIT,
  binance: CFG.ARB_FEE_BINANCE,
  bybit:   CFG.ARB_FEE_BYBIT,
  okx:     CFG.ARB_FEE_OKX,
  gate:    CFG.ARB_FEE_GATE,
  bithumb: CFG.ARB_FEE_BITHUMB,
};

const REST_POLL_INTERVAL_MS = CFG.ARB_REST_POLL_INTERVAL_MS;
const MAX_TS_SKEW_MS        = CFG.ARB_MAX_TS_SKEW_MS;
const DEDUP_BUCKET_PCT      = CFG.ARB_DEDUP_BUCKET_PCT;
const DEDUP_WINDOW_MS       = CFG.ARB_DEDUP_WINDOW_MS;
const LIVE_TTL_MS           = CFG.ARB_LIVE_TTL_MS;
const PRUNE_INTERVAL_MS     = CFG.ARB_PRUNE_INTERVAL_MS;

class CrossExchangeArb extends EventEmitter {
  /**
   * @param {Object}   opts
   * @param {Object}   opts.exchanges    - { name: ExchangeAdapter } 매핑 (REST 모드)
   * @param {number}   opts.usdKrw       - USD/KRW 환율
   * @param {number}   opts.minSpreadPct - 최소 스프레드 % (기본 ARB_MIN_SPREAD_PCT || 1.2)
   * @param {number}   opts.scanInterval - REST 폴링 주기 ms (기본 15000)
   * @param {Object}   opts.multiExWs    - ExchangeWebSocketManager (WS 모드)
   * @param {Object}   opts.upbitWs      - UpbitWebSocket (WS 모드)
   */
  constructor({
    exchanges = {},
    usdKrw = CFG.DEFAULT_USD_KRW,
    minSpreadPct,
    scanInterval = REST_POLL_INTERVAL_MS,
    multiExWs = null,
    upbitWs = null,
  } = {}) {
    super();

    this._exchanges    = exchanges;         // REST 어댑터
    this._usdKrw       = usdKrw;
    this._minSpreadPct = minSpreadPct ?? (parseFloat(process.env.ARB_MIN_SPREAD_PCT) || 1.2);
    this._scanInterval = scanInterval;
    this._multiExWs    = multiExWs;         // WS 매니저 (Binance/Bybit/OKX/Gate)
    this._upbitWs      = upbitWs;           // Upbit WS
    this._intervalId   = null;
    this._running      = false;

    this._coins = new Set(DEFAULT_COINS);

    // 실시간 가격 저장 (WS 모드)
    // coin → { exchangeName: priceUsd, ... }
    this._liveprices = new Map();

    // 현재 열린 차익 기회
    this._opportunities = [];

    // 기회 이력 (최근 200개)
    this._history = [];

    // 통계
    this._stats = {
      totalScans:    0,
      totalOpps:     0,
      maxSpread:     0,
      lastScanAt:    null,
      errors:        0,
      wsOpps:        0,
      restOpps:      0,
    };
  }

  // ── 시작/종료 ──────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    const exchangeNames = Object.keys(this._exchanges);
    const pairCount = exchangeNames.length * (exchangeNames.length - 1) / 2;

    console.log(
      `[CrossExchangeArb] 시작 — ${exchangeNames.length}개 거래소, ` +
      `${pairCount}쌍 비교, ${this._coins.size}개 코인, ` +
      `최소 스프레드: ${this._minSpreadPct}%, USD/KRW: ${this._usdKrw}`
    );

    // ── WS 모드: 실시간 가격 수신 연결 ──────────────
    if (this._multiExWs) {
      this._multiExWs.on('ticker', (data) => {
        this._onWsTicker(data.exchange, data.symbol, data);
      });
      console.log('[CrossExchangeArb] WS 모드 활성화 — Binance/Bybit/OKX/Gate 실시간 감지');
    }

    if (this._upbitWs) {
      this._upbitWs.on('ticker', (data) => {
        // Upbit은 KRW → USD 환산
        const coin = data.symbol.replace('KRW-', '');
        const priceUsd = this._usdKrw > 0 ? data.price / this._usdKrw : data.price;
        this._onWsTicker('upbit', coin, {
          ...data,
          price: priceUsd,
          bid:   (data.bid || data.price) / this._usdKrw,
          ask:   (data.ask || data.price) / this._usdKrw,
        });
      });
      console.log('[CrossExchangeArb] Upbit WS 실시간 감지 활성화');
    }

    // ── REST 모드: 백업 폴링 (WS 장애 대비) ──────────
    await this._restScan().catch(e => {
      console.error('[CrossExchangeArb] 초기 REST 스캔 오류:', e.message);
      this._stats.errors++;
    });

    this._intervalId = setInterval(
      () => this._restScan().catch(e => {
        console.error('[CrossExchangeArb] REST 스캔 오류:', e.message);
        this._stats.errors++;
      }),
      this._scanInterval,
    );

    // TTL 프루닝: _liveprices, _lastLogged, _dedupBuckets (메모리 누수 방지)
    this._pruneIntervalId = setInterval(() => this._prune(), PRUNE_INTERVAL_MS);
  }

  // 오래된 가격/로그/디덥 엔트리 제거 (누수 방지)
  _prune() {
    const cutoff = Date.now() - LIVE_TTL_MS;
    for (const [coin, exMap] of this._liveprices) {
      for (const [ex, p] of Object.entries(exMap)) {
        if ((p?.ts || 0) < cutoff) delete exMap[ex];
      }
      if (Object.keys(exMap).length === 0) this._liveprices.delete(coin);
    }
    if (this._lastLogged) {
      for (const [k, t] of this._lastLogged) if (t < cutoff) this._lastLogged.delete(k);
    }
    if (this._dedupBuckets) {
      const dedupCutoff = Date.now() - DEDUP_WINDOW_MS;
      for (const [k, t] of this._dedupBuckets) if (t < dedupCutoff) this._dedupBuckets.delete(k);
    }
  }

  stop() {
    this._running = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    if (this._pruneIntervalId) {
      clearInterval(this._pruneIntervalId);
      this._pruneIntervalId = null;
    }
    console.log('[CrossExchangeArb] 중지됨');
  }

  // ── 환율 설정 ──────────────────────────────────────────

  setUsdKrw(rate) { if (rate > 0) this._usdKrw = rate; }

  /** 모니터링 코인 추가 */
  addCoin(base) {
    if (base && !this._coins.has(base.toUpperCase())) {
      this._coins.add(base.toUpperCase());
      console.log(`[CrossExchangeArb] 코인 추가: ${base} (총 ${this._coins.size}개)`);
    }
  }

  // ── WS 모드: 실시간 가격 수신 → 즉시 스프레드 비교 ────

  _onWsTicker(exchange, coin, data) {
    if (!this._running || !this._coins.has(coin.toUpperCase())) return;

    const upperCoin = coin.toUpperCase();

    // 실시간 가격 저장
    if (!this._liveprices) this._liveprices = new Map();
    if (!this._liveprices.has(upperCoin)) this._liveprices.set(upperCoin, {});
    this._liveprices.get(upperCoin)[exchange] = {
      price: data.price,
      bid:   data.bid || data.price,
      ask:   data.ask || data.price,
      volume: data.volume || 0,
      ts:    Date.now(),
    };

    // 해당 코인에 대해 모든 거래소 쌍 비교
    const coinPrices = this._liveprices.get(upperCoin);
    const exchangeNames = Object.keys(coinPrices);
    if (exchangeNames.length < 2) return;

    // 6C2 쌍 비교
    for (let i = 0; i < exchangeNames.length; i++) {
      for (let j = i + 1; j < exchangeNames.length; j++) {
        const ex1 = exchangeNames[i];
        const ex2 = exchangeNames[j];
        const p1  = coinPrices[ex1];
        const p2  = coinPrices[ex2];

        // 데이터 신선도 확인 (10초 이내)
        if (Date.now() - p1.ts > 10_000 || Date.now() - p2.ts > 10_000) continue;

        this._compareAndEmit(upperCoin, ex1, p1, ex2, p2, 'websocket');
      }
    }
  }

  // ── REST 모드: 주기적 전체 스캔 ───────────────────────

  async _restScan() {
    if (!this._running) return;
    this._stats.totalScans++;
    this._stats.lastScanAt = Date.now();

    const exchangeEntries = Object.entries(this._exchanges);
    if (exchangeEntries.length < 2) return;

    // 거래소별 가격 수집: coin → [{ exchange, priceUsd, bid, ask, volume }]
    const priceMap = new Map();

    for (const [name, ex] of exchangeEntries) {
      const results = await Promise.allSettled(
        Array.from(this._coins).map(coin => this._fetchRestPrice(name, ex, coin))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          const d = r.value;
          if (!priceMap.has(d.coin)) priceMap.set(d.coin, []);
          priceMap.get(d.coin).push(d);
        }
      }
      // Rate limit 보호
      await new Promise(r => setTimeout(r, 50));
    }

    // 모든 쌍 비교
    const newOpps = [];
    for (const [coin, prices] of priceMap) {
      if (prices.length < 2) continue;

      // 6C2 비교 (모든 조합)
      for (let i = 0; i < prices.length; i++) {
        for (let j = i + 1; j < prices.length; j++) {
          const opp = this._compareAndEmit(
            coin,
            prices[i].exchange, prices[i],
            prices[j].exchange, prices[j],
            'rest',
          );
          if (opp) newOpps.push(opp);
        }
      }
    }

    this._opportunities = newOpps;
  }

  async _fetchRestPrice(exchangeName, adapter, coin) {
    try {
      const ticker = await adapter.getTicker(coin);
      if (!ticker || !ticker.price) return null;

      let priceUsd = ticker.price;
      let bid = ticker.bid || ticker.price;
      let ask = ticker.ask || ticker.price;

      // KRW 거래소 → USD 환산
      if (adapter.quoteCurrency === 'KRW' && this._usdKrw > 0) {
        priceUsd = ticker.price / this._usdKrw;
        bid      = bid / this._usdKrw;
        ask      = ask / this._usdKrw;
      }

      return {
        coin,
        exchange: exchangeName,
        price:    priceUsd,
        bid,
        ask,
        volume:   ticker.volume24h || 0,
      };
    } catch {
      return null;
    }
  }

  // ── 스프레드 비교 & 이벤트 발행 ───────────────────────

  _compareAndEmit(coin, ex1Name, p1, ex2Name, p2, source) {
    const price1 = p1.price;
    const price2 = p2.price;
    if (!price1 || !price2 || price1 <= 0 || price2 <= 0) return null;

    // Stale quote 필터: 양쪽 타임스탬프 싱크 확인 (WS/REST 혼합 시 오탐 방지)
    const now = Date.now();
    const ts1 = p1.ts || now;
    const ts2 = p2.ts || now;
    if (Math.abs(ts1 - ts2) > MAX_TS_SKEW_MS) {
      this._stats.staleRejected = (this._stats.staleRejected || 0) + 1;
      return null;
    }
    // 어느 한쪽이라도 10초 이상 묵은 가격이면 거부
    if (now - ts1 > 10_000 || now - ts2 > 10_000) {
      this._stats.staleRejected = (this._stats.staleRejected || 0) + 1;
      return null;
    }

    // 저가/고가 결정
    const low  = price1 < price2
      ? { exchange: ex1Name, price: price1, bid: p1.bid, ask: p1.ask, volume: p1.volume, ts: ts1 }
      : { exchange: ex2Name, price: price2, bid: p2.bid, ask: p2.ask, volume: p2.volume, ts: ts2 };
    const high = price1 < price2
      ? { exchange: ex2Name, price: price2, bid: p2.bid, ask: p2.ask, volume: p2.volume, ts: ts2 }
      : { exchange: ex1Name, price: price1, bid: p1.bid, ask: p1.ask, volume: p1.volume, ts: ts1 };

    const spreadPct = (high.price - low.price) / low.price * 100;

    // 양쪽 수수료 차감
    const buyFee  = FEE_MAP[low.exchange]  || 0.001;
    const sellFee = FEE_MAP[high.exchange] || 0.001;
    const netSpreadPct = spreadPct - (buyFee + sellFee) * 100;

    if (spreadPct < this._minSpreadPct) return null;

    // 동일 스프레드 버킷 재발행 거부 (stale quote가 같은 값 반복 방출 방지)
    // 예: 1.152% 5연타 → 60초 내 1회만 통과
    if (!this._dedupBuckets) this._dedupBuckets = new Map();
    const bucket = Math.round(spreadPct / DEDUP_BUCKET_PCT) * DEDUP_BUCKET_PCT;
    const dedupKey = `${coin}-${low.exchange}-${high.exchange}-${bucket.toFixed(2)}`;
    const lastSeen = this._dedupBuckets.get(dedupKey) || 0;
    if (now - lastSeen < DEDUP_WINDOW_MS) {
      this._stats.dedupRejected = (this._stats.dedupRejected || 0) + 1;
      return null;
    }
    this._dedupBuckets.set(dedupKey, now);

    const opp = {
      buyExchange:  low.exchange,
      sellExchange: high.exchange,
      symbol:       coin,
      spread:       +spreadPct.toFixed(3),
      netSpread:    +netSpreadPct.toFixed(3),
      buyPrice:     +low.price.toFixed(6),
      sellPrice:    +high.price.toFixed(6),
      buyTs:        low.ts,
      sellTs:       high.ts,
      volume:       Math.min(low.volume || 0, high.volume || 0),
      source,
      detectedAt:   now,
    };

    // 통계 갱신
    this._stats.totalOpps++;
    if (source === 'websocket') this._stats.wsOpps++;
    else this._stats.restOpps++;
    if (spreadPct > this._stats.maxSpread) this._stats.maxSpread = +spreadPct.toFixed(3);

    // 이력 저장
    this._history.unshift(opp);
    if (this._history.length > 200) this._history = this._history.slice(0, 200);

    // 로그 (dedup: 10초당 1회 per coin+pair)
    const tag = source === 'websocket' ? 'WS' : 'REST';
    const logKey = `${coin}-${low.exchange}-${high.exchange}`;
    this._lastLogged = this._lastLogged || new Map();
    const nowLog = Date.now();
    if (nowLog - (this._lastLogged.get(logKey) || 0) >= 10_000) {
      this._lastLogged.set(logKey, nowLog);
      console.log(
        `[CrossExchangeArb] [${tag}] ${coin} — ` +
        `${low.exchange}($${low.price.toFixed(2)}) -> ${high.exchange}($${high.price.toFixed(2)}) | ` +
        `스프레드: ${spreadPct.toFixed(2)}% | 순이익: ${netSpreadPct.toFixed(2)}%`
      );
    }

    // 이벤트 발행
    this.emit('opportunity', opp);

    return opp;
  }

  // ── 외부 API ──────────────────────────────────────────

  getOpportunities() { return this._opportunities; }
  getHistory(limit = 50) { return this._history.slice(0, limit); }

  getSummary() {
    const topOpp = this._opportunities.length > 0
      ? this._opportunities.sort((a, b) => b.spread - a.spread)[0]
      : null;

    return {
      running:       this._running,
      coinCount:     this._coins.size,
      exchangeCount: Object.keys(this._exchanges).length,
      minSpreadPct:  this._minSpreadPct,
      wsEnabled:     !!this._multiExWs,
      stats:         { ...this._stats },
      currentOpps:   this._opportunities.length,
      topOpportunity: topOpp,
      recentHistory: this._history.slice(0, 10),
    };
  }
}

module.exports = { CrossExchangeArb };
