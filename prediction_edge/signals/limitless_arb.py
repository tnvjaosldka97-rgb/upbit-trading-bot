"""
Limitless Exchange × Polymarket Cross-Platform Arbitrage.

Limitless is a Polymarket fork on Base chain with its own CLOB.
Same events, different user bases, different prices.

IMPORTANT DESIGN DECISIONS:
  1. Match quality: Jaccard alone is insufficient (BTC $100k vs $90k both match).
     We extract numeric thresholds, dates, and entity names as HARD constraints.
     Two markets must agree on ALL extracted constraints to be considered a match.

  2. One-legged vs two-legged:
     - Without Limitless API key: signal-only mode (directional, NOT arb).
       Confidence is reduced and sized conservatively via Kelly shrinkage.
     - With API key: true two-legged arb (buy cheap side, sell expensive side).

  3. Fee model: Both Polymarket taker fee AND Limitless dynamic fee are deducted.
     Limitless fee ranges 0.03% → 3% based on time to resolution.
     We use a conservative 2% estimate unless we can fetch the actual rate.

  4. Liquidity filter: Limitless markets with < $5k volume are ignored.
     Thin markets have unreliable prices and execution risk.

  5. Spread validation: If Limitless bid-ask spread > gross edge, skip.
     Can't capture edge if spread eats it.
"""
from __future__ import annotations
import asyncio
import re
import time
import uuid
from dataclasses import dataclass
from typing import Optional
import httpx
import config
from core.models import Market, Signal, PortfolioState
from core.logger import log
from core import db


_SCAN_INTERVAL_SEC    = 90
_MIN_SIMILARITY       = 0.50    # raised from 0.42 — fewer false matches
_MIN_EDGE_THRESHOLD   = 0.04    # 4% minimum net edge (after BOTH platform fees)
_COOLDOWN_SEC         = 1800
_MIN_LIMITLESS_VOLUME = 5000    # $5k minimum volume to trust prices
_MAX_SPREAD_TO_EDGE   = 0.8     # skip if spread > 80% of gross edge
_LIMITLESS_FEE_EST    = 0.02    # conservative 2% fee estimate for Limitless side
_API_BASE             = config.LIMITLESS_API_BASE


# ── Semantic matching with hard constraints ──────────────────────────────────

_STOPWORDS = frozenset({
    "will", "the", "a", "an", "in", "on", "by", "to", "of", "be",
    "is", "are", "does", "do", "for", "at", "or", "and", "win",
    "before", "after", "more", "less", "than", "end",
    "above", "below", "over", "under", "reach", "exceed", "hit",
    "dollar", "dollars", "usd", "price", "go", "get",
})

# Patterns to extract hard constraints from questions
# Match numbers with optional suffix DIRECTLY attached (no space)
# "100k" matches, but "500 by" does NOT capture "b" as suffix
_NUMBER_RE = re.compile(r"[\$]?([\d,]+(?:\.\d+)?)([kKmMbB])?(?=[\s,;.?!)\]]|$)")
_DATE_RE   = re.compile(
    r"(?:january|february|march|april|may|june|july|august|september|"
    r"october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)"
    r"[\s,]*\d{0,2}[\s,]*\d{4}",
    re.IGNORECASE,
)
_YEAR_RE   = re.compile(r"\b(20\d{2})\b")

# Common abbreviation → canonical form mapping for matching
_SYNONYMS = {
    "btc": "bitcoin", "eth": "ethereum", "sol": "solana",
    "xrp": "ripple", "doge": "dogecoin", "ada": "cardano",
    "trump": "trump", "biden": "biden", "fed": "federal reserve",
    "gdp": "gross domestic product", "cpi": "consumer price index",
}


@dataclass(frozen=True)
class _MatchConstraints:
    """Hard constraints extracted from a market question."""
    numbers: frozenset[str]     # normalized numbers (e.g., "100000", "50")
    dates: frozenset[str]       # normalized date strings
    years: frozenset[str]       # standalone years


