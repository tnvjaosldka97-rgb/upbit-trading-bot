"use strict";

/**
 * TelegramNotifier — ATS v9 실시간 알림
 *
 * 알림 종류:
 *   🚨 신규상장 감지 (Strategy B)
 *   ✅/💰/🛑 진입/청산 (A/B)
 *   🟢🔴🟡 레짐 전환
 *   📊 일일 요약 (자정)
 *
 * 설정: TELEGRAM_TOKEN + TELEGRAM_CHAT_ID 환경변수
 * Chat ID 없으면 봇에게 /start 메시지 후 자동감지
 */

class TelegramNotifier {
  constructor({ token, chatId } = {}) {
    this.token  = token  || null;
    this.chatId = chatId || null;
    this._queue   = [];
    this._sending = false;
    this._ready   = false;
    this._lastRegime = null;  // 레짐 중복 알림 방지
    this._dailyTimer = null;
  }

  async init() {
    if (!this.token) {
      console.warn("[Telegram] TELEGRAM_TOKEN 없음 — 알림 비활성화");
      return;
    }

    // Chat ID 없으면 getUpdates로 자동 감지
    if (!this.chatId) {
      await this._detectChatId();
    }

    if (!this.chatId) {
      console.warn("[Telegram] Chat ID 없음 — 봇(@해당봇)에게 /start 전송 후 재시작");
      return;
    }

    this._ready = true;
    console.log(`[Telegram] 활성화 — chat_id: ${this.chatId}`);
    await this.send("🤖 <b>ATS v9 시작</b>\n알림이 활성화됐습니다.");

    // 자정 일일 요약 타이머
    this._scheduleDailySummary();
  }

  // ── Chat ID 자동감지 ────────────────────────────────────
  async _detectChatId() {
    try {
      const res  = await fetch(
        `https://api.telegram.org/bot${this.token}/getUpdates?limit=20&offset=-20`
      );
      if (!res.ok) return;
      const data    = await res.json();
      const updates = data.result || [];

      // 가장 최근 메시지의 chat_id 사용
      for (const upd of updates.reverse()) {
        const chatId =
          upd.message?.chat?.id ||
          upd.edited_message?.chat?.id ||
          upd.callback_query?.message?.chat?.id;
        if (chatId) {
          this.chatId = String(chatId);
          console.log(`[Telegram] Chat ID 자동감지: ${this.chatId}`);
          return;
        }
      }
      console.warn("[Telegram] Chat ID 감지 못함 — 봇에게 /start 보내세요");
    } catch (e) {
      console.warn(`[Telegram] getUpdates 실패: ${e.message}`);
    }
  }

  // ── 메시지 전송 (큐 기반, 속도제한 준수) ───────────────
  async send(text) {
    if (!this._ready && !this.chatId) return;
    if (!this.token || !this.chatId) return;
    this._queue.push(text);
    if (!this._sending) this._flush();
  }

