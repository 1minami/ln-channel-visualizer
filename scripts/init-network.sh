#!/usr/bin/env bash
# regtest LN ネットワーク初期化:
# 1. bitcoind に wallet 作成 + 101 blocks マイニング
# 2. 各 LND ノードに資金 (sendtoaddress + マイニング)
# 3. alice→bob→carol ピア接続
# 4. alice→bob, bob→carol チャネル開設 + 6 blocks マイニング
set -euo pipefail
# Git Bash (MSYS) が docker exec の引数パスを Windows パスに変換するのを防ぐ
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

BTC="docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=polarpass"
LNCLI_ALICE="docker compose exec -T lnd-alice lncli --lnddir=/home/lnd/.lnd --network=regtest"
LNCLI_BOB="docker compose exec -T lnd-bob lncli --lnddir=/home/lnd/.lnd --network=regtest"
LNCLI_CAROL="docker compose exec -T lnd-carol lncli --lnddir=/home/lnd/.lnd --network=regtest"

echo "== wait for bitcoind =="
until $BTC getblockchaininfo >/dev/null 2>&1; do sleep 1; done

echo "== create wallet =="
$BTC -named createwallet wallet_name=default load_on_startup=true >/dev/null 2>&1 || true
MINING_ADDR=$($BTC getnewaddress)
echo "mining addr: $MINING_ADDR"

echo "== mine 101 blocks (matures coinbase) =="
$BTC generatetoaddress 101 "$MINING_ADDR" >/dev/null

echo "== wait for LND nodes =="
for n in alice bob carol; do
  until docker compose exec -T lnd-$n lncli --lnddir=/home/lnd/.lnd --network=regtest getinfo >/dev/null 2>&1; do
    sleep 2
  done
  echo "$n ready"
done

ALICE_PUB=$($LNCLI_ALICE getinfo | grep -oP '"identity_pubkey":\s*"\K[^"]+')
BOB_PUB=$($LNCLI_BOB getinfo | grep -oP '"identity_pubkey":\s*"\K[^"]+')
CAROL_PUB=$($LNCLI_CAROL getinfo | grep -oP '"identity_pubkey":\s*"\K[^"]+')
echo "alice=$ALICE_PUB"
echo "bob=$BOB_PUB"
echo "carol=$CAROL_PUB"

echo "== fund LND nodes =="
for n in alice bob carol; do
  ADDR=$(docker compose exec -T lnd-$n lncli --lnddir=/home/lnd/.lnd --network=regtest newaddress p2wkh | grep -oP '"address":\s*"\K[^"]+')
  echo "$n addr: $ADDR"
  $BTC sendtoaddress "$ADDR" 5 >/dev/null
done
$BTC generatetoaddress 6 "$MINING_ADDR" >/dev/null
echo "funded + 6 blocks"

echo "== connect peers =="
$LNCLI_ALICE connect "$BOB_PUB@lnd-bob:9735" || true
$LNCLI_BOB connect "$CAROL_PUB@lnd-carol:9735" || true
sleep 2

echo "== open channels =="
$LNCLI_ALICE openchannel --node_key="$BOB_PUB" --local_amt=1000000 --push_amt=200000
$LNCLI_BOB openchannel --node_key="$CAROL_PUB" --local_amt=1000000 --push_amt=200000

echo "== mine 6 blocks (activate channels) =="
$BTC generatetoaddress 6 "$MINING_ADDR" >/dev/null
sleep 3

echo "== final state =="
$LNCLI_ALICE listchannels | grep -E '"active"|"capacity"|"local_balance"|"remote_pubkey"'

echo "✅ done. open http://localhost:8000"
