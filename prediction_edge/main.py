"""
Prediction Edge — Main Orchestrator

Startup order:
  1. DB + config validation
  2. Market store (warm from REST)
  3. WebSocket real-time data
  4. All signal generators
  5. Signal aggregator (dedup + ensemble)
  6. Calibration tracker (feedback loop)
  7. Execution gateway
  8. Dashboard

Architecture:
  raw_signal_bus  → signal_aggregator → exec_signal_bus → process_signals → gateway
  orderbook_bus   → market_store (updated live via WebSocket)
  fill_bus        → portfolio state update
  calibration     → DB (outcome recording, Kelly improvement)
"""
import asyncio
import os
import time
from core.db import get_conn
from core.logger import log
from core.models import PortfolioState
from core.calibration import CalibrationTracker
from data.market_store import MarketStore
from data.polymarket_rest import fetch_active_markets
from data.polymarket_ws import start_websocket_manager
from dashboard.web_server import start as start_dashboard
from data.onchain_watcher import OnChainWatcher, build_wallet_database
from signals.oracle_monitor import OracleMonitor, score_oracle_dispute_risk
from signals.fee_arbitrage import FeeArbitrageScanner
from signals.closing_convergence import ClosingConvergenceScanner
from signals.order_flow import OrderFlowMonitor
from signals.correlated_arb import CorrelatedArbScanner
from signals.signal_aggregator import SignalAggregator
from signals.relation_builder import RelationGraphManager
from execution.gateway import ExecutionGateway
from execution.reconciler import PositionReconciler
from sizing.kelly import compute_kelly
from core.models import Order, AggregatedSignal, Signal
import config


async def market_refresh_loop(store: MarketStore):
    """REST market refresh every 60s (WebSocket handles real-time updates)."""
    while True:
        try:
            markets = await fetch_active_markets(limit=500)
            for m in markets:
                m.dispute_risk = score_oracle_dispute_risk(m)
            await store.update_markets(markets)
            log.info(f"[REST] Market store refreshed: {len(markets)} markets")
        except Exception as e:
            log.error(f"Market refresh error: {e}")
        await asyncio.sleep(60)


async def process_aggregated_signals(
    exec_bus: asyncio.Queue,
    store: MarketStore,
    gateway: ExecutionGateway,
    portfolio: PortfolioState,
):
    """
    Consume AggregatedSignals from the aggregator and execute them.
    This is the final execution loop — only aggregated, deduped signals arrive here.
    """
    while True:
        try:
            item = await asyncio.wait_for(exec_bus.get(), timeout=1.0)
        except asyncio.TimeoutError:
            continue

        # Handle both AggregatedSignal and raw Signal (from direct paths)
        if isinstance(item, AggregatedSignal):
            condition_id = item.condition_id
            token_id = item.token_id
            direction = item.direction
            confidence = item.composite_confidence
            net_edge = item.best_net_edge
            urgency = item.urgency
            strategy = item.contributing_signals[0].strategy if item.contributing_signals else "unknown"
            model_prob = item.contributing_signals[0].model_prob if item.contributing_signals else 0.5
            signal = item.contributing_signals[0] if item.contributing_signals else None
        elif isinstance(item, Signal):
            condition_id = item.condition_id
            token_id = item.token_id
            direction = item.direction
            confidence = item.confidence
            net_edge = item.net_edge
            urgency = item.urgency
            strategy = item.strategy
            model_prob = item.model_prob
            signal = item
        else:
            continue

        # Find market and current price
        market = store.get_market(condition_id)
        token = None
        current_price = 0.0
        if market:
            for t in market.tokens:
                if t.token_id == token_id:
                    token = t
                    current_price = t.price
                    break

        if not current_price:
            log.debug(f"No price for {token_id[:8]}, skipping")
            continue

        # Staleness check
        if signal and signal.is_stale(current_price):
            log.debug(f"Stale signal dropped: {strategy} {condition_id[:8]}")
            continue

        if signal and signal.is_expired():
            log.debug(f"Expired signal dropped: {strategy}")
            continue

        # Kelly sizing
        days = market.days_to_resolution if market else 30.0
        fee_per_dollar = config.TAKER_FEE_RATE * (1 - current_price)

        size_usd = compute_kelly(
            model_prob=model_prob,
            market_price=current_price,
            bankroll=portfolio.bankroll,
            days_to_resolution=days,
            strategy=strategy,
            fee_cost_per_dollar=fee_per_dollar,
        )

        if size_usd < 5:
            log.debug(f"Kelly size too small: ${size_usd:.2f} for {strategy}")
            continue

        order = Order(
            condition_id=condition_id,
            token_id=token_id,
            side=direction,
            price=current_price,
            size_usd=size_usd,
            order_type="GTC",
            strategy=strategy,
        )

        fill = await gateway.submit(order, signal=signal, market=market)
        if fill:
            portfolio.trade_count += 1
            log.info(
                f"[EXECUTED] [{strategy}] {direction} ${size_usd:.2f} @ {fill.fill_price:.4f} "
                f"| edge={net_edge:.2%} urgency={urgency} "
                f"| fee=${fill.fee_paid:.3f}"
            )


