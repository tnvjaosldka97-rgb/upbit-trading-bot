"use strict";

/**
 * Strategy C — 한국 3사 동일지역(KRW↔KRW) 차익 모니터
 *
 * 시장 중립(delta-neutral) 차익. 시장 방향과 무관 → RANGE 장세에서도 작동.
 *
 * 동작:
 *   - 업비트 / 빗썸 / 코인원 공통 KRW 마켓 코인 자동 발견
 *   - 30초마다 3거래소 동시 ticker 폴링
 *   - 두 거래소 가격 차이 (수수료 차감 후) ≥ 임계 → 기회 감지
 *   - 모든 기회 SQLite(arb-data.db, sched3 테이블)에 기록
 *   - Telegram 알림 (sustained 30초 이상 유지된 기회만)
 *
 * 미래 확장:
 *   - 실거래: ArbExecutor 연동 (양쪽 자본 분산 + 동시 매매)
 *   - LIVE는 빗썸/코인원 KYC + API 키 발급 후
 */

const { EventEmitter } = require("events");

const POLL_INTERVAL_MS  = 30_000;          // 3거래소 동시 폴링 주기
const MIN_NET_PROFIT    = 0.005;            // 0.5% 순이익(수수료 차감 후) 이상만
const MAX_NET_PROFIT    = 0.05;             // 5% 초과는 데이터 이상 (sanity)
const SUSTAIN_THRESHOLD = 30_000;          // 30초 이상 유지된 기회만 alert
const MAX_CONCURRENT    = 8;                // 한 폴링 사이클당 동시 ticker 호출 한도
const ALERT_DEDUP_MS    = 5 * 60_000;      // 같은 코인+페어 alert 5분 1회

// 2거래소 가격 비율 sanity — 한쪽이 다른쪽의 50%~200% 범위 벗어나면 단위 오류
const MIN_PRICE_RATIO = 0.5;
const MAX_PRICE_RATIO = 2.0;

// 거래소별 maker/taker 평균 수수료 (편도)
const FEES = {
  upbit:   0.0005,   // 0.05%
  bithumb: 0.0004,   // 0.04%
  coinone: 0.0010,   // 0.10%
};

/**
 * 두 거래소 (buy@A, sell@B) 가정 시 net profit 계산
 *   net = (sell - buy) / buy - feeA(buy) - feeB(sell)
 *
 * Sanity:
 *   - 가격 0/음수 → -1
 *   - 두 가격 비율 0.5~2.0 벗어남 → -1 (단위 오류 의심)
 *   - 차익 5% 초과 → -1 (실제로는 호가 거의 없거나 데이터 오류)
 */
function netProfit(priceBuy, priceSell, exA, exB) {
  if (priceBuy <= 0 || priceSell <= 0) return -1;

  // 가격 비율 sanity
  const ratio = priceSell / priceBuy;
  if (ratio < MIN_PRICE_RATIO || ratio > MAX_PRICE_RATIO) return -1;

  const gross  = (priceSell - priceBuy) / priceBuy;
  const feeSum = (FEES[exA] || 0) + (FEES[exB] || 0);
  const net = gross - feeSum;

  // 비정상적으로 큰 차익 차단
  if (net > MAX_NET_PROFIT) return -1;

  return net;
}