def _extract_constraints(text: str) -> _MatchConstraints:
    # Extract years first so we can exclude them from numbers
    years = {m.group() for m in _YEAR_RE.finditer(text)}

    numbers = set()
    for m in _NUMBER_RE.finditer(text):
        raw = m.group(1).replace(",", "")
        suffix = m.group(2) or ""
        try:
            val = float(raw)
        except ValueError:
            continue
        # Skip years (2020-2035) — tracked separately
        if 2020 <= val <= 2035:
            continue
        # Skip tiny numbers that are likely noise
        if val < 10:
            continue
        # Apply suffix multipliers (only if directly attached)
        if suffix.lower() == "k":
            val *= 1000
        elif suffix.lower() == "m":
            val *= 1_000_000
        elif suffix.lower() == "b":
            val *= 1_000_000_000
        numbers.add(str(int(val)) if val == int(val) else f"{val:.2f}")

    dates = {m.group().lower().strip() for m in _DATE_RE.finditer(text)}

    return _MatchConstraints(
        numbers=frozenset(numbers),
        dates=frozenset(dates),
        years=frozenset(years),
    )


def _tokenize(text: str) -> set[str]:
    words = set(re.findall(r"[a-z][a-z0-9]*", text.lower()))
    words -= _STOPWORDS
    # Expand synonyms: "btc" → also add "bitcoin" (and vice versa)
    expanded = set(words)
    reverse_syn = {}
    for abbr, full in _SYNONYMS.items():
        reverse_syn[full] = abbr
    for w in words:
        if w in _SYNONYMS:
            expanded.add(_SYNONYMS[w])
        if w in reverse_syn:
            expanded.add(reverse_syn[w])
    return expanded


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _is_safe_match(poly_q: str, limitless_title: str) -> tuple[bool, float]:
    """
    Two-stage matching:
      1. Hard constraint check: numbers, dates, years must match
      2. Jaccard similarity on remaining keywords

    Returns (is_match, similarity_score).
    """
    c1 = _extract_constraints(poly_q)
    c2 = _extract_constraints(limitless_title)

    # Hard constraint: if both have numbers, they must overlap
    if c1.numbers and c2.numbers and not (c1.numbers & c2.numbers):
        return False, 0.0

    # Hard constraint: if both have years, they must overlap
    if c1.years and c2.years and not (c1.years & c2.years):
        return False, 0.0

    # Hard constraint: if both have dates, they must overlap
    if c1.dates and c2.dates and not (c1.dates & c2.dates):
        return False, 0.0

    # Jaccard on keywords
    w1 = _tokenize(poly_q)
    w2 = _tokenize(limitless_title)
    sim = _jaccard(w1, w2)

    # Bonus for exact constraint matches
    constraint_bonus = 0.0
    if c1.numbers and c1.numbers == c2.numbers:
        constraint_bonus += 0.05
    if c1.years and c1.years == c2.years:
        constraint_bonus += 0.03

    total = sim + constraint_bonus
    return total >= _MIN_SIMILARITY, total


# ── Limitless API ────────────────────────────────────────────────────────────

async def _fetch_limitless_markets(client: httpx.AsyncClient) -> list[dict]:
    """Fetch active CLOB markets from Limitless. Public, no auth."""
    try:
        resp = await client.get(
            f"{_API_BASE}/markets/active",
            params={"limit": 200, "tradeType": "clob"},
        )
        if resp.status_code == 429:
            log.debug("[LIMITLESS] Rate limited, backing off")
            return []
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list):
            data = data.get("markets", []) if isinstance(data, dict) else []

        result = []
        for m in data:
            slug = m.get("slug", "") or m.get("address", "")
            title = m.get("title", "") or m.get("question", "")
            if not slug or not title:
                continue

            # Volume filter: skip illiquid markets
            volume = float(m.get("volumeNum", 0) or m.get("volume", 0) or 0)
            if volume < _MIN_LIMITLESS_VOLUME:
                continue

            # Price extraction with explicit format handling
            prices = m.get("prices", [])
            if isinstance(prices, list) and len(prices) >= 2:
                yes_price = float(prices[0])
                no_price = float(prices[1])
                # Limitless API returns prices as numbers 0-100 (cents)
                # Validate: YES + NO should sum near 100 (cents) or near 1.0 (decimal)
                total = yes_price + no_price
                if 80 < total < 120:
                    # Cents format
                    yes_price /= 100
                    no_price /= 100
                elif 0.8 < total < 1.2:
                    pass  # already decimal
                else:
                    continue  # invalid prices, skip
            else:
                continue  # no price data

            if yes_price <= 0.03 or yes_price >= 0.97:
                continue

            result.append({
                "slug": slug,
                "title": title,
                "yes_price": yes_price,
                "no_price": no_price,
                "volume": volume,
            })

        return result

    except httpx.HTTPStatusError as e:
        log.debug(f"[LIMITLESS] HTTP {e.response.status_code}: {e.response.text[:80]}")
        return []
    except Exception as e:
        log.debug(f"[LIMITLESS] Fetch error: {e}")
        return []


