"""
Paper Trading Daily Report
--------------------------
Usage:
    python tools/daily_report.py            # today's summary
    python tools/daily_report.py --all      # full 10-day history
    python tools/daily_report.py --live     # current open positions
"""
from __future__ import annotations
import sys
import sqlite3
import json
import time
import os
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import config

DB = config.DB_PATH


def get_conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def fmt_pct(v):
    sign = "+" if v >= 0 else ""
    return f"{sign}{v*100:.2f}%"


def fmt_usd(v):
    sign = "+" if v >= 0 else "-"
    return f"{sign}${abs(v):.2f}"


def daily_pnl_breakdown(conn):
    """P&L per day from closed trades."""
    rows = conn.execute("""
        SELECT date(datetime(timestamp, 'unixepoch')) as day,
               strategy,
               COUNT(*) as trades,
               SUM(pnl) as total_pnl,
               SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
               SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
        FROM trades
        WHERE side = 'BUY' AND pnl IS NOT NULL
        GROUP BY day, strategy
        ORDER BY day, strategy
    """).fetchall()
    return rows


def open_positions(conn):
    """Trades with no pnl yet (still open)."""
    rows = conn.execute("""
        SELECT t.token_id, t.condition_id, t.fill_price, t.size_shares,
               t.strategy, t.timestamp, t.fee_paid
        FROM trades t
        WHERE t.side = 'BUY' AND t.pnl IS NULL
        ORDER BY t.timestamp DESC
    """).fetchall()
    return rows


def lifetime_stats(conn):
    rows = conn.execute("""
        SELECT strategy,
               COUNT(*) as total,
               SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
               SUM(pnl) as total_pnl,
               AVG(pnl) as avg_pnl,
               MIN(pnl) as worst,
               MAX(pnl) as best
        FROM trades
        WHERE side = 'BUY' AND pnl IS NOT NULL
        GROUP BY strategy
        ORDER BY total_pnl DESC
    """).fetchall()
    return rows


def print_header(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


def run():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--today"

    if not os.path.exists(DB):
        print(f"DB not found: {DB}")
        print("Bot hasn't run yet — start it first: venv/Scripts/python.exe main.py")
        return

    conn = get_conn()

    # ── 오픈 포지션 ───────────────────────────────────────────
    print_header("현재 오픈 포지션")
    open_pos = open_positions(conn)
    if open_pos:
        print(f"  {'전략':<20} {'진입가':>7} {'수량':>8} {'비용':>7}  {'보유시간'}")
        print(f"  {'-'*20} {'-'*7} {'-'*8} {'-'*7}  {'-'*10}")
        for p in open_pos:
            held_h = (time.time() - p['timestamp']) / 3600
            cost = p['fill_price'] * p['size_shares'] + p['fee_paid']
            print(f"  {p['strategy']:<20} {p['fill_price']:>7.4f} {p['size_shares']:>8.2f} ${cost:>6.2f}  {held_h:.1f}h")
        print(f"\n  총 {len(open_pos)}개 포지션 오픈")
    else:
        print("  오픈 포지션 없음")

    # ── 전략별 누적 성과 ──────────────────────────────────────
    print_header("전략별 누적 성과")
    stats = lifetime_stats(conn)
    if stats:
        total_pnl = sum(r['total_pnl'] or 0 for r in stats)
        total_trades = sum(r['total'] for r in stats)
        total_wins = sum(r['wins'] for r in stats)

        print(f"  {'전략':<22} {'거래':>5} {'승률':>6} {'누적PnL':>9} {'평균':>8} {'최고':>7} {'최저':>7}")
        print(f"  {'-'*22} {'-'*5} {'-'*6} {'-'*9} {'-'*8} {'-'*7} {'-'*7}")
        for r in stats:
            wr = (r['wins'] / r['total'] * 100) if r['total'] > 0 else 0
            print(
                f"  {r['strategy']:<22} {r['total']:>5} {wr:>5.0f}% "
                f"{fmt_usd(r['total_pnl'] or 0):>9} "
                f"{fmt_usd(r['avg_pnl'] or 0):>8} "
                f"{fmt_usd(r['best'] or 0):>7} "
                f"{fmt_usd(r['worst'] or 0):>7}"
            )
        print(f"\n  합계: {total_trades}건 | 승률 {total_wins/total_trades*100:.0f}% | 총 P&L {fmt_usd(total_pnl)}")

        # 초기 시드 대비 수익률
        try:
            bankroll = float(os.getenv("BANKROLL", "100"))
            roi = total_pnl / bankroll
            print(f"  ROI: {fmt_pct(roi)} (시드 ${bankroll:.0f} 기준)")
        except Exception:
            pass
    else:
        print("  청산된 거래 없음 (포지션 보유 중)")

    # ── 일별 P&L ─────────────────────────────────────────────
    if mode == "--all" or mode == "--today":
        print_header("일별 P&L")
        daily = daily_pnl_breakdown(conn)
        if daily:
            days: dict = {}
            for r in daily:
                d = r['day']
                if d not in days:
                    days[d] = {'trades': 0, 'pnl': 0.0, 'wins': 0, 'losses': 0}
                days[d]['trades']  += r['trades']
                days[d]['pnl']     += r['total_pnl'] or 0
                days[d]['wins']    += r['wins']
                days[d]['losses']  += r['losses']

            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            for day, d in sorted(days.items()):
                marker = " ← 오늘" if day == today else ""
                bar_len = int(abs(d['pnl']) * 50)
                bar = ("█" if d['pnl'] >= 0 else "░") * min(bar_len, 20)
                wr = d['wins'] / d['trades'] * 100 if d['trades'] else 0
                print(f"  {day}: {fmt_usd(d['pnl']):>8} | {d['trades']:>3}건 | 승률 {wr:.0f}%  {bar}{marker}")
        else:
            print("  아직 청산된 거래 없음 (마켓 resolve 되면 여기 표시됨)")

    print(f"\n{'='*60}")
    print(f"  [DB: {DB}]  실행: python tools/daily_report.py --all")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    run()
