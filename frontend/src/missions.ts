// 学習ミッション定義（フロント同梱 SSOT）。
// 判定はフロント完結・セッション内のみ（リロードでリセット）。
// 既存の送金 API 応答（lastSend）から自動判定する。新規 backend API なし。

export type LastSend = {
  api: "send" | "pay_invoice"; // 内部送金 or 外部 bolt11 支払い
  source: string;
  dest: string; // pay_invoice は解決後のノード名（外部宛は "external(...)"）
  status: "success" | "failed";
  hops: number; // 経路のホップ数（マルチホップ判定用）
  fee?: number; // total_fees（手数料 sat）。手数料ミッション判定用
  path?: string[]; // 経由ノード名列（source 含む全体, 例 ["alice","bob","carol"]）
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
  {
    id: "pay-fee",
    title: "⑤ 手数料を払う（マルチホップで中継料を体感）",
    hint:
      "直接チャネルがない宛先（例 alice → carol）へ送ると中継ノードを経由し、各ホップが手数料を取る。" +
      "base fee（固定）+ rate（金額比例）の合計が total_fees。手数料 > 0 の送金成功で達成。",
    check: (i) =>
      i.lastSend?.status === "success" && (i.lastSend.fee ?? 0) > 0,
  },
  {
    id: "both-routes",
    title: "⑥ 2経路を制覇（alice → carol を bob 経由・dave 経由 両方）",
    hint:
      "リング接続では alice → carol に2通りの2ホップ経路がある（bob 経由 / dave 経由）。" +
      "「経路選択」モードで両方を送金成功させると、LND の経路選択と冗長性を体感できる。",
    check: (i) => {
      const ls = i.lastSend;
      if (ls?.status === "success" && ls.dest === "carol" && ls.path) {
        if (ls.path.includes("bob")) i.flags.viaBobSeen = true;
        if (ls.path.includes("dave")) i.flags.viaDaveSeen = true;
      }
      return !!i.flags.viaBobSeen && !!i.flags.viaDaveSeen;
    },
  },
  {
    id: "bidirectional",
    title: "⑦ 双方向リング（alice → carol と carol → alice の両方向）",
    hint:
      "リングは双方向に回れる。同じ2ノード間を往復で送ると、流動性が一方向に偏っても逆回りで送れることが分かる。" +
      "alice → carol と carol → alice を両方成功させれば達成。",
    check: (i) => {
      const ls = i.lastSend;
      if (ls?.status === "success") {
        if (ls.source === "alice" && ls.dest === "carol") i.flags.aToC = true;
        if (ls.source === "carol" && ls.dest === "alice") i.flags.cToA = true;
      }
      return !!i.flags.aToC && !!i.flags.cToA;
    },
  },
];
