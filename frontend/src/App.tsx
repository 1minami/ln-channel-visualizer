import { useEffect, useMemo, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { MISSIONS, type LastSend } from "./missions";

type ChanPolicy = { base_fee_msat: number; fee_rate_ppm: number; cltv_delta: number };
type Channel = {
  remote_pubkey: string;
  capacity: number;
  local_balance: number;
  remote_balance: number;
  active: boolean;
  channel_point: string;
  chan_id?: string;
  policy?: ChanPolicy | null;
};
type NodeInfo = {
  pubkey?: string;
  alias?: string;
  num_channels?: number;
  channels?: Channel[];
  balance_sat?: number;
  wallet_sat?: number;
  error?: string;
};
type Snapshot = { nodes: Record<string, NodeInfo> };
type Payment = {
  id: number;
  timestamp: string;
  source: string;
  dest: string;
  amount_sat: number;
  status: string;
  error?: string;
};
type HistoryPoint = { t: number } & Record<string, number>;
type Anim = { id: number; from: string; to: string };
type NodeDef = { name: string; color: string; host?: string };
type HtlcEvent = {
  node: string;
  event_type: string;
  incoming_channel_id: string;
  outgoing_channel_id: string;
  timestamp_ns: string;
  kind: string;
  detail: any;
};
type RouteHop = { pub_key: string; name: string; amt_to_forward: number; fee: number; chan_id: string };
type RouteCandidate = {
  total_fees: number;
  total_amt: number;
  total_time_lock: number;
  hops: RouteHop[];
  _raw: any;
};
type SendMode = "internal" | "external_invoice" | "route_select";

type NodeName = string;
const FALLBACK_COLOR = "#8b949e";
const HISTORY_MAX = 60;
const HOP_MS = 1200;
const ERROR_TIMEOUT_MS = 6000;

function humanizePaymentError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("no_route") || s.includes("unable to find a path"))
    return "経路なし → 中継チャネルの local 残高不足 or チャネル inactive。⛏ で 6 blocks マイニング、または送金量を減らす";
  if (s.includes("insufficient_balance") || s.includes("insufficient local balance"))
    return "残高不足 → 送信元 local_balance < 送金額。フォワード方向で残高を作る or 送金量を減らす";
  if (s.includes("invoice expired")) return "インボイス期限切れ → 再生成して再送";
  if (s.includes("already paid")) return "支払い済 → 同じ invoice は二重送金不可";
  if (s.includes("channel not active") || s.includes("channel is inactive"))
    return "チャネル inactive → 6 blocks マイニングで confirm、または peer 切断中";
  if (s.includes("self-payments not allowed")) return "自己送金不可 → from/to を別ノードに";
  if (s.includes("amount must be") || s.includes("must be positive")) return "金額不正 → 1 以上の整数";
  if (s.includes("not found")) return "ノード/チャネル未検出 → 名前を確認";
  return raw;
}

