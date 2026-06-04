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

NODES_JSON = Path(__file__).parent / "nodes.json"


def _node_defs() -> list[dict[str, Any]]:
    """nodes.json を single source of truth として読む. 失敗時は空リスト."""
    try:
        import json as _json

        return _json.loads(NODES_JSON.read_text(encoding="utf-8"))
    except Exception as e:
        logger.error("failed to read %s: %s", NODES_JSON, e)
        return []


_NODE_DEFS = _node_defs()  # import 時に1回だけ読む
NODE_NAMES: tuple[str, ...] = tuple(n["name"] for n in _NODE_DEFS)
NODE_COLORS: dict[str, str] = {n["name"]: n.get("color", "#8b949e") for n in _NODE_DEFS}
# Polar 内 LND は --listen=0.0.0.0:9735 + DNS名 lnd-<name> で解決可。p2p 公開ポートはホスト側のみ
NODE_HOSTS: dict[str, str] = {n["name"]: f"lnd-{n['name']}" for n in _NODE_DEFS}


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
        cert_p = Path(cert)
        mac_p = Path(mac)
        missing = [str(p) for p in (cert_p, mac_p) if not p.exists()]
        if missing:
            logger.error("node %s: file(s) not found, skipping: %s", name, ", ".join(missing))
            continue
        nodes[name] = LndNode(name=name, rest_url=rest, tls_cert_path=cert, macaroon_path=mac)
    return nodes


BITCOIND_RPC_URL = os.environ.get("BITCOIND_RPC_URL", "http://bitcoind:18443")
BITCOIND_RPC_USER = os.environ.get("BITCOIND_RPC_USER", "polaruser")
BITCOIND_RPC_PASS = os.environ.get("BITCOIND_RPC_PASS", "polarpass")


CLIENTS: dict[str, LndClient] = {}
PUBKEY_TO_NAME: dict[str, str] = {}
WS_CONNECTIONS: set[WebSocket] = set()


async def _resolve_pubkey_to_name(pubkey: str) -> str:
    if not pubkey:
        return ""
    if pubkey in PUBKEY_TO_NAME:
        return PUBKEY_TO_NAME[pubkey]
    for name, c in CLIENTS.items():
        try:
            info = await c.get_info()
            pk = info.get("identity_pubkey", "")
            if pk:
                PUBKEY_TO_NAME[pk] = name
        except Exception:
            pass
    return PUBKEY_TO_NAME.get(pubkey, "")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    for name, node in _load_nodes().items():
        CLIENTS[name] = LndClient(node)
        logger.info("LND client registered: %s -> %s", name, node.rest_url)
    # pubkey キャッシュ warm-up
    for name in list(CLIENTS):
        try:
            info = await CLIENTS[name].get_info()
            pk = info.get("identity_pubkey", "")
            if pk:
                PUBKEY_TO_NAME[pk] = name
        except Exception as e:
            logger.warning("warm-up get_info failed (%s): %s", name, e)
    tasks = [asyncio.create_task(_balance_broadcaster())]
    for name in CLIENTS:
        tasks.append(asyncio.create_task(_htlc_listener(name)))
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        for c in CLIENTS.values():
            await c.close()


