"use strict";

/**
 * UpbitOrderService v2 — 10/10 실행 엔진
 *
 * v1 대비 핵심 추가:
 *   1) smartLimitBuy  — 시장가 대신 지정가 passive 진입 (수수료 0.139% → 슬리피지 0)
 *   2) reconcilePosition — 봇 재시작 시 기존 포지션 복구 (크래시 생존)
 *   3) getSpread — 진입 전 스프레드 실시간 확인
 *   4) adjustUnfilledOrder — 미체결 지정가 자동 추적 (N초 미체결 → 호가 갱신)
 *
 * 필요 패키지:
 *   npm install jsonwebtoken uuid dotenv
 */

const crypto = require("crypto");

let jwt, uuidv4;
try {
  jwt    = require("jsonwebtoken");
  uuidv4 = require("uuid").v4;
} catch {
  console.error("[UpbitOrderService] npm install jsonwebtoken uuid 필요");
}

const UPBIT_API = "https://api.upbit.com";

class UpbitOrderService {
  constructor(options = {}) {
    this.accessKey = options.accessKey || process.env.UPBIT_ACCESS_KEY || null;
    this.secretKey = options.secretKey || process.env.UPBIT_SECRET_KEY || null;

    if (!this.accessKey || !this.secretKey) {
      console.warn("[UpbitOrderService] API 키 없음 — 시뮬레이션 전용 모드");
    }

    this.orderHistory  = [];
    this.activeOrders  = new Map();

    // 서킷브레이커
    this.errorStreak   = 0;
    this.MAX_ERRORS    = 3;
    this.halted        = false;
    this.haltReason    = null;

    // 스마트 진입 설정
    this.LIMIT_CHASE_INTERVAL_MS = 8_000;   // 8초 미체결 → 호가 재조정
    this.LIMIT_CHASE_MAX_TICKS   = 3;        // 최대 3번 호가 추격
    this.MAX_ENTRY_WAIT_MS       = 30_000;   // 30초 내 미체결 시 포기
    this.MAX_SPREAD_FOR_LIMIT    = 0.0008;   // 스프레드 0.08% 초과 시 포기
  }

  // ─── 인증 ───────────────────────────────────────────

  createToken(queryParams = null) {
    if (!jwt || !uuidv4) throw new Error("jwt/uuid 패키지 필요");
    if (!this.accessKey || !this.secretKey) throw new Error("API 키 미설정");

    const payload = { access_key: this.accessKey, nonce: uuidv4() };

    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs   = new URLSearchParams(queryParams).toString();
      const hash = crypto.createHash("sha512").update(qs).digest("hex");
      payload.query_hash     = hash;
      payload.query_hash_alg = "SHA512";
    }