function nodePosition(idx: number, total: number, cx: number, cy: number, r: number) {
  const angle = (idx / total) * 2 * Math.PI - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function Help({ text }: { text: string }) {
  return (
    <span className="help" title={text}>?</span>
  );
}

export default function App() {
  const [nodeDefs, setNodeDefs] = useState<NodeDef[]>([]);
  const NODE_ORDER = useMemo(() => nodeDefs.map((n) => n.name), [nodeDefs]);
  const COLORS = useMemo<Record<string, string>>(
    () => Object.fromEntries(nodeDefs.map((n) => [n.name, n.color])),
    [nodeDefs],
  );
  const colorOf = (name: string) => COLORS[name] ?? FALLBACK_COLOR;
  const hostOf = (name: string) => nodeDefs.find((d) => d.name === name)?.host ?? `lnd-${name}`;

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [source, setSource] = useState<NodeName>("");
  const [dest, setDest] = useState<NodeName>("");
  const [amount, setAmount] = useState(1000);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [anims, setAnims] = useState<Anim[]>([]);
  const animIdRef = useRef(0);

  const [chSource, setChSource] = useState<NodeName>("");
  const [chDest, setChDest] = useState<NodeName>("");
  const [chAmount, setChAmount] = useState(1000000);
  const [chHost, setChHost] = useState("");
  const [chBusy, setChBusy] = useState(false);
  const [mineBlocks, setMineBlocks] = useState(6);
  const [mineNode, setMineNode] = useState<NodeName>("");
  const [mineBusy, setMineBusy] = useState(false);

  const [sendMode, setSendMode] = useState<SendMode>("internal");
  const [extInvoice, setExtInvoice] = useState("");
  const [routes, setRoutes] = useState<RouteCandidate[]>([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [htlcEvents, setHtlcEvents] = useState<HtlcEvent[]>([]);

  const [invNode, setInvNode] = useState<NodeName>("");
  const [invAmount, setInvAmount] = useState(1000);
  const [invMemo, setInvMemo] = useState("");
  const [invResult, setInvResult] = useState("");
  const [invBusy, setInvBusy] = useState(false);

  // サイドバー開閉 (狭幅では折りたたみ運用)
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // 学習ミッション: 達成状態（セッション内のみ。リロードでリセット）
  const [missionDone, setMissionDone] = useState<Record<string, boolean>>({});
  const [missionOpen, setMissionOpen] = useState<Record<string, boolean>>({});
  // 課題横断の観測フラグ（例: carolFailSeen）。check 内で副作用更新するため ref で保持
  const missionFlagsRef = useRef<Record<string, boolean>>({});

  // 送金系ハンドラから呼ぶ。lastSend を全ミッションに渡し、未達→達成の遷移で祝福表示
  const runMissionChecks = (lastSend: LastSend) => {
    setMissionDone((prev) => {
      const next = { ...prev };
      const newly: string[] = [];
      for (const m of MISSIONS) {
        if (next[m.id]) continue;
        try {
          if (m.check({ lastSend, flags: missionFlagsRef.current })) {
            next[m.id] = true;
            newly.push(m.title);
          }
        } catch {
          /* check の例外は無視（達成扱いにしない） */
        }
      }
      if (newly.length) setInfo(`🎉 ミッション達成: ${newly.join(" / ")}`);
      return next;
    });
  };

  // ノード定義を取得し、各セレクタの初期値を設定 (nodes.json 由来)
  useEffect(() => {
    fetch("/api/nodes")
      .then((r) => (r.ok ? r.json() : []))
      .then((defs: NodeDef[]) => {
        setNodeDefs(defs);
        const names = defs.map((d) => d.name);
        if (names.length >= 2) {
          setSource(names[0]);
          setDest(names[names.length - 1]);
          setChSource(names[0]);
          setChDest(names[1]);
          setChHost(defs.find((d) => d.name === names[1])?.host ?? `lnd-${names[1]}`);
          setMineNode(names[0]);
          setInvNode(names[names.length - 1]); // 受取側を既定に
        }
      })
      .catch(() => setError("ノード定義取得失敗 (/api/nodes)"));
  }, []);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/balances`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.snapshot) {
        const s: Snapshot = msg.snapshot;
        setSnap(s);
        const t = Date.now();
        const point: HistoryPoint = { t };
        for (const [name, info] of Object.entries(s.nodes)) {
          point[name] = info?.balance_sat ?? 0;
        }
        setHistory((h) => [...h, point].slice(-HISTORY_MAX));
      } else if (msg.htlc) {
        setHtlcEvents((arr) => [msg.htlc as HtlcEvent, ...arr].slice(0, 30));
      }
    };
    ws.onerror = () => setError("WebSocket 接続失敗");
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), ERROR_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [error]);
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(""), ERROR_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [info]);

  const refreshPayments = async () => {
    const r = await fetch("/api/payments");
    if (r.ok) setPayments(await r.json());
  };

  useEffect(() => {
    refreshPayments();
  }, []);

  const pubkeyToName = (pk: string): NodeName | null => {
    for (const n of NODE_ORDER) if (snap?.nodes[n]?.pubkey === pk) return n;
    return null;
  };

  const animateHops = (from: NodeName, hops: { pub_key: string }[]) => {
    let prev: NodeName = from;
    hops.forEach((hop, i) => {
      const to = pubkeyToName(hop.pub_key);
      if (!to) return;
      const segFrom = prev;
      setTimeout(() => {
        const id = ++animIdRef.current;
        setAnims((a) => [...a, { id, from: segFrom, to }]);
        setTimeout(() => setAnims((a) => a.filter((x) => x.id !== id)), HOP_MS);
      }, i * HOP_MS);
      prev = to;
    });
  };

  const send = async () => {
    setSending(true);
    setError("");
    try {
      const r = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, dest, amount_sat: amount }),
      });
      if (!r.ok) {
        setError(humanizePaymentError(await r.text()));
        runMissionChecks({ api: "send", source, dest, status: "failed", hops: 0 });
      } else {
        const body = await r.json();
        const hops = body.hops || [];
        if (hops.length > 0) {
          animateHops(source, hops);
          const hopNames = [source, ...hops.map((h: any) => pubkeyToName(h.pub_key)).filter(Boolean)];
          setInfo(`✅ 経路: ${hopNames.join(" → ")} · 手数料 ${body.total_fees} sat`);
        }
        runMissionChecks({ api: "send", source, dest, status: "success", hops: hops.length });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
      await refreshPayments();
    }
  };

  const openChannel = async () => {
    setChBusy(true);
    setError("");
    try {
      const r = await fetch("/api/channels/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: chSource,
          dest: chDest,
          local_funding_amount: chAmount,
          peer_host: chHost,
        }),
      });
      const body = await r.text();
      if (!r.ok) setError(humanizePaymentError(body));
      else setInfo(`📡 開設要求送信. 6 blocks マイニング後アクティブ. ${body}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setChBusy(false);
    }
  };

  const closeChannel = async (nodeName: string, channelPoint: string) => {
    if (!channelPoint.includes(":")) return;
    const [txid, idxStr] = channelPoint.split(":");
    if (!confirm(`${nodeName} のチャネル ${txid.slice(0, 12)}... を閉じる？`)) return;
    setChBusy(true);
    try {
      const r = await fetch("/api/channels/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: nodeName,
          funding_txid: txid,
          output_index: parseInt(idxStr, 10),
          force: false,
        }),
      });
      const body = await r.text();
      if (!r.ok) setError(humanizePaymentError(body));
      else setInfo(`🔒 閉鎖要求送信. ${body}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setChBusy(false);
    }
  };

  const payExternal = async () => {
    setSending(true);
    setError("");
    try {
      const r = await fetch("/api/pay_invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, payment_request: extInvoice.trim() }),
      });
      if (!r.ok) {
        setError(humanizePaymentError(await r.text()));
        // 失敗応答に dest は含まれない（解決不能）。fail 観測は内部送金側で拾う
        runMissionChecks({ api: "pay_invoice", source, dest: "", status: "failed", hops: 0 });
      } else {
        const body = await r.json();
        setInfo(`✅ 外部送金 ${body.amount_sat} sat → ${body.dest} · 手数料 ${body.total_fees}`);
        setExtInvoice("");
        runMissionChecks({
          api: "pay_invoice",
          source,
          dest: body.dest,
          status: "success",
          hops: (body.hops || []).length,
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
      await refreshPayments();
    }
  };

  const queryRoutes = async () => {
    setRoutesLoading(true);
    setError("");
    setRoutes([]);
    try {
      const r = await fetch("/api/routes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, dest, amount_sat: amount }),
      });
      if (!r.ok) setError(humanizePaymentError(await r.text()));
      else {
        const body = await r.json();
        setRoutes(body.routes || []);
        if (!body.routes?.length) setInfo("経路候補なし");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRoutesLoading(false);
    }
  };

  const sendOnRoute = async (rt: RouteCandidate) => {
    setSending(true);
    setError("");
    try {
      const r = await fetch("/api/send_route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, dest, amount_sat: amount, route: rt._raw }),
      });
      if (!r.ok) {
        setError(humanizePaymentError(await r.text()));
        runMissionChecks({ api: "send", source, dest, status: "failed", hops: 0 });
      } else {
        setInfo(`✅ 経路指定送金成功 · 手数料 ${rt.total_fees} sat`);
        animateHops(source, rt.hops.map((h) => ({ pub_key: h.pub_key })));
        runMissionChecks({ api: "send", source, dest, status: "success", hops: rt.hops.length });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
      await refreshPayments();
    }
  };

  const mine = async () => {
    setMineBusy(true);
    setError("");
    try {
      const r = await fetch("/api/mine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blocks: mineBlocks, to_node: mineNode }),
      });
      const body = await r.text();
      if (!r.ok) setError(humanizePaymentError(body));
      else setInfo(`⛏ ${mineBlocks} blocks マイニング完了 → ${mineNode} に報酬`);
    } catch (e) {
      setError(String(e));
    } finally {
      setMineBusy(false);
    }
  };

  const genInvoice = async () => {
    setInvBusy(true);
    setError("");
    try {
      const r = await fetch("/api/invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node: invNode, amount_sat: invAmount, memo: invMemo }),
      });
      if (!r.ok) setError(humanizePaymentError(await r.text()));
      else {
        const body = await r.json();
        setInvResult(body.payment_request || "");
        setInfo(`📨 ${invNode} で ${invAmount} sat のインボイス生成`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setInvBusy(false);
    }
  };

  const copyInvoice = async () => {
    if (!invResult) return;
    try {
      await navigator.clipboard.writeText(invResult);
      setInfo("📋 bolt11 をコピー");
    } catch {
      setInfo("コピー不可 → テキストを手動選択してください");
    }
  };

  const useInvoiceInExternal = () => {
    if (!invResult) return;
    setSendMode("external_invoice");
    setExtInvoice(invResult);
    setInfo("外部 bolt11 貼付モードにセット. From を受取側以外にして支払う");
  };

  // ノード数に応じてリング半径・キャンバスをスケール (3〜6+ ノードで破綻しない)
  const layout = useMemo(() => {
    const n = Math.max(NODE_ORDER.length, 1);
    const nodeR = n <= 4 ? 40 : 34;
    const r = 110 + n * 24; // リング半径: ノード増で拡大
    const margin = nodeR + 92; // 外向き残高ボックス + ラベル用の余白
    const cx = r + margin;
    const cy = r + margin;
    const size = (r + margin) * 2;
    return { n, nodeR, r, cx, cy, size };
  }, [NODE_ORDER]);

  const positions = useMemo(
    () => NODE_ORDER.map((_, i) => nodePosition(i, NODE_ORDER.length, layout.cx, layout.cy, layout.r)),
    [NODE_ORDER, layout],
  );

  // 各ノードの中心から外向き単位ベクトル (残高ボックスをリング外側へ置く)
  const outward = (i: number) => {
    const angle = (i / Math.max(NODE_ORDER.length, 1)) * 2 * Math.PI - Math.PI / 2;
    return { ux: Math.cos(angle), uy: Math.sin(angle) };
  };

  const channelLines = useMemo(() => {
    if (!snap) return [];
    const out: { from: number; fromName: NodeName; to: number; toName: NodeName; ch: Channel; key: string }[] = [];
    NODE_ORDER.forEach((name, i) => {
      const node = snap.nodes[name];
      node?.channels?.forEach((ch, j) => {
        const peerIdx = NODE_ORDER.findIndex((n) => snap.nodes[n]?.pubkey === ch.remote_pubkey);
        if (peerIdx < 0 || peerIdx <= i) return;
        out.push({ from: i, fromName: name, to: peerIdx, toName: NODE_ORDER[peerIdx], ch, key: `${name}-${j}` });
      });
    });
    return out;
  }, [snap, NODE_ORDER]);

  return (
    <div className={`app${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <header className="topbar">
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? "操作パネルを隠す" : "操作パネルを表示"}
        >
          {sidebarOpen ? "◀ パネル" : "▶ パネル"}
        </button>
        <div>
          <h1>⚡ LN Channel Visualizer</h1>
          <div className="subtitle">
            Lightning Network 学習用 — Polar regtest {NODE_ORDER.length}ノード (
            {NODE_ORDER.map((n) => n[0].toUpperCase() + n.slice(1)).join(" / ")})
          </div>
        </div>
      </header>

      <div className="layout">
      <aside className="sidebar">

      {/* 学習ミッション */}
      <div className="controls missions">
        <h2>
          🎯 学習ミッション{" "}
          <span className="hint inline">
            ({MISSIONS.filter((m) => missionDone[m.id]).length} / {MISSIONS.length} 達成)
          </span>
        </h2>
        <p className="hint">
          各操作を実際にやると自動でチェックが点く。進捗はセッション内のみ（リロードでリセット）。
        </p>
        {MISSIONS.map((m) => {
          const done = !!missionDone[m.id];
          const open = !!missionOpen[m.id];
          return (
            <div key={m.id} className={`mission-item${done ? " done" : ""}`}>
              <div className="mission-head">
                <span className="mission-check">{done ? "✅" : "⬜"}</span>
                <span className="mission-title">{m.title}</span>
                <button
                  className="mission-hint-toggle"
                  onClick={() => setMissionOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}
                >
                  {open ? "ヒントを隠す" : "ヒント"}
                </button>
              </div>
              {open && <div className="mission-hint-body">{m.hint}</div>}
            </div>
          );
        })}
      </div>

      <div className="controls">
        <h2>💸 送金</h2>
        <div className="row">
          <label>モード</label>
          <select value={sendMode} onChange={(e) => setSendMode(e.target.value as SendMode)}>
            <option value="internal">内部 (自動経路)</option>
            <option value="route_select">経路選択</option>
            <option value="external_invoice">外部 bolt11 貼付</option>
          </select>
        </div>

        {sendMode === "internal" && (
          <>
            <p className="hint">送金成功で黄ドットが <b>1ホップずつ</b> 流れる。直接チャネルがなければ中継ノード経由。</p>
            <div className="row">
              <label>From</label>
              <select value={source} onChange={(e) => setSource(e.target.value as NodeName)}>
                {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <label>To</label>
              <select value={dest} onChange={(e) => setDest(e.target.value as NodeName)}>
                {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <label>Amount (sat) <Help text="1 sat = 0.00000001 BTC" /></label>
              <input type="number" value={amount} min={1} onChange={(e) => setAmount(parseInt(e.target.value || "0", 10))} />
              <button onClick={send} disabled={sending || source === dest}>
                {sending ? "送金中..." : "送金"}
              </button>
            </div>
          </>
        )}

        {sendMode === "route_select" && (
          <>
            <p className="hint">
              QueryRoutes で経路候補取得 → fee/CLTV 確認後「この経路で送る」で SendToRoute。
              内部送金と違い、こちらは <b>手動経路指定</b>。
            </p>
            <div className="row">
              <label>From</label>
              <select value={source} onChange={(e) => setSource(e.target.value as NodeName)}>
                {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <label>To</label>
              <select value={dest} onChange={(e) => setDest(e.target.value as NodeName)}>
                {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <label>Amount (sat)</label>
              <input type="number" value={amount} min={1} onChange={(e) => setAmount(parseInt(e.target.value || "0", 10))} />
              <button onClick={queryRoutes} disabled={routesLoading || source === dest}>
                {routesLoading ? "検索中..." : "経路検索"}
              </button>
            </div>
            <div className="route-list">
              {routes.map((rt, i) => (
                <div key={i} className="log-entry">
                  <div>
                    <b>経路 {i + 1}</b>: {source} → {rt.hops.map((h) => h.name).join(" → ")}
                  </div>
                  <div style={{ fontSize: "0.85em", color: "#8b949e" }}>
                    fee {rt.total_fees} sat · total_amt {rt.total_amt} · CLTV {rt.total_time_lock}
                  </div>
                  <button style={{ marginTop: 4 }} onClick={() => sendOnRoute(rt)} disabled={sending}>
                    この経路で送る
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {sendMode === "external_invoice" && (
          <>
            <p className="hint">
              他ノード生成の bolt11 を貼って送金。<code>add_invoice</code> 経由ではなく既存 invoice を直接支払う。
            </p>
            <div className="row">
              <label>From</label>
              <select value={source} onChange={(e) => setSource(e.target.value as NodeName)}>
                {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="row">
              <textarea
                value={extInvoice}
                onChange={(e) => setExtInvoice(e.target.value)}
                placeholder="lnbcrt..."
                rows={3}
                style={{ flex: 1, fontFamily: "monospace", fontSize: "0.85em" }}
              />
              <button onClick={payExternal} disabled={sending || !extInvoice.trim()}>
                {sending ? "送金中..." : "支払う"}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="controls">
        <h2>📨 インボイス生成 <span className="hint inline">(プル型送金の受取側)</span></h2>
        <p className="hint">
          受取ノードで bolt11 を発行 → 「外部送金にセット」で別ノードから支払うとプル型送金を体感できる。
        </p>
        <div className="row">
          <label>受取ノード</label>
          <select value={invNode} onChange={(e) => setInvNode(e.target.value as NodeName)}>
            {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <label>Amount (sat)</label>
          <input
            type="number"
            value={invAmount}
            min={1}
            onChange={(e) => setInvAmount(parseInt(e.target.value || "0", 10))}
          />
          <label>Memo</label>
          <input
            type="text"
            value={invMemo}
            placeholder="(任意)"
            onChange={(e) => setInvMemo(e.target.value)}
          />
          <button onClick={genInvoice} disabled={invBusy || !invNode}>
            {invBusy ? "生成中..." : "生成"}
          </button>
        </div>
        {invResult && (
          <div className="row" style={{ marginTop: 8 }}>
            <textarea
              value={invResult}
              readOnly
              rows={3}
              style={{ flex: 1, fontFamily: "monospace", fontSize: "0.85em" }}
              onFocus={(e) => e.target.select()}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <button onClick={copyInvoice}>コピー</button>
              <button onClick={useInvoiceInExternal}>外部送金にセット</button>
            </div>
          </div>
        )}
      </div>

      <div className="controls">
        <h2>🔗 チャネル開閉</h2>
        <p className="hint">
          開設後 Polar の bitcoind で <code>6 blocks</code> マイニングが必要 →
          UI 下部「⛏ ブロック生成」ボタン or compose CLI から実行
        </p>
        <div className="row">
          <label>From</label>
          <select value={chSource} onChange={(e) => setChSource(e.target.value as NodeName)}>
            {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <label>To</label>
          <select
            value={chDest}
            onChange={(e) => {
              const v = e.target.value as NodeName;
              setChDest(v);
              setChHost(hostOf(v)); // peer host を自動補完 (手動編集も可)
            }}
          >
            {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <label>Funding (sat) <Help text="チャネル開設時に lock する自分側資金. 最小 ~20000" /></label>
          <input
            type="number"
            value={chAmount}
            min={20000}
            onChange={(e) => setChAmount(parseInt(e.target.value || "0", 10))}
          />
          <label>Peer host <Help text="Docker内部DNS名 (lnd-<ノード名>, 例 lnd-bob)" /></label>
          <input
            type="text"
            value={chHost}
            onChange={(e) => setChHost(e.target.value)}
          />
          <button onClick={openChannel} disabled={chBusy || chSource === chDest}>開設</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label>⛏ ブロック生成 <Help text="bitcoind regtest で N blocks マイニング → チャネル confirm / オンチェーン残高生成" /></label>
          <input
            type="number"
            value={mineBlocks}
            min={1}
            max={1000}
            onChange={(e) => setMineBlocks(parseInt(e.target.value || "0", 10))}
          />
          <label>報酬先</label>
          <select value={mineNode} onChange={(e) => setMineNode(e.target.value as NodeName)}>
            {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button onClick={mine} disabled={mineBusy}>
            {mineBusy ? "マイニング中..." : "生成"}
          </button>
        </div>
        <div className="ch-list">
          {NODE_ORDER.map((name) => {
            const chs = snap?.nodes[name]?.channels ?? [];
            if (!chs.length) return null;
            return (
              <div key={name} className="ch-list-group">
                <strong style={{ color: colorOf(name) }}>{name}</strong> のチャネル:
                {chs.map((ch) => (
                  <div key={ch.channel_point} className="log-entry">
                    {ch.channel_point.slice(0, 24)}... · Cap {ch.capacity.toLocaleString()} · {ch.active ? "🟢 active" : "⏳ pending"}
                    <button
                      style={{ marginLeft: 8, padding: "2px 8px" }}
                      onClick={() => closeChannel(name, ch.channel_point)}
                      disabled={chBusy}
                    >
                      閉じる
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      </aside>

      <main>

      {error && <div className="banner error-banner">⚠️ {error}</div>}
      {info && <div className="banner info-banner">{info}</div>}

      {/* 凡例 */}
      <div className="legend">
        {nodeDefs.map((n) => (
          <span key={n.name}>
            <span className="dot" style={{ background: n.color }} />{" "}
            {n.name[0].toUpperCase() + n.name.slice(1)}
          </span>
        ))}
        <span className="sep">|</span>
        <span><span className="dot" style={{ background: "#56d364" }} /> Local (自分側残高 = 送れる量)</span>
        <span><span className="dot" style={{ background: "#f85149" }} /> Remote (相手側残高 = 受け取れる量)</span>
      </div>

      <div className="viz">
        <svg viewBox={`0 0 ${layout.size} ${layout.size}`} style={{ width: "100%", height: "auto", maxHeight: 600 }}>
          {/* チャネル線: 二色分割で local/remote 比率を可視化 */}
          {channelLines.map(({ from, fromName, to, toName, ch, key }) => {
            const p = positions[from];
            const q = positions[to];
            const total = ch.capacity || 1;
            const localFrac = ch.local_balance / total; // fromName 視点
            const mx = p.x + (q.x - p.x) * localFrac;
            const my = p.y + (q.y - p.y) * localFrac;
            const midX = (p.x + q.x) / 2;
            const midY = (p.y + q.y) / 2;
            // ラベルを線の法線方向 (リング外側) に押し出して衝突回避
            const dx = q.x - p.x;
            const dy = q.y - p.y;
            const len = Math.hypot(dx, dy) || 1;
            let nx = -dy / len;
            let ny = dx / len;
            const outSign = (midX - layout.cx) * nx + (midY - layout.cy) * ny >= 0 ? 1 : -1;
            nx *= outSign;
            ny *= outSign;
            const lx = midX + nx * 34;
            const ly = midY + ny * 34;
            return (
              <g key={key}>
                {/* local 部分 (緑) */}
                <line x1={p.x} y1={p.y} x2={mx} y2={my} stroke="#56d364" strokeWidth={6} strokeLinecap="round" />
                {/* remote 部分 (赤) */}
                <line x1={mx} y1={my} x2={q.x} y2={q.y} stroke="#f85149" strokeWidth={6} strokeLinecap="round" />
                {/* 分割マーカー */}
                <circle cx={mx} cy={my} r={6} fill="#e3b341" stroke="#0d1117" strokeWidth={2} />
                {/* ラベル引出し線 */}
                <line x1={midX} y1={midY} x2={lx} y2={ly} stroke="#30363d" strokeWidth={1} />
                {/* ラベル: 両ノード視点で送れる量 */}
                <g transform={`translate(${lx}, ${ly})`}>
                  <rect
                    x={-76}
                    y={-24}
                    width={152}
                    height={ch.policy ? 60 : 44}
                    rx={6}
                    fill="#161b22"
                    stroke="#30363d"
                  />
                  <text x={0} y={-9} className="ch-label" textAnchor="middle">
                    Cap {ch.capacity.toLocaleString()} {ch.active ? "🟢" : "⏳"}
                  </text>
                  <text x={-71} y={9} className="ch-side ch-local" textAnchor="start">
                    {fromName}→ {ch.local_balance.toLocaleString()}
                  </text>
                  <text x={71} y={9} className="ch-side ch-remote" textAnchor="end">
                    {toName}→ {ch.remote_balance.toLocaleString()}
                  </text>
                  {ch.policy && (
                    <text x={0} y={28} className="ch-policy" textAnchor="middle">
                      {fromName} fee {ch.policy.base_fee_msat}msat + {ch.policy.fee_rate_ppm}ppm · cltv {ch.policy.cltv_delta}
                    </text>
                  )}
                </g>
              </g>
            );
          })}
          {/* ノード */}
          {NODE_ORDER.map((name, i) => {
            const node = snap?.nodes[name];
            const p = positions[i];
            const off = node?.balance_sat ?? 0;
            const on = node?.wallet_sat ?? 0;
            const { ux, uy } = outward(i);
            // 残高ボックスをノードからリング外側へ配置 (隣ノード・線との重なり回避)
            const bx = p.x + ux * (layout.nodeR + 34);
            const by = p.y + uy * (layout.nodeR + 34);
            return (
              <g key={name}>
                <circle cx={p.x} cy={p.y} r={layout.nodeR} fill={colorOf(name)} stroke="#fff" strokeWidth={3} />
                <text x={p.x} y={p.y + 5} className="node-label">{name.toUpperCase()}</text>
                <g transform={`translate(${bx}, ${by})`}>
                  <rect x={-72} y={-15} width={144} height={42} rx={4} fill="#161b22" stroke="#30363d" />
                  <text x={0} y={-1} className="node-balance" textAnchor="middle">
                    ⚡ off-chain: {off.toLocaleString()}
                  </text>
                  <text x={0} y={15} className="node-balance dim" textAnchor="middle">
                    ⛓ on-chain: {on.toLocaleString()}
                  </text>
                </g>
              </g>
            );
          })}
          {/* 送金アニメ */}
          {anims.map((a) => {
            const fi = NODE_ORDER.indexOf(a.from as NodeName);
            const ti = NODE_ORDER.indexOf(a.to as NodeName);
            if (fi < 0 || ti < 0) return null;
            const p = positions[fi];
            const q = positions[ti];
            return (
              <circle key={a.id} r={10} fill="#ffd33d" stroke="#fff" strokeWidth={2}>
                <animate attributeName="cx" from={p.x} to={q.x} dur={`${HOP_MS}ms`} fill="freeze" />
                <animate attributeName="cy" from={p.y} to={q.y} dur={`${HOP_MS}ms`} fill="freeze" />
              </circle>
            );
          })}
        </svg>
      </div>

      <div className="help-box">
        <strong>用語ミニ解説</strong>
        <ul>
          <li><b>Capacity</b>: チャネルの総容量 = 開設時に lock した sat。開設後は増減せず、local と remote の間を移動するだけ</li>
          <li><b>Local balance (緑)</b>: 自分が今 <i>送れる</i> 量 = アウトバウンド流動性</li>
          <li><b>Remote balance (赤)</b>: 相手が今 <i>送ってくる</i> ことができる量 = 自分の <i>インバウンド流動性</i>（＝自分が<i>受け取れる</i>量）</li>
          <li><b>push_amt</b>: チャネル開設時に相手側へ渡す初期残高。これがないと開設直後は受信側の inbound が 0 で受け取れない</li>
          <li><b>Off-chain (⚡)</b>: 全チャネルの local_balance 合計 = LNで送金できる総量。送受信でチャネル内を移動するだけでオンチェーン取引は発生しない</li>
          <li><b>On-chain (⛓)</b>: ウォレットUTXOの確認済残高 = 新規チャネル開設の原資</li>
          <li><b>マルチホップ</b>: 直接チャネルがなくても中継ノード経由で送金可能。中継ノードは <b>手数料</b> を取る</li>
          <li><b>手数料 (fee)</b>: 中継ノードが1ホップごとに取る報酬。base fee（固定）+ rate（金額比例）。経路の合計が total_fees</li>
          <li><b>CLTV / time_lock</b>: HTLC の有効期限（ブロック数）。各ホップで少しずつ積まれ、失敗時の資金回収を保証する安全装置</li>
          <li><b>HTLC</b>: Hashed Time-Locked Contract。送金途中の「条件付き仮押さえ」。受取人が preimage を出せば確定(settle)、出せなければ期限切れで巻き戻る(fail)</li>
        </ul>
      </div>

      <div className="help-box">
        <strong>🔄 なぜリング接続？</strong>
        <ul>
          <li>各ノードを <b>環状</b> につなぐ（alice→bob→carol→dave→alice）。隣同士しか直接チャネルを持たない</li>
          <li>離れたノード宛は <b>マルチホップ</b> になる。例: alice→carol は <b>2通りの2ホップ経路</b>（alice→bob→carol / alice→dave→carol）があり、LND が手数料・流動性で選ぶ</li>
          <li>「経路選択」モードで両経路を比較できる。中継チャネルの local 残高が足りないと <i>no_route</i> になり、別経路や中継の流動性が必要だと体感できる</li>
          <li>リングは <b>双方向に回れる</b>ため、流動性が一方向に偏っても逆回りで送れる場合がある（流動性管理の学習に向く）</li>
        </ul>
      </div>

      <div className="controls">
        <h2>📈 オフチェーン残高推移 <span className="hint inline">(直近 {HISTORY_MAX} 点 × 3秒)</span></h2>
        <div style={{ width: "100%", height: 240 }}>
          <ResponsiveContainer>
            <LineChart data={history}>
              <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
              <XAxis
                dataKey="t"
                tickFormatter={(t) => new Date(t).toLocaleTimeString().slice(0, 8)}
                stroke="#8b949e"
              />
              <YAxis stroke="#8b949e" tickFormatter={(v) => v.toLocaleString()} />
              <Tooltip
                contentStyle={{ background: "#161b22", border: "1px solid #30363d" }}
                labelFormatter={(t) => new Date(t as number).toLocaleTimeString()}
              />
              <Legend />
              {NODE_ORDER.map((name) => (
                <Line key={name} type="monotone" dataKey={name} stroke={colorOf(name)} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="log">
        <h2>🔬 HTLC イベント <span className="hint inline">(SubscribeHtlcEvents stream)</span></h2>
        <p className="hint">
          送金が経路上を進む様子をノード視点で実況。1回の送金で各中継ノードに forward → settle が並ぶ。
          各 kind の意味:
        </p>
        <ul className="hint" style={{ marginTop: 0 }}>
          <li>➡️ <b>forward_event</b>: HTLC を次ホップへ転送（中継開始 = 残高を仮押さえ）</li>
          <li>✅ <b>settle_event</b>: preimage を受領し HTLC 確定（送金成立 → 残高が確定移動）</li>
          <li>❌ <b>forward_fail_event</b>: 下流から fail が戻り転送を巻き戻し（仮押さえ解放）</li>
          <li>🔗❌ <b>link_fail_event</b>: このノードの直近リンクで失敗（残高不足・チャネル inactive 等）</li>
          <li>🏁 <b>final_htlc_event</b>: 最終ノードでの HTLC 完了（受取人側の確定/失敗）</li>
        </ul>
        {htlcEvents.length === 0 && <div className="log-entry">イベント未受信。送金実行で forward/settle/fail が流れる</div>}
        {htlcEvents.map((e, i) => {
          const kindEmoji: Record<string, string> = {
            forward_event: "➡️",
            settle_event: "✅",
            forward_fail_event: "❌",
            link_fail_event: "🔗❌",
            final_htlc_event: "🏁",
          };
          const kindDesc: Record<string, string> = {
            forward_event: "次ホップへ転送",
            settle_event: "確定 (送金成立)",
            forward_fail_event: "転送失敗で巻き戻し",
            link_fail_event: "リンクで失敗",
            final_htlc_event: "最終ノードで完了",
          };
          return (
            <div key={i} className="log-entry">
              {kindEmoji[e.kind] || "•"} <b style={{ color: colorOf(e.node) }}>{e.node}</b> {e.kind}
              {kindDesc[e.kind] && <span style={{ color: "#8b949e" }}> — {kindDesc[e.kind]}</span>}
              {e.incoming_channel_id && ` · in_chan ${e.incoming_channel_id}`}
              {e.outgoing_channel_id && ` · out_chan ${e.outgoing_channel_id}`}
            </div>
          );
        })}
      </div>

      <div className="log">
        <h2>📜 送金履歴</h2>
        {payments.length === 0 && <div className="log-entry">履歴なし</div>}
        {payments.map((p) => (
          <div key={p.id} className={`log-entry ${p.status}`}>
            [{p.timestamp.slice(11, 19)}] {p.source} → {p.dest} {p.amount_sat.toLocaleString()} sat ·{" "}
            {p.status}
            {p.error ? ` · ${p.error}` : ""}
          </div>
        ))}
      </div>

      </main>
      </div>
    </div>
  );
}
