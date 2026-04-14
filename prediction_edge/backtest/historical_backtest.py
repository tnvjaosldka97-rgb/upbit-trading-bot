"""
Prediction Edge — 실제 Polymarket 데이터 기반 백테스트

데이터 소스:
1. Gamma API: 마감된 마켓 목록 + 실제 해결 결과 (outcomePrices)
2. CLOB API:  토큰별 실제 가격 히스토리 (/prices-history)
3. 이론 시뮬레이션: 방법 B (fallback)

전략 시뮬레이션:
- fee_arbitrage:       p>0.95 진입 → 해결 시 exit → 실제 적중률
- oracle_convergence:  분쟁 위험 낮은 마켓의 수렴 패턴
- closing_convergence: 만료 3일 전 진입 패턴
"""
from __future__ import annotations
import asyncio
import json
import math
import time
from datetime import datetime, timezone, timedelta
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


# ── 실제 가격 히스토리 ─────────────────────────────────────────────────────────

async def fetch_price_history(
    client: httpx.AsyncClient,
    token_id: str,
    start_ts: int,
    end_ts: int,
    fidelity: int = 60,
) -> list[dict]:
    """
    CLOB /prices-history로 실제 가격 히스토리 가져오기.
    Returns: [{"t": unix_ts, "p": price}, ...]
    fidelity: 분봉 단위 (60 = 1시간봉)
    """
    try:
        resp = await client.get(
            f"{CLOB_HOST}/prices-history",
            params={
                "market": token_id,
                "startTs": start_ts,
                "endTs": end_ts,
                "fidelity": fidelity,
            },
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("history", [])
    except Exception:
        pass
    return []


# ── 해결된 마켓 수집 ───────────────────────────────────────────────────────────

async def fetch_resolved_markets(
    client: httpx.AsyncClient,
    days_back: int = 60,
    max_markets: int = 500,
) -> list[dict]:
    """
    최근 N일 내 해결된 마켓 수집.
    outcomePrices가 ["1","0"] or ["0","1"] 인 것만 (실제 해결, 분쟁 없음).
    """
    resolved = []
    offset = 0
    batch = 100
    cutoff_dt = datetime.now(timezone.utc) - timedelta(days=days_back)
    cutoff_str = cutoff_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    while len(resolved) < max_markets:
        try:
            resp = await client.get(
                f"{GAMMA_HOST}/markets",
                params={
                    "closed": "true",
                    "limit": batch,
                    "offset": offset,
                    "order": "volume",
                    "ascending": "false",
                    "end_date_min": cutoff_str,
                },
                timeout=30,
            )
            resp.raise_for_status()
            items = resp.json()
            if not isinstance(items, list):
                items = items.get("data", [])
        except Exception as e:
            print(f"  [WARN] Gamma fetch error: {e}")
            break

        if not items:
            break

        for m in items:
            vol = float(m.get("volumeNum") or m.get("volume") or 0)
            if vol < MIN_VOLUME:
                continue

            # outcomePrices 파싱
            op = m.get("outcomePrices", "[]")
            if isinstance(op, str):
                try:
                    op = json.loads(op)
                except Exception:
                    continue
            if not isinstance(op, list) or len(op) < 2:
                continue

            # 실제 해결됐는지 확인 (하나가 정확히 1.0)
            prices = []
            for p in op:
                try:
                    prices.append(float(p))
                except Exception:
                    prices.append(0.0)

            winner_idx = next((i for i, p in enumerate(prices) if p >= 0.99), None)
            if winner_idx is None:
                continue  # 미해결 or 무승부

            # clobTokenIds 파싱
            token_ids = m.get("clobTokenIds", "[]")
            if isinstance(token_ids, str):
                try:
                    token_ids = json.loads(token_ids)
                except Exception:
                    token_ids = []

            if not token_ids or len(token_ids) < 2:
                continue

            question = m.get("question", "")
            category = m.get("category") or "unknown"
            dr = dispute_risk(question, category, vol)

            resolved.append({
                "condition_id": m.get("conditionId", ""),
                "question": question,
                "category": category,
                "volume": vol,
                "dispute_risk": dr,
                "winner_idx": winner_idx,
                "token_ids": token_ids,
                "end_date": m.get("endDateIso") or m.get("endDate", ""),
                "outcome_prices": prices,
            })

        offset += batch
        print(f"  해결된 마켓 수집 중... {len(resolved)}개", end="\r", flush=True)

        if len(items) < batch:
            break

        await asyncio.sleep(0.15)

    print()
    return resolved


# ── fee_arbitrage 실제 시뮬레이션 ─────────────────────────────────────────────

async def simulate_fee_arb_real(
    client: httpx.AsyncClient,
    markets: list[dict],
    semaphore: asyncio.Semaphore,
    price_threshold: float = 0.95,
    lookback_days: int = 7,
) -> dict:
    """
    실제 가격 히스토리 기반 fee_arb 전략 시뮬레이션.

    로직:
    1. 마감 전 lookback_days 동안 가격 히스토리 가져오기
    2. 가격이 price_threshold 이상인 시점에 진입 (한 번만)
    3. 마감 시 실제 해결 결과로 손익 계산
    4. dispute_risk > DISPUTE_SKIP 마켓 제외
    """
    trades = []
    skipped_dispute = 0
    no_history = 0
    below_threshold = 0

    async def process_market(m: dict):
        nonlocal skipped_dispute, no_history, below_threshold

        if m["dispute_risk"] > DISPUTE_SKIP:
            skipped_dispute += 1
            return

        end_ts = None
        if m["end_date"]:
            try:
                dt = datetime.fromisoformat(m["end_date"].replace("Z", "+00:00"))
                end_ts = int(dt.timestamp())
            except Exception:
                pass
        if not end_ts:
            end_ts = int(time.time())

        start_ts = end_ts - lookback_days * 86400

        # 각 토큰에 대해 가격 히스토리 조회
        for token_idx, token_id in enumerate(m["token_ids"][:2]):
            async with semaphore:
                history = await fetch_price_history(client, token_id, start_ts, end_ts, fidelity=60)
            await asyncio.sleep(0.05)

            if not history:
                no_history += 1
                continue

            # threshold 이상인 첫 진입점 찾기
            entry = None
            for point in history:
                try:
                    p = float(point.get("p", 0))
                except Exception:
                    continue
                if p >= price_threshold:
                    entry = p
                    break

            if entry is None:
                below_threshold += 1
                continue

            # 실제 해결 결과
            resolved_price = 1.0 if token_idx == m["winner_idx"] else 0.0
            fee = TAKER_FEE * (1.0 - entry)
            pnl_pct = resolved_price - entry - fee
            was_correct = resolved_price >= 0.99

            trades.append({
                "question": m["question"][:60],
                "category": m["category"],
                "entry_price": round(entry, 4),
                "resolved": resolved_price,
                "fee": round(fee, 5),
                "pnl_pct": round(pnl_pct, 5),
                "was_correct": was_correct,
                "dispute_risk": round(m["dispute_risk"], 3),
                "volume": m["volume"],
            })

    tasks = [process_market(m) for m in markets]
    await asyncio.gather(*tasks)

    if not trades:
        return {"count": 0}

    wins = [t for t in trades if t["was_correct"]]
    losses = [t for t in trades if not t["was_correct"]]
    win_rate = len(wins) / len(trades)
    mean_pnl = sum(t["pnl_pct"] for t in trades) / len(trades)
    std_pnl = math.sqrt(sum((t["pnl_pct"] - mean_pnl) ** 2 for t in trades) / len(trades)) if len(trades) > 1 else 0.001
    sharpe = mean_pnl / std_pnl if std_pnl > 0 else 0

    # 가격 구간별 분석
    bands: dict[str, list] = {
        "0.95-0.97": [], "0.97-0.99": [], "0.99+": [],
    }
    for t in trades:
        p = t["entry_price"]
        if p < 0.97:
            bands["0.95-0.97"].append(t)
        elif p < 0.99:
            bands["0.97-0.99"].append(t)
        else:
            bands["0.99+"].append(t)

    band_stats = {}
    for band, blist in bands.items():
        if blist:
            bw = sum(1 for t in blist if t["was_correct"])
            band_stats[band] = {
                "count": len(blist),
                "win_rate": round(bw / len(blist), 4),
                "avg_pnl": round(sum(t["pnl_pct"] for t in blist) / len(blist), 5),
            }

    # 카테고리별 분석
    cats: dict[str, list] = {}
    for t in trades:
        cats.setdefault(t["category"], []).append(t)
    cat_stats = {}
    for cat, clist in sorted(cats.items(), key=lambda x: -len(x[1])):
        cw = sum(1 for t in clist if t["was_correct"])
        cat_stats[cat] = {
            "count": len(clist),
            "win_rate": round(cw / len(clist), 4),
            "avg_pnl": round(sum(t["pnl_pct"] for t in clist) / len(clist), 5),
        }

    return {
        "count": len(trades),
        "win_count": len(wins),
        "loss_count": len(losses),
        "win_rate": round(win_rate, 4),
        "mean_pnl": round(mean_pnl, 5),
        "std_pnl": round(std_pnl, 5),
        "sharpe": round(sharpe, 3),
        "cum_pnl_pct": round(sum(t["pnl_pct"] for t in trades), 4),
        "skipped_dispute": skipped_dispute,
        "no_history": no_history,
        "below_threshold": below_threshold,
        "top_trades": sorted(trades, key=lambda x: x["pnl_pct"], reverse=True)[:5],
        "worst_trades": sorted(trades, key=lambda x: x["pnl_pct"])[:5],
        "band_stats": band_stats,
        "cat_stats": cat_stats,
    }


# ── oracle_convergence 시뮬레이션 ─────────────────────────────────────────────

async def simulate_oracle_convergence(
    client: httpx.AsyncClient,
    markets: list[dict],
    semaphore: asyncio.Semaphore,
) -> dict:
    """
    Oracle convergence: 분쟁 위험 낮은 마켓에서
    해결 24시간 전 ~ 해결 시점 사이 가격 수렴 패턴 분석.
    """
    trades = []

    async def process_market(m: dict):
        if m["dispute_risk"] > 0.03:  # oracle_convergence는 더 엄격한 필터
            return

        end_ts = None
        if m["end_date"]:
            try:
                dt = datetime.fromisoformat(m["end_date"].replace("Z", "+00:00"))
                end_ts = int(dt.timestamp())
            except Exception:
                pass
        if not end_ts:
            return

        # 해결 24시간 전 구간만
        start_ts = end_ts - 86400

        for token_idx, token_id in enumerate(m["token_ids"][:2]):
            async with semaphore:
                history = await fetch_price_history(client, token_id, start_ts, end_ts, fidelity=60)
            await asyncio.sleep(0.05)

            if not history or len(history) < 3:
                continue

            # 진입: 처음 0.85~0.99 구간 진입 시점
            entry = None
            for point in history[:-1]:
                try:
                    p = float(point.get("p", 0))
                except Exception:
                    continue
                if 0.85 <= p < 0.99:
                    entry = p
                    break

            if entry is None:
                continue

            resolved_price = 1.0 if token_idx == m["winner_idx"] else 0.0
            fee = TAKER_FEE * (1.0 - entry)
            pnl_pct = resolved_price - entry - fee
            was_correct = resolved_price >= 0.99

            trades.append({
                "entry_price": round(entry, 4),
                "pnl_pct": round(pnl_pct, 5),
                "was_correct": was_correct,
                "category": m["category"],
                "dispute_risk": round(m["dispute_risk"], 3),
            })

    tasks = [process_market(m) for m in markets[:200]]  # oracle: 상위 200개
    await asyncio.gather(*tasks)

    if not trades:
        return {"count": 0}

    wins = sum(1 for t in trades if t["was_correct"])
    win_rate = wins / len(trades)
    mean_pnl = sum(t["pnl_pct"] for t in trades) / len(trades)
    std_pnl = math.sqrt(sum((t["pnl_pct"] - mean_pnl) ** 2 for t in trades) / len(trades)) if len(trades) > 1 else 0.001
    sharpe = mean_pnl / std_pnl if std_pnl > 0 else 0

    return {
        "count": len(trades),
        "win_rate": round(win_rate, 4),
        "mean_pnl": round(mean_pnl, 5),
        "sharpe": round(sharpe, 3),
        "cum_pnl_pct": round(sum(t["pnl_pct"] for t in trades), 4),
    }


# ── Live 기회 스캔 ─────────────────────────────────────────────────────────────

async def scan_live_opportunities(client: httpx.AsyncClient) -> list[dict]:
    """현재 OPEN 마켓에서 p>0.95 기회 스캔"""
    opps = []
    offset = 0
    batch = 100
    scanned = 0

    while scanned < 3000:
        params = {
            "active": "true", "closed": "false",
            "limit": batch, "offset": offset,
            "order": "volume", "ascending": "false",
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
                except Exception:
                    continue
            if isinstance(outcomes, str):
                try:
                    outcomes = json.loads(outcomes)
                except Exception:
                    continue

            for i, op in enumerate(outcome_prices):
                try:
                    price = float(op)
                except Exception:
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
                    "question": question[:70],
                    "outcome": outcomes[i] if i < len(outcomes) else f"outcome_{i}",
                    "price": price,
                    "net_edge": net_edge,
                    "dispute_risk": dr,
                    "volume": vol,
                    "end_date": end_date[:10] if end_date else "?",
                    "category": category or "unknown",
                })

        scanned += len(items)
        offset += batch
        print(f"  스캔 {scanned}개 마켓... 기회 {len(opps)}건", end="\r", flush=True)
        await asyncio.sleep(0.2)

        if len(items) < batch:
            break

    print()
    return sorted(opps, key=lambda x: x["net_edge"], reverse=True)