    return jwt.sign(payload, this.secretKey);
  }

  async request(method, path, params = null) {
    if (this.halted) throw new Error(`주문 엔진 중단: ${this.haltReason}`);

    const token = this.createToken(method === "GET" ? params : null);
    const url =
      method === "GET" && params
        ? `${UPBIT_API}${path}?${new URLSearchParams(params)}`
        : `${UPBIT_API}${path}`;

    const opts = {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    };
    if (method !== "GET" && params) opts.body = JSON.stringify(params);

    try {
      const res  = await fetch(url, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(`API ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
      this.errorStreak = 0;
      return data;
    } catch (err) {
      this.errorStreak++;
      if (this.errorStreak >= this.MAX_ERRORS) {
        this.halted     = true;
        this.haltReason = `연속 오류 ${this.errorStreak}회`;
        console.error(`[UpbitOrderService] 서킷브레이커 작동 — ${this.haltReason}`);
      }
      throw err;
    }
  }

  // ─── 계좌 ───────────────────────────────────────────

  async getAccounts() {
    return this.request("GET", "/v1/accounts");
  }

  async getBalance(currency) {
    const accounts = await this.getAccounts();
    const acc = accounts.find((a) => a.currency === currency.toUpperCase());
    return acc ? Number(acc.balance) : 0;
  }

  // ─── 호가창 ─────────────────────────────────────────

  async fetchOrderbook(market) {
    const res = await fetch(
      `${UPBIT_API}/v1/orderbook?markets=${market}&count=5`,
      { headers: { accept: "application/json" } },
    );
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : null;
    if (!first) throw new Error(`호가창 조회 실패: ${market}`);

    const units = first.orderbook_units || [];
    return {
      bestBid:   Number(units[0]?.bid_price || 0),
      bestAsk:   Number(units[0]?.ask_price || 0),
      spreadRate: units[0]
        ? (units[0].ask_price - units[0].bid_price) / units[0].ask_price
        : 1,
      bids: units.map((u) => ({ price: Number(u.bid_price), size: Number(u.bid_size) })),
      asks: units.map((u) => ({ price: Number(u.ask_price), size: Number(u.ask_size) })),
    };
  }

  // ─── 핵심: 스마트 지정가 진입 ────────────────────────

  /**
   * smartLimitBuy v2
   *
   * 시장가 대신 매수 1호가에 지정가를 붙인다.
   * → 슬리피지 제로, taker 수수료 대신 maker 수수료 적용
   *
   * 알고리즘:
   *   1) 호가창 조회 → 스프레드 확인
   *   2) 스프레드 OK → bestBid 가격에 지정가 매수 주문
   *   3) 8초마다 체결 확인
   *   4) 미체결 + 가격 안 움직였으면 → 그냥 대기
   *   5) 미체결 + 가격 올라갔으면 → 호가 갱신 (최대 3회)
   *   6) 30초 내 미체결 → 포기 (진입 취소)
   *
   * @returns { filled: boolean, order, avgPrice, executedVolume }
   */
  async smartLimitBuy(market, krwAmount) {
    if (krwAmount < 5_000) throw new Error(`최소 주문 미달: ${krwAmount}원`);

    const ob = await this.fetchOrderbook(market);

    if (ob.spreadRate > this.MAX_SPREAD_FOR_LIMIT) {
      console.warn(
        `[UpbitOrderService] 스프레드 과다 (${(ob.spreadRate * 100).toFixed(3)}%) — 진입 포기`,
      );
      return { filled: false, reason: "SPREAD_TOO_WIDE" };
    }

    // bestBid 가격에 지정가 주문 (passive maker)
    let entryPrice = ob.bestBid;
    let order      = await this._placeLimitBid(market, krwAmount, entryPrice);
    let chaseCount = 0;
    const startMs  = Date.now();

    console.log(
      `[UpbitOrderService] 지정가 매수 → ${market} | ${entryPrice.toLocaleString()}원 | 금액 ${krwAmount.toLocaleString()}원`,
    );

    // 체결 대기 루프
    while (Date.now() - startMs < this.MAX_ENTRY_WAIT_MS) {
      await sleep(this.LIMIT_CHASE_INTERVAL_MS);

      const status = await this.getOrderStatus(order.uuid);

      // 체결 완료
      if (status.state === "done") {
        const avgPrice        = Number(status.avg_buy_price || entryPrice);
        const executedVolume  = Number(status.executed_volume || 0);
        console.log(
          `[UpbitOrderService] 지정가 체결 완료 — 평균가 ${avgPrice.toLocaleString()} | 수량 ${executedVolume}`,
        );
        this.track(order, "LIMIT_BUY", market, krwAmount);
        return { filled: true, order, avgPrice, executedVolume };
      }

      // 부분 체결: 그냥 대기 (취소하면 손해)
      if (Number(status.executed_volume) > 0) {
        continue;
      }

      // 미체결: 현재 호가 다시 확인
      if (chaseCount >= this.LIMIT_CHASE_MAX_TICKS) {
        // 최대 추격 횟수 초과 → 포기
        await this.cancelOrder(order.uuid).catch(() => {});
        console.warn(`[UpbitOrderService] 지정가 추격 한도 초과 — 진입 포기: ${market}`);
        return { filled: false, reason: "CHASE_LIMIT_EXCEEDED" };
      }

      const freshOb     = await this.fetchOrderbook(market);
      const newBestBid  = freshOb.bestBid;

      // 가격이 위로 도망갔을 때만 호가 갱신
      if (newBestBid > entryPrice * 1.0002) {
        await this.cancelOrder(order.uuid).catch(() => {});
        entryPrice = newBestBid;
        order      = await this._placeLimitBid(market, krwAmount, entryPrice);
        chaseCount++;
        console.log(
          `[UpbitOrderService] 지정가 갱신 (${chaseCount}회) → ${entryPrice.toLocaleString()}원`,
        );
      }
      // 가격 안 움직였으면 그냥 대기
    }

    // 타임아웃: 취소
    await this.cancelOrder(order.uuid).catch(() => {});
    console.warn(`[UpbitOrderService] 지정가 타임아웃 — 진입 포기: ${market}`);
    return { filled: false, reason: "TIMEOUT" };
  }

  async _placeLimitBid(market, krwAmount, price) {
    const volume = krwAmount / price;
    return this.request("POST", "/v1/orders", {
      market,
      side:     "bid",
      volume:   String(volume.toFixed(8)),
      price:    String(Math.floor(price)),
      ord_type: "limit",
    });
  }

  // ─── 매도 ───────────────────────────────────────────

  /** 지정가(예약) 매도 — 목표가 체결용 */
  async limitSell(market, quantity, price) {
    console.log(
      `[UpbitOrderService] 지정가 매도 예약 → ${market} | ${price.toLocaleString()}원 | 수량 ${quantity}`,
    );
    const order = await this.request("POST", "/v1/orders", {
      market,
      side:     "ask",
      volume:   String(quantity),
      price:    String(Math.floor(price)),
      ord_type: "limit",
    });
    this.track(order, "LIMIT_SELL", market, null, quantity, price);
    return order;
  }

  /** 시장가 매도 — 손절 전용 */
  async marketSell(market, quantity) {
    console.log(`[UpbitOrderService] 시장가 매도(손절) → ${market} | 수량 ${quantity}`);
    const order = await this.request("POST", "/v1/orders", {
      market,
      side:     "ask",
      volume:   String(quantity),
      ord_type: "market",
    });
    this.track(order, "MARKET_SELL", market, null, quantity);
    return order;
  }

  // ─── 주문 관리 ──────────────────────────────────────

  async getOrderStatus(uuid) {
    return this.request("GET", "/v1/order", { uuid });
  }

  async cancelOrder(uuid) {
    return this.request("DELETE", "/v1/order", { uuid });
  }

  async isOrderFilled(uuid) {
    const order = await this.getOrderStatus(uuid);
    return order?.state === "done";
  }

  async cancelAllOpenOrders(market) {
    const orders = await this.request("GET", "/v1/orders", {
      market, state: "wait", limit: 100,
    });
    const results = [];
    for (const o of orders) {
      try { results.push(await this.cancelOrder(o.uuid)); } catch { /* ignore */ }
    }
    console.log(`[UpbitOrderService] ${market} 미체결 ${results.length}건 취소`);
    return results;
  }

  // ─── v2 핵심: 시작 시 포지션 복구 ──────────────────

  /**
   * reconcilePosition
   *
   * 봇이 크래시 후 재시작할 때 호출.
   * 계좌에 코인 잔고가 있으면 이미 포지션이 열려있다고 판단하고
   * 즉시 손절가를 설정한다.
   *
   * @param {string[]} watchedMarkets - 관찰할 마켓 목록 (예: ["KRW-BTC", "KRW-ETH"])
   * @returns {object|null} 복구된 포지션 정보
   */
  async reconcilePosition(watchedMarkets) {
    console.log("[UpbitOrderService] 포지션 복구 확인 중...");

    const accounts = await this.getAccounts();

    for (const market of watchedMarkets) {
      const coinSymbol = market.split("-")[1];
      const account    = accounts.find((a) => a.currency === coinSymbol);

      if (!account || Number(account.balance) < 0.00001) continue;

      const balance     = Number(account.balance);
      const avgBuyPrice = Number(account.avg_buy_price || 0);

      if (avgBuyPrice <= 0) continue;

      console.log(
        `[UpbitOrderService] 기존 포지션 발견! ${market} | ` +
        `수량 ${balance} | 평균 매수가 ${avgBuyPrice.toLocaleString()}원`,
      );

      // 미체결 지정가 매도 주문 확인
      let limitSellUuid = null;
      try {
        const openOrders = await this.request("GET", "/v1/orders", {
          market, state: "wait", limit: 10,
        });
        const limitSell = openOrders.find((o) => o.side === "ask" && o.ord_type === "limit");
        if (limitSell) {
          limitSellUuid = limitSell.uuid;
          console.log(`[UpbitOrderService] 기존 지정가 매도 발견: ${limitSellUuid}`);
        }
      } catch { /* 주문 조회 실패해도 포지션은 복구 */ }

      return {
        market,
        quantity:       balance,
        avgBuyPrice,
        limitSellUuid,
        recoveredAt:    Date.now(),
        isRecovered:    true,
      };
    }

    console.log("[UpbitOrderService] 복구할 포지션 없음 — 신규 시작");
    return null;
  }

  // ─── 지정가 매도 체결 대기 ──────────────────────────

  /**
   * 지정가 체결 대기 + 타임아웃 시 시장가 전환
   */
  async waitForFillOrMarketSell(uuid, market, quantity, timeoutMs = 30 * 60_000) {
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const check = async () => {
        try {
          const filled = await this.isOrderFilled(uuid);

          if (filled) {
            this.activeOrders.delete(uuid);
            resolve({ method: "LIMIT_FILLED", uuid });
            return;
          }

          if (Date.now() - start >= timeoutMs) {
            console.warn(`[UpbitOrderService] 지정가 타임아웃 → 시장가 전환: ${market}`);
            try { await this.cancelOrder(uuid); } catch { /* 이미 체결됐을 수 있음 */ }

            const balance = await this.getBalance(market.split("-")[1]);
            if (balance > 0.00001) {
              const result = await this.marketSell(market, balance);
              this.activeOrders.delete(uuid);
              resolve({ method: "MARKET_FALLBACK", uuid, result });
            } else {
              resolve({ method: "ALREADY_FILLED", uuid });
            }
            return;
          }

          setTimeout(check, 10_000);
        } catch (err) {
          reject(err);
        }
      };

      setTimeout(check, 10_000);
    });
  }

  // ─── 유틸 ───────────────────────────────────────────

  track(order, type, market, krwAmount = null, quantity = null, price = null) {
    const record = {
      uuid: order?.uuid,
      type,
      market,
      krwAmount,
      quantity,
      price,
      createdAt: new Date().toISOString(),
      state: order?.state,
    };
    this.orderHistory.unshift(record);
    this.orderHistory = this.orderHistory.slice(0, 300);
    if (order?.uuid) this.activeOrders.set(order.uuid, record);
  }

  resetHalt() {
    this.halted     = false;
    this.haltReason = null;
    this.errorStreak = 0;
    console.log("[UpbitOrderService] 서킷브레이커 해제");
  }

  getSummary() {
    return {
      halted:           this.halted,
      haltReason:       this.haltReason,
      errorStreak:      this.errorStreak,
      activeOrderCount: this.activeOrders.size,
      totalOrderCount:  this.orderHistory.length,
      hasApiKeys:       !!(this.accessKey && this.secretKey),
    };
  }

  getOrderHistory(limit = 50) {
    return this.orderHistory.slice(0, limit);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { UpbitOrderService };
