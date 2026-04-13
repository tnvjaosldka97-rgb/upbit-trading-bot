"use strict";

/**
 * RegimeEngine v2 — 멀티타임프레임 시장 국면 감지
 *
 * v1 (단일 일봉 SMA200) → v2 (일봉 + 4h 이중 확인)
 *
 * 3-국면 분류:
 *   BULL   : 일봉 SMA200 +2% 이상 + 주간 양수 + 4h 추세 상승
 *   NEUTRAL: 중간 구간
 *   BEAR   : 일봉 SMA200 -2% 이하 + 주간 음수 + 4h 추세 하락
 *
 * 개선점 (v2):
 *   1) 4h 캔들 SMA50으로 단기 추세 확인
 *   2) 일봉 RSI14로 과열/침체 보정
 *   3) 복합 신뢰도 계산 (단순 30% 고착 제거)
 *   4) 국면 전환 히스테리시스 (잦은 전환 방지)
 */
class RegimeEngine {
  constructor() {
    this.REFRESH_MS   = 15 * 60_000;  // 15분마다 갱신 (v1: 30분)
    this._intervalId  = null;

    this.state = {
      regime:           "NEUTRAL",
      confidence:       0,
      btcVsSma200:      0,
      btcVsSma50_4h:    0,    // 4h SMA50 대비
      weeklyReturn:     0,
      monthlyReturn:    0,
      dailyRsi:         50,
      volatilityRegime: "NORMAL",
      lastUpdated:      0,
    };

    // 히스테리시스: 같은 신호 2회 연속일 때만 전환
    this._pendingRegime   = null;
    this._pendingCount    = 0;
    this.HYSTERESIS_COUNT = 2;   // 2회 연속 확인 후 전환
  }

  async start() {
    await this.refresh();
    this._intervalId = setInterval(() => this.refresh(), this.REFRESH_MS);
    console.log(
      `[RegimeEngine v2] 시작 — 국면: ${this.state.regime} ` +
      `(신뢰도 ${Math.round(this.state.confidence)}%) ` +
      `BTC vs SMA200: ${(this.state.btcVsSma200 * 100).toFixed(1)}%`
    );
  }

  stop() { if (this._intervalId) clearInterval(this._intervalId); }

  getRegime()   { return this.state.regime; }
  isBull()      { return this.state.regime === "BULL"; }
  isNeutral()   { return this.state.regime === "NEUTRAL"; }
  isBear()      { return this.state.regime === "BEAR"; }

  getKellyMultiplier() {
    if (this.state.regime === "BULL")    return 1.5;
    if (this.state.regime === "NEUTRAL") return 1.0;
    return 0.0;
  }

  getScoreContribution() {
    if (this.state.regime === "BULL")    return 25;
    if (this.state.regime === "NEUTRAL") return 0;
    return -999;
  }