# ── 이론 시뮬레이션 (fallback) ────────────────────────────────────────────────

def theoretical_simulation(liquid_markets: int, win_rate_override: Optional[float] = None) -> dict:
    """이론적 P&L 시뮬레이션 (가격 히스토리 없을 때 fallback)."""
    if liquid_markets == 0:
        return {}

    price_bands = [
        (0.96, win_rate_override or 0.992, 0.04),
        (0.97, win_rate_override or 0.995, 0.03),
        (0.98, win_rate_override or 0.998, 0.02),
        (0.99, win_rate_override or 0.9997, 0.01),
    ]

    all_trades = []
    for price, acc, frac in price_bands:
        n_trades = max(1, int(liquid_markets * frac))
        fee = TAKER_FEE * (1 - price)
        net_edge = (1.0 - price) - fee
        if net_edge < MIN_EDGE:
            continue
        n_wins = round(n_trades * acc)
        n_losses = n_trades - n_wins
        for _ in range(n_wins):
            all_trades.append(net_edge)
        for _ in range(n_losses):
            all_trades.append(-(price + fee))

    if not all_trades:
        return {}

    mean = sum(all_trades) / len(all_trades)
    var = sum((p - mean) ** 2 for p in all_trades) / len(all_trades)
    std = math.sqrt(var) if var > 0 else 0.001
    return {
        "n_trades": len(all_trades),
        "win_rate": sum(1 for p in all_trades if p > 0) / len(all_trades),
        "mean_pnl": mean,
        "cum_pnl": sum(all_trades),
        "sharpe": mean / std,
        "std": std,
    }


