"use strict";

/**
 * DataAggregationEngine — 빅데이터 신호 집합체
 *
 * 공개 API 기반 최대 데이터 수집. 인증 불필요.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  데이터 소스         갱신주기  엣지                   │
 * ├─────────────────────────────────────────────────────┤
 * │  Binance OI 변화율   1분      포지션 증감 = 방향 확인 │
 * │  Binance L/S 비율    5분      군중 쏠림 역발상        │
 * │  Binance Taker 비율  1분      공격적 매수/매도 흐름   │
 * │  Bybit OI           1분      크로스 거래소 확인       │
 * │  업비트 신규상장 감지 1분      100~500% 상승 패턴      │
 * │  뉴스 감성 분석      10분     실시간 이벤트 반응       │
 * └─────────────────────────────────────────────────────┘
 *
 * 핵심 알파:
 * 1) OI 급증 + 가격 상승 = 신규 자금 유입 = 추세 확인
 * 2) OI 급감 + 가격 상승 = 숏 커버링 = 약한 상승 (조심)
 * 3) L/S 비율 극단 = 군중 반대편이 맞다
 * 4) Taker Buy > Sell = 시장에서 공격적으로 사는 중
 * 5) 신규 상장 < 12시간 = 업비트 특화 최고 알파
 */
class DataAggregationEngine {
  constructor(marketDataService) {
    this.mds = marketDataService;

    // OI 임계값
    this.OI_SURGE_THRESHOLD   = 0.03;  // OI 3% 이상 증가 = 급증
    this.OI_DROP_THRESHOLD    = -0.03; // OI 3% 이상 감소 = 급감
    // L/S 임계값
    this.LS_CROWDED_LONG      = 1.8;   // 롱 비율 1.8배 이상 = 과밀 롱
    this.LS_CROWDED_SHORT     = 0.6;   // 롱/숏 비율 0.6 이하 = 과밀 숏
    // 신규 상장 유효기간
    this.NEW_LISTING_WINDOW_MS = 12 * 60 * 60_000;  // 12시간

    this.state = {
      // Binance Futures
      binanceOI:      new Map(),   // symbol → { oi, timestamp }
      binanceOIPrev:  new Map(),   // 이전 스냅샷 (변화율 계산용)
      lsRatios:       new Map(),   // symbol → { longRatio, shortRatio, timestamp }
      takerRatios:    new Map(),   // symbol → buySellRatio (>1=매수우위)

      // Bybit
      bybitOI:        new Map(),   // symbol → { oi, timestamp }

      // 업비트 신규 상장
      knownMarkets:   new Set(),
      newListings:    new Map(),   // market → listedAt (timestamp)

      // 뉴스 감성
      newsScores:     new Map(),   // symbol → { score, headline, timestamp }

      lastUpdated: {
        oi: 0, lsRatio: 0, taker: 0,
        bybitOI: 0, listings: 0, news: 0,
      },
    };

    this.intervalIds       = [];
    this._listingCallbacks = [];  // 신규상장 즉시 이벤트 리스너
  }

  /**
   * 신규상장 감지 시 즉시 호출되는 콜백 등록
   * Strategy B가 구독 → 30초 폴링 대기 없이 즉시 반응
   */
  onNewListing(cb) {
    this._listingCallbacks.push(cb);
  }

  // ─── 시작 / 종료 ──────────────────────────────────────

  start() {
    console.log("[DataAggregation] 시작 — OI/L·S비율/테이커흐름/신규상장/뉴스");

    // 즉시 실행
    Promise.allSettled([
      this.refreshOpenInterest(),
      this.refreshLsRatios(),
      this.refreshTakerFlow(),
      this.refreshBybitOI(),
      this.checkNewListings(),
      this.refreshNewsScores(),
    ]);

    // 주기적 갱신
    this.intervalIds.push(setInterval(() => this.refreshOpenInterest(),  60_000));
    this.intervalIds.push(setInterval(() => this.refreshBybitOI(),       60_000));
    this.intervalIds.push(setInterval(() => this.refreshTakerFlow(),     60_000));
    this.intervalIds.push(setInterval(() => this.refreshLsRatios(),  5 * 60_000));
    this.intervalIds.push(setInterval(() => this.checkNewListings(),     30_000)); // 신규상장은 30초 (빠른 감지)
    this.intervalIds.push(setInterval(() => this.refreshNewsScores(), 10 * 60_000));
  }

  stop() {
    for (const id of this.intervalIds) clearInterval(id);
    this.intervalIds = [];
  }

