"use strict";

/**
 * WhaleTracker — 거래소 입출금 큰 트랜잭션 감지
 *
 * Whale Alert 패턴 (대안 데이터):
 *   1. 큰 트랜잭션 (>$1M) → 거래소 입금 = 매도 압력 사전 신호
 *   2. 큰 트랜잭션 → 거래소 출금 = 자가보관(콜드월릿) = 강세 신호
 *
 * 데이터 소스 (공개, 무료):
 *   - Etherscan API (ETH 체인) — 무료 5/sec
 *   - Bitcoin: Blockchain.info, Mempool.space
 *   - Polygon: Polygonscan
 *
 * 단순화 (이번 버전):
 *   - Etherscan ETH 큰 출금/입금 (10K ETH = ~$30M 이상)
 *   - 거래소 알려진 wallet 주소 list로 거래소 ↔ wallet 분류
 *   - 5분 주기
 *
 * LIVE 활용:
 *   - 큰 거래소 입금 ≥ $5M 감지 → 5분 내 ETH 가격 -1~3% 영향 (역사적)
 *   - SHORT 트리거 또는 매수 보류
 */

const { EventEmitter } = require("events");

const ETHERSCAN_BASE = "https://api.etherscan.io";
const POLL_INTERVAL_MS = 5 * 60_000;
const MIN_ETH_THRESHOLD = 1000;        // 1000 ETH = ~$3M+ 트랜잭션만
const ALERT_DEDUP_MS = 30 * 60_000;

// 알려진 거래소 hot wallet (ETH 체인) — 공개 정보
// 출처: Etherscan public labels
const EXCHANGE_WALLETS = {
  // Binance
  "0x28C6c06298d514Db089934071355E5743bf21d60": "binance",
  "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549": "binance",
  // Coinbase
  "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3": "coinbase",
  // Kraken
  "0x53d284357ec70cE289D6D64134DfAc8E511c8a3D": "kraken",
  // Bitfinex
  "0x876EabF441B2EE5B5b0554Fd502a8E0600950cFa": "bitfinex",
  // Upbit (알려진 ETH wallet 일부)
  "0x390de26d772D2e2005C6D1d24afC3DfE36D8e7Ec": "upbit",
};

