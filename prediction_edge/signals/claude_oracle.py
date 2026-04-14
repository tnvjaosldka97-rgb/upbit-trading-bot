"""
Claude Oracle Scanner — 뉴스 컨텍스트 주입 + 2-샘플 독립 추정.

단순 메모리 기반의 문제:
  Claude의 훈련 데이터 컷오프 이후 사건은 알 수 없음
  → 최신 뉴스 헤드라인 5개를 먹인 후 확률 추정

개선된 파이프라인:
  1. 마켓 질문 키워드 추출
  2. Google News RSS에서 관련 헤드라인 5개 수집 (무료, 키 없음)
  3. 헤드라인 + 질문을 Claude에게 2개 독립 프롬프트로 전달
  4. 두 추정치가 같은 방향일 때만 시그널
  5. 분산 기반 confidence 조정

비용: ~$0.15/day (뉴스 있어도 Haiku는 저렴)
캐시: 1시간 (뉴스 반응성 확보)
"""
from __future__ import annotations
import asyncio
import os
import re
import time
import uuid
import xml.etree.ElementTree as ET
from typing import Optional
from urllib.parse import quote_plus

import aiohttp

import config
from core.logger import log
from core.models import Signal

# ── 상수 ─────────────────────────────────────────────────────────────────────
SCAN_INTERVAL_SEC   = 600        # 10분 스캔
CACHE_TTL_SEC       = 3600       # 1시간 캐시 (뉴스 반응성)
MIN_EDGE_TO_SIGNAL  = 0.05
MIN_VOLUME_24H      = 5_000
TOP_MARKETS         = 20
MAX_CONCURRENT      = 3
CLAUDE_MODEL        = "claude-haiku-4-5"
NEWS_HEADLINES      = 5          # 주입할 헤드라인 수
NEWS_FETCH_TIMEOUT  = 6          # 초
MAX_ALLOWED_STD     = 0.20
REQUIRE_CONSENSUS   = True

_SKIP_CATEGORIES = {"sports", "crypto_price", "entertainment"}

# ── 두 독립 시스템 프롬프트 ──────────────────────────────────────────────────
_SYSTEM_A = (
    "You are a superforecaster. Estimate the YES probability for a prediction market "
    "question based on provided recent news headlines and your knowledge. "
    "Be calibrated: 70% should happen ~70% of the time. "
    "Reply with ONLY a decimal like 0.73, or UNKNOWN if you cannot estimate."
)

_SYSTEM_B = (
    "You are an expert policy and events analyst. "
    "Given recent news context, reason through the causal mechanisms to estimate "
    "whether the stated event will occur. Consider stakeholder incentives and precedents. "
    "Reply with ONLY a decimal like 0.73, or UNKNOWN if you cannot estimate."
)

# ── 캐시 ─────────────────────────────────────────────────────────────────────
# {condition_id: (avg_prob, std, timestamp)}
_cache: dict[str, tuple[float, float, float]] = {}


def _get_cached(condition_id: str) -> Optional[tuple[float, float]]:
    entry = _cache.get(condition_id)
    if entry and (time.time() - entry[2]) < CACHE_TTL_SEC:
        return entry[0], entry[1]
    return None


def _set_cache(condition_id: str, avg: float, std: float) -> None:
    _cache[condition_id] = (avg, std, time.time())


# ── 확률 파싱 ─────────────────────────────────────────────────────────────────

def _extract_probability(text: str) -> Optional[float]:
    text = text.strip()
    for pattern, divisor in [
        (r'\b(0\.\d{1,4})\b', 1),
        (r'\b(\d{1,3})\s*%', 100),
        (r'\b(\d{1,3})\s*/\s*100\b', 100),
        (r'\b(\d{1,3})\b', 100),
    ]:
        m = re.search(pattern, text)
        if m:
            val = float(m.group(1)) / divisor
            if 0.01 <= val <= 0.99:
                return val
    return None


# ── 뉴스 헤드라인 수집 ────────────────────────────────────────────────────────

def _extract_query_terms(question: str) -> str:
    """마켓 질문에서 검색용 키워드 추출 (처음 6단어 + 고유명사)."""
    stop = {
        "will", "the", "a", "an", "in", "on", "at", "by", "for",
        "of", "to", "be", "is", "are", "was", "were", "has", "have",
        "do", "does", "did", "this", "that", "or", "and", "not", "no",
        "any", "more", "than", "before", "after", "between", "with",
    }
    words = re.findall(r'\b[a-zA-Z]{3,}\b', question)
    key_words = [w for w in words if w.lower() not in stop][:6]
    return " ".join(key_words)


