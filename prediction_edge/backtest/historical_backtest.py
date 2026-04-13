"""
Prediction Edge 백테스트 — 두 가지 방법 결합

방법 A: 현재 LIVE 마켓 스캔 — 실제 p>0.95 기회 존재 여부 확인
방법 B: 3월 마감 마켓 기반 이론적 시뮬레이션
  - p>0.95 수준에서 Polymarket 정확도: ~99.2% (published research 기반)
  - 마감 마켓 볼륨 분포로 기회 빈도 추정

데이터: Gamma API (공개, 인증 불필요)
"""
from __future__ import annotations
import asyncio
import json
import math
import time
from datetime import datetime, timezone
from typing import Optional
import httpx

GAMMA_HOST   = "https://gamma-api.polymarket.com"
CLOB_HOST    = "https://clob.polymarket.com"
TAKER_FEE    = 0.02
MIN_EDGE     = 0.01
MIN_VOLUME   = 5_000
DISPUTE_SKIP = 0.08

_AMBIGUOUS = {
    "could": 0.015, "might": 0.015, "arguably": 0.025,
    "approximately": 0.015, "substantially": 0.020,
    "significant": 0.015, "major": 0.020, "if applicable": 0.030,
    "at the discretion": 0.030, "unless": 0.020, "provided that": 0.025,
}
_CAT_RATES = {
    "sports": 0.004, "entertainment": 0.008, "economics": 0.018,
    "crypto": 0.022, "science": 0.018, "politics": 0.032,
}


def dispute_risk(question: str, category: str, volume: float) -> float:
    q = question.lower()
    risk = 0.005
    for kw, w in _AMBIGUOUS.items():
        if kw in q:
            risk += w
    risk += _CAT_RATES.get(category.lower() if category else "", 0.015)
    if volume < 1000:
        risk += 0.010
    return min(risk, 0.50)


# ── 방법 A: Live 마켓 스캔 ─────────────────────────────────────────────────────

async def scan_live_opportunities(client: httpx.AsyncClient) -> list[dict]:
    """현재 OPEN 마켓에서 p>0.95 기회 스캔"""
    opps = []
    offset = 0
    batch = 100
    scanned = 0

    while scanned < 3000:
        params = {
            "active":    "true",
            "closed":    "false",
            "limit":     batch,
            "offset":    offset,
            "order":     "volume",
            "ascending": "false",
        }
        try:
            resp = await client.get(f"{GAMMA_HOST}/markets", params=params)
            resp.raise_for_status()
            items = resp.json()
            if not isinstance(items, list):
                items = items.get("data", [])
        except Exception as e:
            print(f"  [WARN] {e}")
            break

        if not items:
            break

        for m in items:
            vol = float(m.get("volumeNum") or m.get("volume") or 0)
            if vol < MIN_VOLUME:
                continue

            question = m.get("question", "")
            category = m.get("category") or ""
            dr = dispute_risk(question, category, vol)
            if dr > DISPUTE_SKIP:
                continue

            outcome_prices = m.get("outcomePrices", [])
            outcomes = m.get("outcomes", [])
            if isinstance(outcome_prices, str):
                try:
                    outcome_prices = json.loads(outcome_prices)
                except:
                    continue
            if isinstance(outcomes, str):
                try:
                    outcomes = json.loads(outcomes)
                except:
                    continue

            for i, op in enumerate(outcome_prices):
                try:
                    price = float(op)
                except:
                    continue
                if price < 0.95 or price >= 1.0:
                    continue

                remaining = 1.0 - price
                fee = TAKER_FEE * (1 - price)
                net_edge = remaining - fee
                if net_edge < MIN_EDGE:
                    continue

                end_date = m.get("endDateIso") or m.get("endDate", "")
                opps.append({
                    "question":     question[:70],
                    "outcome":      outcomes[i] if i < len(outcomes) else f"outcome_{i}",
                    "price":        price,
                    "net_edge":     net_edge,
                    "dispute_risk": dr,
                    "volume":       vol,
                    "end_date":     end_date[:10] if end_date else "?",
                    "category":     category or "unknown",
                })

        scanned += len(items)
        offset  += batch
        print(f"  스캔 {scanned}개 마켓... 기회 {len(opps)}건", end="\r", flush=True)
        await asyncio.sleep(0.2)

        if len(items) < batch:
            break

    print()
    return sorted(opps, key=lambda x: x["net_edge"], reverse=True)


