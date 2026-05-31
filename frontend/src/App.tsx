import { useEffect, useMemo, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

type Channel = {
  remote_pubkey: string;
  capacity: number;
  local_balance: number;
  remote_balance: number;
  active: boolean;
  channel_point: string;
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
type HistoryPoint = { t: number; alice: number; bob: number; carol: number };
type Anim = { id: number; from: string; to: string };

const NODE_ORDER = ["alice", "bob", "carol"] as const;
type NodeName = typeof NODE_ORDER[number];
const COLORS: Record<string, string> = {
  alice: "#f78166",
  bob: "#a371f7",
  carol: "#39c5cf",
};
const HISTORY_MAX = 60;
const HOP_MS = 1200;
const ERROR_TIMEOUT_MS = 6000;

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
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [source, setSource] = useState<NodeName>("alice");
  const [dest, setDest] = useState<NodeName>("carol");
  const [amount, setAmount] = useState(1000);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [anims, setAnims] = useState<Anim[]>([]);
  const animIdRef = useRef(0);

  const [chSource, setChSource] = useState<NodeName>("alice");
  const [chDest, setChDest] = useState<NodeName>("bob");
  const [chAmount, setChAmount] = useState(1000000);
  const [chHost, setChHost] = useState("lnd-bob");
  const [chBusy, setChBusy] = useState(false);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/balances`);
    ws.onmessage = (ev) => {
      const s: Snapshot = JSON.parse(ev.data);
      setSnap(s);
      const t = Date.now();
      setHistory((h) =>
        [
          ...h,
          {
            t,
            alice: s.nodes.alice?.balance_sat ?? 0,
            bob: s.nodes.bob?.balance_sat ?? 0,
            carol: s.nodes.carol?.balance_sat ?? 0,
          },
        ].slice(-HISTORY_MAX),
      );
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
        setError(await r.text());
      } else {
        const body = await r.json();
        const hops = body.hops || [];
        if (hops.length > 0) {
          animateHops(source, hops);
          const hopNames = [source, ...hops.map((h: any) => pubkeyToName(h.pub_key)).filter(Boolean)];
          setInfo(`✅ 経路: ${hopNames.join(" → ")} · 手数料 ${body.total_fees} sat`);
        }
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
      if (!r.ok) setError(body);
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
      if (!r.ok) setError(body);
      else setInfo(`🔒 閉鎖要求送信. ${body}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setChBusy(false);
    }
  };

  const positions = useMemo(
    () => NODE_ORDER.map((_, i) => nodePosition(i, NODE_ORDER.length, 380, 240, 160)),
    [],
  );

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
  }, [snap]);

  return (
    <div className="app">
      <h1>⚡ LN Channel Visualizer</h1>
      <div className="subtitle">Lightning Network 学習用 — Polar regtest 3ノード (Alice / Bob / Carol)</div>

      {error && <div className="banner error-banner">⚠️ {error}</div>}
      {info && <div className="banner info-banner">{info}</div>}

      {/* 凡例 */}
      <div className="legend">
        <span><span className="dot" style={{ background: COLORS.alice }} /> Alice</span>
        <span><span className="dot" style={{ background: COLORS.bob }} /> Bob</span>
        <span><span className="dot" style={{ background: COLORS.carol }} /> Carol</span>
        <span className="sep">|</span>
        <span><span className="dot" style={{ background: "#56d364" }} /> Local (自分側残高 = 送れる量)</span>
        <span><span className="dot" style={{ background: "#f85149" }} /> Remote (相手側残高 = 受け取れる量)</span>
      </div>

      <div className="viz">
        <svg viewBox="0 0 760 480" style={{ width: "100%", height: 480 }}>
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
            return (
              <g key={key}>
                {/* local 部分 (緑) */}
                <line x1={p.x} y1={p.y} x2={mx} y2={my} stroke="#56d364" strokeWidth={6} strokeLinecap="round" />
                {/* remote 部分 (赤) */}
                <line x1={mx} y1={my} x2={q.x} y2={q.y} stroke="#f85149" strokeWidth={6} strokeLinecap="round" />
                {/* 分割マーカー */}
                <circle cx={mx} cy={my} r={6} fill="#e3b341" stroke="#0d1117" strokeWidth={2} />
                {/* ラベル: 両ノード視点で送れる量 */}
                <g transform={`translate(${midX}, ${midY})`}>
                  <rect x={-90} y={-26} width={180} height={48} rx={6} fill="#161b22" stroke="#30363d" />
                  <text x={0} y={-10} className="ch-label" textAnchor="middle">
                    Cap {ch.capacity.toLocaleString()} sat {ch.active ? "🟢" : "⏳"}
                  </text>
                  <text x={-85} y={10} className="ch-side ch-local" textAnchor="start">
                    {fromName}→: {ch.local_balance.toLocaleString()}
                  </text>
                  <text x={85} y={10} className="ch-side ch-remote" textAnchor="end">
                    {toName}→: {ch.remote_balance.toLocaleString()}
                  </text>
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
            return (
              <g key={name}>
                <circle cx={p.x} cy={p.y} r={44} fill={COLORS[name]} stroke="#fff" strokeWidth={3} />
                <text x={p.x} y={p.y + 5} className="node-label">{name.toUpperCase()}</text>
                <g transform={`translate(${p.x}, ${p.y + 64})`}>
                  <rect x={-72} y={-14} width={144} height={42} rx={4} fill="#161b22" stroke="#30363d" />
                  <text x={0} y={0} className="node-balance" textAnchor="middle">
                    ⚡ off-chain: {off.toLocaleString()}
                  </text>
                  <text x={0} y={16} className="node-balance dim" textAnchor="middle">
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
          <li><b>Capacity</b>: チャネルの総容量 = 開設時に lock した sat</li>
          <li><b>Local balance (緑)</b>: 自分が今 <i>送れる</i> 量</li>
          <li><b>Remote balance (赤)</b>: 相手が今 <i>送ってくる</i> ことができる量 = 自分の <i>インバウンド流動性</i></li>
          <li><b>Off-chain (⚡)</b>: 全チャネルの local_balance 合計 = LNで送金できる総量</li>
          <li><b>On-chain (⛓)</b>: ウォレットUTXOの確認済残高 = 新規チャネル開設の原資</li>
          <li><b>マルチホップ</b>: 直接チャネルがなくても中継ノード経由で送金可能 (例: Alice→Bob→Carol)</li>
        </ul>
      </div>

      <div className="controls">
        <h2>💸 送金</h2>
        <p className="hint">
          送金成功すると 黄色のドット が経路に沿って <b>1ホップずつ</b> 流れる。Alice→Carol は Bob 中継。
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
          <label>Amount (sat) <Help text="1 sat = 0.00000001 BTC. regtest なので何でも自由" /></label>
          <input
            type="number"
            value={amount}
            min={1}
            onChange={(e) => setAmount(parseInt(e.target.value || "0", 10))}
          />
          <button onClick={send} disabled={sending || source === dest}>
            {sending ? "送金中..." : "送金"}
          </button>
        </div>
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
          <select value={chDest} onChange={(e) => setChDest(e.target.value as NodeName)}>
            {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <label>Funding (sat) <Help text="チャネル開設時に lock する自分側資金. 最小 ~20000" /></label>
          <input
            type="number"
            value={chAmount}
            min={20000}
            onChange={(e) => setChAmount(parseInt(e.target.value || "0", 10))}
          />
          <label>Peer host <Help text="Docker内部DNS名 (lnd-alice/lnd-bob/lnd-carol)" /></label>
          <input
            type="text"
            value={chHost}
            onChange={(e) => setChHost(e.target.value)}
          />
          <button onClick={openChannel} disabled={chBusy || chSource === chDest}>開設</button>
        </div>
        <div className="ch-list">
          {NODE_ORDER.map((name) => {
            const chs = snap?.nodes[name]?.channels ?? [];
            if (!chs.length) return null;
            return (
              <div key={name} className="ch-list-group">
                <strong style={{ color: COLORS[name] }}>{name}</strong> のチャネル:
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
              <Line type="monotone" dataKey="alice" stroke={COLORS.alice} dot={false} />
              <Line type="monotone" dataKey="bob" stroke={COLORS.bob} dot={false} />
              <Line type="monotone" dataKey="carol" stroke={COLORS.carol} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
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
    </div>
  );
}
