# SPEC — Phase 1 ロードマップ実装

EXPLANATION.md セクション7「Phase 1（すぐやる・低コスト高効果）」3機能を実装する。

---

## 受入条件

### 機能1: インボイス生成 UI
- 任意ノードで bolt11 を生成し、画面に表示・コピーできる。
- backend に `POST /api/invoice` を追加。`{node, amount_sat, memo?}` → `{payment_request, r_hash}`。
- 生成した bolt11 を「外部 bolt11 貼付」モードに流用できる（プル型送金を体感）。

### 機能2: peer host 自動補完
- `GET /api/nodes` が各ノードに `host`（= `lnd-<name>`）を含めて返す。
- チャネル開設フォームの「To」を変更すると「Peer host」が自動で `lnd-<dest>` に更新される。
- 手動編集は引き続き可能（自動補完は上書き、ユーザー編集を妨げない）。

### 機能3: チャネルポリシー表示
- 各チャネル線のラベルに base_fee / fee_rate / CLTV delta を表示。
- backend が各チャネルの `chan_id` とポリシーを snapshot に含める。

---

## 非目標
- 認証・LANバインド制限（Phase 3）。
- `/v2/router/send` 移行、MPP（Phase外）。
- インボイスの有効期限/金額0（amountless）対応。生成は固定額のみ。
- ポリシーの編集（updatechanpolicy）。表示のみ。
- App.tsx のコンポーネント分割（可読性提案、今回スコープ外）。

---

## 仕様詳細

### 機能1: インボイス生成
**backend (`main.py`)**
```
class InvoiceRequest(BaseModel):
    node: str
    amount_sat: int
    memo: str = ""

POST /api/invoice
  - node が CLIENTS になければ 404
  - amount_sat <= 0 なら 400
  - dst.add_invoice(amount_sat, memo) を呼ぶ
  - return {payment_request, r_hash}
```
`lnd_client.add_invoice` は既存（変更不要）。

**frontend (`App.tsx`)**
- 「💸 送金」パネル付近に新パネル「📨 インボイス生成」。
- node select + amount(number) + memo(text) + 「生成」ボタン。
- 結果 bolt11 を readonly textarea に表示 + 「コピー」ボタン（`navigator.clipboard`）。
- 「外部送金にセット」ボタン: `sendMode="external_invoice"` + `extInvoice` に流し込む。

### 機能2: peer host 自動補完
**backend (`main.py`)**
- `_node_defs()` を import 時1回読みに集約（現状 `NODE_NAMES`/`NODE_COLORS` で2回 read_text → 1回に。EXPLANATION 改善提案🟡も同時解消）。
- `NODE_HOSTS: dict[str,str] = {name: f"lnd-{name}" for name in NODE_NAMES}`。
- `/api/nodes` の各要素に `"host": NODE_HOSTS[name]` を追加。
  - 根拠: docker-compose で全 LND が `--listen=0.0.0.0:9735`、Polar内DNS名 `lnd-<name>` で解決。p2p 公開ポート(9736+)はホスト側のみ、コンテナ間通信には不要。

**frontend (`App.tsx`)**
- `NodeDef` 型に `host?: string` 追加。
- `chDest` の `onChange` で host も更新: `setChHost(hostOf(value))`。`hostOf` は nodeDefs から引く（fallback `lnd-<name>`）。
- 初期化（`/api/nodes` fetch後）も `hostOf` 使用。

### 機能3: チャネルポリシー表示
**backend (`lnd_client.py`)**
```
async def get_chan_info(chan_id: str) -> dict:
    GET /v1/graph/edge/{chan_id}
```
**backend (`main.py`) `_snapshot`**
- 各 channel に `chan_id`（= `ch.get("chan_id")`）を追加。
- chan_id が "0"/空（未confirm）以外なら `get_chan_info` を呼び、自ノード pubkey が node1_pub か node2_pub かを判定して**自分が課すポリシー**を抽出:
  - `policy = {base_fee_msat, fee_rate_ppm, cltv_delta}`
- 失敗・未確定時は `policy: null`。
- 呼び出しは `asyncio.gather` でチャネル単位に並列。ポリシーは `CHAN_POLICY_CACHE[chan_id]` に簡易キャッシュ（毎snapshotの再取得を抑制、regtestで変動しないため）。

**frontend (`App.tsx`)**
- `Channel` 型に `chan_id?: string`, `policy?: {base_fee_msat,fee_rate_ppm,cltv_delta}|null` 追加。
- チャネルラベル rect を縦に拡張し、最下行に
  `fee {base}msat + {ppm}ppm · cltv {delta}` を追記（policy あるときのみ）。

---

## 例外・境界
- pending チャネル（chan_id="0"）: policy 取得しない、`null` 表示なし。
- get_chan_info が graph 未伝播で 404: try/except で握り、`null`。
- amount 0 / 負: backend 400、frontend ボタン disable。
- clipboard 非対応環境: textarea を選択させる fallback（select()）。

---

## テスト方針
- ローカル Docker 起動で手動確認（ユーザー指定）:
  1. `python scripts/gen-compose.py`（compose 変更なし想定だが整合確認）
  2. `docker compose up -d --build`
  3. `bash scripts/init-network.sh`
  4. UI で: インボイス生成→外部送金で支払い / 開設To変更でhost自動入力 / チャネル線にfee表示
- 既存自動テストなし。今回も pytest 追加は非目標（手動確認のみ）。

---

## 互換性
- `/api/nodes` は既存キー（name,color）を維持し host を**追加**するのみ → 後方互換。
- snapshot の channel に chan_id/policy を**追加** → フロント既存描画に影響なし。
- 新エンドポイント追加のみ、既存エンドポイント挙動は不変。

---

## ロールバック
- 各機能は独立。問題時は該当の追加コード（エンドポイント/パネル/policy取得）を削除すれば元に戻る。
- DB スキーマ変更なし。

---

## 影響ファイル
- `main.py` — `/api/invoice` 追加、`/api/nodes` に host、`_snapshot` に chan_id/policy、`_node_defs` 1回読み集約
- `backend/lnd_client.py` — `get_chan_info` 追加
- `frontend/src/App.tsx` — インボイス生成パネル、host 自動補完、ポリシーラベル
- `EXPLANATION.md` — Phase 1 を「実装済み」に更新、改善提案🟡(_node_defs 2回読み)を解消済みに
