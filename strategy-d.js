"use strict";

/**
 * StrategyD — 한국 알트 sentiment 모니터 (RSS + 키워드 + 단순 분류)
 *
 * 배경:
 *   - 한국 알트 코인은 디시/X/텔레그램 한국어 sentiment에 민감
 *   - 글로벌 헤지펀드는 한국어 + 문화 컨텍스트 못 따라감 → 우리 우위
 *
 * 데이터 소스 (공개, 무료, KYC 불필요):
 *   1. 코인니스 RSS (한국어 가상자산 뉴스)
 *   2. Upbit 공식 공지 RSS (상장/이벤트)
 *   3. 추후: 디시인사이드 비트코인 갤러리 크롤링
 *   4. 추후: X(Twitter) 한국 인플루언서 모니터
 *
 * 단순 sentiment 분류 (의존성 0):
 *   - 양수 키워드: "상장", "출시", "파트너십", "투자", "급등", "신고가"
 *   - 음수 키워드: "해킹", "상장폐지", "유의", "급락", "폭락", "조사"
 *   - 코인 매핑: 헤드라인에서 코인 심볼 추출 → topic 분류
 *
 * 추후 확장 (Claude API):
 *   - LLM이 sentiment 분류 (현재는 룰 기반)
 *   - 펌프 직전 패턴 학습
 *
 * 시그널:
 *   - 강한 양수 sentiment 코인 → Strategy B 진입 가산점
 *   - 강한 음수 sentiment → 진입 차단
 */

const { EventEmitter } = require("events");

const POLL_INTERVAL_MS = 5 * 60_000;
const ALERT_DEDUP_MS   = 60 * 60_000;

const POSITIVE_KEYWORDS = [
  "상장", "출시", "파트너십", "투자유치", "메인넷",
  "급등", "신고가", "호재", "협력", "개발", "업그레이드", "런칭",
];
const NEGATIVE_KEYWORDS = [
  "해킹", "상장폐지", "유의", "급락", "폭락", "조사",
  "사기", "러그풀", "악재", "지연", "취소", "철회",
];

const RSS_FEEDS = [
  { name: "coinness", url: "https://kr.coinness.com/rss" },
  // Upbit 공지: https://upbit.com/service_center/notice (RSS 미공식, 별도 작업)
];