  async _flush() {
    this._sending = true;
    while (this._queue.length > 0) {
      const text = this._queue.shift();
      try {
        await fetch(
          `https://api.telegram.org/bot${this.token}/sendMessage`,
          {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              chat_id:    this.chatId,
              text,
              parse_mode: "HTML",
            }),
          }
        );
      } catch (e) {
        // 전송 실패는 조용히 무시 (알림이 봇 자체를 멈추면 안 됨)
      }
      await new Promise(r => setTimeout(r, 150));  // Telegram rate limit: ~7/s
    }
    this._sending = false;
  }

  // ── 전략 알림 메서드 ─────────────────────────────────────

  /** 신규상장 감지 직후 */
  async notifyNewListing(market) {
    const name = market.replace("KRW-", "");
    await this.send(
      `🚨 <b>신규상장 감지!</b>\n` +
      `코인: <b>${name}</b>\n` +
      `⚡ 즉시 진입 시도 중...`
    );
  }

  /** 진입 완료 */
  async notifyEntry(strategy, market, price, budget, targetPct, stopPct) {
    await this.send(
      `✅ <b>Strategy ${strategy} 진입</b>\n` +
      `마켓: ${market.replace("KRW-","")}\n` +
      `진입가: ${Math.round(price).toLocaleString()}원\n` +
      `예산: ${Math.round(budget).toLocaleString()}원\n` +
      `목표: +${(targetPct * 100).toFixed(1)}% / 손절: ${(stopPct * 100).toFixed(1)}%`
    );
  }

  /** 부분청산 */
  async notifyPartial(strategy, market, movePct) {
    await this.send(
      `💸 <b>Strategy ${strategy} 부분청산</b>\n` +
      `${market.replace("KRW-","")}: +${movePct.toFixed(1)}%\n` +
      `50% 매도 완료, 트레일링 스탑 시작`
    );
  }

  /** 최종 청산 */
  async notifyExit(strategy, market, pnlRate, reason, partialDone) {
    const emoji  = pnlRate >= 0 ? "💰" : "🛑";
    const sign   = pnlRate >= 0 ? "+" : "";
    const partial = partialDone ? "\n(50% 부분청산 포함)" : "";
    await this.send(
      `${emoji} <b>Strategy ${strategy} 청산(${reason})</b>\n` +
      `마켓: ${market.replace("KRW-","")}\n` +
      `손익: <b>${sign}${(pnlRate * 100).toFixed(2)}%</b>${partial}`
    );
  }

  /** 레짐 전환 (중복 알림 방지) */
  async notifyRegime(from, to) {
    if (from === this._lastRegime) return;
    this._lastRegime = to;
    const emoji = to === "BULL" ? "🟢" : to === "BEAR" ? "🔴" : "🟡";
    await this.send(
      `${emoji} <b>레짐 전환</b>\n` +
      `${from} → <b>${to}</b>\n` +
      `${to === "BULL" ? "Strategy A 활성화" : to === "BEAR" ? "전략 차단" : "대기 모드"}`
    );
  }

  /** 일일 요약 */
  async dailySummary({ totalAsset, initCap, sA, sB }) {
    const totalPnl = totalAsset - initCap;
    const sign     = totalPnl >= 0 ? "+" : "";
    const pnlA     = sA?.pnlRate ?? 0;
    const pnlB     = sB?.pnlRate ?? 0;
    await this.send(
      `📊 <b>일일 요약</b> (${new Date().toLocaleDateString("ko-KR")})\n` +
      `총자산: ${Math.round(totalAsset).toLocaleString()}원\n` +
      `손익: <b>${sign}${Math.round(totalPnl).toLocaleString()}원</b>\n\n` +
      `Strategy A: ${pnlA >= 0 ? "+" : ""}${pnlA}% (${sA?.totalTrades ?? 0}건)\n` +
      `Strategy B: ${pnlB >= 0 ? "+" : ""}${pnlB}% (${sB?.totalTrades ?? 0}건)`
    );
  }

  /** 서킷브레이커 발동 */
  async notifyHalt(reason) {
    await this.send(`⛔ <b>서킷브레이커 발동</b>\n사유: ${reason}\n오늘 거래 중단`);
  }

  // ── 일일 요약 자동 스케줄 ────────────────────────────────
  _scheduleDailySummary() {
    const now      = new Date();
    const midnight = new Date(now);
    midnight.setHours(23, 59, 0, 0);  // 23:59에 일일 요약
    const msUntil  = midnight - now;

    this._dailyTimer = setTimeout(() => {
      this._dailySummaryCallback?.();
      // 다음날도 반복
      this._scheduleDailySummary();
    }, msUntil > 0 ? msUntil : 24 * 3600_000);
  }

  setDailySummaryCallback(cb) {
    this._dailySummaryCallback = cb;
  }

  stop() {
    if (this._dailyTimer) clearTimeout(this._dailyTimer);
  }
}

module.exports = { TelegramNotifier };
