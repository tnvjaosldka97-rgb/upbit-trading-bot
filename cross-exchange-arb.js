"use strict";

/**
 * CrossExchangeArb — 교차 거래소 차익 거래 감지기
 *
 * 여러 거래소의 동일 코인 가격을 비교하여
 * 스프레드가 임계값을 초과하면 차익 기회를 알림.
 *
 * Upbit(KRW) vs Binance/Bybit(USDT) 비교 시 USD/KRW 환율 적용.
 */

// 기본 모니터링 대상 코인 (base 기준)
const DEFAULT_COINS = [
  "BTC", "ETH", "XRP", "SOL", "ADA", "DOGE", "AVAX",
  "DOT", "LINK", "MATIC", "NEAR", "APT", "ARB", "OP",
  "AAVE", "UNI", "ATOM", "FIL", "ICP", "HBAR",
];

// 거래소별 수수료 (편도) — 보수적 추정
const FEE_PER_SIDE = 0.001; // 0.1%
const TOTAL_FEE    = FEE_PER_SIDE * 2; // 양쪽 0.2%

class CrossExchangeArb {
  /**
   * @param {Object} opts
   * @param {Array}  opts.exchanges    - ExchangeAdapter 인스턴스 배열
   * @param {number} opts.usdKrw       - USD/KRW 환율 (기본 1350)
   * @param {number} opts.minSpreadPct - 최소 스프레드 % (기본 1.5)
   * @param {Function} opts.onOpportunity - 기회 발견 시 콜백
   * @param {number} opts.scanInterval - 스캔 주기 ms (기본 15000)
   * @param {Object} opts.multiExWs    - MultiExchangeWebSocket 인스턴스 (옵션)
   * @param {Object} opts.upbitWs      - UpbitWebSocket 인스턴스 (옵션)
   */
  constructor({
    exchanges = [],
    usdKrw = 1350,
    minSpreadPct = 1.5,
    onOpportunity,
    scanInterval = 15_000,
    multiExWs = null,
    upbitWs = null,
  } = {}) {
    this._exchanges    = exchanges;
    this._usdKrw       = usdKrw;
    this._minSpreadPct = minSpreadPct;
    this._onOpportunity = onOpportunity || (() => {});
    this._scanInterval = scanInterval;
    this._intervalId   = null;
    this._running      = false;
    this._multiExWs    = multiExWs;  // Binance/Bybit WS
    this._upbitWs      = upbitWs;    // Upbit WS

    // 모니터링 코인 목록 (동적으로 추가 가능)
    this._coins = new Set(DEFAULT_COINS);

    // 현재 열린 차익 기회
    this._opportunities = [];

    // 기회 이력 (최근 100개)
    this._history = [];

    // WS 실시간 감지 통계
    this._wsDetections = 0;

    // 통계
    this._stats = {
      totalScans:    0,
      totalOpps:     0,
      maxSpread:     0,
      lastScanAt:    null,
      errors:        0,
      wsOpps:        0,  // WS 실시간 감지 기회 수
    };
  }

