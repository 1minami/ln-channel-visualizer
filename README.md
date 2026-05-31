# ln-channel-visualizer

Polar regtest の 3ノード(Alice/Bob/Carol) をビジュアル表示する Web UI。
チャネル残高をリアルタイム表示し、ノード間送金を実行できる。

## 構成

- Backend: FastAPI + WebSocket、LND REST API (macaroon認証)
- Frontend: React + Vite (SVG可視化)
- 永続化: SQLite (送金履歴)
- 実行: Docker Compose (ローカル)

## セットアップ手順 (全Docker構成)

Polar GUI 不要。Docker Compose だけで完結。bitcoind + LND × 3 + app を一括起動。

### 必要なもの
- Docker Desktop (Windows/Mac) または Docker Engine + Compose (Linux)

### 1. 起動

```bash
docker compose up -d --build
```

bitcoind / lnd-alice / lnd-bob / lnd-carol / app の5コンテナ起動。

### 2. ネットワーク初期化 (初回のみ)

```bash
bash scripts/init-network.sh
```

実行内容:
1. bitcoind ウォレット作成 + 101 blocks マイニング
2. 各 LND ノードに 5 BTC 入金 + 6 blocks マイニング
3. alice→bob, bob→carol ピア接続
4. alice→bob (1,000,000 sat), bob→carol (1,000,000 sat) チャネル開設
5. 6 blocks マイニングしてチャネルアクティブ化

### 3. UI 確認

http://localhost:8000 → 3ノード残高 + 送金UI

### 4. 追加マイニング (チャネル状態を確定したい時)

```bash
docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=polarpass \
  generatetoaddress 6 $(docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=polarpass getnewaddress)
```

### 5. 停止 / リセット

```bash
docker compose down            # 状態保持
docker compose down -v         # ボリューム削除 (完全リセット)
```

## ローカル開発 (frontend hot reload)

```bash
source /c/Users/ryo11/Antigrabity/.venv/Scripts/activate
pip install -r requirements.txt
python main.py  # backend
# 別端末
cd frontend && npm install && npm run dev  # http://localhost:5173
```

backend の `.env` は LND コンテナを 直接参照する場合 `https://localhost:8081` 等。

## API

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/snapshot` | 全ノードの info/channels/balance |
| GET | `/api/payments` | 送金履歴 (最新50件) |
| POST | `/api/send` | 送金実行 `{source, dest, amount_sat}` |
| WS | `/ws/balances` | 残高ストリーム (3秒間隔) |
| GET | `/healthz` | ヘルスチェック |

## MVP スコープ

- 残高表示 + 3ノード可視化
- 送金ボタン (Alice/Bob/Carol 任意間)
- 送金履歴ログ (SQLite)

## 非目標 (将来拡張)

- アニメーション送金経路表示
- チャネル開閉 UI (Polar 上で手動操作)
- 推計値ダッシュボード (受信/送信可能額)
- mainnet/testnet 接続

## 関連

- [Polar 公式](https://lightningpolar.com/)
- [LND REST API](https://lightning.engineering/api-docs/api/lnd/)
- 親アイデア: `knowledge/lightning-network-app-ideas.md` 3.2