# ── 메인 백테스트 ─────────────────────────────────────────────────────────────

async def run_backtest():
    print("=" * 70)
    print("  Prediction Edge 백테스트 — 실제 Polymarket 데이터 기반")
    print("=" * 70)

    semaphore = asyncio.Semaphore(5)  # 최대 5개 동시 API 호출

    async with httpx.AsyncClient(timeout=30) as client:

        # ── Part 1: 해결된 마켓 수집 ──────────────────────────────────────────
        print("\n[1] 최근 60일 해결된 마켓 수집 중...")
        markets = await fetch_resolved_markets(client, days_back=60, max_markets=500)

        liquid = [m for m in markets if m["volume"] >= MIN_VOLUME]
        total_vol = sum(m["volume"] for m in liquid)
        dispute_filtered = [m for m in liquid if m["dispute_risk"] <= DISPUTE_SKIP]

        print(f"\n  총 해결된 마켓:         {len(markets):,}개")
        print(f"  거래량 $5K+ 마켓:       {len(liquid):,}개")
        print(f"  분쟁필터 통과 (DR<8%):  {len(dispute_filtered):,}개")
        print(f"  총 거래량:              ${total_vol:,.0f}")

        # 카테고리 분포
        cats: dict[str, int] = {}
        for m in dispute_filtered:
            cats[m["category"]] = cats.get(m["category"], 0) + 1
        print(f"\n  카테고리 분포 (Top 6):")
        for cat, cnt in sorted(cats.items(), key=lambda x: -x[1])[:6]:
            print(f"    {cat[:18]:18}: {cnt}개")

        # ── Part 2: fee_arb 실제 시뮬레이션 ──────────────────────────────────
        print(f"\n[2] fee_arbitrage 실제 백테스트 (상위 200개 마켓)...")
        print("    CLOB 가격 히스토리 조회 중... (약 1~2분 소요)")

        top_markets = sorted(dispute_filtered, key=lambda x: -x["volume"])[:200]
        fa_result = await simulate_fee_arb_real(client, top_markets, semaphore, price_threshold=0.95)

        if fa_result.get("count", 0) > 0:
            print(f"\n  [fee_arbitrage 실제 결과]")
            print(f"  시뮬레이션 트레이드:  {fa_result['count']}건")
            print(f"  승/패:               {fa_result['win_count']}승 / {fa_result['loss_count']}패")
            print(f"  실제 승률:            {fa_result['win_rate']:.2%}")
            print(f"  평균 수익:            {fa_result['mean_pnl']:+.3%}/트레이드")
            print(f"  Sharpe:              {fa_result['sharpe']:.3f}")
            print(f"  누적 수익(합계):      {fa_result['cum_pnl_pct']:+.2f} edges")
            print(f"  제외됨 — 분쟁필터:   {fa_result['skipped_dispute']}건")
            print(f"  제외됨 — 히스토리없음:{fa_result['no_history']}건")
            print(f"  제외됨 — 임계값미달: {fa_result['below_threshold']}건")

            if fa_result.get("band_stats"):
                print(f"\n  [가격 구간별 실제 승률]")
                for band, bs in fa_result["band_stats"].items():
                    print(f"    {band}: {bs['count']}건, 승률 {bs['win_rate']:.2%}, avg pnl {bs['avg_pnl']:+.3%}")

            if fa_result.get("cat_stats"):
                print(f"\n  [카테고리별 실제 승률 (Top 5)]")
                for cat, cs in list(fa_result["cat_stats"].items())[:5]:
                    print(f"    {cat[:16]:16}: {cs['count']}건, 승률 {cs['win_rate']:.2%}")

            if fa_result.get("worst_trades"):
                print(f"\n  [최악의 거래 Top 3]")
                for t in fa_result["worst_trades"][:3]:
                    print(f"    {t['entry_price']:.3f} → {t['resolved']:.0f} | pnl {t['pnl_pct']:+.3%} | {t['question'][:45]}")
        else:
            print("  가격 히스토리 데이터 부족 — 이론 시뮬레이션으로 fallback")
            sim = theoretical_simulation(len(dispute_filtered))
            if sim:
                print(f"  이론값 — 승률: {sim['win_rate']:.2%}, Sharpe: {sim['sharpe']:.3f}")

        # ── Part 3: oracle_convergence 시뮬레이션 ─────────────────────────────
        print(f"\n[3] oracle_convergence 시뮬레이션 (분쟁 <3% 마켓)...")
        oc_result = await simulate_oracle_convergence(client, top_markets, semaphore)

        if oc_result.get("count", 0) > 0:
            print(f"  트레이드: {oc_result['count']}건, 승률: {oc_result['win_rate']:.2%}, "
                  f"avg pnl: {oc_result['mean_pnl']:+.3%}, Sharpe: {oc_result['sharpe']:.3f}")
        else:
            print("  데이터 부족")

        # ── Part 4: Live 기회 스캔 ─────────────────────────────────────────────
        print(f"\n[4] 현재 LIVE p>0.95 기회 스캔...")
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

            bands_live: dict[str, list] = {"0.95-0.97": [], "0.97-0.99": [], "0.99+": []}
            for o in opps:
                if o["price"] < 0.97:
                    bands_live["0.95-0.97"].append(o)
                elif o["price"] < 0.99:
                    bands_live["0.97-0.99"].append(o)
                else:
                    bands_live["0.99+"].append(o)
            print(f"\n  [가격 구간별 현재 기회]")
            for band, lst in bands_live.items():
                if lst:
                    avg_edge = sum(o["net_edge"] for o in lst) / len(lst)
                    print(f"    {band}: {len(lst)}건, avg edge {avg_edge:.3%}")

    # ── 요약 ───────────────────────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("  [백테스트 요약]")
    if fa_result.get("count", 0) > 0:
        wr = fa_result["win_rate"]
        sharpe = fa_result["sharpe"]
        print(f"  fee_arb 실제 승률:   {wr:.2%}  (이론: ~99.2% — 실제 gap 확인!)")
        print(f"  fee_arb Sharpe:      {sharpe:.3f}  (2.0+ = 전략 실행 가능)")
        if sharpe >= 2.0:
            print("  ** 백테스트 통과 — 실매매 진행 적합 **")
        elif sharpe >= 1.0:
            print("  ** 긍정적이나 추가 검증 필요 **")
        else:
            print("  ** 주의: Sharpe 낮음 — 전략 파라미터 재검토 **")
    print(f"  현재 Live 기회:      {len(opps)}건")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(run_backtest())