app = FastAPI(title="ln-channel-visualizer", version="0.1.0", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/nodes")
def api_nodes() -> list[dict[str, str]]:
    """フロントが描画順・色・peer host を取得するためのノード定義 (nodes.json 由来)."""
    return [
        {
            "name": name,
            "color": NODE_COLORS.get(name, "#8b949e"),
            "host": NODE_HOSTS.get(name, f"lnd-{name}"),
        }
        for name in NODE_NAMES
    ]


# chan_id -> 自ノード視点ポリシー. regtest で変動しないため簡易キャッシュ
CHAN_POLICY_CACHE: dict[str, dict[str, int]] = {}


async def _chan_policy(client: LndClient, chan_id: str, my_pubkey: str) -> dict[str, int] | None:
    """チャネルの「自分が課す」手数料ポリシーを抽出. 未確定/失敗時は None."""
    if not chan_id or chan_id == "0":
        return None
    if chan_id in CHAN_POLICY_CACHE:
        return CHAN_POLICY_CACHE[chan_id]
    try:
        edge = await client.get_chan_info(chan_id)
    except Exception:
        return None
    pol = edge.get("node1_policy") if edge.get("node1_pub", "") == my_pubkey else edge.get("node2_policy")
    if not pol:
        return None
    result = {
        "base_fee_msat": int(pol.get("fee_base_msat", 0)),
        "fee_rate_ppm": int(pol.get("fee_rate_milli_msat", 0)),
        "cltv_delta": int(pol.get("time_lock_delta", 0)),
    }
    CHAN_POLICY_CACHE[chan_id] = result
    return result


async def _snapshot() -> dict[str, Any]:
    out: dict[str, Any] = {"nodes": {}}
    for name, client in CLIENTS.items():
        try:
            info, channels, balance, wallet = await asyncio.gather(
                client.get_info(),
                client.list_channels(),
                client.channel_balance(),
                client.wallet_balance(),
            )
            chans = channels.get("channels", [])
            my_pub = info.get("identity_pubkey", "")
            policies = await asyncio.gather(
                *[_chan_policy(client, str(ch.get("chan_id", "")), my_pub) for ch in chans]
            )
            out["nodes"][name] = {
                "pubkey": my_pub,
                "alias": info.get("alias", name),
                "num_channels": len(chans),
                "channels": [
                    {
                        "remote_pubkey": ch.get("remote_pubkey", ""),
                        "capacity": int(ch.get("capacity", 0)),
                        "local_balance": int(ch.get("local_balance", 0)),
                        "remote_balance": int(ch.get("remote_balance", 0)),
                        "active": ch.get("active", False),
                        "channel_point": ch.get("channel_point", ""),
                        "chan_id": str(ch.get("chan_id", "")),
                        "policy": policies[idx],
                    }
                    for idx, ch in enumerate(chans)
                ],
                "balance_sat": int(balance.get("balance", 0)),
                "wallet_sat": int(wallet.get("confirmed_balance", 0)),
            }
        except Exception as e:
            out["nodes"][name] = {"error": str(e)}
    return out


RECENT_HTLC_EVENTS: list[dict[str, Any]] = []
HTLC_MAX = 50


async def _broadcast_to_ws(payload: dict) -> None:
    dead: list[WebSocket] = []
    for ws in WS_CONNECTIONS:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        WS_CONNECTIONS.discard(ws)


async def _htlc_listener(node_name: str) -> None:
    """1ノードの HTLC stream を読み続け WS に broadcast. 切断時は指数バックオフで再接続."""
    import json as _json
    backoff = 1.0
    while True:
        try:
            client = CLIENTS[node_name]
            async for line in client.subscribe_htlc_events():
                try:
                    raw = _json.loads(line)
                except Exception:
                    continue
                # LND は {"result": {...}} 形式 (gRPC-gateway)
                ev = raw.get("result", raw)
                evt = {
                    "node": node_name,
                    "event_type": ev.get("event_type", ""),
                    "incoming_channel_id": ev.get("incoming_channel_id", ""),
                    "outgoing_channel_id": ev.get("outgoing_channel_id", ""),
                    "timestamp_ns": ev.get("timestamp_ns", ""),
                    "kind": next(
                        (k for k in ("forward_event", "forward_fail_event", "settle_event", "link_fail_event", "final_htlc_event")
                         if k in ev), "unknown"),
                    "detail": ev,
                }
                RECENT_HTLC_EVENTS.append(evt)
                del RECENT_HTLC_EVENTS[:-HTLC_MAX]
                await _broadcast_to_ws({"htlc": evt})
            backoff = 1.0
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.warning("htlc stream %s disconnected: %s; retry in %.1fs", node_name, e, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


@app.get("/api/htlc_events")
def api_htlc_events() -> list[dict]:
    return list(RECENT_HTLC_EVENTS[-HTLC_MAX:])


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
        await _broadcast_to_ws({"snapshot": snap})


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
        route = result.get("payment_route", {})
        hops = [
            {
                "pub_key": h.get("pub_key", ""),
                "amt_to_forward": int(h.get("amt_to_forward", 0)),
                "fee": int(h.get("fee", 0)),
            }
            for h in route.get("hops", [])
        ]
        record_payment(req.source, req.dest, req.amount_sat, pr, phash, "success")
        return {
            "status": "success",
            "payment_hash": phash,
            "payment_request": pr,
            "hops": hops,
            "total_fees": int(route.get("total_fees", 0)),
        }
    except HTTPException:
        raise
    except Exception as e:
        record_payment(req.source, req.dest, req.amount_sat, "", "", "error", str(e))
        raise HTTPException(500, str(e))


class InvoiceRequest(BaseModel):
    node: str
    amount_sat: int
    memo: str = ""


@app.post("/api/invoice")
async def api_invoice(req: InvoiceRequest) -> dict[str, Any]:
    """任意ノードで bolt11 を生成 (プル型送金の受取側)."""
    if req.node not in CLIENTS:
        raise HTTPException(404, f"node not found: {req.node}")
    if req.amount_sat <= 0:
        raise HTTPException(400, "amount must be positive")
    try:
        inv = await CLIENTS[req.node].add_invoice(req.amount_sat, memo=req.memo)
        return {
            "node": req.node,
            "amount_sat": req.amount_sat,
            "payment_request": inv.get("payment_request", ""),
            "r_hash": inv.get("r_hash", ""),
        }
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"LND error: {e.response.text}")
    except Exception as e:
        raise HTTPException(500, str(e))


class PayInvoiceRequest(BaseModel):
    source: str
    payment_request: str


@app.post("/api/pay_invoice")
async def api_pay_invoice(req: PayInvoiceRequest) -> dict[str, Any]:
    if req.source not in CLIENTS:
        raise HTTPException(404, f"source node not found: {req.source}")
    pr = req.payment_request.strip()
    if not pr:
        raise HTTPException(400, "payment_request empty")
    src = CLIENTS[req.source]
    try:
        decoded = await src.decode_pay_req(pr)
        dest_pub = decoded.get("destination", "")
        amount = int(decoded.get("num_satoshis", 0))
        dest_name = await _resolve_pubkey_to_name(dest_pub) or f"external({dest_pub[:10]}...)"
        result = await src.send_payment_sync(pr)
        err = result.get("payment_error", "")
        if err:
            record_payment(req.source, dest_name, amount, pr, "", "failed", err)
            raise HTTPException(502, f"payment failed: {err}")
        phash = result.get("payment_hash", "")
        route = result.get("payment_route", {})
        hops = [
            {"pub_key": h.get("pub_key", ""), "amt_to_forward": int(h.get("amt_to_forward", 0)), "fee": int(h.get("fee", 0))}
            for h in route.get("hops", [])
        ]
        record_payment(req.source, dest_name, amount, pr, phash, "success")
        return {
            "status": "success",
            "payment_hash": phash,
            "dest": dest_name,
            "amount_sat": amount,
            "hops": hops,
            "total_fees": int(route.get("total_fees", 0)),
        }
    except HTTPException:
        raise
    except Exception as e:
        record_payment(req.source, "?", 0, pr, "", "error", str(e))
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


class RoutesRequest(BaseModel):
    source: str
    dest: str
    amount_sat: int
    fee_limit_sat: int | None = None


@app.post("/api/routes")
async def api_routes(req: RoutesRequest) -> dict[str, Any]:
    if req.source not in CLIENTS or req.dest not in CLIENTS:
        raise HTTPException(404, "node not found")
    if req.source == req.dest:
        raise HTTPException(400, "source and dest must differ")
    if req.amount_sat <= 0:
        raise HTTPException(400, "amount must be positive")
    src = CLIENTS[req.source]
    dst = CLIENTS[req.dest]
    try:
        dst_info = await dst.get_info()
        dst_pubkey = dst_info["identity_pubkey"]
        result = await src.query_routes(dst_pubkey, req.amount_sat, req.fee_limit_sat)
        routes = []
        for rt in result.get("routes", []):
            hops_view = []
            for h in rt.get("hops", []):
                pk = h.get("pub_key", "")
                hops_view.append({
                    "pub_key": pk,
                    "name": await _resolve_pubkey_to_name(pk) or pk[:10] + "...",
                    "amt_to_forward": int(h.get("amt_to_forward", 0)),
                    "fee": int(h.get("fee", 0)),
                    "chan_id": h.get("chan_id", ""),
                })
            routes.append({
                "total_fees": int(rt.get("total_fees", 0)),
                "total_amt": int(rt.get("total_amt", 0)),
                "total_time_lock": int(rt.get("total_time_lock", 0)),
                "hops": hops_view,
                "_raw": rt,
            })
        return {"routes": routes}
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"LND error: {e.response.text}")
    except Exception as e:
        raise HTTPException(500, str(e))


