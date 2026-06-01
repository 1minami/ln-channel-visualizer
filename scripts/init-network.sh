#!/usr/bin/env bash
# regtest LN ネットワーク初期化 (nodes.json 汎用 / リングトポロジ):
# 1. bitcoind に wallet 作成 + 101 blocks マイニング
# 2. 各 LND ノードに資金 (sendtoaddress + マイニング)
# 3. リング状にピア接続 + チャネル開設 (node[i] -> node[i+1], 末尾 -> 先頭)
# 4. 6 blocks マイニングでチャネルをアクティブ化
#
# ノード定義の single source of truth = ../nodes.json.
# ノード追加時はこのスクリプトの変更不要 (nodes.json の name を自動で読む).
set -euo pipefail
# Git Bash (MSYS) が docker exec の引数パスを Windows パスに変換するのを防ぐ
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODES_JSON="$SCRIPT_DIR/../nodes.json"

# nodes.json から name を順序どおり取得
mapfile -t NAMES < <(grep -oP '"name":\s*"\K[^"]+' "$NODES_JSON")
N=${#NAMES[@]}
if [ "$N" -lt 2 ]; then
  echo "need >= 2 nodes in nodes.json (got $N)" >&2
  exit 1
fi
echo "nodes ($N): ${NAMES[*]}"

BTC="docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=polarpass"
lncli() { docker compose exec -T "lnd-$1" lncli --lnddir=/home/lnd/.lnd --network=regtest "${@:2}"; }

echo "== wait for bitcoind =="
until $BTC getblockchaininfo >/dev/null 2>&1; do sleep 1; done

echo "== create wallet =="
$BTC -named createwallet wallet_name=default load_on_startup=true >/dev/null 2>&1 || true
MINING_ADDR=$($BTC getnewaddress)
echo "mining addr: $MINING_ADDR"

echo "== mine 101 blocks (matures coinbase) =="
$BTC generatetoaddress 101 "$MINING_ADDR" >/dev/null

echo "== wait for LND nodes =="
for n in "${NAMES[@]}"; do
  until lncli "$n" getinfo >/dev/null 2>&1; do sleep 2; done
  echo "$n ready"
done

echo "== collect pubkeys =="
declare -A PUB
for n in "${NAMES[@]}"; do
  PUB[$n]=$(lncli "$n" getinfo | grep -oP '"identity_pubkey":\s*"\K[^"]+')
  echo "$n=${PUB[$n]}"
done

echo "== fund LND nodes =="
for n in "${NAMES[@]}"; do
  ADDR=$(lncli "$n" newaddress p2wkh | grep -oP '"address":\s*"\K[^"]+')
  echo "$n addr: $ADDR"
  $BTC sendtoaddress "$ADDR" 5 >/dev/null
done
$BTC generatetoaddress 6 "$MINING_ADDR" >/dev/null
echo "funded + 6 blocks"

echo "== connect peers (ring) =="
for ((i = 0; i < N; i++)); do
  a=${NAMES[$i]}
  b=${NAMES[$(((i + 1) % N))]}
  lncli "$a" connect "${PUB[$b]}@lnd-$b:9735" || true
done
sleep 2

echo "== open channels (ring) =="
for ((i = 0; i < N; i++)); do
  a=${NAMES[$i]}
  b=${NAMES[$(((i + 1) % N))]}
  echo "channel $a -> $b"
  lncli "$a" openchannel --node_key="${PUB[$b]}" --local_amt=1000000 --push_amt=200000
done

echo "== mine 6 blocks (activate channels) =="
$BTC generatetoaddress 6 "$MINING_ADDR" >/dev/null
sleep 3

echo "== final state =="
for n in "${NAMES[@]}"; do
  echo "-- $n channels --"
  lncli "$n" listchannels | grep -E '"active"|"capacity"|"local_balance"|"remote_pubkey"' || true
done

echo "✅ done. open http://localhost:8000"
