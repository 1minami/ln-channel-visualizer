"""ln-channel-visualizer — FastAPI エントリポイント.

Polar regtest の 3ノード(Alice/Bob/Carol) を可視化する Web UI.
REST API + WebSocket で残高ストリーム配信 + 送金トリガ.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.db import init_db, recent_payments, record_payment
from backend.lnd_client import LndClient, LndNode

load_dotenv()

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("ln-channel-visualizer")

POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "3"))

NODE_NAMES = ("alice", "bob", "carol")


def _load_nodes() -> dict[str, LndNode]:
    nodes: dict[str, LndNode] = {}
    for name in NODE_NAMES:
        upper = name.upper()
        rest = os.environ.get(f"LND_{upper}_REST")
        cert = os.environ.get(f"LND_{upper}_TLS_CERT_PATH")
        mac = os.environ.get(f"LND_{upper}_MACAROON_PATH")
        if not (rest and cert and mac):
            logger.warning("node %s: env incomplete; skipping", name)
            continue
        nodes[name] = LndNode(name=name, rest_url=rest, tls_cert_path=cert, macaroon_path=mac)
    return nodes


CLIENTS: dict[str, LndClient] = {}
WS_CONNECTIONS: set[WebSocket] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    for name, node in _load_nodes().items():
        CLIENTS[name] = LndClient(node)
        logger.info("LND client registered: %s -> %s", name, node.rest_url)
    task = asyncio.create_task(_balance_broadcaster())
    try:
        yield
    finally:
        task.cancel()
        for c in CLIENTS.values():
            await c.close()


app = FastAPI(title="ln-channel-visualizer", version="0.1.0", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


async def _snapshot() -> dict[str, Any]:
    out: dict[str, Any] = {"nodes": {}}
    for name, client in CLIENTS.items():
        try:
            info, channels, balance = await asyncio.gather(
                client.get_info(),
                client.list_channels(),
                client.channel_balance(),
            )
            out["nodes"][name] = {
                "pubkey": info.get("identity_pubkey", ""),
                "alias": info.get("alias", name),
                "num_channels": len(channels.get("channels", [])),
                "channels": [
                    {
                        "remote_pubkey": ch.get("remote_pubkey", ""),
                        "capacity": int(ch.get("capacity", 0)),
                        "local_balance": int(ch.get("local_balance", 0)),
                        "remote_balance": int(ch.get("remote_balance", 0)),
                        "active": ch.get("active", False),
                        "channel_point": ch.get("channel_point", ""),
                    }
                    for ch in channels.get("channels", [])
                ],
                "balance_sat": int(balance.get("balance", 0)),
            }
        except Exception as e:
            out["nodes"][name] = {"error": str(e)}
    return out


async def _balance_broadcaster() -> None:
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        if not WS_CONNECTIONS:
            continue
        try:
            snap = await _snapshot()
        except Exception as e:
            logger.warning("snapshot failed: %s", e)
            continue
        dead: list[WebSocket] = []
        for ws in WS_CONNECTIONS:
            try:
                await ws.send_json(snap)
            except Exception:
                dead.append(ws)
        for ws in dead:
            WS_CONNECTIONS.discard(ws)


@app.get("/api/snapshot")
async def api_snapshot() -> dict[str, Any]:
    return await _snapshot()


@app.get("/api/payments")
def api_payments() -> list[dict]:
    return recent_payments()


class SendRequest(BaseModel):
    source: str
    dest: str
    amount_sat: int


@app.post("/api/send")
async def api_send(req: SendRequest) -> dict[str, Any]:
    if req.source not in CLIENTS:
        raise HTTPException(404, f"source node not found: {req.source}")
    if req.dest not in CLIENTS:
        raise HTTPException(404, f"dest node not found: {req.dest}")
    if req.source == req.dest:
        raise HTTPException(400, "source and dest must differ")
    if req.amount_sat <= 0:
        raise HTTPException(400, "amount must be positive")

    src = CLIENTS[req.source]
    dst = CLIENTS[req.dest]

    try:
        invoice = await dst.add_invoice(req.amount_sat, memo=f"viz {req.source}->{req.dest}")
        pr = invoice["payment_request"]
        result = await src.send_payment_sync(pr)
        err = result.get("payment_error", "")
        if err:
            record_payment(req.source, req.dest, req.amount_sat, pr, "", "failed", err)
            raise HTTPException(502, f"payment failed: {err}")
        phash = result.get("payment_hash", "")
        record_payment(req.source, req.dest, req.amount_sat, pr, phash, "success")
        return {"status": "success", "payment_hash": phash, "payment_request": pr}
    except HTTPException:
        raise
    except Exception as e:
        record_payment(req.source, req.dest, req.amount_sat, "", "", "error", str(e))
        raise HTTPException(500, str(e))


class OpenChannelRequest(BaseModel):
    source: str
    dest: str
    local_funding_amount: int
    peer_host: str = "host.docker.internal"  # Polar 規定: Docker内ノード名 or localhost


@app.post("/api/channels/open")
async def api_open_channel(req: OpenChannelRequest) -> dict[str, Any]:
    if req.source not in CLIENTS or req.dest not in CLIENTS:
        raise HTTPException(404, "node not found")
    if req.source == req.dest:
        raise HTTPException(400, "source and dest must differ")
    if req.local_funding_amount <= 0:
        raise HTTPException(400, "amount must be positive")

    src = CLIENTS[req.source]
    dst = CLIENTS[req.dest]
    try:
        dst_info = await dst.get_info()
        dst_pubkey = dst_info["identity_pubkey"]
        # Polar 内 LND は ノード名 (例: "bob") で他コンテナを解決可能。fallback で host 指定許可
        await src.connect_peer(dst_pubkey, req.peer_host)
        result = await src.open_channel(dst_pubkey, req.local_funding_amount)
        return {
            "status": "pending",
            "funding_txid": result.get("funding_txid_str", ""),
            "note": "Polar で 6 ブロックマイニング後にアクティブ化",
        }
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"LND error: {e.response.text}")
    except Exception as e:
        raise HTTPException(500, str(e))


class CloseChannelRequest(BaseModel):
    source: str
    funding_txid: str
    output_index: int
    force: bool = False


@app.post("/api/channels/close")
async def api_close_channel(req: CloseChannelRequest) -> dict[str, Any]:
    if req.source not in CLIENTS:
        raise HTTPException(404, "node not found")
    try:
        result = await CLIENTS[req.source].close_channel(
            req.funding_txid, req.output_index, force=req.force
        )
        return {"status": "closing", "result": result}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.websocket("/ws/balances")
async def ws_balances(ws: WebSocket) -> None:
    await ws.accept()
    WS_CONNECTIONS.add(ws)
    try:
        await ws.send_json(await _snapshot())
        while True:
            await ws.receive_text()  # keepalive
    except WebSocketDisconnect:
        pass
    finally:
        WS_CONNECTIONS.discard(ws)


frontend_dist = Path(__file__).parent / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
    logger.info("frontend mounted from %s", frontend_dist)
else:
    logger.info("frontend/dist not found; run `cd frontend && npm run build`")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, log_level=LOG_LEVEL.lower())
