#!/usr/bin/env python3
"""nodes.json から docker-compose.yml を生成する.

ノード定義の single source of truth = nodes.json.
ノードを増やす手順:
  1. nodes.json に1行追加 (name/color/rest/grpc/p2p をユニークに)
  2. python scripts/gen-compose.py
  3. docker compose down -v && docker compose up -d --build
  4. bash scripts/init-network.sh
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODES_PATH = ROOT / "nodes.json"
COMPOSE_PATH = ROOT / "docker-compose.yml"

HEADER = """# このファイルは scripts/gen-compose.py が nodes.json から自動生成する.
# 直接編集しない. ノード変更は nodes.json を編集して再生成すること.
services:
  bitcoind:
    image: polarlightning/bitcoind:27.0
    container_name: lnviz-bitcoind
    restart: unless-stopped
    command:
      - bitcoind
      - -server=1
      - -regtest=1
      - -rpcauth=polaruser:5e5e98c21f5c814568f8b55d83b23c1c$$066b03f92df30b11de8e4b1b1cd5b1b4281aa25205bd57df9be82caf97a05526
      - -rpcbind=0.0.0.0:18443
      - -rpcallowip=0.0.0.0/0
      - -debug=rpc
      - -zmqpubrawblock=tcp://0.0.0.0:28334
      - -zmqpubrawtx=tcp://0.0.0.0:28335
      - -zmqpubhashblock=tcp://0.0.0.0:28336
      - -txindex=1
      - -dnsseed=0
      - -upnp=0
      - -rpcworkqueue=128
      - -fallbackfee=0.0002
    volumes:
      - bitcoind-data:/home/bitcoin/.bitcoin
    ports:
      - "18443:18443"
    networks:
      - lnviz
"""

LND_TEMPLATE = """
  lnd-{name}:
    image: polarlightning/lnd:0.18.3-beta
    container_name: lnviz-lnd-{name}
    restart: unless-stopped
    depends_on:
      - bitcoind
    command:
      - lnd
      - --noseedbackup
      - --trickledelay=5000
      - --alias={name}
      - --externalip=lnd-{name}
      - --tlsextradomain=lnd-{name}
      - --tlsextradomain=host.docker.internal
      - --listen=0.0.0.0:9735
      - --rpclisten=0.0.0.0:10009
      - --restlisten=0.0.0.0:8080
      - --bitcoin.active
      - --bitcoin.regtest
      - --bitcoin.node=bitcoind
      - --bitcoind.rpchost=bitcoind:18443
      - --bitcoind.rpcuser=polaruser
      - --bitcoind.rpcpass=polarpass
      - --bitcoind.zmqpubrawblock=tcp://bitcoind:28334
      - --bitcoind.zmqpubrawtx=tcp://bitcoind:28335
    volumes:
      - lnd-{name}-data:/home/lnd/.lnd
    ports:
      - "{grpc}:10009"
      - "{rest}:8080"
      - "{p2p}:9735"
    networks:
      - lnviz
"""


def _app_service(nodes: list[dict]) -> str:
    env_lines: list[str] = []
    for n in nodes:
        upper = n["name"].upper()
        env_lines.append(f"      LND_{upper}_REST: https://lnd-{n['name']}:8080")
        env_lines.append(f"      LND_{upper}_TLS_CERT_PATH: /lnd/{n['name']}/tls.cert")
        env_lines.append(
            f"      LND_{upper}_MACAROON_PATH: /lnd/{n['name']}/data/chain/bitcoin/regtest/admin.macaroon"
        )
    env_block = "\n".join(env_lines)

    vol_lines = [f"      - lnd-{n['name']}-data:/lnd/{n['name']}:ro" for n in nodes]
    vol_block = "\n".join(vol_lines)

    depends = "\n".join(f"      - lnd-{n['name']}" for n in nodes)

    return f"""
  app:
    build: .
    container_name: lnviz-app
    restart: unless-stopped
    depends_on:
{depends}
    environment:
{env_block}
      POLL_INTERVAL: "10"
      LOG_LEVEL: INFO
      BITCOIND_RPC_URL: http://bitcoind:18443
      BITCOIND_RPC_USER: polaruser
      BITCOIND_RPC_PASS: polarpass
    volumes:
      - ./data:/app/data
{vol_block}
    ports:
      - "8000:8000"
    networks:
      - lnviz
"""


def _footer(nodes: list[dict]) -> str:
    vols = ["  bitcoind-data:"]
    for n in nodes:
        vols.append(f"  lnd-{n['name']}-data:")
    vol_block = "\n".join(vols)
    return f"""
volumes:
{vol_block}

networks:
  lnviz:
    driver: bridge
"""


def _validate(nodes: list[dict]) -> None:
    if not nodes:
        raise SystemExit("nodes.json is empty")
    seen: dict[str, set] = {"name": set(), "rest": set(), "grpc": set(), "p2p": set()}
    for n in nodes:
        for key in ("name", "color", "rest", "grpc", "p2p"):
            if key not in n:
                raise SystemExit(f"node missing key '{key}': {n}")
        for key in ("name", "rest", "grpc", "p2p"):
            if n[key] in seen[key]:
                raise SystemExit(f"duplicate {key}={n[key]!r} in nodes.json")
            seen[key].add(n[key])


def main() -> None:
    nodes = json.loads(NODES_PATH.read_text(encoding="utf-8"))
    _validate(nodes)
    parts = [HEADER]
    for n in nodes:
        parts.append(LND_TEMPLATE.format(name=n["name"], grpc=n["grpc"], rest=n["rest"], p2p=n["p2p"]))
    parts.append(_app_service(nodes))
    parts.append(_footer(nodes))
    COMPOSE_PATH.write_text("".join(parts), encoding="utf-8")
    names = ", ".join(n["name"] for n in nodes)
    print(f"generated {COMPOSE_PATH.name} with {len(nodes)} nodes: {names}")


if __name__ == "__main__":
    main()
