"""
SQLite database layer.
Stores: trades, signals (with outcomes for calibration), price history, wallet stats.
"""
import asyncio
import sqlite3
import json
import time
from pathlib import Path
from typing import Optional
import config


_conn: Optional[sqlite3.Connection] = None
_lock = asyncio.Lock()


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _run_migrations(_conn)
    return _conn


def _run_migrations(conn: sqlite3.Connection) -> None:
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS trades (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id    TEXT,
        condition_id TEXT NOT NULL,
        token_id    TEXT NOT NULL,
        side        TEXT NOT NULL,
        fill_price  REAL NOT NULL,
        size_shares REAL NOT NULL,
        fee_paid    REAL NOT NULL,
        strategy    TEXT,
        timestamp   REAL NOT NULL,
        pnl         REAL       -- filled in on close
    );

    CREATE TABLE IF NOT EXISTS signals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id       TEXT UNIQUE,
        strategy        TEXT,
        condition_id    TEXT,
        token_id        TEXT,
        direction       TEXT,
        model_prob      REAL,
        market_prob     REAL,
        net_edge        REAL,
        confidence      REAL,
        created_at      REAL,
        resolved_at     REAL,
        actual_outcome  REAL,   -- 0 or 1, filled when market resolves
        was_correct     INTEGER -- 1/0/NULL
    );

    CREATE TABLE IF NOT EXISTS price_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id    TEXT NOT NULL,
        price       REAL NOT NULL,
        timestamp   REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_stats (
        address     TEXT PRIMARY KEY,
        stats_json  TEXT NOT NULL,
        updated_at  REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oracle_disputes (
        condition_id    TEXT PRIMARY KEY,
        dispute_risk    REAL,
        ambiguity_score REAL,
        updated_at      REAL
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   REAL NOT NULL,
        total_value REAL NOT NULL,
        bankroll    REAL NOT NULL,
        unrealized  REAL NOT NULL,
        realized    REAL NOT NULL,
        positions   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cross_arb_matches (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        poly_condition_id TEXT NOT NULL,
        poly_question   TEXT,
        remote_slug     TEXT NOT NULL,
        remote_title    TEXT,
        remote_platform TEXT NOT NULL,      -- 'limitless' | 'kalshi'
        match_score     REAL NOT NULL,
        poly_price      REAL,
        remote_price    REAL,
        spread          REAL,
        signal_emitted  INTEGER DEFAULT 0,  -- 1 if signal was generated
        timestamp       REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cross_arb_prices (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        poly_condition_id TEXT NOT NULL,
        remote_slug     TEXT NOT NULL,
        remote_platform TEXT NOT NULL,
        poly_price      REAL NOT NULL,
        remote_bid      REAL NOT NULL,
        remote_ask      REAL NOT NULL,
        remote_mid      REAL NOT NULL,
        spread          REAL NOT NULL,
        timestamp       REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON portfolio_snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_price_history_token ON price_history(token_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy, created_at);
    CREATE INDEX IF NOT EXISTS idx_trades_condition ON trades(condition_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_cross_matches_ts ON cross_arb_matches(timestamp);
    CREATE INDEX IF NOT EXISTS idx_cross_prices_ts ON cross_arb_prices(poly_condition_id, timestamp);
    """)
    conn.commit()


def insert_trade(order_id: str, condition_id: str, token_id: str,
                 side: str, fill_price: float, size_shares: float,
                 fee_paid: float, strategy: str) -> int:
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO trades
           (order_id, condition_id, token_id, side, fill_price, size_shares,
            fee_paid, strategy, timestamp)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (order_id, condition_id, token_id, side, fill_price, size_shares,
         fee_paid, strategy, time.time())
    )
    conn.commit()
    return cur.lastrowid


def insert_signal(signal) -> None:
    """Store signal for later calibration tracking."""
    conn = get_conn()
    conn.execute(
        """INSERT OR REPLACE INTO signals
           (signal_id, strategy, condition_id, token_id, direction,
            model_prob, market_prob, net_edge, confidence, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (signal.signal_id, signal.strategy, signal.condition_id,
         signal.token_id, signal.direction, signal.model_prob,
         signal.market_prob, signal.net_edge, signal.confidence,
         signal.created_at)
    )
    conn.commit()


def record_price(token_id: str, price: float) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO price_history (token_id, price, timestamp) VALUES (?,?,?)",
        (token_id, price, time.time())
    )
    conn.commit()


# ── 전략별 사전확률 (Bayesian priors) ────────────────────────────────────────
# 근거: Polymarket 실증 연구 및 전략 특성 기반
# prior_n: 사전 지식의 가중치 (트레이드 수 단위)
# higher prior_n = 실제 데이터가 더 많아야 prior 영향 감소
_STRATEGY_PRIORS: dict[str, dict] = {
    # fee_arb: p>0.95 시장은 매우 잘 calibrated. calib_error 낮게.
    "fee_arbitrage":       {"accuracy": 0.97,  "calib_error": 0.01, "n": 30},
    # oracle: 분쟁 낮은 마켓 수렴 — 높은 정확도, 약간 오차
    "oracle_convergence":  {"accuracy": 0.93,  "calib_error": 0.02, "n": 20},
    # closing_conv: 만료 임박 마켓 — 중간 정확도
    "closing_convergence": {"accuracy": 0.66,  "calib_error": 0.06, "n": 20},
    # order_flow: 고래 따라가기 — 노이즈 많음
    "order_flow":          {"accuracy": 0.55,  "calib_error": 0.08, "n": 10},
    # cross_platform: Kalshi 차익거래
    "cross_platform":      {"accuracy": 0.70,  "calib_error": 0.05, "n": 15},
    # limitless_arb: Limitless vs Polymarket — 동일 구조 CLOB 차익
    "limitless_arb":       {"accuracy": 0.68,  "calib_error": 0.06, "n": 15},
    # correlated_arb: 상관관계 기반
    "correlated_arb":      {"accuracy": 0.63,  "calib_error": 0.07, "n": 15},
    # claude_oracle: 백테스트 Brier=0.499 (랜덤 이하) → 사실상 비활성화 수준
    # calib_error 0.30 → shrinkage 60% → model_prob 거의 0.5로 수렴 → Kelly ≈ $0
    # 라이브 캘리브레이션 데이터가 이걸 개선할 때까지 관찰 모드
    "claude_oracle":       {"accuracy": 0.50,  "calib_error": 0.30, "n": 3},
    # base_rate: 백테스트 미실행, 보수적 유지
    "base_rate":           {"accuracy": 0.55,  "calib_error": 0.18, "n": 5},
}
_DEFAULT_PRIOR = {"accuracy": 0.60, "calib_error": 0.05, "n": 10}


def get_calibration_stats(strategy: str) -> dict:
    """
    전략의 캘리브레이션 데이터 반환.
    Kelly sizing에서 모델 신뢰도 측정에 사용.

    Bayesian blend: 실제 데이터가 쌓이기 전 전략별 사전확률(prior) 적용.
    - 실제 트레이드 0개: prior만 사용
    - 실제 트레이드 증가: prior 영향 감소, 실제 데이터 영향 증가
    - 100+ 트레이드: 거의 실제 데이터만 사용
    """
    conn = get_conn()
    rows = conn.execute(
        """SELECT model_prob, was_correct
           FROM signals
           WHERE strategy = ? AND was_correct IS NOT NULL
           ORDER BY created_at DESC LIMIT 1000""",
        (strategy,)
    ).fetchall()

    prior = _STRATEGY_PRIORS.get(strategy, _DEFAULT_PRIOR)
    n_prior = prior["n"]

    if not rows:
        # Cold-start: prior만 사용 (strategy 특성 반영)
        return {
            "count": 0,
            "accuracy": prior["accuracy"],
            "calibration_error": prior["calib_error"],
            "is_prior": True,
        }

    n_actual = len(rows)
    correct = sum(1 for r in rows if r["was_correct"] == 1)
    avg_model_prob = sum(r["model_prob"] for r in rows) / n_actual

    # Bayesian blend: weighted average of prior and actual
    # 실제 데이터가 많을수록 prior 영향 감소
    blend_weight = n_prior / (n_prior + n_actual)  # 0→1, 실제 많을수록 0에 가까워짐
    blended_accuracy = (
        prior["accuracy"] * blend_weight +
        (correct / n_actual) * (1 - blend_weight)
    )
    blended_calib_error = (
        prior["calib_error"] * blend_weight +
        abs((correct / n_actual) - avg_model_prob) * (1 - blend_weight)
    )
    # Cap at 0.3 — even a bad model shouldn't fully collapse bets
    blended_calib_error = min(blended_calib_error, 0.30)

    return {
        "count": n_actual,
        "accuracy": blended_accuracy,
        "calibration_error": blended_calib_error,
        "is_prior": blend_weight > 0.5,  # still mostly prior-driven
    }


def insert_cross_arb_match(
    poly_condition_id: str, poly_question: str,
    remote_slug: str, remote_title: str, remote_platform: str,
    match_score: float, poly_price: float, remote_price: float,
    spread: float, signal_emitted: bool,
) -> None:
    """Log every cross-platform match for audit trail."""
    conn = get_conn()
    conn.execute(
        """INSERT INTO cross_arb_matches
           (poly_condition_id, poly_question, remote_slug, remote_title,
            remote_platform, match_score, poly_price, remote_price,
            spread, signal_emitted, timestamp)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (poly_condition_id, poly_question, remote_slug, remote_title,
         remote_platform, match_score, poly_price, remote_price,
         spread, 1 if signal_emitted else 0, time.time())
    )
    conn.commit()


def insert_cross_arb_price(
    poly_condition_id: str, remote_slug: str, remote_platform: str,
    poly_price: float, remote_bid: float, remote_ask: float,
    remote_mid: float, spread: float,
) -> None:
    """Log cross-platform price snapshot for convergence analysis."""
    conn = get_conn()
    conn.execute(
        """INSERT INTO cross_arb_prices
           (poly_condition_id, remote_slug, remote_platform,
            poly_price, remote_bid, remote_ask, remote_mid, spread, timestamp)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (poly_condition_id, remote_slug, remote_platform,
         poly_price, remote_bid, remote_ask, remote_mid, spread, time.time())
    )
    conn.commit()


def get_cross_arb_convergence(poly_condition_id: str, hours: int = 24) -> list:
    """Get price convergence history for a cross-arb pair."""
    conn = get_conn()
    cutoff = time.time() - hours * 3600
    return conn.execute(
        """SELECT poly_price, remote_mid, spread, timestamp
           FROM cross_arb_prices
           WHERE poly_condition_id = ? AND timestamp > ?
           ORDER BY timestamp ASC""",
        (poly_condition_id, cutoff)
    ).fetchall()


def update_pnl_for_token(token_id: str, pnl: float) -> None:
    """Record realized PnL on the most recent open buy trade for a token."""
    conn = get_conn()
    row = conn.execute(
        "SELECT id FROM trades WHERE token_id = ? AND side = 'BUY' AND pnl IS NULL ORDER BY timestamp DESC LIMIT 1",
        (token_id,)
    ).fetchone()
    if row:
        conn.execute("UPDATE trades SET pnl = ? WHERE id = ?", (pnl, row["id"]))
        conn.commit()


def get_recent_trade_returns(limit: int = 50) -> list[float]:
    """Return recent closed-trade returns as fractions of cost basis."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT pnl, fill_price, size_shares FROM trades WHERE pnl IS NOT NULL AND side = 'BUY' ORDER BY timestamp DESC LIMIT ?",
        (limit,)
    ).fetchall()
    result = []
    for r in rows:
        cost = r["fill_price"] * r["size_shares"]
        if cost > 0:
            result.append(r["pnl"] / cost)
    return result


def insert_snapshot(total_value: float, bankroll: float, unrealized: float, realized: float, positions: int) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO portfolio_snapshots (timestamp, total_value, bankroll, unrealized, realized, positions) VALUES (?,?,?,?,?,?)",
        (time.time(), total_value, bankroll, unrealized, realized, positions)
    )
    conn.commit()


def get_snapshots(limit: int = 2000) -> list:
    conn = get_conn()
    return conn.execute(
        "SELECT timestamp, total_value, bankroll, unrealized, realized, positions FROM portfolio_snapshots ORDER BY timestamp ASC"
    ).fetchall()


def upsert_wallet_stats(address: str, stats: dict) -> None:
    conn = get_conn()
    conn.execute(
        """INSERT OR REPLACE INTO wallet_stats (address, stats_json, updated_at)
           VALUES (?,?,?)""",
        (address, json.dumps(stats), time.time())
    )
    conn.commit()


def get_top_wallets(min_sharpe: float, limit: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT address, stats_json FROM wallet_stats WHERE updated_at > ?",
        (time.time() - 86400 * 7,)  # only wallets updated in last 7 days
    ).fetchall()

    wallets = []
    for row in rows:
        stats = json.loads(row["stats_json"])
        if stats.get("sharpe_ratio", 0) >= min_sharpe:
            stats["address"] = row["address"]
            wallets.append(stats)

    wallets.sort(key=lambda x: x.get("sharpe_ratio", 0), reverse=True)
    return wallets[:limit]