async def _fetch_limitless_orderbook(
    client: httpx.AsyncClient, slug: str
) -> Optional[dict]:
    """Fetch orderbook. Returns {best_bid, best_ask, mid, spread} or None."""
    try:
        resp = await client.get(f"{_API_BASE}/markets/{slug}/orderbook")
        if resp.status_code != 200:
            return None
        data = resp.json()

        bids = data.get("bids", [])
        asks = data.get("asks", [])
        if not bids or not asks:
            return None  # no two-sided book → unreliable

        best_bid = float(bids[0]["price"])
        best_ask = float(asks[0]["price"])

        # Normalize using same YES+NO validation approach
        # If bid > 1 → cents
        if best_bid > 1:
            best_bid /= 100
        if best_ask > 1:
            best_ask /= 100

        # Sanity: ask should be > bid
        if best_ask <= best_bid:
            return None

        spread = best_ask - best_bid

        mid = float(data.get("adjustedMidpoint", 0) or data.get("lastTradePrice", 0))
        if mid > 1:
            mid /= 100
        if mid <= 0:
            mid = (best_bid + best_ask) / 2

        return {
            "best_bid": best_bid,
            "best_ask": best_ask,
            "mid": mid,
            "spread": spread,
        }

    except Exception:
        return None


# ── Matching ─────────────────────────────────────────────────────────────────

def _match_poly_to_limitless(
    poly_market: Market,
    limitless_markets: list[dict],
) -> Optional[tuple[dict, float]]:
    """
    Find best-matching Limitless market.
    Returns (market_dict, match_score) or None.
    Does NOT mutate the limitless market dict.
    """
    poly_q = poly_market.question
    if len(_tokenize(poly_q)) < 3:
        return None

    best_score = 0.0
    best_match = None

    for lm in limitless_markets:
        is_match, score = _is_safe_match(poly_q, lm["title"])
        if is_match and score > best_score:
            best_score = score
            best_match = lm

    if best_match:
        return best_match, best_score
    return None


# ── Signal generation ────────────────────────────────────────────────────────

def _build_arb_signal(
    poly_market: Market,
    poly_price: float,
    limitless_price: float,     # bid for BUY signal, ask for SELL signal
    limitless_spread: float,
    match_score: float,
    is_hedged: bool,
    direction: str = "BUY",
) -> Optional[Signal]:
    """
    Build BUY or SELL signal with BOTH platform fees deducted.

    BUY: Limitless bid > Polymarket ask → buy on Poly (cheaper)
    SELL: Polymarket bid > Limitless ask → sell on Poly (overpriced)

    For hedged: both platform fees deducted → locked-in profit.
    For unhedged: only Poly fee → directional bet with reduced confidence.
    """
    yes = poly_market.yes_token
    if not yes:
        return None

    if poly_market.dispute_risk > config.ORACLE_DISPUTE_THRESHOLD_SKIP:
        return None

    # Fee calculation depends on direction
    if direction == "BUY":
        poly_fee = config.TAKER_FEE_RATE * (1 - poly_price)
        gross_edge = limitless_price - poly_price
        lm_fee = _LIMITLESS_FEE_EST * (1 - limitless_price) if is_hedged else 0
    else:  # SELL
        poly_fee = config.TAKER_FEE_RATE * (1 - poly_price)
        gross_edge = poly_price - limitless_price
        lm_fee = _LIMITLESS_FEE_EST * (1 - limitless_price) if is_hedged else 0

    net_edge = gross_edge - poly_fee - lm_fee

    if net_edge < _MIN_EDGE_THRESHOLD:
        return None

    # Spread sanity: if Limitless spread > 80% of gross edge, arb is fragile
    if limitless_spread > 0 and limitless_spread > gross_edge * _MAX_SPREAD_TO_EDGE:
        return None

    # Confidence: hedged >> unhedged
    if is_hedged:
        confidence = min(0.90, 0.5 + match_score * 0.3 + net_edge * 2)
    else:
        confidence = min(0.60, 0.2 + match_score * 0.2 + net_edge * 1.5)

    if net_edge > 0.10:
        urgency = "HIGH"
    elif net_edge > 0.06:
        urgency = "MEDIUM"
    else:
        urgency = "LOW"

    model_prob = (
        min(0.99, poly_price + net_edge) if direction == "BUY"
        else max(0.01, poly_price - net_edge)
    )

    return Signal(
        signal_id=str(uuid.uuid4()),
        strategy="limitless_arb",
        condition_id=poly_market.condition_id,
        token_id=yes.token_id,
        direction=direction,
        model_prob=model_prob,
        market_prob=poly_price,
        edge=gross_edge,
        net_edge=net_edge,
        confidence=confidence,
        urgency=urgency,
        created_at=time.time(),
        expires_at=time.time() + 1800,
        stale_price=poly_price,
        stale_threshold=net_edge * 0.5,
    )


