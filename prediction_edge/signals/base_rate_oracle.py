"""
Statistical Base Rate Oracle — 역사적 기저율 기반 확률 추정.

핵심 아이디어:
  예측 시장은 종종 앵커링 편향, 군중 심리로 인해
  잘 알려진 역사적 기저율에서 벗어납니다.

  예) "Will the Fed hold rates at the next meeting?"
    Polymarket: 0.45 (공포 분위기로 하락 예상 높음)
    역사적 기저율: 2022-2024 사이클에서 hold 횟수 비율 0.60
    → BUY 시그널

기저율 카테고리:
  1. 미국 대선/의회선거 — 현직 프리미엄, 정당 기저율
  2. Fed 금리 결정 — CME FedWatch 히스토리
  3. FDA 의약품 승인 — Phase별 승인율
  4. 경기침체 — 기간별 베이스레이트
  5. 입법/법안 — 의회 통과율
  6. 국제관계 — 협정 갱신, 제재 지속
  7. 기업 이벤트 — M&A 완료율, IPO 성공

한계:
  - 패턴 매칭 기반이라 불확실성 있음
  - edge 임계값 높게 설정 (8%) — 오매칭 방지
  - 단독 시그널은 낮은 confidence (0.4-0.55)
  - Claude Oracle과 결합 시 confidence 상승 (signal_aggregator에서)
"""
from __future__ import annotations
import asyncio
import re
import time
import uuid
from dataclasses import dataclass
from typing import Optional

import config
from core.logger import log
from core.models import Signal

# ── 상수 ─────────────────────────────────────────────────────────────────────
SCAN_INTERVAL_SEC  = 1800      # 30분 스캔 (기저율은 자주 바뀌지 않음)
MIN_EDGE_TO_SIGNAL = 0.08      # 8% 이상 — 오매칭 방지
MIN_VOLUME_24H     = 20_000    # 중간 볼륨 마켓만
TOP_MARKETS        = 50        # 상위 50개 스캔 (기저율은 빠름)


# ── 기저율 패턴 DB ────────────────────────────────────────────────────────────

@dataclass
class BaseRatePattern:
    """
    매칭 패턴과 해당 기저율.

    required: 질문에 ALL 포함돼야 함
    any_of:   이 중 최소 1개 포함돼야 함 (동의어 묶음)
    exclude:  하나라도 포함되면 제외
    """
    name: str
    required: list[str]          # 모두 포함 필수
    any_of: list[str]            # 하나 이상 포함 필수 (빈 리스트면 무시)
    exclude: list[str]           # 하나라도 있으면 제외
    base_rate_yes: float
    n_historical: int
    description: str


def _B(name, required, any_of, exclude, rate, n, desc):
    return BaseRatePattern(name, required, any_of, exclude, rate, n, desc)