async def _fetch_news_headlines(
    question: str,
    session: aiohttp.ClientSession,
) -> list[str]:
    """
    Google News RSS에서 관련 헤드라인 수집.
    무료, API 키 불필요.
    """
    query = _extract_query_terms(question)
    if not query:
        return []

    url = (
        "https://news.google.com/rss/search?"
        f"q={quote_plus(query)}&hl=en-US&gl=US&ceid=US:en"
    )

    try:
        async with session.get(
            url,
            timeout=aiohttp.ClientTimeout(total=NEWS_FETCH_TIMEOUT),
            headers={"User-Agent": "Mozilla/5.0 (compatible; PredictionEdge/1.0)"},
        ) as resp:
            if resp.status != 200:
                return []
            text = await resp.text()

        root = ET.fromstring(text)
        headlines = []
        for item in root.findall(".//item"):
            title_el = item.find("title")
            if title_el is not None and title_el.text:
                # Google News 헤드라인 형식: "Title - Source"
                headline = title_el.text.split(" - ")[0].strip()
                headlines.append(headline)
                if len(headlines) >= NEWS_HEADLINES:
                    break
        return headlines

    except Exception as e:
        log.debug(f"[Claude Oracle] News fetch error: {e}")
        return []


# ── Claude API 단일 쿼리 ──────────────────────────────────────────────────────

async def _query_claude(
    question: str,
    end_date_iso: str,
    headlines: list[str],
    system_prompt: str,
    client,
    semaphore: asyncio.Semaphore,
) -> Optional[float]:
    """뉴스 컨텍스트 포함 단일 Claude 쿼리."""
    news_section = ""
    if headlines:
        news_lines = "\n".join(f"  - {h}" for h in headlines)
        news_section = f"\nRecent news headlines:\n{news_lines}\n"

    user_msg = (
        f"Question: {question}\n"
        f"Resolution date: {end_date_iso}\n"
        f"Today: {time.strftime('%Y-%m-%d')}"
        f"{news_section}\n"
        "Probability (YES):"
    )

    async with semaphore:
        try:
            response = await client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=20,
                system=system_prompt,
                messages=[{"role": "user", "content": user_msg}],
            )
            text = ""
            for block in response.content:
                if block.type == "text":
                    text = block.text.strip()
                    break

            if "UNKNOWN" in text.upper() or not text:
                return None
            return _extract_probability(text)

        except Exception as e:
            log.debug(f"[Claude Oracle] API error: {e}")
            return None


# ── 다중 샘플 추정 ────────────────────────────────────────────────────────────