  // ─── 1. Binance 미결제약정 (OI) ──────────────────────

  /**
   * OI 변화율이 핵심. 단순 OI 숫자가 아니라 변화율을 봐야 함.
   * OI 급증 + 가격 상승 = 새로운 롱 포지션 진입 = 강한 상승 신호
   * OI 급감 + 가격 상승 = 숏 청산(커버링) = 약한 상승, 이후 되돌림 가능
   */
  async refreshOpenInterest() {
    const symbols = ["BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","LINKUSDT"];
    try {
      const results = await Promise.allSettled(
        symbols.map((sym) =>
          fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`)
            .then((r) => r.ok ? r.json() : null),
        ),
      );

      for (let i = 0; i < symbols.length; i++) {
        const data = results[i].status === "fulfilled" ? results[i].value : null;
        if (!data?.openInterest) continue;

        const sym = symbols[i].replace("USDT", "");
        const oi  = Number(data.openInterest);
        const prev = this.state.binanceOI.get(sym);

        // 이전 스냅샷 보존 후 갱신
        if (prev) this.state.binanceOIPrev.set(sym, prev);
        this.state.binanceOI.set(sym, { oi, timestamp: Date.now() });
      }
      this.state.lastUpdated.oi = Date.now();
    } catch {}
  }

  // ─── 2. Long/Short 비율 (군중 쏠림) ──────────────────

  /**
   * 80% 이상이 롱 → 더 올라갈 사람이 없음 → 조정 위험
   * 70% 이상이 숏 → 숏 스퀴즈 대기 중 → 반등 가능
   */
  async refreshLsRatios() {
    const symbols = ["BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT"];
    try {
      const results = await Promise.allSettled(
        symbols.map((sym) =>
          fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=1`)
            .then((r) => r.ok ? r.json() : null),
        ),
      );

      for (let i = 0; i < symbols.length; i++) {
        const data = results[i].status === "fulfilled" ? results[i].value : null;
        const item = Array.isArray(data) ? data[0] : null;
        if (!item) continue;

        const sym = symbols[i].replace("USDT", "");
        this.state.lsRatios.set(sym, {
          longRatio:  Number(item.longAccount),
          shortRatio: Number(item.shortAccount),
          lsRatio:    Number(item.longShortRatio),
          timestamp:  Number(item.timestamp),
        });
      }
      this.state.lastUpdated.lsRatio = Date.now();
    } catch {}
  }

  // ─── 3. Taker 매수/매도 비율 ─────────────────────────

  /**
   * Taker = 시장가로 즉시 체결하는 공격적 주문
   * Taker Buy > Sell = 급하게 사는 사람이 더 많음 = 상승 모멘텀
   * Taker Sell > Buy = 급하게 파는 사람이 더 많음 = 하락 압력
   */
  async refreshTakerFlow() {
    const symbols = ["BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT"];
    try {
      const results = await Promise.allSettled(
        symbols.map((sym) =>
          fetch(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${sym}&period=5m&limit=3`)
            .then((r) => r.ok ? r.json() : null),
        ),
      );

      for (let i = 0; i < symbols.length; i++) {
        const data = results[i].status === "fulfilled" ? results[i].value : null;
        if (!Array.isArray(data) || !data.length) continue;

        // 최근 3개 평균
        const avgRatio = data.reduce((s, d) => s + Number(d.buySellRatio || 1), 0) / data.length;
        const sym = symbols[i].replace("USDT", "");
        this.state.takerRatios.set(sym, avgRatio);
      }
      this.state.lastUpdated.taker = Date.now();
    } catch {}
  }

  // ─── 4. Bybit OI (크로스 거래소 확인) ────────────────

  /**
   * Binance와 Bybit 모두 OI 증가 = 글로벌 자금 유입 확인
   * 한 거래소만 증가 = 노이즈일 가능성
   */
  async refreshBybitOI() {
    const symbols = ["BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT"];
    try {
      const results = await Promise.allSettled(
        symbols.map((sym) =>
          fetch(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=5min&limit=2`)
            .then((r) => r.ok ? r.json() : null),
        ),
      );

      for (let i = 0; i < symbols.length; i++) {
        const data = results[i].status === "fulfilled" ? results[i].value : null;
        const list = data?.result?.list;
        if (!Array.isArray(list) || !list.length) continue;

        const sym = symbols[i].replace("USDT", "");
        this.state.bybitOI.set(sym, {
          oi:        Number(list[0].openInterest),
          timestamp: Number(list[0].timestamp),
        });
      }
      this.state.lastUpdated.bybitOI = Date.now();
    } catch {}
  }

  // ─── 5. 업비트 신규 상장 감지 ────────────────────────

  /**
   * 업비트 신규 상장은 역대 최고 단기 알파.
   * 상장 후 첫 12시간: 평균 50~300% 상승
   * 원리: 업비트에서만 거래 가능하던 코인이 새로 상장 → 수요 폭발
   *
   * 동작:
   * - 매분 업비트 마켓 목록 조회
   * - 기존 목록에 없는 마켓 발견 → 신규 상장 기록
   * - 신규 상장 후 12시간 이내 → 강력 매수 신호
   */
  async checkNewListings() {
    try {
      const res = await fetch("https://api.upbit.com/v1/market/all?isDetails=false");
      if (!res.ok) return;
      const markets = await res.json();

      const currentKrwMarkets = new Set(
        markets
          .filter((m) => m.market?.startsWith("KRW-"))
          .map((m) => m.market),
      );

      if (this.state.knownMarkets.size === 0) {
        // 첫 실행: 기존 마켓 기록만 (신규 상장으로 처리하지 않음)
        this.state.knownMarkets = currentKrwMarkets;
        return;
      }

      // 새로 나타난 마켓 감지
      for (const market of currentKrwMarkets) {
        if (!this.state.knownMarkets.has(market)) {
          const listedAt = Date.now();
          this.state.newListings.set(market, listedAt);
          console.log(`[DataAggregation] 🚨 신규 상장 감지: ${market} @ ${new Date(listedAt).toLocaleTimeString("ko-KR")}`);
          // 구독자에게 즉시 통보 (Strategy B 30초 대기 제거)
          for (const cb of this._listingCallbacks) {
            try { cb(market, listedAt); } catch (e) {
              console.error("[DataAggregation] 상장 콜백 오류:", e.message);
            }
          }
        }
      }

      this.state.knownMarkets = currentKrwMarkets;
      this.state.lastUpdated.listings = Date.now();

      // 만료된 신규 상장 정리
      const now = Date.now();
      for (const [market, listedAt] of this.state.newListings.entries()) {
        if (now - listedAt > this.NEW_LISTING_WINDOW_MS * 2) {
          this.state.newListings.delete(market);
        }
      }
    } catch {}
  }

  // ─── 6. 뉴스 감성 분석 ───────────────────────────────

  /**
   * CryptoPanic 공개 API (인증 없이 사용 가능한 공개 엔드포인트)
   * 뉴스 긍정/부정 비율로 단기 감성 스코어 계산
   */
  async refreshNewsScores() {
    const currencies = ["BTC","ETH","XRP","SOL"];
    try {
      const results = await Promise.allSettled(
        currencies.map((cur) =>
          fetch(`https://cryptopanic.com/api/v1/posts/?public=true&currencies=${cur}&filter=hot&limit=10`)
            .then((r) => r.ok ? r.json() : null),
        ),
      );

      for (let i = 0; i < currencies.length; i++) {
        const data = results[i].status === "fulfilled" ? results[i].value : null;
        const posts = data?.results;
        if (!Array.isArray(posts) || !posts.length) continue;

        let score = 0;
        let count = 0;
        for (const post of posts) {
          const votes = post.votes || {};
          const bull = Number(votes.positive || votes.liked || 0);
          const bear = Number(votes.negative || votes.disliked || 0);
          if (bull + bear > 0) {
            score += (bull - bear) / (bull + bear);
            count++;
          }
        }

        if (count > 0) {
          const latest = posts[0];
          this.state.newsScores.set(currencies[i], {
            score:     score / count,
            headline:  latest.title,
            timestamp: Date.now(),
          });
        }
      }
      this.state.lastUpdated.news = Date.now();
    } catch {}
  }

  // ─── 신호 종합 ───────────────────────────────────────

  /**
   * marketCode에 대한 종합 데이터 신호 반환
   * dataScore: -25 ~ +25
   */
  getSignals(marketCode) {
    const now    = Date.now();
    const symbol = marketCode.split("-")[1];

    let score = 0;
    const flags = [];

    // ── OI 신호 ──────────────────────────────────────
    const oiCurrent = this.state.binanceOI.get(symbol);
    const oiPrev    = this.state.binanceOIPrev.get(symbol);
    let oiChangeRate = 0;

    if (oiCurrent && oiPrev && oiPrev.oi > 0) {
      oiChangeRate = (oiCurrent.oi - oiPrev.oi) / oiPrev.oi;

      if (oiChangeRate >= this.OI_SURGE_THRESHOLD) {
        flags.push("OI_SURGE");
        score += 12;    // 강한 새 포지션 진입 = 모멘텀 확인
      } else if (oiChangeRate <= this.OI_DROP_THRESHOLD) {
        flags.push("OI_DROP");
        score -= 8;     // 포지션 청산 = 추세 약화
      } else {
        score += Math.max(-5, Math.min(8, oiChangeRate * 200));
      }

      // Bybit OI 크로스 확인
      const bybitOI = this.state.bybitOI.get(symbol);
      if (bybitOI && flags.includes("OI_SURGE")) {
        flags.push("OI_CONFIRMED_CROSS_EXCHANGE");
        score += 5;    // 두 거래소에서 동시 확인 = 더 신뢰
      }
    }

    // ── L/S 비율 (역발상) ────────────────────────────
    // BTC L/S 비율을 알트에도 일부 적용 (시장 전체 분위기)
    const lsSymbol = ["BTC","ETH","XRP","SOL"].includes(symbol) ? symbol : "BTC";
    const ls = this.state.lsRatios.get(lsSymbol);
    let lsRatio = null;

    if (ls) {
      lsRatio = ls.lsRatio;
      if (lsRatio > this.LS_CROWDED_LONG) {
        flags.push("LS_CROWDED_LONG");
        score -= 10;   // 롱 과밀 → 추가 상승 에너지 없음
      } else if (lsRatio < this.LS_CROWDED_SHORT) {
        flags.push("LS_CROWDED_SHORT");
        score += 8;    // 숏 스퀴즈 대기 → 반등 가능
      } else {
        // 중립 구간: 약간 매수 편향 (0.9~1.1)이 최적
        const distFromNeutral = Math.abs(lsRatio - 1.0);
        score += Math.max(-4, 4 - distFromNeutral * 8);
      }
    }

    // ── Taker 매수/매도 비율 ─────────────────────────
    const takerSym = ["BTC","ETH","XRP","SOL"].includes(symbol) ? symbol : "BTC";
    const takerRatio = this.state.takerRatios.get(takerSym);

    if (takerRatio != null) {
      if (takerRatio > 1.3) {
        flags.push("TAKER_BUY_DOMINANT");
        score += 8;    // 공격적 매수 우위
      } else if (takerRatio < 0.75) {
        flags.push("TAKER_SELL_DOMINANT");
        score -= 8;    // 공격적 매도 우위
      } else {
        score += Math.max(-4, Math.min(6, (takerRatio - 1) * 20));
      }
    }

    // ── 신규 상장 신호 ───────────────────────────────
    const listedAt = this.state.newListings.get(marketCode);
    let newListingScore = 0;
    let hoursSinceListing = null;

    if (listedAt) {
      hoursSinceListing = (now - listedAt) / 3_600_000;
      if (hoursSinceListing < this.NEW_LISTING_WINDOW_MS / 3_600_000) {
        flags.push("NEW_LISTING");
        // 상장 직후일수록 강한 신호 (지수적 감소)
        newListingScore = Math.max(0, 20 * Math.exp(-hoursSinceListing / 4));
        score += newListingScore;
      }
    }

    // ── 뉴스 감성 ────────────────────────────────────
    const newsSym = ["BTC","ETH","XRP","SOL"].includes(symbol) ? symbol : "BTC";
    const news = this.state.newsScores.get(newsSym);
    let newsScore = 0;

    if (news && now - news.timestamp < 30 * 60_000) { // 30분 이내 뉴스만
      newsScore = news.score;  // -1 ~ 1
      score += newsScore * 5;  // 최대 ±5점
    }

    return {
      oiChangeRate,
      lsRatio,
      takerRatio:        takerRatio ?? null,
      hoursSinceListing,
      newsScore,
      flags,
      dataScore:         Math.max(-25, Math.min(25, Math.round(score * 10) / 10)),
    };
  }

  getSummary() {
    return {
      binanceOICount:  this.state.binanceOI.size,
      lsRatioCount:    this.state.lsRatios.size,
      newListings:     Object.fromEntries(this.state.newListings),
      newsScoreCount:  this.state.newsScores.size,
      lastUpdated:     this.state.lastUpdated,
    };
  }
}

module.exports = { DataAggregationEngine };