async def main():
    log.info("=" * 60)
    log.info("  Prediction Edge v2.0 - Starting")
    log.info(f"  Mode: {'DRY RUN (paper trading)' if config.DRY_RUN else 'LIVE TRADING'}")
    log.info("=" * 60)

    # Init DB schema
    get_conn()

    bankroll = float(os.getenv("BANKROLL", "1000"))
    portfolio = PortfolioState(bankroll=bankroll, peak_value=bankroll)

    # Market store
    store = MarketStore()

    # Event buses
    raw_signal_bus: asyncio.Queue = asyncio.Queue(maxsize=2000)   # all raw signals
    exec_signal_bus: asyncio.Queue = asyncio.Queue(maxsize=500)   # aggregated signals
    orderbook_bus: asyncio.Queue = asyncio.Queue(maxsize=5000)    # WebSocket orderbooks
    fill_bus: asyncio.Queue = asyncio.Queue(maxsize=500)

    # Init execution gateway + reconciler
    gateway = ExecutionGateway(portfolio, fill_bus)
    reconciler = PositionReconciler(portfolio, gateway.get_clob)
    gateway.set_reconciler(reconciler)

    # Initial market fetch
    log.info("Fetching initial market data...")
    markets = await fetch_active_markets(limit=500)
    for m in markets:
        m.dispute_risk = score_oracle_dispute_risk(m)
    await store.update_markets(markets)
    log.info(f"Loaded {len(markets)} markets, {sum(len(m.tokens) for m in markets)} tokens")

    # Build wallet profitability database (runs once; skip if already done)
    from core.db import get_conn as _gc
    conn = _gc()
    wallet_count = conn.execute("SELECT COUNT(*) FROM wallet_stats").fetchone()[0]
    if wallet_count == 0:
        log.info("No wallet data found. Building wallet database (this takes ~5 minutes)...")
        try:
            await build_wallet_database()
        except Exception as e:
            log.warning(f"Wallet database build failed: {e}. Copy trading will be limited.")
    else:
        log.info(f"Wallet database: {wallet_count} wallets loaded")

    # Init correlated arb scanner (relation graph auto-built and injected)
    corr_arb_scanner = CorrelatedArbScanner(store, raw_signal_bus)

    # Assemble all tasks
    tasks = [
        # Data layer
        asyncio.create_task(market_refresh_loop(store), name="market_refresh"),

        # Signal generators → raw_signal_bus
        asyncio.create_task(OracleMonitor(store, raw_signal_bus).start(),        name="oracle_monitor"),
        asyncio.create_task(FeeArbitrageScanner(store, raw_signal_bus).start(),  name="fee_arb"),
        asyncio.create_task(ClosingConvergenceScanner(store, raw_signal_bus).start(), name="convergence"),
        asyncio.create_task(OrderFlowMonitor(store, raw_signal_bus).start(),     name="order_flow"),
        asyncio.create_task(corr_arb_scanner.start(),                            name="corr_arb"),

        # Auto-builds relation graph (Gamma API + Claude + price correlation)
        # Refreshes every 6 hours — zero manual work required
        asyncio.create_task(
            RelationGraphManager(store, corr_arb_scanner).start(),
            name="relation_builder"
        ),

        # Signal aggregator: raw_signal_bus → exec_signal_bus
        asyncio.create_task(
            SignalAggregator(raw_signal_bus, exec_signal_bus).start(),
            name="aggregator"
        ),

        # Calibration feedback loop
        asyncio.create_task(CalibrationTracker(store).start(), name="calibration"),

        # Execution
        asyncio.create_task(
            process_aggregated_signals(exec_signal_bus, store, gateway, portfolio),
            name="execution"
        ),

        # Position/balance reconciler (syncs local state with CLOB truth)
        asyncio.create_task(reconciler.start(), name="reconciler"),
    ]

    # WebSocket real-time orderbook (requires aiohttp connection)
    try:
        ws_tasks = await start_websocket_manager(store, orderbook_bus)
        tasks.extend(ws_tasks)
        log.info(f"WebSocket: {len(ws_tasks)} connection(s) started")
    except Exception as e:
        log.warning(f"WebSocket startup failed: {e}. Falling back to REST polling.")

    # On-chain watcher (requires premium RPC)
    if config.POLYGON_RPC and "alchemy" in config.POLYGON_RPC.lower():
        tasks.append(asyncio.create_task(
            OnChainWatcher(store, raw_signal_bus).start(),
            name="onchain"
        ))
        log.info("On-chain copy trading: ACTIVE")
    else:
        log.warning("On-chain copy trading: DISABLED (configure POLYGON_RPC in .env)")

    # Web dashboard — http://localhost:8080
    tasks.append(asyncio.create_task(
        start_dashboard(store, portfolio, lambda: gateway.stats),
        name="dashboard"
    ))
    log.info("Dashboard: http://localhost:8080")

    log.info(f"System running with {len(tasks)} tasks. Ctrl+C to stop.")
    log.info(f"Strategies: oracle_convergence, fee_arb, closing_convergence, "
             f"order_flow, correlated_arb, on_chain_copy")

    try:
        await asyncio.gather(*tasks)
    except (KeyboardInterrupt, asyncio.CancelledError):
        log.info("Shutting down gracefully...")
        for t in tasks:
            t.cancel()
        # Print calibration report on exit
        from core.calibration import get_strategy_calibration_report
        report = get_strategy_calibration_report()
        if report:
            log.info("=== Final Calibration Report ===")
            for strategy, stats in report.items():
                log.info(f"  {strategy}: {stats['trades']} trades, "
                         f"{stats['accuracy']:.1%} accuracy, "
                         f"Kelly={stats['kelly_fraction']:.1%}")


if __name__ == "__main__":
    asyncio.run(main())
