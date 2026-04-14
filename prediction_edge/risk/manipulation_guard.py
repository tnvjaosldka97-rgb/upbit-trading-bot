"""
Manipulation Guard — Wash Trading & Orderbook Spoofing Detection.

Two core detectors:

1. WASH TRADING: same-wallet self-trades or coordinated volume inflation
   - maker == taker (obvious self-trade)
   - Repeated identical (price, size) pairs in short window
   - High trade count but low unique-wallet count (sock puppets)

2. ORDERBOOK SPOOFING: large orders placed/cancelled to lure trades
   - Depth oscillation: book depth swings >50% within 60 seconds
   - Ghost walls: large orders appear at best bid/ask then vanish
   - Imbalance flips: bid-heavy → ask-heavy rapidly (painting the tape)

Output: per-market manipulation_score (0.0 = clean, 1.0 = obvious manipulation)
Signals check this score before emitting; risk/limits.py rejects high scores.
"""
from __future__ import annotations
import time
from collections import defaultdict
from dataclasses import dataclass, field
from core.logger import log


# ── Thresholds ─────────────────────────────────────────────────────────────────
WASH_SELF_TRADE_WEIGHT     = 0.40   # maker == taker → instant 0.40 score
WASH_REPEAT_PATTERN_WEIGHT = 0.30   # identical (price, size) trades
WASH_LOW_DIVERSITY_WEIGHT  = 0.30   # few unique wallets for many trades
SPOOF_DEPTH_OSCILLATION_WEIGHT = 0.50  # book depth swings
SPOOF_IMBALANCE_FLIP_WEIGHT    = 0.50  # bid/ask ratio flips

# Score above this → reject signal
MANIPULATION_SCORE_REJECT = 0.45
# Score above this → halve position size
MANIPULATION_SCORE_WARN   = 0.25

# Time windows
WASH_WINDOW_SEC  = 300   # 5 minutes for wash detection
SPOOF_WINDOW_SEC = 120   # 2 minutes for spoof detection
SCORE_DECAY_SEC  = 600   # scores decay over 10 minutes


@dataclass
class TradeRecord:
    timestamp: float
    maker: str
    taker: str
    price: float
    size_usd: float
    token_id: str


@dataclass
class BookSnapshot:
    timestamp: float
    bid_depth: float      # total bid depth in USD (top 5 levels)
    ask_depth: float      # total ask depth in USD (top 5 levels)
    best_bid: float
    best_ask: float


@dataclass
class MarketManipulationState:
    """Per-market manipulation tracking state."""
    trades: list[TradeRecord] = field(default_factory=list)
    book_snapshots: list[BookSnapshot] = field(default_factory=list)
    last_score: float = 0.0
    last_score_time: float = 0.0
    wash_score: float = 0.0
    spoof_score: float = 0.0
    wash_details: str = ""
    spoof_details: str = ""