class SendRouteRequest(BaseModel):
    source: str
    dest: str
    amount_sat: int
    route: dict


@app.post("/api/send_route")
async def api_send_route(req: SendRouteRequest) -> dict[str, Any]:
    import base64 as _b64
    if req.source not in CLIENTS or req.dest not in CLIENTS:
        raise HTTPException(404, "node not found")
    src = CLIENTS[req.source]
    dst = CLIENTS[req.dest]
    try:
        invoice = await dst.add_invoice(req.amount_sat, memo=f"route {req.source}->{req.dest}")
        pr = invoice["payment_request"]
        phash_b64 = invoice["r_hash"]  # base64 (REST)
        # `_raw` キーが route に紛れていれば除去
        route = {k: v for k, v in req.route.items() if not k.startswith("_")}
        result = await src.send_to_route_v2(phash_b64, route)
        failure = result.get("failure")
        if failure:
            record_payment(req.source, req.dest, req.amount_sat, pr, "", "failed", str(failure))
            raise HTTPException(502, f"route send failed: {failure}")
        record_payment(req.source, req.dest, req.amount_sat, pr, result.get("preimage", ""), "success")
        return {"status": "success", "result": result}
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"LND error: {e.response.text}")
    except Exception as e:
        record_payment(req.source, req.dest, req.amount_sat, "", "", "error", str(e))
        raise HTTPException(500, str(e))


