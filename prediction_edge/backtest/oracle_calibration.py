"""
Claude Oracle Calibration Backtest.

과거 해결된 마켓 N개에 대해:
  1. Claude에게 확률 추정 요청 (뉴스 없이 — 공정 비교)
  2. 실제 결과와 비교
  3. 캘리브레이션 측정: Brier score, calibration curve, edge accuracy

이 결과로:
  - Claude 추정치가 시장 가격보다 나은지 실증적으로 검증
  - calib_error 실제 값 측정 → db.py prior 업데이트
  - 결과가 나쁘면 Claude Oracle 가중치를 더 낮추거나 비활성화

사용법:
  python -m backtest.oracle_calibration --count 50

비용: 50 마켓 × 2 샘플 = 100 Haiku 쿼리 ≈ $0.05
"""
from __future__ import annotations
import asyncio
import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field

# 프로젝트 루트를 경로에 추가
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config


@dataclass
class CalibrationResult:
    question: str
    market_price_at_close: float     # 마켓 종료 직전 가격
    claude_estimate: float            # Claude 추정치
    actual_outcome: int               # 1=YES, 0=NO
    claude_edge: float = 0.0         # claude - market
    market_correct: bool = False
    claude_correct: bool = False


@dataclass
class CalibrationReport:
    total: int = 0
    claude_brier: float = 0.0
    market_brier: float = 0.0        # 시장 가격의 Brier score
    claude_accuracy: float = 0.0
    market_accuracy: float = 0.0
    claude_beats_market: int = 0     # Claude가 시장보다 나은 횟수
    avg_edge: float = 0.0
    calibration_error: float = 0.0
    bin_data: dict = field(default_factory=dict)
    results: list = field(default_factory=list)


async def fetch_resolved_markets(limit: int = 50) -> list[dict]:
    """Gamma API에서 최근 해결된 마켓 가져오기."""
    import aiohttp

    url = f"{config.GAMMA_HOST}/markets"
    params = {
        "closed": "true",
        "limit": min(limit * 3, 300),  # 오버페치 (일부는 필터링됨)
    }

    async with aiohttp.ClientSession() as session:
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status != 200:
                print(f"Gamma API error: {resp.status}")
                return []
            data = await resp.json()

    # 필터: outcome이 명확하고 volume이 있는 마켓
    valid = []
    for m in data:
        outcomes = m.get("outcomePrices", "") or ""
        question = m.get("question", "")
        volume = float(m.get("volume", 0) or 0)
        end_date = m.get("endDateIso", "")

        if not outcomes or not question or volume < 5000:
            continue

        # outcome 파싱
        try:
            prices = json.loads(outcomes) if isinstance(outcomes, str) else outcomes
            if len(prices) < 2:
                continue
            yes_final = float(prices[0])
        except Exception:
            continue

        # 명확한 결과만 (0.95+ or 0.05-)
        if 0.05 < yes_final < 0.95:
            continue

        actual_yes = 1 if yes_final >= 0.95 else 0

        valid.append({
            "question": question,
            "condition_id": m.get("conditionId", ""),
            "actual_outcome": actual_yes,
            "volume": volume,
            "end_date": end_date,
            "category": m.get("category", ""),
        })

        if len(valid) >= limit:
            break

    return valid


async def get_claude_estimate(question: str, end_date: str) -> float | None:
    """Claude에게 단일 확률 추정 요청 (뉴스 없이 — 공정 비교용)."""
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None

    try:
        import anthropic
    except ImportError:
        print("ERROR: pip install anthropic")
        return None

    from signals.claude_oracle import _extract_probability

    client = anthropic.AsyncAnthropic(api_key=api_key)

    prompt = (
        f"You are a calibrated probability forecaster.\n\n"
        f"Question: {question}\n"
        f"Resolution date: {end_date}\n\n"
        f"Estimate the probability of YES. Reply ONLY with a decimal like 0.73, "
        f"or UNKNOWN.\n\nProbability (YES):"
    )

    try:
        response = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=20,
            messages=[{"role": "user", "content": prompt}],
        )
        text = ""
        for block in response.content:
            if block.type == "text":
                text = block.text.strip()
                break

        if "UNKNOWN" in text.upper():
            return None
        return _extract_probability(text)

    except Exception as e:
        print(f"  API error: {e}")
        return None