_BASE_RATES: list[BaseRatePattern] = [

    # ── 미국 연준 (Fed) 금리 결정 ─────────────────────────────────────────────
    _B("fed_hold",
       required=["rate"],
       any_of=["fed", "federal reserve", "fomc"],
       exclude=["hike", "cut", "raise", "lower", "reduce", "increase"],
       rate=0.55, n=60,
       desc="Fed 금리 동결 — 역사적 55%"),

    _B("fed_cut",
       required=["rate"],
       any_of=["fed", "federal reserve", "fomc"],
       exclude=["hike", "raise", "hold", "unchanged", "pause", "increase"],
       rate=0.35, n=60,
       desc="Fed 금리 인하 — 인하 사이클 외 35%"),

    _B("fed_hike",
       required=["rate"],
       any_of=["fed", "federal reserve", "fomc"],
       exclude=["cut", "lower", "reduce", "hold", "unchanged", "pause"],
       rate=0.25, n=60,
       desc="Fed 금리 인상 — 인상 사이클 외 25%"),

    # ── 미국 선거 ────────────────────────────────────────────────────────────
    _B("us_president_incumbent",
       required=["president"],
       any_of=["win", "reelect", "second term", "incumbent"],
       exclude=["congress", "senate", "house", "midterm", "primary",
                "peru", "brazil", "mexico", "france", "korea", "argentina",
                "colombia", "chile", "ecuador", "bolivia", "venezuela",
                "philippine", "nigeria", "kenya", "india", "indonesia",
                "turkey", "south africa", "uk ", "british", "canadian"],
       rate=0.67, n=20,
       desc="현직 미국 대통령 재선 — 역사적 67% (외국 선거 제외)"),

    _B("senate_incumbent",
       required=["senate"],
       any_of=["win", "reelect", "incumbent", "retain"],
       exclude=["president", "house", "majority"],
       rate=0.82, n=200,
       desc="현직 상원의원 재선 — 역사적 82%"),

    _B("house_incumbent",
       required=["house", "representative"],
       any_of=["win", "reelect", "incumbent"],
       exclude=["president", "senate", "speaker"],
       rate=0.90, n=1000,
       desc="현직 하원의원 재선 — 역사적 90%"),

    # ── FDA 승인 ─────────────────────────────────────────────────────────────
    _B("fda_priority",
       required=["fda"],
       any_of=["approve", "approval", "grant"],
       exclude=["reject", "deny", "refuse", "withdraw", "delay"],
       rate=0.88, n=800,
       desc="FDA 의약품 승인 — 역사적 88%"),

    # ── 경기침체 ─────────────────────────────────────────────────────────────
    _B("us_recession",
       required=[],
       any_of=["recession", "contraction"],
       exclude=["avoid", "no recession", "soft landing", "prevent"],
       rate=0.15, n=75,
       desc="미국 경기침체 발생 — 연간 기저율 15%"),

    # ── 입법/법안 ─────────────────────────────────────────────────────────────
    _B("us_bill_pass",
       required=[],
       any_of=["bill", "legislation", "act"],
       exclude=["veto", "fail", "blocked", "filibuster", "repeal"],
       rate=0.05, n=10000,
       desc="미국 법안 의회 통과 — 역사적 5%"),

    _B("us_bill_bipartisan",
       required=["bipartisan"],
       any_of=["bill", "legislation", "pass", "vote"],
       exclude=["veto", "fail"],
       rate=0.40, n=200,
       desc="초당적 법안 통과 — 역사적 40%"),

    # ── M&A / 기업 이벤트 ─────────────────────────────────────────────────────
    _B("ma_complete",
       required=[],
       any_of=["acquisition", "merger", "acquire", "takeover"],
       exclude=["block", "fail", "cancel", "terminate", "abandon", "antitrust"],
       rate=0.78, n=5000,
       desc="발표된 M&A 완료 — 역사적 78%"),

    _B("ma_blocked",
       required=[],
       any_of=["acquisition", "merger", "antitrust"],
       exclude=["approve", "clear", "complete", "close"],
       rate=0.15, n=500,
       desc="M&A 반독점 차단 — 역사적 15%"),

    # ── 국제관계 / 제재 ───────────────────────────────────────────────────────
    _B("sanctions_renew",
       required=["sanctions"],
       any_of=["renew", "extend", "continue", "maintain"],
       exclude=["lift", "remove", "end", "expire", "waive"],
       rate=0.85, n=100,
       desc="경제 제재 갱신 — 역사적 85%"),

    _B("ceasefire_hold",
       required=[],
       any_of=["ceasefire", "truce", "armistice"],
       exclude=["collapse", "break", "fail", "end"],
       rate=0.45, n=50,
       desc="정전협정 유지 — 역사적 45%"),

    # ── 암호화폐 / 규제 ───────────────────────────────────────────────────────
    _B("crypto_etf",
       required=["etf", "sec"],
       any_of=["bitcoin", "btc", "crypto", "ethereum"],
       exclude=["reject", "deny", "delay"],
       rate=0.60, n=20,
       desc="암호화폐 ETF SEC 승인 — 현재 60%"),

    # ── IPO ──────────────────────────────────────────────────────────────────
    _B("ipo_complete",
       required=["ipo"],
       any_of=["complete", "close", "list", "public", "proceed"],
       exclude=["cancel", "withdraw", "postpone", "delay", "pull"],
       rate=0.72, n=500,
       desc="예정 IPO 완료 — 역사적 72%"),

    # ── 슈퍼볼 / 챔피언십 (스포츠 제외이지만 고볼륨) ────────────────────────────
    # 참고: 스포츠는 기저율 무의미 (50:50에 가까움) — 의도적으로 제외
]


def _match_base_rate(question: str) -> Optional[BaseRatePattern]:
    """
    required + any_of + exclude 매칭.
    """
    q = question.lower()
    matches = []

    for pattern in _BASE_RATES:
        # 제외 키워드
        if any(kw in q for kw in pattern.exclude):
            continue
        # required 키워드 ALL 포함
        if pattern.required and not all(kw in q for kw in pattern.required):
            continue
        # any_of 키워드 최소 1개
        if pattern.any_of and not any(kw in q for kw in pattern.any_of):
            continue
        matches.append(pattern)

    if not matches:
        return None
    # 여러 매칭 시: required 개수 많은 것 우선 (더 구체적)
    return max(matches, key=lambda p: len(p.required) + len(p.any_of))