  async refresh() {
    try {
      // ── 일봉 데이터 (200개) ─────────────────────────
      const [dailyRes, h4Res] = await Promise.allSettled([
        fetch("https://api.upbit.com/v1/candles/days?market=KRW-BTC&count=200"),
        fetch("https://api.upbit.com/v1/candles/minutes/240?market=KRW-BTC&count=100"),
      ]);

      if (dailyRes.status !== "fulfilled" || !dailyRes.value.ok) return;
      const rawDaily = await dailyRes.value.json();
      if (!Array.isArray(rawDaily) || rawDaily.length < 50) return;

      const daily   = rawDaily.reverse();
      const closes  = daily.map(c => Number(c.trade_price));
      const price   = closes[closes.length - 1];
      const n       = closes.length;

      // ── 일봉 지표 ──────────────────────────────────
      const smaLen  = Math.min(200, n);
      const sma200  = closes.slice(-smaLen).reduce((s, v) => s + v, 0) / smaLen;
      const btcVsSma200 = (price - sma200) / sma200;

      const weeklyReturn  = n >= 8  ? (price - closes[n - 8])  / closes[n - 8]  : 0;
      const monthlyReturn = n >= 31 ? (price - closes[n - 31]) / closes[n - 31] : 0;

      // 일봉 RSI14
      const dailyRsi = this._rsi(closes, 14);

      // 일봉 ATR20
      const atr20      = this._atr(daily.slice(-21));
      const volRatio   = atr20 / price;
      const volatilityRegime = volRatio > 0.045 ? "HIGH"
        : volRatio < 0.018 ? "LOW"
        : "NORMAL";

      // ── 4h 지표 ────────────────────────────────────
      let btcVsSma50_4h = 0;
      let h4TrendUp = null;

      if (h4Res.status === "fulfilled" && h4Res.value.ok) {
        const raw4h = await h4Res.value.json();
        if (Array.isArray(raw4h) && raw4h.length >= 50) {
          const h4 = raw4h.reverse();
          const h4closes = h4.map(c => Number(c.trade_price));
          const h4price  = h4closes[h4closes.length - 1];
          const h4sma50  = h4closes.slice(-50).reduce((s, v) => s + v, 0) / 50;
          btcVsSma50_4h  = (h4price - h4sma50) / h4sma50;

          // 4h SMA50 기울기: 최근 10개 vs 이전 10개
          const smaRecent = h4closes.slice(-10).reduce((s, v) => s + v, 0) / 10;
          const smaPrev   = h4closes.slice(-20, -10).reduce((s, v) => s + v, 0) / 10;
          h4TrendUp       = smaRecent > smaPrev;
        }
      }

      // ── 국면 결정 (멀티타임프레임) ─────────────────
      const aboveSma200 = btcVsSma200 > 0.02;
      const belowSma200 = btcVsSma200 < -0.02;
      const weekUp      = weeklyReturn > 0.01;
      const weekDown    = weeklyReturn < -0.01;
      const monthUp     = monthlyReturn > 0.03;
      const monthDown   = monthlyReturn < -0.03;
      const above4hSma  = btcVsSma50_4h > 0;
      const below4hSma  = btcVsSma50_4h < 0;

      // RSI 보정: 극단 RSI → 신뢰도 조정
      const rsiOverbought  = dailyRsi > 75;  // 과열 → BULL 신뢰도 감소
      const rsiOversold    = dailyRsi < 30;  // 침체 → BEAR 완화, 반등 가능

      let rawRegime;
      let confidence = 0;

      if (aboveSma200 && weekUp) {
        rawRegime  = "BULL";
        confidence = 50 + Math.min(30, btcVsSma200 * 800 + weeklyReturn * 300);
        if (monthUp)              confidence = Math.min(90, confidence + 10);
        if (above4hSma && h4TrendUp) confidence = Math.min(95, confidence + 10); // 4h 확인
        if (rsiOverbought)        confidence -= 10;  // 과열 보정
      } else if (belowSma200 && weekDown) {
        rawRegime  = "BEAR";
        confidence = 50 + Math.min(30, Math.abs(btcVsSma200) * 800);
        if (monthDown)            confidence = Math.min(90, confidence + 10);
        if (below4hSma && !h4TrendUp) confidence = Math.min(95, confidence + 10); // 4h 확인
        if (rsiOversold)          confidence -= 10;  // 과매도 반등 가능
      } else if (btcVsSma200 > 0.01 && above4hSma) {
        rawRegime  = "BULL";
        confidence = 42;
        if (weekUp) confidence += 8;
      } else if (btcVsSma200 < -0.01 && weekDown && below4hSma) {
        rawRegime  = "BEAR";
        confidence = 40;
      } else {
        rawRegime  = "NEUTRAL";
        // NEUTRAL 신뢰도도 시장 상태 반영
        confidence = 35 + Math.min(20, Math.abs(btcVsSma200) * 300);
      }

      if (volatilityRegime === "HIGH") confidence = Math.max(20, confidence - 15);
      confidence = Math.round(Math.max(0, Math.min(95, confidence)));

      // ── 히스테리시스: 잦은 전환 방지 ──────────────
      const prev = this.state.regime;
      let finalRegime = prev;

      if (rawRegime !== prev) {
        if (rawRegime === this._pendingRegime) {
          this._pendingCount++;
          if (this._pendingCount >= this.HYSTERESIS_COUNT) {
            finalRegime         = rawRegime;
            this._pendingRegime = null;
            this._pendingCount  = 0;
          }
        } else {
          this._pendingRegime = rawRegime;
          this._pendingCount  = 1;
        }
      } else {
        this._pendingRegime = null;
        this._pendingCount  = 0;
      }

      this.state = {
        regime:           finalRegime,
        confidence,
        btcVsSma200,
        btcVsSma50_4h,
        weeklyReturn,
        monthlyReturn,
        dailyRsi:         Math.round(dailyRsi),
        volatilityRegime,
        lastUpdated:      Date.now(),
      };

      if (prev !== finalRegime) {
        console.log(
          `[RegimeEngine v2] 국면 전환: ${prev} → ${finalRegime} ` +
          `(신뢰도 ${confidence}%)\n` +
          `  SMA200: ${(btcVsSma200 * 100).toFixed(2)}% | ` +
          `SMA50(4h): ${(btcVsSma50_4h * 100).toFixed(2)}% | ` +
          `RSI: ${Math.round(dailyRsi)} | ` +
          `주간: ${(weeklyReturn * 100).toFixed(2)}%`
        );
      } else if (rawRegime !== this._pendingRegime || prev === finalRegime) {
        // 주기적 상태 로그 (30분마다)
        if (!this._lastStateLog || Date.now() - this._lastStateLog > 30 * 60_000) {
          console.log(
            `[RegimeEngine v2] ${finalRegime} (신뢰도 ${confidence}%) | ` +
            `SMA200: ${(btcVsSma200 * 100).toFixed(1)}% | ` +
            `SMA50(4h): ${(btcVsSma50_4h * 100).toFixed(1)}% | ` +
            `RSI: ${Math.round(dailyRsi)} | 변동성: ${volatilityRegime}`
          );
          this._lastStateLog = Date.now();
        }
      }
    } catch (e) {
      console.error("[RegimeEngine v2] refresh 오류:", e.message);
    }
  }