async def estimate_with_news(
    question: str,
    end_date_iso: str,
    semaphore: asyncio.Semaphore,
    session: aiohttp.ClientSession,
) -> Optional[tuple[float, float, int]]:
    """
    뉴스 컨텍스트 + 2-샘플 추정.
    Returns (avg_prob, std, n_headlines) or None.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None

    try:
        import anthropic
    except ImportError:
        return None

    client = anthropic.AsyncAnthropic(api_key=api_key)

    # 뉴스 수집 + 두 Claude 쿼리 동시 실행
    headlines_task = _fetch_news_headlines(question, session)
    headlines = await headlines_task

    # 두 샘플 병렬 실행
    a_task = _query_claude(question, end_date_iso, headlines, _SYSTEM_A, client, semaphore)
    b_task = _query_claude(question, end_date_iso, headlines, _SYSTEM_B, client, semaphore)
    prob_a, prob_b = await asyncio.gather(a_task, b_task)

    n_headlines = len(headlines)
    log.debug(
        f"[Claude Oracle] '{question[:40]}' "
        f"A={prob_a} B={prob_b} news={n_headlines}개"
    )

    if prob_a is None and prob_b is None:
        return None

    if prob_a is None or prob_b is None:
        single = prob_a if prob_a is not None else prob_b
        return single, 0.15, n_headlines  # 단일 샘플 → std 높음

    avg = (prob_a + prob_b) / 2.0
    std = abs(prob_a - prob_b) / 2.0
    return avg, std, n_headlines


# ── 메인 스캐너 ───────────────────────────────────────────────────────────────

class ClaudeOracleScanner:
    """
    뉴스 컨텍스트 + 2-샘플 Claude 추정 vs Polymarket 가격.

    시그널 생성 조건:
      1. 관련 뉴스 수집 (0개여도 진행, confidence만 낮춤)
      2. 2-샘플 방향 컨센서스 (REQUIRE_CONSENSUS=True)
      3. std < MAX_ALLOWED_STD
      4. net_edge > MIN_EDGE_AFTER_FEES
    """

    def __init__(self, store, signal_bus: asyncio.Queue):
        self._store = store
        self._bus = signal_bus
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        self._enabled = bool(os.getenv("ANTHROPIC_API_KEY", ""))

    async def start(self) -> None:
        if not self._enabled:
            log.warning("[Claude Oracle] Disabled: set ANTHROPIC_API_KEY to enable")
            return

        try:
            import anthropic  # noqa: F401
        except ImportError:
            log.warning("[Claude Oracle] Disabled: pip install anthropic")
            return

        log.info(
            f"[Claude Oracle] Started (news+2-sample) — "
            f"top {TOP_MARKETS} every {SCAN_INTERVAL_SEC//60}min, "
            f"cache {CACHE_TTL_SEC//3600}h"
        )
        while True:
            try:
                await self._scan()
            except Exception as e:
                log.error(f"[Claude Oracle] Scan error: {e}")
            await asyncio.sleep(SCAN_INTERVAL_SEC)

    async def _scan(self) -> None:
        markets = self._store.get_active_markets()
        eligible = [
            m for m in markets
            if m.volume_24h >= MIN_VOLUME_24H
            and m.category.lower() not in _SKIP_CATEGORIES
            and m.days_to_resolution > 0.5
            and m.yes_token is not None
        ]
        eligible.sort(key=lambda m: m.volume_24h, reverse=True)
        eligible = eligible[:TOP_MARKETS]

        if not eligible:
            return

        async with aiohttp.ClientSession() as session:
            tasks = [self._evaluate_market(m, session) for m in eligible]
            results = await asyncio.gather(*tasks, return_exceptions=True)

        signals_generated = 0
        for result in results:
            if isinstance(result, Signal):
                await self._bus.put(result)
                signals_generated += 1

        log.info(
            f"[Claude Oracle] Scanned {len(eligible)} markets → "
            f"{signals_generated} signals"
        )

    async def _evaluate_market(
        self, market, session: aiohttp.ClientSession
    ) -> Optional[Signal]:
        yes_token = market.yes_token
        if not yes_token or yes_token.price <= 0:
            return None

        market_price = yes_token.price
        if market_price > 0.90 or market_price < 0.10:
            return None

        cached = _get_cached(market.condition_id)
        if cached is not None:
            avg_prob, std = cached
            n_headlines = 0  # cached, 뉴스 수 불명
        else:
            result = await estimate_with_news(
                question=market.question,
                end_date_iso=market.end_date_iso,
                semaphore=self._semaphore,
                session=session,
            )
            if result is None:
                return None
            avg_prob, std, n_headlines = result
            _set_cache(market.condition_id, avg_prob, std)

        if std > MAX_ALLOWED_STD:
            return None

        edge = avg_prob - market_price

        if REQUIRE_CONSENSUS and abs(edge) < std * 1.5:
            return None

        if abs(edge) < MIN_EDGE_TO_SIGNAL:
            return None

        # 방향 결정
        if edge > 0:
            token_id = yes_token.token_id
            token_price = market_price
            model_prob = avg_prob
        else:
            no_token = market.no_token
            if not no_token:
                return None
            token_id = no_token.token_id
            token_price = no_token.price
            model_prob = 1.0 - avg_prob
            edge = -edge

        fee_per_dollar = config.TAKER_FEE_RATE * (1 - token_price)
        net_edge = edge - fee_per_dollar

        if net_edge < config.MIN_EDGE_AFTER_FEES:
            return None

        # 신뢰도: 엣지 + 분산 역수 + 뉴스 보너스
        std_penalty = min(std / MAX_ALLOWED_STD, 1.0)
        news_bonus = min(n_headlines / NEWS_HEADLINES * 0.10, 0.10)  # 최대 +10%
        base_conf = min(0.45 + edge * 2.0, 0.80)
        confidence = base_conf * (1.0 - std_penalty * 0.3) + news_bonus

        urgency = "MEDIUM" if edge >= 0.15 and std < 0.08 and n_headlines >= 3 else "LOW"

        signal = Signal(
            signal_id=str(uuid.uuid4()),
            strategy="claude_oracle",
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
            stale_threshold=0.04,
            expires_at=time.time() + 3600,
        )

        log.info(
            f"[Claude Oracle] SIGNAL: {market.question[:50]}"
            f" | mkt={token_price:.2%} model={model_prob:.2%}"
            f" | edge={edge:+.2%} std={std:.2%} news={n_headlines} conf={confidence:.0%}"
        )
        return signal
