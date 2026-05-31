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
const ANIM_MS = 1500;
const ERROR_TIMEOUT_MS = 5000;

function nodePosition(idx: number, total: number, cx: number, cy: number, r: number) {
  const angle = (idx / total) * 2 * Math.PI - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [source, setSource] = useState<NodeName>("alice");
  const [dest, setDest] = useState<NodeName>("carol");
  const [amount, setAmount] = useState(1000);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [anims, setAnims] = useState<Anim[]>([]);
  const animIdRef = useRef(0);

  // Channel open/close form
  const [chSource, setChSource] = useState<NodeName>("alice");
  const [chDest, setChDest] = useState<NodeName>("bob");
  const [chAmount, setChAmount] = useState(1000000);
  const [chHost, setChHost] = useState("host.docker.internal");
  const [chBusy, setChBusy] = useState(false);

  // WebSocket
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

  // エラー自動消去
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), ERROR_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [error]);

  const refreshPayments = async () => {
    const r = await fetch("/api/payments");
    if (r.ok) setPayments(await r.json());
  };

  useEffect(() => {
    refreshPayments();
  }, []);

  const triggerAnim = (from: string, to: string) => {
    const id = ++animIdRef.current;
    setAnims((a) => [...a, { id, from, to }]);
    setTimeout(() => setAnims((a) => a.filter((x) => x.id !== id)), ANIM_MS);
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
        const t = await r.text();
        setError(t);
      } else {
        triggerAnim(source, dest);
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
      else setError(`📡 開設要求送信 — Polar で6blocksマイニング. ${body}`);
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
      else setError(`🔒 閉鎖要求送信. ${body}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setChBusy(false);
    }
  };

  const positions = useMemo(
    () => NODE_ORDER.map((_, i) => nodePosition(i, NODE_ORDER.length, 350, 220, 150)),
    [],
  );

  const channelLines = useMemo(() => {
    if (!snap) return [];
    const out: { from: number; to: number; ch: Channel; key: string }[] = [];
    NODE_ORDER.forEach((name, i) => {
      const node = snap.nodes[name];
      node?.channels?.forEach((ch, j) => {
        const peerIdx = NODE_ORDER.findIndex((n) => snap.nodes[n]?.pubkey === ch.remote_pubkey);
        if (peerIdx < 0 || peerIdx <= i) return;
        out.push({ from: i, to: peerIdx, ch, key: `${name}-${j}` });
      });
    });
    return out;
  }, [snap]);

  return (
    <div className="app">
      <h1>⚡ LN Channel Visualizer</h1>
      <div className="subtitle">Polar regtest — Alice / Bob / Carol</div>

      {error && <div className="error-banner">{error}</div>}

      <div className="viz">
        <svg viewBox="0 0 700 440" style={{ width: "100%", height: 440 }}>
          {channelLines.map(({ from, to, ch, key }) => {
            const p = positions[from];
            const q = positions[to];
            const total = ch.capacity || 1;
            const localFrac = ch.local_balance / total;
            const mx = p.x + (q.x - p.x) * localFrac;
            const my = p.y + (q.y - p.y) * localFrac;
            return (
              <g key={key}>
                <line
                  x1={p.x}
                  y1={p.y}
                  x2={q.x}
                  y2={q.y}
                  className={`channel-line ${ch.active ? "active" : ""}`}
                />
                <circle cx={mx} cy={my} r={5} fill="#e3b341" />
                <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 8} className="node-balance">
                  {ch.local_balance.toLocaleString()} / {ch.remote_balance.toLocaleString()} sat
                </text>
              </g>
            );
          })}
          {NODE_ORDER.map((name, i) => {
            const node = snap?.nodes[name];
            const p = positions[i];
            return (
              <g key={name}>
                <circle cx={p.x} cy={p.y} r={40} fill={COLORS[name]} stroke="#fff" strokeWidth={2} />
                <text x={p.x} y={p.y + 4} className="node-label">
                  {name.toUpperCase()}
                </text>
                <text x={p.x} y={p.y + 60} className="node-balance">
                  {node?.error ? "ERROR" : `${(node?.balance_sat ?? 0).toLocaleString()} sat`}
                </text>
              </g>
            );
          })}
          {/* 送金アニメ — from → to を直線で */}
          {anims.map((a) => {
            const fi = NODE_ORDER.indexOf(a.from as NodeName);
            const ti = NODE_ORDER.indexOf(a.to as NodeName);
            if (fi < 0 || ti < 0) return null;
            const p = positions[fi];
            const q = positions[ti];
            return (
              <circle key={a.id} r={8} fill="#ffd33d" stroke="#fff" strokeWidth={2}>
                <animate
                  attributeName="cx"
                  from={p.x}
                  to={q.x}
                  dur={`${ANIM_MS}ms`}
                  fill="freeze"
                />
                <animate
                  attributeName="cy"
                  from={p.y}
                  to={q.y}
                  dur={`${ANIM_MS}ms`}
                  fill="freeze"
                />
              </circle>
            );
          })}
        </svg>
      </div>

      <div className="controls">
        <h2>送金</h2>
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
        <h2>チャネル開閉</h2>
        <div className="row">
          <label>From</label>
          <select value={chSource} onChange={(e) => setChSource(e.target.value as NodeName)}>
            {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <label>To</label>
          <select value={chDest} onChange={(e) => setChDest(e.target.value as NodeName)}>
            {NODE_ORDER.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <label>Funding (sat)</label>
          <input
            type="number"
            value={chAmount}
            min={20000}
            onChange={(e) => setChAmount(parseInt(e.target.value || "0", 10))}
          />
          <label>Peer host</label>
          <input
            type="text"
            value={chHost}
            onChange={(e) => setChHost(e.target.value)}
            placeholder="host.docker.internal or polar-node-name"
          />
          <button onClick={openChannel} disabled={chBusy || chSource === chDest}>
            開設
          </button>
        </div>
        <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
          {NODE_ORDER.map((name) => {
            const chs = snap?.nodes[name]?.channels ?? [];
            if (!chs.length) return null;
            return (
              <div key={name} style={{ marginBottom: 8 }}>
                <strong style={{ color: COLORS[name] }}>{name}</strong>
                {chs.map((ch) => (
                  <div key={ch.channel_point} className="log-entry">
                    {ch.channel_point.slice(0, 20)}... · {ch.capacity.toLocaleString()} sat ·{" "}
                    {ch.active ? "✅" : "⏳"}{" "}
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
        <h2>残高推移 (直近{HISTORY_MAX}点)</h2>
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
        <h2>送金履歴</h2>
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
