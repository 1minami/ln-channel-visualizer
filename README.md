# ln-channel-visualizer

Polar regtest の LN ノード群 (デフォルト Alice/Bob/Carol/Dave の4ノード・リング接続) をビジュアル表示する Web UI。
チャネル残高をリアルタイム表示し、ノード間送金を実行できる。

ノード定義の single source of truth は **`nodes.json`**。ノードを増減するには `nodes.json` を編集して再生成する (下記「ノード追加手順」)。

## 構成

- Backend: FastAPI + WebSocket、LND REST API (macaroon認証)
- Frontend: React + Vite (SVG可視化)
- 永続化: SQLite (送金履歴)
- 実行: Docker Compose (ローカル)

## セットアップ手順 (全Docker構成)

Polar GUI 不要。Docker Compose だけで完結。bitcoind + LND × N (nodes.json 定義数) + app を一括起動。

`docker-compose.yml` は `nodes.json` から自動生成 (直接編集しない):

```bash
python scripts/gen-compose.py
```

### 必要なもの
- Docker Desktop (Windows/Mac) または Docker Engine + Compose (Linux)

### 1. 起動

```bash
docker compose up -d --build
```

bitcoind / lnd-alice / lnd-bob / lnd-carol / lnd-dave / app のコンテナ起動 (ノード数 +2)。

### 2. ネットワーク初期化 (初回のみ)

```bash
bash scripts/init-network.sh
```

実行内容 (nodes.json から自動でノード列を読み、**リング**接続):
1. bitcoind ウォレット作成 + 101 blocks マイニング
2. 各 LND ノードに 5 BTC 入金 + 6 blocks マイニング
3. リング状にピア接続 (node[i]→node[i+1], 末尾→先頭。例: alice→bob→carol→dave→alice)
4. 同じリング順に各 1,000,000 sat (push 200,000) チャネル開設
5. 6 blocks マイニングしてチャネルアクティブ化

### 3. UI 確認

http://localhost:8000 → 全ノード残高 + 送金UI

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
| GET | `/api/nodes` | ノード定義 (name/color, nodes.json 由来) — フロントの描画順・色 |
| GET | `/api/snapshot` | 全ノードの info/channels/balance |
| GET | `/api/payments` | 送金履歴 (最新50件) |
| POST | `/api/send` | 送金実行 `{source, dest, amount_sat}` |
| WS | `/ws/balances` | 残高ストリーム (3秒間隔) |
| GET | `/healthz` | ヘルスチェック |

## ノード追加手順

ノード定義は `nodes.json` に集約。backend (`/api/nodes`)・frontend (描画) ・`docker-compose.yml` ・`init-network.sh` がすべてこれを参照する。

1. `nodes.json` に1行追加 (`name`/`color`/`rest`/`grpc`/`p2p` をユニークに)
2. `python scripts/gen-compose.py` で compose 再生成
3. `docker compose down -v && docker compose up -d --build`
4. `bash scripts/init-network.sh` (リングを再構成)

frontend のコード変更は不要 (`/api/nodes` から動的に描画)。

## MVP スコープ

- 残高表示 + 全ノード可視化 (nodes.json 駆動)
- 送金ボタン (任意ノード間)
- 送金履歴ログ (SQLite)

## 非目標 (将来拡張)

- アニメーション送金経路表示
- チャネル開閉 UI (Polar 上で手動操作)
- 推計値ダッシュボード (受信/送信可能額)
- mainnet/testnet 接続

## Lightning Network 学習メモ

このツールで体感できる LN の基礎概念。

### チャネルと流動性
- **チャネル** = 2ノードがオンチェーンに lock した共有残高（Capacity）。開設後はオンチェーン取引なしに、`local`（自分の送れる量）と `remote`（相手の送れる量＝自分のインバウンド流動性）の間を残高が移動するだけ。
- 送金とは「自分の local を減らし、相手の local（= 自分の remote）を増やす」操作。**Capacity は不変**で、内訳が動く。
- 開設時の `push_amt` で相手側に初期残高を渡せる。これがないと受信側 inbound が 0 で「受け取れない」状態になる。

### マルチホップとリングトポロジ
- 直接チャネルがなくても、中継ノード経由で送れる（**マルチホップ**）。中継ノードは**手数料**を取る。
- 本ツールはノードを**リング**接続（例: alice→bob→carol→dave→alice）。隣同士のみ直接チャネル。
- 離れた宛先は複数経路を持つ。例: `alice→carol` は `alice→bob→carol` と `alice→dave→carol` の2通り。LND が手数料・流動性から選ぶ（「経路選択」モードで比較可能）。
- 中継チャネルの local 残高不足だと `no_route` になる。流動性をどこに用意するかが送金成功の鍵だと体感できる。

### HTLC（送金の仕組み）
- **HTLC** = Hashed Time-Locked Contract。送金が経路を通る間の「条件付き仮押さえ」。
- 受取人が `preimage`（ハッシュの逆像）を提示できれば各ホップが順に確定（**settle**）。提示できなければ **CLTV（time_lock）** の期限切れで全ホップが巻き戻る（**fail**）。資金が途中で消えない安全装置。
- UI の「HTLC イベント」欄で `forward`（転送）→ `settle`（確定）/ `fail`（巻き戻し）の流れをノード視点で観察できる。

### 試す手順の例
1. `alice→carol` を「経路選択」で検索 → 2経路の手数料・CLTV を比較
2. どちらかで送金 → 黄ドットが1ホップずつ流れ、HTLC イベントに forward→settle が並ぶ
3. 同方向に何度も送ると中継の local が枯れて `no_route` → 逆回りや別経路、`push_amt` 付きチャネル開設で流動性を作る

## 関連

- [Polar 公式](https://lightningpolar.com/)
- [LND REST API](https://lightning.engineering/api-docs/api/lnd/)
- 親アイデア: `knowledge/lightning-network-app-ideas.md` 3.2