# ── 메인 스캐너 ───────────────────────────────────────────────────────────────

class BaseRateOracleScanner:
    """
    역사적 기저율 vs Polymarket 가격 비교.

    장점:
      - API 불필요, 완전 오프라인
      - 수십~수천 건의 역사적 사례 기반
      - 앙커링/군중심리 편향 포착
    단점:
      - 패턴 매칭 → 오매칭 가능성
      - MIN_EDGE 8%로 보수적 운영
    """

    def __init__(self, store, signal_bus: asyncio.Queue):
        self._store = store
        self._bus = signal_bus

    async def start(self) -> None:
        log.info(
            f"[BaseRate] Started — {len(_BASE_RATES)} patterns, "
            f"top {TOP_MARKETS} markets every {SCAN_INTERVAL_SEC//60}min"
        )
        while True:
            try:
                await self._scan()
            except Exception as e:
                log.error(f"[BaseRate] Scan error: {e}")
            await asyncio.sleep(SCAN_INTERVAL_SEC)

    async def _scan(self) -> None:
        markets = self._store.get_active_markets()
        eligible = [
            m for m in markets
            if m.volume_24h >= MIN_VOLUME_24H
            and m.days_to_resolution > 0.5
            and m.yes_token is not None
        ]
        eligible.sort(key=lambda m: m.volume_24h, reverse=True)
        eligible = eligible[:TOP_MARKETS]

        signals_generated = 0
        for market in eligible:
            try:
                signal = self._evaluate_market(market)
                if signal:
                    await self._bus.put(signal)
                    signals_generated += 1
            except Exception as e:
                log.debug(f"[BaseRate] Market eval error: {e}")

        if signals_generated:
            log.info(f"[BaseRate] {signals_generated} base rate signals generated")

    def _evaluate_market(self, market) -> Optional[Signal]:
        yes_token = market.yes_token
        if not yes_token or yes_token.price <= 0:
            return None

        market_price = yes_token.price
        if market_price > 0.92 or market_price < 0.08:
            return None

        pattern = _match_base_rate(market.question)
        if pattern is None:
            return None

        base_rate = pattern.base_rate_yes
        edge = base_rate - market_price

        if abs(edge) < MIN_EDGE_TO_SIGNAL:
            return None

        # 방향 결정
        if edge > 0:
            token_id = yes_token.token_id
            token_price = market_price
            model_prob = base_rate
        else:
            no_token = market.no_token
            if not no_token:
                return None
            token_id = no_token.token_id
            token_price = no_token.price
            model_prob = 1.0 - base_rate
            edge = -edge

        fee_per_dollar = config.TAKER_FEE_RATE * (1 - token_price)
        net_edge = edge - fee_per_dollar

        if net_edge < config.MIN_EDGE_AFTER_FEES:
            return None

        # 신뢰도: 역사적 사례 수에 비례
        # n=10 → low, n=100 → medium, n=1000+ → high (but still capped, base rates aren't perfect)
        import math
        n_factor = math.log10(max(pattern.n_historical, 10)) / 4  # 0.25~1.0
        confidence = min(0.35 + n_factor * edge * 2, 0.65)  # 최대 0.65 (단독 기저율의 한계)

        urgency = "MEDIUM" if edge >= 0.20 and pattern.n_historical >= 100 else "LOW"

        signal = Signal(
            signal_id=str(uuid.uuid4()),
            strategy="claude_oracle",   # base_rate도 oracle 버킷으로 집계
            condition_id=market.condition_id,
            token_id=token_id,
            direction="BUY",
            model_prob=model_prob,
            market_prob=token_price,
            edge=edge,
            net_edge=net_edge,
            confidence=round(confidence, 3),
            urgency=urgency,
            stale_price=token_price,
            stale_threshold=0.05,
            expires_at=time.time() + 3600,
        )

        log.info(
            f"[BaseRate] SIGNAL ({pattern.name}): {market.question[:50]}"
            f" | mkt={token_price:.2%} base={model_prob:.2%}"
            f" | edge={edge:+.2%} n={pattern.n_historical}"
        )
        return signal
