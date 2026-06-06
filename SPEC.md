# SPEC — ミッション機能（学習クエスト）

LN 学習効果を高めるため、既存操作（送金・インボイス・チャネル開設）を題材にした
ガイド式ミッションを追加する。初版は **A系（ガイド）3課題 + 障害D 再現容易版1課題 = 計4課題**。

判定は **frontend 完結（自動判定優先）**、進捗は **セッション内のみ（永続化なし）**。

---

## 受入条件

### 全体
- 画面にミッションパネルを表示。4課題のチェックリスト + 進捗（n/4）+ 各課題のヒント展開。
- 各課題は送金系 API 応答（lastSend）から **自動で達成判定** し、達成で✅点灯 + 祝福バナー。
  - 初版は lastSend のみで4課題を判定可能なため WS snapshot/htlc 発火は使わない（簡易版）。
- リロードで進捗はリセットされる（永続化しない）。
- ミッション定義はフロント同梱の `missions.ts` 定数（backend 変更なし）。

### 課題1: 初送金（alice→bob）
- `/api/send` 応答が `status==success && source=="alice" && dest=="bob"` で達成。

### 課題2: インボイス理解（bob 生成 → alice が外部送金で支払い）
- 「📨 インボイス生成」で bob の bolt11 を発行 →「外部送金にセット」→ alice が支払い。
- `/api/pay_invoice` 応答が `status==success && dest=="bob"` で達成。
  - 割り切り: `/api/send`（内部送金）と区別するため **pay_invoice 経由の成功**を判定キーにする。
    「インボイス生成パネルを使った支払い体験」を達成とみなす。

### 課題3: マルチホップ（alice→carol 疎通）
- 送金応答（`/api/send` or `/api/pay_invoice`）が `dest=="carol" && hops.length>=2` で達成。
  - リング接続（alice-bob-carol-dave）で alice→carol は中継1つ以上を通る。

### 課題4: inbound 不足を体験（障害D・再現容易版）
- 段階達成:
  1. carol 宛送金が一度 `failed`（inbound/no_route 等）になるのを観測 → `carolFailSeen` フラグを立てる。
  2. その後 carol 宛送金が `success` する（逆送金や push でinbound確保後）→ 達成。
- フラグは `missionFlagsRef`（ref）で保持し、check 内で副作用更新。
- pay_invoice の失敗応答に dest は含まれないため、fail 観測は内部送金（/api/send）側で拾う。

---

## 非目標
- 進捗の永続化、XP / バッジ / 実績システム。
- パズル/チャレンジ系（B）、クイズ（C）。
- CLTV 期限切れ課題（regtest の時間操作が必要で再現困難）。
- フォースクローズ/ペナルティ（Phase3 Watchtower 連動）。
- backend 判定 / `GET /api/missions` エンドポイント（フロント定数で足りる）。
- 課題達成条件の厳密な順序強制（課題4は観測フラグの組合せで判定）。
- App.tsx のコンポーネント分割（別途・スコープ外）。

---

## 仕様詳細

### missions.ts（新規 / フロント）
```ts
type MissionCheckInput = {
  lastSend?: { api: "send" | "pay_invoice"; source: string; dest: string;
               status: string; hops: number };
  snapshot?: Snapshot;          // WS で受信した最新 snapshot
  htlc?: HtlcEvent;             // 直近の HTLC イベント
  flags: Record<string, boolean>; // 課題横断の観測フラグ（例 carolFailSeen）
};

type Mission = {
  id: string;
  title: string;
  hint: string;                 // EXPLANATION のアナロジー流用
  // 達成なら true。副作用で input.flags を更新してよい（観測フラグ蓄積）
  check: (input: MissionCheckInput) => boolean;
};

export const MISSIONS: Mission[] = [ /* m1..m4 */ ];
```

### App.tsx（既存 / フロント）
- state 追加: `missionDone: Record<string, boolean>`、`missionFlags: Record<string, boolean>`。
- 判定の発火点:
  - `/api/send`・`/api/pay_invoice` 応答ハンドラ内で `MissionCheckInput.lastSend` を作り全 mission `check` を回す。
  - WS `snapshot` / `htlc` 受信時にも `check` を回す（課題4の fail 観測など）。
- 達成時: `missionDone[id]=true` をセット、未達→達成の遷移でトースト表示。
- ミッションパネル: タイトル / ✅or☐ / 「ヒント」開閉 / 進捗 `done/4`。
  - 既存 SVG リング・各操作パネルと同列に配置（左サイド or 上部の新カード）。

### 判定材料の確認（実装済みで利用可能）
- `/api/send` 応答: `status, hops[]`（main.py 335-341）。source/dest はリクエスト側で保持。
- `/api/pay_invoice` 応答: `status, dest(解決名), hops[]`（main.py 406-413）。
- WS `snapshot`: `nodes[name].channels[].{remote_pubkey, local_balance, remote_balance, active}`。
- WS `htlc`: `{node, event_type, kind, ...}`。

---

## 例外・境界
- 送金 fail（HTTP 502）時もフロントは応答本文/例外から `status:"failed"` を組み立てて `check` に渡す
  （課題4の fail 観測に必須）。現状フロントの送金失敗ハンドリングを要確認 → 失敗時も lastSend を生成。
- snapshot に `error` を含むノードがある場合、その channels 判定はスキップ（既存 `{"error":...}` 形式）。
- 同一課題の重複達成: `missionDone[id]` が true なら再判定しても no-op（トースト二重表示を防ぐ）。
- carol 宛 success が fail より先に起きた場合: 課題4は「fail 観測フラグ」が立つまで未達のまま
  （意図通り — 失敗体験を経ていない）。

---

## テスト方針
- ローカル Docker 起動で手動確認（既存方針）:
  1. `docker compose up -d --build`
  2. `bash scripts/init-network.sh`
  3. UI で4課題を順に実施し ✅ 点灯・進捗・トーストを確認:
     - 課題1: alice→bob 送金
     - 課題2: bob インボイス生成→外部送金で alice 支払い
     - 課題3: alice→carol 送金（hops≥2）
     - 課題4: carol 宛で一度 fail を作る→inbound確保→carol宛 success
- 既存自動テストなし。pytest 追加は非目標（手動確認のみ）。

---

## 互換性
- backend 変更なし（API/snapshot/WS の形は不変）。
- フロントは state 追加とパネル追加のみ。既存送金/チャネル/マイニング動作に影響なし。

---

## ロールバック
- ミッションパネルと `missions.ts`、App.tsx の mission 関連 state/判定呼び出しを削除すれば元に戻る。
- DB / backend / nodes.json 変更なし。

---

## 影響ファイル
- `frontend/src/missions.ts` — 新規。4課題の定義と `check` 関数。
- `frontend/src/App.tsx` — mission state、判定発火（send/pay/WS）、ミッションパネル UI。
- `EXPLANATION.md` — §7 ロードマップに「ミッション機能（実装済み）」を追記。