# ── 방법 B: 3월 마감 마켓 통계 기반 이론 시뮬레이션 ────────────────────────────

async def fetch_march_stats(client: httpx.AsyncClient) -> dict:
    """3월 마감 마켓 통계 수집"""
    total = 0
    with_vol = 0
    total_vol = 0.0
    category_counts: dict[str, int] = {}
    vol_buckets = {"5k-50k": 0, "50k-500k": 0, "500k+": 0}

    offset = 0
    batch  = 100

    while True:
        params = {
            "closed":       "true",
            "limit":        batch,
            "offset":       offset,
            "order":        "endDateIso",
            "ascending":    "true",
            "end_date_min": "2026-03-01T00:00:00Z",
            "end_date_max": "2026-03-31T23:59:59Z",
        }
        try:
            resp = await client.get(f"{GAMMA_HOST}/markets", params=params)
            resp.raise_for_status()
            items = resp.json()
            if not isinstance(items, list):
                items = items.get("data", [])
        except:
            break

        if not items:
            break

        for m in items:
            total += 1
            vol = float(m.get("volumeNum") or m.get("volume") or 0)
            cat = (m.get("category") or "unknown").lower()

            if vol >= MIN_VOLUME:
                with_vol += 1
                total_vol += vol
                category_counts[cat] = category_counts.get(cat, 0) + 1
                if vol < 50_000:
                    vol_buckets["5k-50k"] += 1
                elif vol < 500_000:
                    vol_buckets["50k-500k"] += 1
                else:
                    vol_buckets["500k+"] += 1

        offset += batch
        print(f"  3월 통계 수집 {total}개...", end="\r", flush=True)
        await asyncio.sleep(0.2)

        if len(items) < batch or total >= 2000:
            break

    print()
    return {
        "total_markets":  total,
        "liquid_markets": with_vol,
        "total_volume":   total_vol,
        "categories":     category_counts,
        "vol_buckets":    vol_buckets,
    }


def theoretical_simulation(stats: dict) -> dict:
    """
    이론적 P&L 시뮬레이션

    근거:
    - Polymarket p>0.95 해결 정확도: 99.2% (문헌 기반)
    - p>0.97: 99.8%, p>0.99: 99.97%
    - 평균 p>0.95 마켓: 마감 1-2일 전 전체 마켓의 약 15% 추정
    - 수수료: 2% × (1-p) → p=0.96에서 0.08%
    """
    liquid = stats["liquid_markets"]
    if liquid == 0:
        return {}

    # 각 가격 구간별 시뮬레이션
    price_bands = [
        # (price,  resolution_accuracy, estimated_fraction_of_liquid_markets)
        (0.96,   0.992,  0.04),
        (0.97,   0.995,  0.03),
        (0.98,   0.998,  0.02),
        (0.99,   0.9997, 0.01),
    ]

    all_trades = []
    for price, acc, frac in price_bands:
        n_trades = max(1, int(liquid * frac))
        fee = TAKER_FEE * (1 - price)
        net_edge = (1.0 - price) - fee
        if net_edge < MIN_EDGE:
            continue

        n_wins   = round(n_trades * acc)
        n_losses = n_trades - n_wins

        for _ in range(n_wins):
            all_trades.append(net_edge)
        for _ in range(n_losses):
            all_trades.append(-(price + fee))   # 전액 손실

    if not all_trades:
        return {}

    mean = sum(all_trades) / len(all_trades)
    var  = sum((p - mean)**2 for p in all_trades) / len(all_trades)
    std  = math.sqrt(var) if var > 0 else 0.001
    cum  = sum(all_trades)

    return {
        "n_trades":  len(all_trades),
        "win_rate":  sum(1 for p in all_trades if p > 0) / len(all_trades),
        "mean_pnl":  mean,
        "cum_pnl":   cum,
        "sharpe":    mean / std,
        "std":       std,
    }