class StrategyC extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Object} opts.upbit    UpbitAdapter — getMarkets/getTicker 구현
   * @param {Object} opts.bithumb  BithumbAdapter
   * @param {Object} opts.coinone  CoinoneAdapter
   * @param {Object} opts.arbLogger ArbDataLogger 인스턴스 (optional, 기록용)
   * @param {Object} opts.notifier TelegramNotifier 인스턴스 (optional, 알림용)
   */
  constructor(opts = {}) {
    super();
    this.upbit    = opts.upbit    || null;
    this.bithumb  = opts.bithumb  || null;
    this.coinone  = opts.coinone  || null;
    this.arbLogger = opts.arbLogger || null;
    this.notifier = opts.notifier || null;

    this._intervalId   = null;
    this._running      = false;
    this._commonCoins  = [];      // 3거래소 공통 KRW 코인 (대문자 base)
    this._lastAlerts   = new Map(); // dedup: key=`${coin}-${buyEx}-${sellEx}` → ts
    this._sustainTrack = new Map(); // 기회 시작 시각: key → firstSeenTs
    this._stats = {
      cycles:    0,
      detected:  0,
      sustained: 0,
      alerted:   0,
      errors:    0,
      startedAt: null,
      lastCycleMs: null,
    };
    // Top 알파 코인 추적 (어느 코인이 가장 자주 차익 기회 만드는지)
    this._coinStats = new Map(); // coin → { count, avgNet, maxNet, lastSeen }
  }

  // ── Lifecycle ──────────────────────────────────────────

  async start() {
    if (this._running) return;
    if (!this.upbit || !this.bithumb || !this.coinone) {
      console.warn("[StrategyC] 어댑터 미주입 — 시작 실패");
      return;
    }

    console.log("[StrategyC] 한국 3사 동일지역 차익 모니터 시작");
    this._stats.startedAt = Date.now();

    // 1) 공통 코인 디스커버리
    try {
      await this._discoverCommonCoins();
    } catch (e) {
      console.error("[StrategyC] common coin discovery 실패:", e.message);
      return;
    }

    if (this._commonCoins.length === 0) {
      console.warn("[StrategyC] 공통 코인 없음 — 종료");
      return;
    }

    console.log(`[StrategyC] 공통 KRW 코인 ${this._commonCoins.length}개 모니터링`);

    // 2) 첫 사이클 즉시 + 주기 시작
    this._running = true;
    this._cycle().catch(e => console.error("[StrategyC] initial cycle:", e.message));
    this._intervalId = setInterval(
      () => this._cycle().catch(e => console.error("[StrategyC] cycle:", e.message)),
      POLL_INTERVAL_MS
    );
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = null;
    this._running = false;
    console.log("[StrategyC] 종료");
  }

  // ── 공통 코인 발견 ──────────────────────────────────────

  async _discoverCommonCoins() {
    const [upbitMarkets, bithumbMarkets, coinoneMarkets] = await Promise.all([
      this.upbit.getMarkets().catch(e => { console.warn("[StrategyC] upbit markets:", e.message); return []; }),
      this.bithumb.getMarkets().catch(e => { console.warn("[StrategyC] bithumb markets:", e.message); return []; }),
      this.coinone.getMarkets().catch(e => { console.warn("[StrategyC] coinone markets:", e.message); return []; }),
    ]);

    const upbitSet = new Set(upbitMarkets
      .filter(m => m.quote === "KRW")
      .map(m => (m.base || "").toUpperCase())
      .filter(Boolean));
    const bithumbSet = new Set(bithumbMarkets
      .filter(m => (m.quote || "KRW") === "KRW")
      .map(m => (m.base || "").toUpperCase())
      .filter(Boolean));
    const coinoneSet = new Set(coinoneMarkets
      .filter(m => m.quote === "KRW")
      .map(m => (m.base || "").toUpperCase())
      .filter(Boolean));

    // 3개 모두 상장된 것만
    const all3 = [...upbitSet].filter(c => bithumbSet.has(c) && coinoneSet.has(c));

    // 스테이블/원화환산토큰 제외
    const STABLES = new Set(["USDT", "USDC", "DAI", "BUSD", "TUSD", "PYUSD"]);
    this._commonCoins = all3.filter(c => !STABLES.has(c)).sort();
  }

  // ── 메인 사이클 ──────────────────────────────────────

  async _cycle() {
    const t0 = Date.now();
    this._stats.cycles++;

    // 모든 공통 코인의 3거래소 ticker 동시 조회
    const tickers = new Map(); // coin → { upbit, bithumb, coinone }

    // 동시성 제어 (MAX_CONCURRENT)
    const queue = [...this._commonCoins];
    while (queue.length > 0) {
      const batch = queue.splice(0, MAX_CONCURRENT);
      await Promise.all(batch.map(async coin => {
        try {
          const [u, b, c] = await Promise.all([
            this.upbit.getTicker(coin).catch(() => null),
            this.bithumb.getTicker(coin).catch(() => null),
            this.coinone.getTicker(coin).catch(() => null),
          ]);
          if (u || b || c) {
            tickers.set(coin, {
              upbit:   u?.price || null,
              bithumb: b?.price || null,
              coinone: c?.price || null,
            });
          }
        } catch {
          this._stats.errors++;
        }
      }));
    }

    // 페어별 차익 검사 (3 choose 2 = 3 페어)
    const PAIRS = [
      ["upbit",   "bithumb"],
      ["upbit",   "coinone"],
      ["bithumb", "coinone"],
    ];
    const opportunities = [];

    for (const [coin, t] of tickers) {
      for (const [a, b] of PAIRS) {
        const pa = t[a], pb = t[b];
        if (!pa || !pb) continue;

        // 양방향 검사 (a→b, b→a)
        const npAB = netProfit(pa, pb, a, b); // buy@a, sell@b
        const npBA = netProfit(pb, pa, b, a); // buy@b, sell@a

        if (npAB >= MIN_NET_PROFIT) {
          opportunities.push({
            coin, buyExchange: a, sellExchange: b,
            buyPrice: pa, sellPrice: pb,
            netProfitPct: npAB * 100,
          });
        }
        if (npBA >= MIN_NET_PROFIT) {
          opportunities.push({
            coin, buyExchange: b, sellExchange: a,
            buyPrice: pb, sellPrice: pa,
            netProfitPct: npBA * 100,
          });
        }
      }
    }

    this._stats.detected += opportunities.length;
    this._stats.lastCycleMs = Date.now() - t0;

    // 지속성 체크 + 알림
    const now = Date.now();
    for (const opp of opportunities) {
      const key = `${opp.coin}-${opp.buyExchange}-${opp.sellExchange}`;
      const firstSeen = this._sustainTrack.get(key);
      if (!firstSeen) {
        this._sustainTrack.set(key, now);
        continue;
      }
      const sustainedMs = now - firstSeen;
      if (sustainedMs < SUSTAIN_THRESHOLD) continue;
      this._stats.sustained++;

      // dedup 체크
      const lastAlert = this._lastAlerts.get(key) || 0;
      if (now - lastAlert < ALERT_DEDUP_MS) continue;
      this._lastAlerts.set(key, now);

      this._handleSustainedOpportunity({ ...opp, sustainedMs });
    }

    // 사라진 기회는 sustainTrack에서 제거 (그 다음 사이클에 다시 보이면 카운터 리셋)
    const seenKeys = new Set(opportunities.map(o => `${o.coin}-${o.buyExchange}-${o.sellExchange}`));
    for (const k of this._sustainTrack.keys()) {
      if (!seenKeys.has(k)) this._sustainTrack.delete(k);
    }

    // 알림 dedup map 정리 (1시간 지난 항목 제거)
    const cutoff = now - 60 * 60_000;
    for (const [k, ts] of this._lastAlerts) {
      if (ts < cutoff) this._lastAlerts.delete(k);
    }

    if (this._stats.cycles % 10 === 0) {
      console.log(
        `[StrategyC] cycle ${this._stats.cycles} — ` +
        `coins:${tickers.size} opp:${opportunities.length} ` +
        `detected:${this._stats.detected} sustained:${this._stats.sustained} ` +
        `alerted:${this._stats.alerted} (${this._stats.lastCycleMs}ms)`
      );
    }
  }

  _handleSustainedOpportunity(opp) {
    this._stats.alerted++;

    // Coin alpha tracking
    const cs = this._coinStats.get(opp.coin) || { count: 0, sumNet: 0, maxNet: 0, lastSeen: 0 };
    cs.count++;
    cs.sumNet += opp.netProfitPct;
    cs.maxNet = Math.max(cs.maxNet, opp.netProfitPct);
    cs.lastSeen = Date.now();
    this._coinStats.set(opp.coin, cs);

    const msg =
      `💎 [StrategyC] 차익 기회 (${(opp.sustainedMs / 1000).toFixed(0)}초 지속) — ` +
      `${opp.coin} ${opp.buyExchange.toUpperCase()}→${opp.sellExchange.toUpperCase()} ` +
      `${opp.buyPrice.toLocaleString()}→${opp.sellPrice.toLocaleString()} ` +
      `net +${opp.netProfitPct.toFixed(2)}%`;
    console.log(msg);

    // ArbDataLogger 기록
    if (this.arbLogger?.logSpreadEvent) {
      try {
        this.arbLogger.logSpreadEvent({
          symbol:        opp.coin,
          buyExchange:   opp.buyExchange,
          sellExchange:  opp.sellExchange,
          buyPrice:      opp.buyPrice,
          sellPrice:     opp.sellPrice,
          spreadPct:     opp.netProfitPct + (FEES[opp.buyExchange] + FEES[opp.sellExchange]) * 100,
          netSpreadPct:  opp.netProfitPct,
          source:        "strategy-c-krw3",
        });
      } catch (e) {
        console.warn("[StrategyC] logSpreadEvent 실패:", e.message);
      }
    }

    // Telegram 알림
    if (this.notifier?.send) {
      try {
        this.notifier.send(
          `💎 <b>한국 3사 차익 (Strategy C)</b>\n` +
          `코인: <b>${opp.coin}</b>\n` +
          `${opp.buyExchange.toUpperCase()} ${opp.buyPrice.toLocaleString()}원 매수\n` +
          `${opp.sellExchange.toUpperCase()} ${opp.sellPrice.toLocaleString()}원 매도\n` +
          `순이익: <b>+${opp.netProfitPct.toFixed(2)}%</b> (${(opp.sustainedMs / 1000).toFixed(0)}초 지속)`
        );
      } catch {}
    }

    this.emit("opportunity", opp);
  }

  // ── 외부 조회 ────────────────────────────────────────

  getSummary() {
    // Top 알파 코인 (count 순 상위 20개)
    const topCoins = [...this._coinStats.entries()]
      .map(([coin, s]) => ({
        coin,
        count: s.count,
        avgNetPct: +(s.sumNet / s.count).toFixed(3),
        maxNetPct: +s.maxNet.toFixed(3),
        lastSeenAgo: Math.round((Date.now() - s.lastSeen) / 60_000) + "분",
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return {
      running:    this._running,
      coins:      this._commonCoins.length,
      stats:      { ...this._stats },
      uptimeHrs:  this._stats.startedAt
        ? +((Date.now() - this._stats.startedAt) / 3_600_000).toFixed(2)
        : 0,
      activeOpportunities: this._sustainTrack.size,
      topAlphaCoins: topCoins,
    };
  }
}

module.exports = { StrategyC };