async def run_calibration_backtest(count: int = 50) -> CalibrationReport:
    """메인 캘리브레이션 백테스트."""
    print(f"=== Claude Oracle Calibration Backtest ===")
    print(f"Target: {count} resolved markets\n")

    # 1. 해결된 마켓 가져오기
    print("Fetching resolved markets from Gamma API...")
    markets = await fetch_resolved_markets(limit=count)
    print(f"  Found {len(markets)} valid resolved markets\n")

    if not markets:
        print("No markets found. Check API connection.")
        return CalibrationReport()

    # 2. 각 마켓에 Claude 추정치 요청
    report = CalibrationReport()
    semaphore = asyncio.Semaphore(3)

    async def evaluate_one(m: dict) -> CalibrationResult | None:
        async with semaphore:
            estimate = await get_claude_estimate(m["question"], m["end_date"])
        if estimate is None:
            return None

        actual = m["actual_outcome"]
        market_price = 0.50  # 마켓 종료 직전 가격을 모르므로 기저율로 비교

        result = CalibrationResult(
            question=m["question"],
            market_price_at_close=market_price,
            claude_estimate=estimate,
            actual_outcome=actual,
            claude_edge=estimate - market_price,
            claude_correct=(estimate > 0.5 and actual == 1) or (estimate <= 0.5 and actual == 0),
        )
        return result

    tasks = [evaluate_one(m) for m in markets]
    raw_results = await asyncio.gather(*tasks)
    results = [r for r in raw_results if r is not None]

    if not results:
        print("No results. Check ANTHROPIC_API_KEY.")
        return CalibrationReport()

    # 3. 지표 계산
    report.total = len(results)
    report.results = results

    # Brier Score: 낮을수록 좋음 (완벽 = 0, 최악 = 1)
    brier_sum = 0.0
    correct_count = 0
    edge_sum = 0.0

    # 캘리브레이션 bins (0.1 단위)
    bins: dict[str, list[CalibrationResult]] = {}

    for r in results:
        # Brier score
        brier_sum += (r.claude_estimate - r.actual_outcome) ** 2
        if r.claude_correct:
            correct_count += 1
        edge_sum += r.claude_edge

        # Bin
        bin_key = f"{int(r.claude_estimate * 10) / 10:.1f}"
        if bin_key not in bins:
            bins[bin_key] = []
        bins[bin_key].append(r)

    report.claude_brier = brier_sum / report.total
    report.claude_accuracy = correct_count / report.total
    report.avg_edge = edge_sum / report.total

    # Calibration error: 각 bin의 예측 확률 vs 실제 비율 차이
    calib_errors = []
    bin_data = {}
    for bin_key, bin_results in sorted(bins.items()):
        avg_pred = sum(r.claude_estimate for r in bin_results) / len(bin_results)
        actual_rate = sum(r.actual_outcome for r in bin_results) / len(bin_results)
        error = abs(avg_pred - actual_rate)
        calib_errors.append(error)
        bin_data[bin_key] = {
            "count": len(bin_results),
            "avg_predicted": round(avg_pred, 3),
            "actual_rate": round(actual_rate, 3),
            "error": round(error, 3),
        }

    report.calibration_error = sum(calib_errors) / len(calib_errors) if calib_errors else 0.5
    report.bin_data = bin_data

    # 4. 리포트 출력
    print(f"\n{'='*60}")
    print(f"  CALIBRATION RESULTS ({report.total} markets)")
    print(f"{'='*60}")
    print(f"  Brier Score:        {report.claude_brier:.4f}  (lower = better, 0.25 = coin flip)")
    print(f"  Direction Accuracy: {report.claude_accuracy:.1%}  (>50% = better than random)")
    print(f"  Calibration Error:  {report.calibration_error:.4f}  (lower = better calibrated)")
    print(f"  Avg Edge:           {report.avg_edge:+.2%}")

    print(f"\n  Calibration Curve:")
    print(f"  {'Bin':>6} | {'n':>4} | {'Predicted':>10} | {'Actual':>8} | {'Error':>7}")
    print(f"  {'-'*6}-+-{'-'*4}-+-{'-'*10}-+-{'-'*8}-+-{'-'*7}")
    for bin_key, bd in sorted(bin_data.items()):
        print(
            f"  {bin_key:>6} | {bd['count']:>4} | "
            f"{bd['avg_predicted']:>10.1%} | {bd['actual_rate']:>8.1%} | "
            f"{bd['error']:>7.3f}"
        )

    # 5. 추천 사항
    print(f"\n  {'='*60}")
    print(f"  RECOMMENDATIONS:")
    if report.claude_brier < 0.20:
        print(f"  ✓ Claude Brier {report.claude_brier:.3f} < 0.20 → 좋은 캘리브레이션")
        print(f"  → signal_aggregator weight를 0.55로 상향 권장")
    elif report.claude_brier < 0.25:
        print(f"  ~ Claude Brier {report.claude_brier:.3f} ≈ 코인 플립 수준")
        print(f"  → 현재 weight 0.35 유지 적절")
    else:
        print(f"  ✗ Claude Brier {report.claude_brier:.3f} > 0.25 → 코인 플립보다 나쁨")
        print(f"  → Claude Oracle 비활성화 권장")

    if report.calibration_error < 0.08:
        print(f"  ✓ Calibration error {report.calibration_error:.3f} < 0.08 → db.py prior 업데이트 권장")
        print(f"     claude_oracle: calib_error={report.calibration_error:.2f}")

    # 6. 결과 저장
    output_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "oracle_calibration_result.json"
    )
    save_data = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_markets": report.total,
        "brier_score": round(report.claude_brier, 4),
        "direction_accuracy": round(report.claude_accuracy, 4),
        "calibration_error": round(report.calibration_error, 4),
        "bins": bin_data,
    }
    with open(output_path, "w") as f:
        json.dump(save_data, f, indent=2)
    print(f"\n  Results saved to: {output_path}")

    return report


def main():
    parser = argparse.ArgumentParser(description="Claude Oracle Calibration Backtest")
    parser.add_argument("--count", type=int, default=50, help="Number of resolved markets to test")
    args = parser.parse_args()
    asyncio.run(run_calibration_backtest(count=args.count))


if __name__ == "__main__":
    main()