class StrategyD extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.notifier  = opts.notifier  || null;
    this.arbLogger = opts.arbLogger || null;

    this._intervalId = null;
    this._running    = false;
    this._lastAlerts = new Map();
    this._lastSeenItems = new Set();
    this._stats = {
      cycles:    0,
      detected:  0,
      alerted:   0,
      startedAt: null,
    };
    this._latestSentiments = [];
  }

  async start() {
    if (this._running) return;
    console.log("[StrategyD] 시작 — 한국 sentiment 모니터");
    this._stats.startedAt = Date.now();
    this._running = true;

    this._cycle().catch(e => console.error("[StrategyD] initial:", e.message));
    this._intervalId = setInterval(() => {
      this._cycle().catch(e => console.error("[StrategyD] cycle:", e.message));
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = null;
    this._running = false;
  }

  async _fetchRSS(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const text = await res.text();
      // 매우 단순 RSS 파싱 (정규식)
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRegex.exec(text)) !== null) {
        const block = m[1];
        const title = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i) || [])[1];
        const link  = (block.match(/<link>(.*?)<\/link>/i) || [])[1];
        const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/i) || [])[1];
        if (title) {
          items.push({
            title: title.trim(),
            link:  link?.trim() || "",
            pubDate: pubDate?.trim() || "",
            id: link || title,
          });
        }
      }
      return items;
    } catch { return []; }
  }

  _classifySentiment(title) {
    const t = String(title);
    let posScore = 0, negScore = 0;
    for (const kw of POSITIVE_KEYWORDS) {
      if (t.includes(kw)) posScore++;
    }
    for (const kw of NEGATIVE_KEYWORDS) {
      if (t.includes(kw)) negScore++;
    }
    const net = posScore - negScore;
    let label = "NEUTRAL";
    if (net >= 2) label = "STRONG_BULLISH";
    else if (net === 1) label = "BULLISH";
    else if (net === -1) label = "BEARISH";
    else if (net <= -2) label = "STRONG_BEARISH";
    return { label, posScore, negScore, net };
  }

  _extractCoin(title) {
    // 한국어 헤드라인에서 영어 코인 심볼 추출 (단순)
    const matches = String(title).match(/\b([A-Z]{2,8})\b/g) || [];
    const STABLES = new Set(["KRW","USD","USDT","USDC","CEO","CTO","API","NFT","FAQ","ETF","ICO","IPO","DAO","DEX","P2P","DEFI","TVL","ATH","ATL"]);
    return matches.filter(m => !STABLES.has(m))[0] || null;
  }

  async _cycle() {
    this._stats.cycles++;

    for (const feed of RSS_FEEDS) {
      const items = await this._fetchRSS(feed.url);
      if (items.length === 0) continue;

      for (const item of items) {
        if (this._lastSeenItems.has(item.id)) continue;
        this._lastSeenItems.add(item.id);
        // dedup 캐시 크기 제한
        if (this._lastSeenItems.size > 1000) {
          const arr = [...this._lastSeenItems];
          this._lastSeenItems = new Set(arr.slice(-500));
        }

        const sentiment = this._classifySentiment(item.title);
        const coin = this._extractCoin(item.title);

        if (sentiment.label === "NEUTRAL" && !coin) continue;
        this._stats.detected++;

        const summary = {
          source:    feed.name,
          coin,
          title:     item.title,
          link:      item.link,
          sentiment: sentiment.label,
          score:     sentiment.net,
          time:      Date.now(),
        };
        this._latestSentiments.unshift(summary);
        if (this._latestSentiments.length > 100) this._latestSentiments.length = 100;

        // 강한 sentiment + 코인 발견 시 알림
        if (sentiment.label === "STRONG_BULLISH" || sentiment.label === "STRONG_BEARISH") {
          const dedupKey = `${coin || "general"}-${sentiment.label}`;
          const lastTs = this._lastAlerts.get(dedupKey) || 0;
          if (Date.now() - lastTs < ALERT_DEDUP_MS) continue;
          this._lastAlerts.set(dedupKey, Date.now());

          this._stats.alerted++;
          const emoji = sentiment.label.startsWith("STRONG_BULLISH") ? "🚀" : "💥";
          console.log(`${emoji} [StrategyD] ${sentiment.label} — ${item.title}`);

          if (this.arbLogger?.logSpreadEvent) {
            try {
              this.arbLogger.logSpreadEvent({
                symbol:        coin || "GENERAL",
                buyExchange:   "sentiment",
                sellExchange:  sentiment.label.toLowerCase(),
                buyPrice:      sentiment.net,
                sellPrice:     0,
                spreadPct:     sentiment.net,
                netSpreadPct:  sentiment.net,
                source:        "strategy-d-sentiment",
              });
            } catch {}
          }

          if (this.notifier?.send) {
            this.notifier.send(
              `${emoji} <b>한국 sentiment ${sentiment.label}</b>\n` +
              `${coin ? `코인: <b>${coin}</b>\n` : ""}` +
              `헤드라인: ${item.title}\n` +
              `score: ${sentiment.net > 0 ? "+" : ""}${sentiment.net}\n` +
              (item.link ? `링크: ${item.link}` : "")
            );
          }

          this.emit("sentiment", summary);
        }
      }
    }
  }

  getSummary() {
    return {
      running:    this._running,
      stats:      { ...this._stats },
      uptimeHrs:  this._stats.startedAt
        ? +((Date.now() - this._stats.startedAt) / 3_600_000).toFixed(2)
        : 0,
      latestSentiments: this._latestSentiments.slice(0, 20),
    };
  }
}

module.exports = { StrategyD };