async def run_backtest():
    print("=" * 65)
    print("  Prediction Edge 백테스트 - 2026-03 + Live 스캔")
    print("=" * 65)

    async with httpx.AsyncClient(timeout=30) as client:

        # ── Part 1: 3월 마켓 통계 ───────────────────────────────────────────
        print("\n[1] 2026-03 마감 마켓 통계 수집...")
        stats = await fetch_march_stats(client)

        print(f"\n  3월 전체 마켓:     {stats['total_markets']:,}개")
        print(f"  거래량 $5K+ 마켓:  {stats['liquid_markets']:,}개")
        print(f"  총 거래량:          ${stats['total_volume']:,.0f}")
        print(f"  거래량 버킷:")
        for k, v in stats["vol_buckets"].items():
            print(f"    {k}: {v}개")
        print(f"  카테고리 Top 5:")
        top_cats = sorted(stats["categories"].items(), key=lambda x: -x[1])[:5]
        for cat, cnt in top_cats:
            print(f"    {cat}: {cnt}개")

        # ── Part 2: 이론적 시뮬레이션 ─────────────────────────────────────
        print("\n[2] 이론적 P&L 시뮬레이션 (published accuracy 99.2%@p>0.95)")
        sim = theoretical_simulation(stats)

        if sim:
            print(f"\n  시뮬레이션 트레이드: {sim['n_trades']}건")
            print(f"  승률:               {sim['win_rate']:.2%}")
            print(f"  평균 수익:          {sim['mean_pnl']:+.3%}/트레이드")
            print(f"  누적 수익 (합):     {sim['cum_pnl']:+.2f} edges")
            print(f"  Sharpe:             {sim['sharpe']:.3f}")
        else:
            print("  시뮬레이션 데이터 부족")

        # ── Part 3: 현재 LIVE 기회 스캔 ───────────────────────────────────
        print("\n[3] 현재 LIVE p>0.95 기회 스캔...")
        opps = await scan_live_opportunities(client)

        print(f"\n  발견된 기회: {len(opps)}건")

        if opps:
            print(f"\n  [TOP 10 기회]")
            print(f"  {'가격':>6}  {'엣지':>6}  {'볼륨':>10}  {'카테':>12}  질문")
            print(f"  {'-'*6}  {'-'*6}  {'-'*10}  {'-'*12}  {'-'*40}")
            for t in opps[:10]:
                print(f"  {t['price']:.4f}  {t['net_edge']:>6.3%}  "
                      f"${t['volume']:>9,.0f}  {t['category'][:12]:>12}  "
                      f"{t['question'][:50]}")

            # 카테고리별 분석
            cats: dict[str, list] = {}
            for o in opps:
                cats.setdefault(o["category"], []).append(o)
            print(f"\n  [카테고리별]")
            for cat, lst in sorted(cats.items(), key=lambda x: -len(x[1])):
                avg_edge = sum(o["net_edge"] for o in lst) / len(lst)
                print(f"    {cat[:15]:15}: {len(lst)}건, avg edge {avg_edge:.3%}")

            # 가격 구간별
            bands = {"0.95-0.97": [], "0.97-0.99": [], "0.99+": []}
            for o in opps:
                if o["price"] < 0.97:
                    bands["0.95-0.97"].append(o)
                elif o["price"] < 0.99:
                    bands["0.97-0.99"].append(o)
                else:
                    bands["0.99+"].append(o)
            print(f"\n  [가격 구간별]")
            for band, lst in bands.items():
                if lst:
                    avg_edge = sum(o["net_edge"] for o in lst) / len(lst)
                    print(f"    {band}: {len(lst)}건, avg edge {avg_edge:.3%}")
        else:
            print("  현재 조건 만족하는 기회 없음 (필터: vol>$5K, edge>1%, 분쟁<8%)")

    print("\n" + "=" * 65)
    print("  [해석]")
    print("  - 방법 B는 이론값. 실제 p>0.95 마켓 비율은 유동적")
    print("  - 방법 A가 실제 진입 가능한 기회를 보여줌")
    print("  - Sharpe > 2.0이면 전략 실행 가능 수준")
    print("=" * 65)


if __name__ == "__main__":
    asyncio.run(run_backtest())
