# ln-channel-visualizer

Polar regtest の 3ノード(Alice/Bob/Carol) をビジュアル表示する Web UI。
チャネル残高をリアルタイム表示し、ノード間送金を実行できる。

## 構成

- Backend: FastAPI + WebSocket、LND REST API (macaroon認証)
- Frontend: React + Vite (SVG可視化)
- 永続化: SQLite (送金履歴)
- 実行: Docker Compose (ローカル)

## セットアップ手順

### 1. Polar インストール

[Polar](https://lightningpolar.com/) をダウンロード→インストール。Docker Desktop が必要。

### 2. ネットワーク作成

1. Polar 起動 → Create Network
2. ノード構成: LND × 3 (Alice, Bob, Carol)
3. Start ボタンでネットワーク起動

### 3. チャネル開設

1. Alice → Bob: 1,000,000 sat (Alice の Local)
2. Bob → Carol: 1,000,000 sat (Bob の Local)
3. マイニング (Polar 内 Bitcoin Core → Mine 6 blocks)

### 4. 認証情報の取得

各ノードを右クリック → View Node Info → File Paths タブから以下を確認:

- TLS Cert: `tls.cert` のフルパス
- Macaroon: `admin.macaroon` のフルパス

または、ノードを右クリック → Export → Linker Compatible で zip を取得し展開。

`secrets/` ディレクトリに各ノード分を配置:

```
secrets/
├── alice/
│   ├── tls.cert
│   └── admin.macaroon
├── bob/
│   ├── tls.cert
│   └── admin.macaroon
└── carol/
    ├── tls.cert
    └── admin.macaroon
```

### 5. REST ポート確認

Polar のノード詳細 → Connect → REST タブで URL を確認。Polar デフォルト:

- Alice: `https://127.0.0.1:8081`
- Bob:   `https://127.0.0.1:8082`
- Carol: `https://127.0.0.1:8083`

### 6. .env 作成

```bash
cp .env.example .env
# 必要に応じて REST URL / パスを編集
```

Docker から Polar (ホスト上) へアクセスする場合、`.env` の REST URL は `https://host.docker.internal:8081` 等に書き換える。

### 7. 起動

#### Docker (推奨)

```bash
docker compose up -d --build
```

→ http://localhost:8000 を開く

#### ローカル開発 (frontend hot reload)

```bash
# ルートの venv を利用
source /c/Users/ryo11/Antigrabity/.venv/Scripts/activate
pip install -r requirements.txt

# Backend
python main.py

# 別ターミナル: Frontend (Vite dev server)
cd frontend
npm install
npm run dev
```

→ Vite dev: http://localhost:5173 (API は :8000 にプロキシ)

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