class ManipulationGuard:
    """
    Central manipulation detection engine.

    Usage:
        guard = ManipulationGuard()

        # Feed trade data (from order_flow polling)
        guard.record_trade(token_id, maker, taker, price, size_usd)

        # Feed orderbook snapshots (from clob_orderbook_poller)
        guard.record_book_snapshot(token_id, bid_depth, ask_depth, best_bid, best_ask)

        # Check before emitting signal
        score = guard.get_score(token_id)
        if score >= MANIPULATION_SCORE_REJECT:
            return None  # skip this signal
    """

    def __init__(self):
        self._states: dict[str, MarketManipulationState] = defaultdict(MarketManipulationState)

    def record_trade(
        self,
        token_id: str,
        maker: str,
        taker: str,
        price: float,
        size_usd: float,
    ):
        """Record a trade for wash trading analysis."""
        state = self._states[token_id]
        now = time.time()

        state.trades.append(TradeRecord(
            timestamp=now,
            maker=maker.lower(),
            taker=taker.lower(),
            price=round(price, 4),
            size_usd=round(size_usd, 2),
            token_id=token_id,
        ))

        # Prune old trades (keep last 10 minutes)
        cutoff = now - WASH_WINDOW_SEC * 2
        state.trades = [t for t in state.trades if t.timestamp > cutoff]

    def record_book_snapshot(
        self,
        token_id: str,
        bid_depth: float,
        ask_depth: float,
        best_bid: float,
        best_ask: float,
    ):
        """Record an orderbook snapshot for spoofing detection."""
        state = self._states[token_id]
        now = time.time()

        state.book_snapshots.append(BookSnapshot(
            timestamp=now,
            bid_depth=bid_depth,
            ask_depth=ask_depth,
            best_bid=best_bid,
            best_ask=best_ask,
        ))

        # Prune old snapshots (keep last 5 minutes)
        cutoff = now - SPOOF_WINDOW_SEC * 3
        state.book_snapshots = [s for s in state.book_snapshots if s.timestamp > cutoff]

    def get_score(self, token_id: str) -> float:
        """
        Get manipulation risk score for a token.
        Returns 0.0 (clean) to 1.0 (obvious manipulation).
        Cached for 30 seconds.
        """
        state = self._states.get(token_id)
        if not state:
            return 0.0

        now = time.time()

        # Use cached score if fresh
        if now - state.last_score_time < 30:
            return state.last_score

        wash = self._compute_wash_score(state, now)
        spoof = self._compute_spoof_score(state, now)

        # Combined score (max of the two — either one is enough to flag)
        combined = max(wash, spoof)

        # Apply time decay from last high score
        if state.last_score > combined and now - state.last_score_time < SCORE_DECAY_SEC:
            elapsed = now - state.last_score_time
            decay = 1.0 - (elapsed / SCORE_DECAY_SEC)
            combined = max(combined, state.last_score * decay)

        state.wash_score = wash
        state.spoof_score = spoof
        state.last_score = combined
        state.last_score_time = now

        if combined >= MANIPULATION_SCORE_WARN:
            log.warning(
                f"[MANIP] {token_id[:12]}... score={combined:.2f} "
                f"(wash={wash:.2f} spoof={spoof:.2f}) "
                f"{state.wash_details} {state.spoof_details}"
            )

        return combined

    def is_rejected(self, token_id: str) -> bool:
        """True if manipulation score is above rejection threshold."""
        return self.get_score(token_id) >= MANIPULATION_SCORE_REJECT

    def should_reduce_size(self, token_id: str) -> bool:
        """True if manipulation score is above warning threshold."""
        score = self.get_score(token_id)
        return MANIPULATION_SCORE_WARN <= score < MANIPULATION_SCORE_REJECT

    def get_report(self) -> list[dict]:
        """Get manipulation report for all tracked tokens (for dashboard)."""
        now = time.time()
        report = []
        for token_id, state in self._states.items():
            if state.last_score < 0.05:
                continue
            report.append({
                "token_id": token_id[:12],
                "score": round(state.last_score, 3),
                "wash": round(state.wash_score, 3),
                "spoof": round(state.spoof_score, 3),
                "wash_detail": state.wash_details,
                "spoof_detail": state.spoof_details,
                "age_sec": round(now - state.last_score_time),
            })
        return sorted(report, key=lambda x: x["score"], reverse=True)[:20]

    # ── Wash Trading Detection ────────────────────────────────────────────────

    def _compute_wash_score(self, state: MarketManipulationState, now: float) -> float:
        recent = [t for t in state.trades if now - t.timestamp < WASH_WINDOW_SEC]
        if len(recent) < 3:
            state.wash_details = ""
            return 0.0

        score = 0.0
        details = []

        # 1. Self-trade detection (maker == taker)
        self_trades = [t for t in recent if t.maker == t.taker and t.maker != ""]
        if self_trades:
            self_ratio = len(self_trades) / len(recent)
            component = min(1.0, self_ratio * 2) * WASH_SELF_TRADE_WEIGHT
            score += component
            details.append(f"self={len(self_trades)}/{len(recent)}")

        # 2. Repeated identical patterns (same price+size = suspicious)
        patterns: dict[tuple, int] = defaultdict(int)
        for t in recent:
            key = (t.price, t.size_usd)
            patterns[key] += 1

        repeated = sum(1 for count in patterns.values() if count >= 3)
        if repeated > 0 and len(recent) > 5:
            repeat_ratio = repeated / len(patterns) if patterns else 0
            component = min(1.0, repeat_ratio * 3) * WASH_REPEAT_PATTERN_WEIGHT
            score += component
            details.append(f"repeat_patterns={repeated}")

        # 3. Low wallet diversity (many trades, few unique wallets)
        unique_wallets = set()
        for t in recent:
            if t.maker:
                unique_wallets.add(t.maker)
            if t.taker:
                unique_wallets.add(t.taker)

        if len(recent) >= 5 and len(unique_wallets) > 0:
            diversity = len(unique_wallets) / len(recent)
            if diversity < 0.3:  # fewer than 30% unique wallets
                component = (1.0 - diversity / 0.3) * WASH_LOW_DIVERSITY_WEIGHT
                score += component
                details.append(f"wallets={len(unique_wallets)}/{len(recent)}trades")

        state.wash_details = " ".join(details)
        return min(1.0, score)

    # ── Orderbook Spoofing Detection ──────────────────────────────────────────

    def _compute_spoof_score(self, state: MarketManipulationState, now: float) -> float:
        recent = [s for s in state.book_snapshots if now - s.timestamp < SPOOF_WINDOW_SEC]
        if len(recent) < 3:
            state.spoof_details = ""
            return 0.0

        score = 0.0
        details = []

        # 1. Depth oscillation: large swings in total depth
        depths = [s.bid_depth + s.ask_depth for s in recent]
        if len(depths) >= 3:
            max_depth = max(depths)
            min_depth = min(depths)

            if max_depth > 0 and min_depth > 0:
                oscillation = (max_depth - min_depth) / max_depth
                if oscillation > 0.50:  # >50% swing in depth
                    component = min(1.0, (oscillation - 0.50) * 4) * SPOOF_DEPTH_OSCILLATION_WEIGHT
                    score += component
                    details.append(f"depth_swing={oscillation:.0%}")

        # 2. Imbalance flips: bid/ask ratio reverses rapidly
        ratios = []
        for s in recent:
            total = s.bid_depth + s.ask_depth
            if total > 0:
                ratios.append(s.bid_depth / total)  # 0.0=all ask, 1.0=all bid

        if len(ratios) >= 3:
            flips = 0
            for i in range(1, len(ratios)):
                # A flip: ratio crosses 0.5 (bid-heavy ↔ ask-heavy)
                if (ratios[i-1] > 0.6 and ratios[i] < 0.4) or \
                   (ratios[i-1] < 0.4 and ratios[i] > 0.6):
                    flips += 1

            if flips >= 2:  # 2+ flips in 2 minutes = suspicious
                component = min(1.0, flips / 4) * SPOOF_IMBALANCE_FLIP_WEIGHT
                score += component
                details.append(f"imbalance_flips={flips}")

        state.spoof_details = " ".join(details)
        return min(1.0, score)


# ── Singleton ─────────────────────────────────────────────────────────────────
_guard: ManipulationGuard | None = None


def get_guard() -> ManipulationGuard:
    """Get or create the global ManipulationGuard instance."""
    global _guard
    if _guard is None:
        _guard = ManipulationGuard()
    return _guard