# ── Scanner ──────────────────────────────────────────────────────────────────

class LimitlessArbScanner:
    """
    Scans for Limitless vs Polymarket price divergences.
    - BUY: Limitless bid > Poly ask → buy on Poly
    - SELL: Poly bid > Limitless ask → sell existing Poly position
    - All matches + prices logged to DB for audit trail
    - With LIMITLESS_PRIVATE_KEY: places hedge orders on Limitless for true arb
    """

    def __init__(self, store, signal_bus: asyncio.Queue, portfolio: PortfolioState = None):
        self._store = store
        self._bus = signal_bus
        self._portfolio = portfolio
        self._running = False
        self._emitted: dict[str, float] = {}
        self._match_cache: dict[str, Optional[tuple[dict, float]]] = {}
        self._cache_time = 0.0
        self._client: Optional[httpx.AsyncClient] = None
        self._hedge_client = None   # LimitlessHedgeClient (initialized in start)
        self._hedge_enabled = bool(config.LIMITLESS_PRIVATE_KEY)

    async def start(self):
        self._running = True

        # Initialize hedge client if private key is available
        if self._hedge_enabled:
            try:
                from execution.limitless_hedge import LimitlessHedgeClient
                self._hedge_client = LimitlessHedgeClient()
                if self._hedge_client.is_available:
                    ok = await self._hedge_client.initialize()
                    if not ok:
                        log.warning("[LIMITLESS ARB] Hedge client init failed — falling back to signal-only")
                        self._hedge_enabled = False
                        self._hedge_client = None
                else:
                    log.warning("[LIMITLESS ARB] eth_account not installed — signal-only mode")
                    self._hedge_enabled = False
                    self._hedge_client = None
            except Exception as e:
                log.warning(f"[LIMITLESS ARB] Hedge client error: {e} — signal-only mode")
                self._hedge_enabled = False
                self._hedge_client = None

        mode = "HEDGE mode (true arb)" if self._hedge_enabled else "SIGNAL-ONLY (no hedge)"
        log.info(f"[LIMITLESS ARB] Starting — {mode}")

        self._client = httpx.AsyncClient(timeout=12)

        try:
            test = await _fetch_limitless_markets(self._client)
            if not test:
                log.warning("[LIMITLESS ARB] Could not reach Limitless API — will retry")
            else:
                log.info(f"[LIMITLESS ARB] Connected — {len(test)} CLOB markets (vol > ${_MIN_LIMITLESS_VOLUME})")

            while self._running:
                try:
                    await self._scan()
                except Exception as e:
                    log.error(f"[LIMITLESS ARB] Scan error: {e}")
                await asyncio.sleep(_SCAN_INTERVAL_SEC)
        finally:
            await self._client.aclose()
            if self._hedge_client:
                await self._hedge_client.close()

    async def _scan(self):
        now = time.time()
        client = self._client
        if not client:
            return

        limitless_markets = await _fetch_limitless_markets(client)
        if not limitless_markets:
            return

        poly_markets = self._store.get_active_markets()
        if not poly_markets:
            return

        # Rebuild match cache every 30 minutes
        if now - self._cache_time > 1800:
            self._match_cache.clear()
            self._cache_time = now

        # Prune old emitted entries
        if len(self._emitted) > 1000:
            cutoff = now - _COOLDOWN_SEC * 2
            self._emitted = {k: v for k, v in self._emitted.items() if v > cutoff}

        signals_generated = 0

        for poly in poly_markets:
            if not poly.active:
                continue

            cid = poly.condition_id

            if now - self._emitted.get(cid, 0) < _COOLDOWN_SEC:
                continue

            yes = poly.yes_token
            if not yes or yes.price <= 0:
                continue
            if yes.price < 0.04 or yes.price > 0.96:
                continue

            # Match (cached)
            if cid not in self._match_cache:
                self._match_cache[cid] = _match_poly_to_limitless(
                    poly, limitless_markets
                )

            match_result = self._match_cache[cid]
            if not match_result:
                continue

            match, match_score = match_result

            # Rate limit compliance
            await asyncio.sleep(0.35)

            # Fetch Limitless orderbook
            book = await _fetch_limitless_orderbook(client, match["slug"])
            if not book or book["best_bid"] <= 0:
                continue

            lm_bid = book["best_bid"]
            lm_ask = book["best_ask"]
            lm_mid = book["mid"]
            lm_spread = book["spread"]

            # Polymarket prices
            poly_book = self._store.get_orderbook(yes.token_id)
            poly_ask = (
                poly_book.best_ask
                if poly_book and poly_book.best_ask > 0
                else yes.price + 0.01
            )
            poly_bid = (
                poly_book.best_bid
                if poly_book and poly_book.best_bid > 0
                else yes.price - 0.01
            )

            # ── Record price snapshot for convergence analysis ────────────
            try:
                db.insert_cross_arb_price(
                    poly_condition_id=cid,
                    remote_slug=match["slug"],
                    remote_platform="limitless",
                    poly_price=yes.price,
                    remote_bid=lm_bid,
                    remote_ask=lm_ask,
                    remote_mid=lm_mid,
                    spread=lm_spread,
                )
            except Exception:
                pass

            # ── Direction 1: BUY on Poly (Limitless bid > Poly ask) ───────
            signal = None
            if lm_bid > poly_ask:
                signal = _build_arb_signal(
                    poly, poly_ask, lm_bid, lm_spread,
                    match_score, is_hedged=self._hedge_enabled,
                    direction="BUY",
                )

            # ── Direction 2: SELL on Poly (Poly bid > Limitless ask) ──────
            # Only if we hold a position in this token
            if not signal and self._portfolio and poly_bid > lm_ask:
                if yes.token_id in self._portfolio.positions:
                    signal = _build_arb_signal(
                        poly, poly_bid, lm_ask, lm_spread,
                        match_score, is_hedged=self._hedge_enabled,
                        direction="SELL",
                    )

            # ── Log match to audit trail ──────────────────────────────────
            if signal:
                try:
                    db.insert_cross_arb_match(
                        poly_condition_id=cid,
                        poly_question=poly.question[:100],
                        remote_slug=match["slug"],
                        remote_title=match["title"][:100],
                        remote_platform="limitless",
                        match_score=match_score,
                        poly_price=yes.price,
                        remote_price=lm_mid,
                        spread=lm_spread,
                        signal_emitted=True,
                    )
                except Exception:
                    pass

                direction_str = signal.direction
                hedge_str = "HEDGED" if self._hedge_enabled else "SIGNAL"
                log.info(
                    f"[LIMITLESS ARB] {hedge_str} {direction_str} "
                    f"{poly.question[:45]}\n"
                    f"  LM bid={lm_bid:.3f} ask={lm_ask:.3f} spread={lm_spread:.3f}\n"
                    f"  Poly bid={poly_bid:.3f} ask={poly_ask:.3f}\n"
                    f"  net_edge={signal.net_edge:.2%} conf={signal.confidence:.2f} "
                    f"match={match_score:.2f} slug={match['slug']}"
                )
                await self._bus.put(signal)
                self._emitted[cid] = now
                signals_generated += 1

        if signals_generated:
            log.info(f"[LIMITLESS ARB] {signals_generated} arb signal(s) this scan")

    def stop(self):
        self._running = False