  _rsi(closes, p = 14) {
    if (closes.length < p + 1) return 50;
    let g = 0, l = 0;
    for (let i = closes.length - p; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    const al = l / p;
    return al === 0 ? 99 : 100 - 100 / (1 + (g / p) / al);
  }

  _atr(candles) {
    if (candles.length < 2) return 0;
    const trs = candles.slice(1).map((c, i) =>
      Math.max(
        Number(c.high_price) - Number(c.low_price),
        Math.abs(Number(c.high_price) - Number(candles[i].trade_price)),
        Math.abs(Number(c.low_price)  - Number(candles[i].trade_price))
      )
    );
    return trs.reduce((s, v) => s + v, 0) / trs.length;
  }

  getSummary() {
    return {
      regime:           this.state.regime,
      confidence:       this.state.confidence,
      btcVsSma200Pct:   +(this.state.btcVsSma200 * 100).toFixed(2),
      btcVsSma50_4hPct: +(this.state.btcVsSma50_4h * 100).toFixed(2),
      weeklyReturnPct:  +(this.state.weeklyReturn * 100).toFixed(2),
      monthlyReturnPct: +(this.state.monthlyReturn * 100).toFixed(2),
      dailyRsi:         this.state.dailyRsi,
      volatilityRegime: this.state.volatilityRegime,
      kellyMultiplier:  this.getKellyMultiplier(),
      pendingRegime:    this._pendingRegime,
      lastUpdated:      this.state.lastUpdated,
    };
  }
}

module.exports = { RegimeEngine };
