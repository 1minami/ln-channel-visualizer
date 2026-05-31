"""LND REST API クライアント (macaroon 認証 + 自己署名TLS)."""
from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path

import httpx


@dataclass(frozen=True)
class LndNode:
    name: str
    rest_url: str
    tls_cert_path: str
    macaroon_path: str

    def macaroon_hex(self) -> str:
        return Path(self.macaroon_path).read_bytes().hex()

    def headers(self) -> dict[str, str]:
        return {"Grpc-Metadata-macaroon": self.macaroon_hex()}


class LndClient:
    def __init__(self, node: LndNode) -> None:
        self.node = node
        # Polar の自己署名 cert を検証に使う
        self._client = httpx.AsyncClient(
            base_url=node.rest_url,
            headers=node.headers(),
            verify=node.tls_cert_path,
            timeout=10.0,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def get_info(self) -> dict:
        r = await self._client.get("/v1/getinfo")
        r.raise_for_status()
        return r.json()

    async def list_channels(self) -> dict:
        r = await self._client.get("/v1/channels")
        r.raise_for_status()
        return r.json()

    async def channel_balance(self) -> dict:
        r = await self._client.get("/v1/balance/channels")
        r.raise_for_status()
        return r.json()

    async def add_invoice(self, value_sat: int, memo: str = "") -> dict:
        r = await self._client.post(
            "/v1/invoices",
            json={"value": str(value_sat), "memo": memo},
        )
        r.raise_for_status()
        return r.json()

    async def send_payment_sync(self, payment_request: str) -> dict:
        r = await self._client.post(
            "/v1/channels/transactions",
            json={"payment_request": payment_request},
            timeout=30.0,
        )
        r.raise_for_status()
        return r.json()

    async def list_peers(self) -> dict:
        r = await self._client.get("/v1/peers")
        r.raise_for_status()
        return r.json()

    async def connect_peer(self, pubkey: str, host: str) -> dict:
        # 既に接続済みなら 200/エラーどちらも握りつぶす
        r = await self._client.post(
            "/v1/peers",
            json={"addr": {"pubkey": pubkey, "host": host}, "perm": False},
        )
        if r.status_code >= 400 and "already connected" not in r.text.lower():
            r.raise_for_status()
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else {}

    async def open_channel(self, node_pubkey: str, local_funding_amount: int) -> dict:
        pubkey_b64 = base64.b64encode(bytes.fromhex(node_pubkey)).decode()
        r = await self._client.post(
            "/v1/channels",
            json={
                "node_pubkey": pubkey_b64,
                "local_funding_amount": str(local_funding_amount),
            },
            timeout=30.0,
        )
        r.raise_for_status()
        return r.json()

    async def close_channel(self, funding_txid: str, output_index: int, force: bool = False) -> dict:
        # REST close は streaming response。最初のメッセージで close_pending を返すのを待つ
        params = {"force": "true" if force else "false"}
        url = f"/v1/channels/{funding_txid}/{output_index}"
        async with self._client.stream("DELETE", url, params=params, timeout=30.0) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.strip():
                    return {"raw": line}
        return {}
