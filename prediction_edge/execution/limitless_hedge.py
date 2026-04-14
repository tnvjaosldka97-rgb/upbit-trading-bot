"""
Limitless Exchange hedge leg — EIP-712 order signing + submission.

Places the opposite-side order on Limitless to lock in cross-platform arb.
When LimitlessArbScanner detects Limitless bid > Poly ask:
  1. BUY on Polymarket (cheap side) — handled by ExecutionGateway
  2. SELL YES on Limitless (expensive side) — handled HERE

Authentication flow:
  GET /auth/signing-message → sign with EIP-191 → POST /auth/login
  Session cookies persist for subsequent requests.

Order signing:
  EIP-712 typed data with domain "Limitless CTF Exchange" v1 on Base (8453).
  Uses eth_account.messages.encode_typed_data — no web3 dependency needed.

Based on:
  - github.com/limitless-labs-group/agents-starter (TypeScript reference)
  - github.com/guzus/dr-manhattan (Python reference, CCXT-style)
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional

import httpx

import config
from core.logger import log


# ── EIP-712 type definitions ────────────────────────────────────────────────

EIP712_TYPES = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "Order": [
        {"name": "salt", "type": "uint256"},
        {"name": "maker", "type": "address"},
        {"name": "signer", "type": "address"},
        {"name": "taker", "type": "address"},
        {"name": "tokenId", "type": "uint256"},
        {"name": "makerAmount", "type": "uint256"},
        {"name": "takerAmount", "type": "uint256"},
        {"name": "expiration", "type": "uint256"},
        {"name": "nonce", "type": "uint256"},
        {"name": "feeRateBps", "type": "uint256"},
        {"name": "side", "type": "uint8"},
        {"name": "signatureType", "type": "uint8"},
    ],
}

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
SCALE = 1_000_000  # 6 decimal places (USDC)
TICK = 0.001       # Limitless tick size


class LimitlessHedgeClient:
    """
    Authenticated Limitless client for placing hedge orders.

    Requires:
      - LIMITLESS_PRIVATE_KEY in env (EVM wallet private key on Base chain)
      - eth_account >= 0.11.0 (pip install eth-account)
      - USDC + CTF token approvals on-chain (one-time setup)
    """

    def __init__(self):
        self._host = config.LIMITLESS_API_BASE
        self._chain_id = config.LIMITLESS_CHAIN_ID
        self._private_key = config.LIMITLESS_PRIVATE_KEY
        self._account = None
        self._address: str = ""
        self._owner_id: Optional[str] = None
        self._session: Optional[httpx.AsyncClient] = None
        self._authenticated = False
        self._fee_rate_bps = 300  # 3% Bronze tier (conservative default)

        # Market venue cache: slug -> {"exchange": "0x...", "adapter": "0x..."}
        self._venue_cache: Dict[str, Dict[str, str]] = {}
        # Token cache: slug -> {"yes": "token_id", "no": "token_id"}
        self._token_cache: Dict[str, Dict[str, str]] = {}

    @property
    def is_available(self) -> bool:
        """Check if hedge client can be initialized (has required deps + key)."""
        if not self._private_key:
            return False
        try:
            from eth_account import Account  # noqa: F401
            return True
        except ImportError:
            return False

    async def initialize(self) -> bool:
        """
        Initialize account and authenticate with Limitless API.
        Returns True on success, False on failure.
        """
        if not self._private_key:
            log.warning("[LIMITLESS HEDGE] No LIMITLESS_PRIVATE_KEY configured")
            return False

        try:
            from eth_account import Account
            self._account = Account.from_key(self._private_key)
            self._address = self._account.address
        except ImportError:
            log.error("[LIMITLESS HEDGE] eth_account not installed. pip install eth-account>=0.11.0")
            return False
        except Exception as e:
            log.error(f"[LIMITLESS HEDGE] Invalid private key: {e}")
            return False

        self._session = httpx.AsyncClient(timeout=15)

        try:
            await self._authenticate()
            log.info(f"[LIMITLESS HEDGE] Authenticated as {self._address[:10]}...")
            return True
        except Exception as e:
            log.error(f"[LIMITLESS HEDGE] Authentication failed: {e}")
            return False

    async def _authenticate(self):
        """EIP-191 signing auth flow: get message → sign → login."""
        from eth_account.messages import encode_defunct

        # Step 1: Get signing message
        resp = await self._session.get(f"{self._host}/auth/signing-message")
        resp.raise_for_status()
        message = resp.text.strip()
        if not message:
            raise RuntimeError("Empty signing message from API")

        # Step 2: Sign with EIP-191 (personal_sign)
        signed = self._account.sign_message(encode_defunct(text=message))
        signature = signed.signature.hex()
        if not signature.startswith("0x"):
            signature = f"0x{signature}"

        # Step 3: Login
        message_hex = "0x" + message.encode("utf-8").hex()
        headers = {
            "x-account": self._address,
            "x-signing-message": message_hex,
            "x-signature": signature,
        }
        login_resp = await self._session.post(
            f"{self._host}/auth/login",
            headers=headers,
            json={"client": "eoa"},
        )
        login_resp.raise_for_status()

        try:
            login_data = login_resp.json()
            user_data = login_data.get("user", login_data)
            self._owner_id = user_data.get("id")
        except Exception:
            pass

        self._authenticated = True

    async def _ensure_session(self):
        """Re-authenticate if session expired."""
        if not self._authenticated and self._account:
            await self._authenticate()

    async def get_market_details(self, slug: str) -> Optional[Dict[str, Any]]:
        """
        Fetch market details including venue (exchange address) and token IDs.
        Results are cached per slug.
        """
        if slug in self._venue_cache and slug in self._token_cache:
            return {
                "venue": self._venue_cache[slug],
                "tokens": self._token_cache[slug],
            }

        try:
            resp = await self._session.get(f"{self._host}/markets/{slug}")
            if resp.status_code != 200:
                return None
            data = resp.json()

            venue = data.get("venue", {})
            tokens = data.get("tokens", {})

            if not venue or not venue.get("exchange"):
                log.debug(f"[LIMITLESS HEDGE] Market {slug} has no venue.exchange")
                return None

            self._venue_cache[slug] = venue
            self._token_cache[slug] = {
                "yes": str(tokens.get("yes", "")),
                "no": str(tokens.get("no", "")),
            }

            return {"venue": venue, "tokens": self._token_cache[slug]}

        except Exception as e:
            log.debug(f"[LIMITLESS HEDGE] Failed to fetch market {slug}: {e}")
            return None

    def _compute_amounts(
        self,
        price: float,
        size_usdc: float,
        side: str,  # "BUY" or "SELL"
    ) -> tuple[int, int]:
        """
        Compute makerAmount and takerAmount for GTC order.

        BUY:  maker pays collateral (price * shares), taker provides shares
        SELL: maker provides shares, taker pays collateral

        All values in micro-units (1e6).
        """
        shares = int(size_usdc * SCALE)
        price_int = int(price * SCALE)
        tick_int = int(TICK * SCALE)  # 1000

        # Tick-align shares
        shares_step = SCALE // tick_int  # 1000
        if shares % shares_step != 0:
            shares = (shares // shares_step) * shares_step

        if shares <= 0:
            raise ValueError(f"Size too small after tick alignment: {size_usdc}")

        # Collateral calculation
        numerator = shares * price_int * SCALE
        denominator = SCALE * SCALE

        if side == "BUY":
            # Round UP for buyer
            collateral = (numerator + denominator - 1) // denominator
            return collateral, shares  # maker=collateral, taker=shares
        else:
            # Round DOWN for seller
            collateral = numerator // denominator
            return shares, collateral  # maker=shares, taker=collateral

    def _sign_order(
        self,
        order_msg: Dict[str, Any],
        exchange_address: str,
    ) -> str:
        """Sign order with EIP-712 typed data. Returns hex signature."""
        from eth_account.messages import encode_typed_data

        typed_data = {
            "types": EIP712_TYPES,
            "primaryType": "Order",
            "domain": {
                "name": "Limitless CTF Exchange",
                "version": "1",
                "chainId": self._chain_id,
                "verifyingContract": exchange_address,
            },
            "message": order_msg,
        }

        encoded = encode_typed_data(full_message=typed_data)
        signed = self._account.sign_message(encoded)

        sig = signed.signature.hex()
        if not sig.startswith("0x"):
            sig = f"0x{sig}"
        return sig

    async def place_hedge_order(
        self,
        slug: str,
        outcome: str,       # "Yes" or "No"
        side: str,           # "BUY" or "SELL"
        price: float,        # 0-1 (e.g., 0.55)
        size_usdc: float,    # USD amount
        order_type: str = "FOK",  # "FOK" or "GTC"
    ) -> Optional[Dict[str, Any]]:
        """
        Place an order on Limitless Exchange.

        For arb hedge: typically SELL YES on Limitless when Limitless bid > Poly ask.

        Args:
            slug: Limitless market slug
            outcome: "Yes" or "No"
            side: "BUY" or "SELL"
            price: Limit price (0-1)
            size_usdc: Order size in USD
            order_type: "FOK" (fill-or-kill) or "GTC" (good-til-cancel)

        Returns:
            API response dict with order details, or None on failure.
        """
        await self._ensure_session()

        # 1. Get market details (venue + tokens)
        details = await self.get_market_details(slug)
        if not details:
            log.warning(f"[LIMITLESS HEDGE] Cannot get market details for {slug}")
            return None

        exchange_address = details["venue"]["exchange"]
        token_key = "yes" if outcome == "Yes" else "no"
        token_id = details["tokens"].get(token_key, "")
        if not token_id:
            log.warning(f"[LIMITLESS HEDGE] No token_id for {outcome} in {slug}")
            return None

        # 2. Validate price
        if price <= 0 or price >= 1:
            log.warning(f"[LIMITLESS HEDGE] Invalid price {price} for {slug}")
            return None

        # 3. Compute amounts
        side_int = 0 if side == "BUY" else 1

        if order_type == "FOK":
            # FOK: makerAmount = total USD spend, takerAmount = 1
            maker_amount = int(size_usdc * SCALE)
            taker_amount = 1
        else:
            # GTC: proper tick-aligned amounts
            maker_amount, taker_amount = self._compute_amounts(price, size_usdc, side)

        # 4. Generate salt (timestamp-based, matches SDK pattern)
        timestamp_ms = int(time.time() * 1000)
        nano_offset = int((time.perf_counter() * 1_000_000) % 1_000_000)
        one_day_ms = 86_400_000
        salt = timestamp_ms * 1000 + nano_offset + one_day_ms

        # 5. Build message for EIP-712 signing (all ints)
        order_msg = {
            "salt": salt,
            "maker": self._address,
            "signer": self._address,
            "taker": ZERO_ADDRESS,
            "tokenId": int(token_id),
            "makerAmount": maker_amount,
            "takerAmount": taker_amount,
            "expiration": 0,
            "nonce": 0,
            "feeRateBps": self._fee_rate_bps,
            "side": side_int,
            "signatureType": 0,  # EOA
        }

        # 6. Sign
        try:
            signature = self._sign_order(order_msg, exchange_address)
        except Exception as e:
            log.error(f"[LIMITLESS HEDGE] Signing failed: {e}")
            return None

        # 7. Build API payload
        # Note: tokenId is STRING in payload, expiration is STRING "0"
        order_payload: Dict[str, Any] = {
            "salt": salt,
            "maker": self._address,
            "signer": self._address,
            "taker": ZERO_ADDRESS,
            "tokenId": token_id,        # string
            "makerAmount": maker_amount,
            "takerAmount": taker_amount,
            "expiration": "0",           # string
            "nonce": 0,
            "feeRateBps": self._fee_rate_bps,
            "side": side_int,
            "signatureType": 0,
            "signature": signature,
        }

        # GTC orders include price; FOK orders must NOT
        if order_type == "GTC":
            order_payload["price"] = round(price, 3)

        payload = {
            "order": order_payload,
            "orderType": order_type,
            "marketSlug": slug,
        }
        if self._owner_id:
            payload["ownerId"] = self._owner_id

        # 8. Submit
        try:
            resp = await self._session.post(
                f"{self._host}/orders",
                json=payload,
            )

            if resp.status_code in (200, 201):
                result = resp.json()
                order_data = result.get("order", result)
                order_id = order_data.get("id", order_data.get("orderId", "unknown"))
                status = order_data.get("status", "UNKNOWN")

                log.info(
                    f"[LIMITLESS HEDGE] {order_type} {side} {outcome} on {slug}\n"
                    f"  price={price:.3f} size=${size_usdc:.2f}\n"
                    f"  order_id={order_id} status={status}"
                )
                return result

            else:
                error_text = resp.text[:200]
                log.warning(
                    f"[LIMITLESS HEDGE] Order rejected {resp.status_code}: {error_text}\n"
                    f"  {order_type} {side} {outcome} {slug} price={price:.3f}"
                )

                # Re-auth on 401/403
                if resp.status_code in (401, 403):
                    self._authenticated = False

                return None

        except Exception as e:
            log.error(f"[LIMITLESS HEDGE] Request failed: {e}")
            return None

    async def cancel_order(self, order_id: str) -> bool:
        """Cancel a specific order. Returns True on success."""
        await self._ensure_session()
        try:
            resp = await self._session.delete(f"{self._host}/orders/{order_id}")
            return resp.status_code in (200, 204)
        except Exception as e:
            log.debug(f"[LIMITLESS HEDGE] Cancel failed for {order_id}: {e}")
            return False

    async def cancel_all_orders(self, slug: str) -> bool:
        """Cancel all open orders for a market."""
        await self._ensure_session()
        try:
            resp = await self._session.delete(f"{self._host}/orders/all/{slug}")
            return resp.status_code in (200, 204)
        except Exception as e:
            log.debug(f"[LIMITLESS HEDGE] Cancel all failed for {slug}: {e}")
            return False

    async def get_positions(self) -> list[Dict[str, Any]]:
        """Fetch current positions on Limitless."""
        await self._ensure_session()
        try:
            resp = await self._session.get(f"{self._host}/portfolio/positions")
            if resp.status_code != 200:
                return []
            data = resp.json()
            return data.get("clob", [])
        except Exception:
            return []

    async def close(self):
        """Clean up HTTP session."""
        if self._session:
            await self._session.aclose()
            self._session = None