class WhaleTracker extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.notifier  = opts.notifier  || null;
    this.arbLogger = opts.arbLogger || null;
    this.apiKey    = opts.apiKey    || process.env.ETHERSCAN_API_KEY || ""; // 옵션

    this._intervalId = null;
    this._running    = false;
    this._lastAlerts = new Map();
    this._lastBlockChecked = null;
    this._stats = {
      cycles:    0,
      detected:  0,
      alerted:   0,
      startedAt: null,
    };
    this._latestWhales = [];
  }

  async start() {
    if (this._running) return;
    console.log("[WhaleTracker] 시작 — Etherscan 큰 ETH 트랜잭션 모니터");
    this._stats.startedAt = Date.now();
    this._running = true;

    this._cycle().catch(e => console.error("[WhaleTracker] initial:", e.message));
    this._intervalId = setInterval(() => {
      this._cycle().catch(e => console.error("[WhaleTracker] cycle:", e.message));
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = null;
    this._running = false;
  }

  async _fetchTopAccounts() {
    // 무료 Etherscan: 거래소 wallet의 최근 거래 조회
    // GET /api?module=account&action=txlist&address=...&startblock=0&endblock=99999999&sort=desc
    const results = [];

    for (const [address, exchange] of Object.entries(EXCHANGE_WALLETS)) {
      try {
        const url = `${ETHERSCAN_BASE}/api?module=account&action=txlist&address=${address}&page=1&offset=20&sort=desc${this.apiKey ? `&apikey=${this.apiKey}` : ""}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const data = await res.json();
        if (data.status !== "1" || !Array.isArray(data.result)) continue;

        for (const tx of data.result) {
          const valueEth = parseFloat(tx.value) / 1e18;
          if (valueEth < MIN_ETH_THRESHOLD) continue;

          const isInbound = tx.to.toLowerCase() === address.toLowerCase();
          const direction = isInbound ? "INFLOW" : "OUTFLOW";
          const counterparty = isInbound ? tx.from : tx.to;
          const counterpartyExchange = EXCHANGE_WALLETS[counterparty] || null;

          results.push({
            hash: tx.hash,
            blockNumber: parseInt(tx.blockNumber),
            timestamp: parseInt(tx.timeStamp) * 1000,
            from: tx.from,
            to: tx.to,
            valueEth: +valueEth.toFixed(2),
            exchange,
            direction,
            counterpartyExchange,
            type: counterpartyExchange ? "EXCHANGE_TRANSFER" : (direction === "INFLOW" ? "DEPOSIT" : "WITHDRAWAL"),
          });
        }
      } catch (e) {
        // silent
      }
      await new Promise(r => setTimeout(r, 250)); // rate limit (5/sec 무료)
    }

    return results;
  }

  async _cycle() {
    this._stats.cycles++;
    if (!this.apiKey) {
      // API 키 없으면 1번만 경고 후 cycle skip
      if (this._stats.cycles === 1) {
        console.warn("[WhaleTracker] ETHERSCAN_API_KEY 없음 — 비활성 (무료 키 발급: etherscan.io/myapikey)");
      }
      return;
    }

    try {
      const whales = await this._fetchTopAccounts();
      // 이전 사이클과 중복 제거
      const seenHashes = new Set(this._latestWhales.map(w => w.hash));
      const newWhales = whales.filter(w => !seenHashes.has(w.hash));

      this._stats.detected += newWhales.length;
      this._latestWhales = [...whales].slice(0, 50);

      for (const w of newWhales) {
        const key = w.hash;
        const lastTs = this._lastAlerts.get(key) || 0;
        if (Date.now() - lastTs < ALERT_DEDUP_MS) continue;
        this._lastAlerts.set(key, Date.now());

        this._stats.alerted++;
        const sign = w.direction === "INFLOW" ? "🔴" : "🟢";
        const msg = `${sign} [Whale] ${w.valueEth.toLocaleString()} ETH ${w.direction} ${w.exchange.toUpperCase()}${w.counterpartyExchange ? ` ↔ ${w.counterpartyExchange.toUpperCase()}` : ""}`;
        console.log(msg);

        if (this.arbLogger?.logSpreadEvent) {
          try {
            this.arbLogger.logSpreadEvent({
              symbol:        "ETH_WHALE",
              buyExchange:   w.exchange,
              sellExchange:  w.direction.toLowerCase(),
              buyPrice:      w.valueEth,
              sellPrice:     0,
              spreadPct:     0,
              netSpreadPct:  w.valueEth,
              source:        "whale-tracker",
            });
          } catch {}
        }

        if (this.notifier?.send && w.valueEth >= 5000) {
          // $15M+ 만 텔레그램 (노이즈 방지)
          this.notifier.send(
            `${sign} <b>고래 트랜잭션 감지</b>\n` +
            `<b>${w.valueEth.toLocaleString()} ETH</b> ${w.direction}\n` +
            `거래소: ${w.exchange.toUpperCase()}\n` +
            (w.counterpartyExchange ? `상대: ${w.counterpartyExchange.toUpperCase()}\n` : "") +
            `시그널: ${w.direction === "INFLOW" ? "매도 압력 가능 (단기 -1~3%)" : "자가 보관 (강세 시그널)"}`
          );
        }

        this.emit("whale", w);
      }
    } catch (e) {
      console.warn("[WhaleTracker] cycle err:", e.message);
    }
  }

  getSummary() {
    return {
      running:       this._running,
      hasApiKey:     !!this.apiKey,
      stats:         { ...this._stats },
      uptimeHrs:     this._stats.startedAt
        ? +((Date.now() - this._stats.startedAt) / 3_600_000).toFixed(2)
        : 0,
      latestWhales:  this._latestWhales.slice(0, 20),
    };
  }
}

module.exports = { WhaleTracker };