  // ── 시작/종료 ──────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    console.log(
      `[CrossArb] 시작 — ${this._exchanges.length}개 거래소, ` +
      `${this._coins.size}개 코인 모니터링, ` +
      `최소 스프레드: ${this._minSpreadPct}%, USD/KRW: ${this._usdKrw}`
    );

    // ── WebSocket 실시간 감지 (있으면 활성화) ──────────────
    if (this._multiExWs) {
      this._multiExWs.onPrice((exchange, coin, price) => {
        this._onWsPrice(exchange, coin, price);
      });
      console.log("[CrossArb] WebSocket 실시간 감지 활성화 (Binance/Bybit)");
    }

    // 즉시 1회 스캔
    await this._scan().catch(e => console.error("[CrossArb] 초기 스캔 오류:", e.message));

    // REST 폴링은 WS 백업으로 유지 (WS 장애 대비)
    this._intervalId = setInterval(
      () => this._scan().catch(e => {
        console.error("[CrossArb] 스캔 오류:", e.message);
        this._stats.errors++;
      }),
      this._scanInterval
    );
  }

  // ── WebSocket 실시간 가격 수신 → 즉시 스프레드 체크 ────────

  _onWsPrice(wsExchange, coin, wsPriceUsdt) {
    if (!this._running || !this._coins.has(coin)) return;

    // Upbit WS 가격 가져오기 (KRW → USD 환산)
    let upbitPriceUsd = null;
    if (this._upbitWs) {
      const krwPrice = this._upbitWs.getPrice?.(`KRW-${coin}`);
      if (krwPrice && this._usdKrw > 0) {
        upbitPriceUsd = krwPrice / this._usdKrw;
      }
    }

    // Binance/Bybit 다른 쪽 가격 가져오기
    let otherExchange = null;
    let otherPrice = null;
    if (this._multiExWs) {
      if (wsExchange === "Binance") {
        otherPrice = this._multiExWs.getPrice("Bybit", coin);
        otherExchange = "Bybit";
      } else {
        otherPrice = this._multiExWs.getPrice("Binance", coin);
        otherExchange = "Binance";
      }
    }

    // 가격 쌍 비교 (Upbit vs WS거래소, WS거래소 간)
    const pairs = [];
    if (upbitPriceUsd && wsPriceUsdt) {
      pairs.push(
        { ex1: "Upbit", p1: upbitPriceUsd, ex2: wsExchange, p2: wsPriceUsdt },
      );
    }
    if (otherPrice && wsPriceUsdt) {
      pairs.push(
        { ex1: wsExchange, p1: wsPriceUsdt, ex2: otherExchange, p2: otherPrice },
      );
    }

    for (const { ex1, p1, ex2, p2 } of pairs) {
      const low  = p1 < p2 ? { exchange: ex1, price: p1 } : { exchange: ex2, price: p2 };
      const high = p1 < p2 ? { exchange: ex2, price: p2 } : { exchange: ex1, price: p1 };

      const spreadPct = (high.price - low.price) / low.price * 100;
      if (spreadPct >= this._minSpreadPct) {
        const netProfitPct = spreadPct - (TOTAL_FEE * 100);
        const opp = {
          coin,
          buyExchange:  low.exchange,
          sellExchange: high.exchange,
          buyPrice:     low.price,
          sellPrice:    high.price,
          spreadPct:    +spreadPct.toFixed(3),
          netProfitPct: +netProfitPct.toFixed(3),
          detectedAt:   Date.now(),
          source:       "websocket",
        };

        this._stats.wsOpps++;
        this._stats.totalOpps++;
        if (spreadPct > this._stats.maxSpread) {
          this._stats.maxSpread = +spreadPct.toFixed(3);
        }

        this._history.unshift(opp);
        if (this._history.length > 100) this._history = this._history.slice(0, 100);

        console.log(
          `[CrossArb] ⚡ WS 실시간 차익! ${coin} — ` +
          `${low.exchange}($${low.price.toFixed(2)}) → ${high.exchange}($${high.price.toFixed(2)}) | ` +
          `스프레드: ${spreadPct.toFixed(2)}%`
        );

        try { this._onOpportunity(opp); } catch (e) {
          console.error("[CrossArb] WS onOpportunity 오류:", e.message);
        }
      }
    }
  }

  stop() {
    this._running = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    console.log("[CrossArb] 중지됨");
  }

  // ── 환율 설정 ─────────────────────────────────────────────

  setUsdKrw(rate) {
    if (rate > 0) this._usdKrw = rate;
  }

  /** 신규 상장 코인 추가 (GlobalListingScanner에서 호출) */
  addCoin(base) {
    if (base && !this._coins.has(base.toUpperCase())) {
      this._coins.add(base.toUpperCase());
      console.log(`[CrossArb] 모니터링 코인 추가: ${base} (총 ${this._coins.size}개)`);
    }
  }

  // ── 스캔 ──────────────────────────────────────────────────

  async _scan() {
    if (!this._running) return;
    this._stats.totalScans++;
    this._stats.lastScanAt = Date.now();

    // 거래소별 순차 → 코인 병렬 (메모리 안전)
    const priceMap = new Map(); // coin → [{exchange, price (USD 환산)}]

    for (const ex of this._exchanges) {
      const results = await Promise.allSettled(
        Array.from(this._coins).map(coin => this._fetchPrice(ex, coin))
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          const { coin, exchange, priceUsd } = r.value;
          if (!priceMap.has(coin)) priceMap.set(coin, []);
          priceMap.get(coin).push({ exchange, priceUsd });
        }
      }
      // 거래소 간 간격 (rate limit)
      await new Promise(r => setTimeout(r, 50));
    }

    // 스프레드 계산 및 기회 감지
    const newOpps = [];
    for (const [coin, prices] of priceMap) {
      if (prices.length < 2) continue;

      // 최고가/최저가 거래소 찾기
      prices.sort((a, b) => a.priceUsd - b.priceUsd);
      const low  = prices[0];
      const high = prices[prices.length - 1];

      const spreadPct = (high.priceUsd - low.priceUsd) / low.priceUsd * 100;
      const netProfitPct = spreadPct - (TOTAL_FEE * 100);

      if (spreadPct >= this._minSpreadPct) {
        const opp = {
          coin,
          buyExchange:  low.exchange,
          sellExchange: high.exchange,
          buyPrice:     low.priceUsd,
          sellPrice:    high.priceUsd,
          spreadPct:    +spreadPct.toFixed(3),
          netProfitPct: +netProfitPct.toFixed(3),
          detectedAt:   Date.now(),
        };
        newOpps.push(opp);

        // 최대 스프레드 갱신
        if (spreadPct > this._stats.maxSpread) {
          this._stats.maxSpread = +spreadPct.toFixed(3);
        }

        // 이력 저장
        this._history.unshift(opp);
        if (this._history.length > 100) this._history = this._history.slice(0, 100);

        this._stats.totalOpps++;

        console.log(
          `[CrossArb] 차익 기회! ${coin} — ` +
          `${low.exchange}($${low.priceUsd.toFixed(2)}) → ${high.exchange}($${high.priceUsd.toFixed(2)}) | ` +
          `스프레드: ${spreadPct.toFixed(2)}% | 순수익: ${netProfitPct.toFixed(2)}%`
        );

        // 콜백
        try {
          this._onOpportunity(opp);
        } catch (e) {
          console.error("[CrossArb] onOpportunity 콜백 오류:", e.message);
        }
      }
    }

    this._opportunities = newOpps;
  }

  // ── 개별 가격 조회 ─────────────────────────────────────────

  async _fetchPrice(exchange, coin) {
    try {
      const ticker = await exchange.getTicker(coin);
      if (!ticker || !ticker.price) return null;

      let priceUsd = ticker.price;

      // Upbit KRW → USD 변환
      if (exchange.quoteCurrency === "KRW" && this._usdKrw > 0) {
        priceUsd = ticker.price / this._usdKrw;
      }

      return {
        coin,
        exchange: exchange.name,
        priceUsd,
      };
    } catch {
      // 해당 거래소에 상장되지 않은 코인 → 무시
      return null;
    }
  }

  // ── 외부 API ──────────────────────────────────────────────

  /** 현재 열린 기회 목록 */
  getOpportunities() {
    return this._opportunities;
  }

  /** 요약 통계 (대시보드용) */
  getSummary() {
    // 현재 최고 스프레드 기회
    const topOpp = this._opportunities.length > 0
      ? this._opportunities.sort((a, b) => b.spreadPct - a.spreadPct)[0]
      : null;

    return {
      running:        this._running,
      coinCount:      this._coins.size,
      exchangeCount:  this._exchanges.length,
      totalScans:     this._stats.totalScans,
      totalOpps:      this._stats.totalOpps,
      maxSpread:      this._stats.maxSpread,
      lastScanAt:     this._stats.lastScanAt,
      errors:         this._stats.errors,
      wsOpps:         this._stats.wsOpps,
      wsEnabled:      !!this._multiExWs,
      currentOpps:    this._opportunities.length,
      topOpportunity: topOpp ? {
        coin:        topOpp.coin,
        buy:         topOpp.buyExchange,
        sell:        topOpp.sellExchange,
        spreadPct:   topOpp.spreadPct,
        netProfit:   topOpp.netProfitPct,
      } : null,
      recentHistory: this._history.slice(0, 10).map(h => ({
        coin:       h.coin,
        buy:        h.buyExchange,
        sell:       h.sellExchange,
        spreadPct:  h.spreadPct,
        detectedAt: h.detectedAt,
      })),
    };
  }
}

module.exports = { CrossExchangeArb };
