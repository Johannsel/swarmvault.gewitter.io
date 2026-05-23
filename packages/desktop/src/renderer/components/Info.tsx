import { useEffect, useState } from "react";
import { Globe, Lock, Shield, HardDrive, Zap, RefreshCw, Server, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

interface SwarmStats {
  onlineNodes: number;
  totalNodes: number;
  onlinePledgedBytes: number;
  totalPledgedBytes: number;
  usedBytes: number;
}

function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-1">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-2xl font-bold ${accent ?? "text-slate-100"}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export default function Info() {
  const [stats, setStats] = useState<SwarmStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchStats = async () => {
    const s = await window.swarmvault.getSwarmStats();
    setStats(s);
    setLastUpdated(new Date());
    setLoading(false);
  };

  useEffect(() => {
    fetchStats();
    const timer = setInterval(fetchStats, 30_000);
    return () => clearInterval(timer);
  }, []);

  const usedPct = stats && stats.onlinePledgedBytes > 0 ? (stats.usedBytes / stats.onlinePledgedBytes) * 100 : 0;
  const onlinePct = stats && stats.totalNodes > 0 ? (stats.onlineNodes / stats.totalNodes) * 100 : 0;

  return (
    <div className="p-6 space-y-8 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Swarm Info</h1>
          <p className="text-xs text-slate-500 mt-0.5">Live network statistics and how SwarmVault works</p>
        </div>
        <button onClick={fetchStats} disabled={loading} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 transition-colors text-slate-400">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Live swarm stats */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Globe size={14} className="text-cyan-400" /> Live Network Status
          </h2>
          {lastUpdated && <span className="text-xs text-slate-600">updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
        </div>

        {loading && !stats ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm py-6">
            <Loader2 size={16} className="animate-spin" /> Fetching network stats…
          </div>
        ) : !stats ? (
          <div className="flex items-center gap-2 text-amber-400 text-xs bg-amber-900/20 border border-amber-800/30 rounded-xl p-4">
            <AlertTriangle size={14} className="shrink-0" /> Could not reach the SwarmVault server. Stats will update automatically when the connection is restored.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Online Nodes" value={String(stats.onlineNodes)} sub={`of ${stats.totalNodes} registered`} accent="text-emerald-400" />
              <StatCard label="Node Availability" value={`${onlinePct.toFixed(0)}%`} sub="nodes currently online" accent={onlinePct >= 75 ? "text-emerald-400" : onlinePct >= 50 ? "text-amber-400" : "text-red-400"} />
              <StatCard label="Online Capacity" value={formatBytes(stats.onlinePledgedBytes)} sub="pledged by online nodes" accent="text-cyan-400" />
              <StatCard label="Total Capacity" value={formatBytes(stats.totalPledgedBytes)} sub="pledged by all nodes" />
            </div>

            {/* Capacity bar */}
            <div className="bg-slate-800 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Network usage</span>
                <span>
                  <span className="text-slate-200">{formatBytes(stats.usedBytes)}</span> used of <span className="text-slate-200">{formatBytes(stats.onlinePledgedBytes)}</span> online capacity
                  <span className="text-slate-500 ml-1">({usedPct.toFixed(1)}%)</span>
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-700 overflow-hidden">
                <div className={`h-full rounded-full transition-all ${usedPct > 85 ? "bg-red-500" : usedPct > 60 ? "bg-amber-500" : "bg-violet-500"}`} style={{ width: `${Math.min(usedPct, 100).toFixed(1)}%` }} />
              </div>
            </div>
          </>
        )}
      </section>

      {/* How it works */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <Zap size={14} className="text-violet-400" /> How It Works
        </h2>
        <div className="space-y-2">
          {[
            {
              Icon: HardDrive,
              title: "Distributed Storage",
              body: "Your files are split into shards and spread across multiple independent nodes run by volunteers in the SwarmVault network. No single server holds your complete files.",
              color: "text-violet-400",
            },
            {
              Icon: Shield,
              title: "Erasure Coding",
              body: "Each file is encoded with redundant parity shards. Even if some nodes go offline, your files remain fully recoverable — like RAID for the internet.",
              color: "text-cyan-400",
            },
            {
              Icon: Lock,
              title: "End-to-End Encryption",
              body: "Files are encrypted on your device before leaving it. The SwarmVault server and storage nodes only ever see ciphertext — they cannot read your files.",
              color: "text-emerald-400",
            },
            {
              Icon: Server,
              title: "Incentive Layer",
              body: "Nodes that contribute storage and maintain high uptime earn SwarmCredits, which convert to extra cloud storage quota. This keeps the network healthy and growing.",
              color: "text-yellow-400",
            },
          ].map(({ Icon, title, body, color }) => (
            <div key={title} className="bg-slate-800 rounded-xl p-4 flex gap-4">
              <div className={`mt-0.5 shrink-0 ${color}`}>
                <Icon size={18} />
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium text-slate-200">{title}</div>
                <div className="text-xs text-slate-400 leading-relaxed">{body}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Security properties */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <Lock size={14} className="text-emerald-400" /> Security Properties
        </h2>
        <div className="bg-slate-800 rounded-xl divide-y divide-slate-700/60">
          {[
            { label: "Encryption key never leaves your device", detail: "AES-256 encryption; the server never handles your key." },
            { label: "Files split — no node holds a complete copy", detail: "An attacker compromising one node cannot read your data." },
            { label: "Redundancy survives node failures", detail: "Parity shards allow full recovery even if multiple nodes drop." },
            { label: "Open relay protocol", detail: "Encrypted shards are relayed by the server but remain opaque to it." },
            { label: "Share links are time-limited", detail: "Public share links expire after 7 days and can be revoked any time." },
          ].map(({ label, detail }) => (
            <div key={label} className="flex gap-3 items-start px-4 py-3">
              <CheckCircle2 size={14} className="text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-medium text-slate-200">{label}</div>
                <div className="text-xs text-slate-500 mt-0.5">{detail}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Upload flow */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-slate-300">Upload Flow (step by step)</h2>
        <ol className="space-y-2">
          {[
            "File is detected in your sync folder by the local watcher.",
            "File is encrypted on your device using a key only you hold.",
            "Encrypted data is split into data shards + parity shards via erasure coding.",
            "Shards are uploaded to the SwarmVault server over HTTPS.",
            "Server relays each shard to an available storage node via an encrypted WebSocket.",
            "The node acknowledges receipt; the server records the shard location.",
            'Once all shards are distributed, the file status changes to "available".',
          ].map((step, i) => (
            <li key={i} className="flex gap-3 items-start">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-violet-900/60 text-violet-300 text-xs flex items-center justify-center font-medium">{i + 1}</span>
              <span className="text-xs text-slate-400 leading-relaxed pt-0.5">{step}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