class MineRequest(BaseModel):
    blocks: int = 6
    to_node: str = "alice"


async def _bitcoind_rpc(method: str, params: list) -> Any:
    async with httpx.AsyncClient(
        auth=(BITCOIND_RPC_USER, BITCOIND_RPC_PASS), timeout=20.0
    ) as c:
        r = await c.post(
            BITCOIND_RPC_URL,
            json={"jsonrpc": "1.0", "id": "lnviz", "method": method, "params": params},
        )
        r.raise_for_status()
        data = r.json()
        if data.get("error"):
            raise HTTPException(502, f"bitcoind RPC error: {data['error']}")
        return data["result"]


@app.post("/api/mine")
async def api_mine(req: MineRequest) -> dict[str, Any]:
    if req.blocks <= 0 or req.blocks > 1000:
        raise HTTPException(400, "blocks must be 1..1000")
    if req.to_node not in CLIENTS:
        raise HTTPException(404, f"node not found: {req.to_node}")
    try:
        addr_resp = await CLIENTS[req.to_node].new_address()
        addr = addr_resp["address"]
        hashes = await _bitcoind_rpc("generatetoaddress", [req.blocks, addr])
        return {"status": "ok", "blocks": len(hashes), "address": addr, "to_node": req.to_node}
    except httpx.HTTPError as e:
        raise HTTPException(502, f"bitcoind unreachable: {e}")


@app.websocket("/ws/balances")
async def ws_balances(ws: WebSocket) -> None:
    await ws.accept()
    WS_CONNECTIONS.add(ws)
    try:
        await ws.send_json({"snapshot": await _snapshot()})
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
