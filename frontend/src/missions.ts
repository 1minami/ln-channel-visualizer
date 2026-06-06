// 学習ミッション定義（フロント同梱 SSOT）。
// 判定はフロント完結・セッション内のみ（リロードでリセット）。
// 既存の送金 API 応答（lastSend）から自動判定する。新規 backend API なし。

export type LastSend = {
  api: "send" | "pay_invoice"; // 内部送金 or 外部 bolt11 支払い
  source: string;
  dest: string; // pay_invoice は解決後のノード名（外部宛は "external(...)"）
  status: "success" | "failed";
  hops: number; // 経路のホップ数（マルチホップ判定用）
};

export type MissionInput = {
  lastSend?: LastSend;
  // 課題横断の観測フラグ。check 内で副作用更新してよい（例: carolFailSeen）
  flags: Record<string, boolean>;
};

export type Mission = {
  id: string;
  title: string;
  hint: string; // EXPLANATION のアナロジー流用
  check: (input: MissionInput) => boolean;
};

export const MISSIONS: Mission[] = [
  {
    id: "first-send",
    title: "① はじめての送金（alice → bob）",
    hint:
      "「💸 送金」を内部モードにして From=alice / To=bob で送金。チャネルは2人の間の両替トレイ。" +
      "コインをトレイ上で相手側に押すだけ＝オンチェーン取引なしの送金。",
    check: (i) =>
      i.lastSend?.status === "success" &&
      i.lastSend.source === "alice" &&
      i.lastSend.dest === "bob",
  },
  {
    id: "invoice-pull",
    title: "② インボイスで受け取る（bob 生成 → alice が支払い）",
    hint:
      "「📨 インボイス生成」で受取ノード=bob の bolt11 を発行 →「外部送金にセット」→ " +
      "From=alice で支払う。送金は『受取人が請求書を出し送信者が払う』プル型。これが LN の基本。",
    check: (i) =>
      i.lastSend?.api === "pay_invoice" &&
      i.lastSend.status === "success" &&
      i.lastSend.dest === "bob",
  },
  {
    id: "multi-hop",
    title: "③ マルチホップ送金（alice → carol）",
    hint:
      "alice と carol は直接チャネルを持たない（リング接続）。中継ノード（bob か dave）を経由して届く。" +
      "中継は手数料を取る。経路が2ホップ以上で達成。",
    check: (i) =>
      i.lastSend?.status === "success" &&
      i.lastSend.dest === "carol" &&
      i.lastSend.hops >= 2,
  },
  {
    id: "inbound-liquidity",
    title: "④ inbound 不足を体験して解消（carol が受け取れない → 受け取れる）",
    hint:
      "開設直後は受信側の remote（inbound）が 0 で受け取れない。まず carol 宛送金を一度失敗させ（no_route 等）、" +
      "carol から一度送金して inbound を作る or push_amt 付きで開設し直す → 再度 carol 宛送金が成功すれば達成。",
    check: (i) => {
      const ls = i.lastSend;
      // carol 宛の失敗を観測したらフラグを立てる（失敗体験の記録）
      if (ls && ls.dest === "carol" && ls.status === "failed") {
        i.flags.carolFailSeen = true;
      }
      // 失敗を経たうえで carol 宛が成功したら達成
      return (
        !!i.flags.carolFailSeen &&
        ls?.dest === "carol" &&
        ls.status === "success"
      );
    },
  },
];
