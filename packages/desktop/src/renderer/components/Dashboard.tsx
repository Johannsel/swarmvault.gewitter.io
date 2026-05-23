import { useEffect, useState } from "react";
import { HardDrive, Cloud, TrendingUp, Wifi, WifiOff, AlertTriangle, CheckCircle2, PauseCircle, PlayCircle, Info } from "lucide-react";

interface Stats {
  usedBytes: number;
  pledgedBytes: number;
  availableDiskBytes: number;
  paused: boolean;
  nodeId: string | null;
  tier: string | null;
}

interface NodeStatus {
  id: string;
  displayName: string;
  tier: string;
  status: string;
  pledgedBytes: number;
  usedBytes: number;
  uptimePct: number;
  uptimePct3m: number | null;
  lastSeenAt: string | null;
}

interface Rewards {
  balance?: { credits: number; lifetimeEarned: number };
  quota?: { storageQuotaBytes: string; usedStorageBytes: string };
}

function formatBytes(bytes: number): string {
  if (!isFinite(bytes)) return "∞";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function uptimeLabel(pct: number): { text: string; color: string } {
  if (pct >= 80) return { text: "Full rewards", color: "text-emerald-400" };
  if (pct >= 50) return { text: "Partial rewards", color: "text-amber-400" };
  return { text: "No rewards — below 50%", color: "text-red-400" };
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [nodeStatus, setNodeStatus] = useState<NodeStatus | null>(null);
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [connected, setConnected] = useState(false);

  const load = async () => {
    const [s, r, n] = await Promise.all([window.swarmvault.getStorageStats(), window.swarmvault.getRewards().catch(() => null), window.swarmvault.getNodeStatus().catch(() => null)]);
    setStats(s as Stats);
    setRewards(r);
    setNodeStatus(n as NodeStatus | null);
  };

  useEffect(() => {
    load();
    // Poll current state immediately — avoids missing the push event that fires
    // before the renderer is ready to receive it (race on first WS auth).
    void window.swarmvault.getSyncConnected().then((c) => setConnected(c));
    const timer = setInterval(load, 15_000);
    const unsub = window.swarmvault.onSyncStatus((status) => setConnected(status.connected));
    return () => {
      clearInterval(timer);
      unsub();
    };
  }, []);

  const pledgedGb = stats ? stats.pledgedBytes / 1024 ** 3 : 0;
  const usedGb = stats ? stats.usedBytes / 1024 ** 3 : 0;
  const usedPct = pledgedGb > 0 ? (usedGb / pledgedGb) * 100 : 0;

  const quotaBytes = rewards?.quota ? Number(rewards.quota.storageQuotaBytes) : 0;
  const usedUserBytes = rewards?.quota ? Number(rewards.quota.usedStorageBytes) : 0;
  const quotaUsedPct = quotaBytes > 0 ? (usedUserBytes / quotaBytes) * 100 : 0;
  const isOverQuota = quotaUsedPct >= 100;

  const effectiveUptime = nodeStatus?.uptimePct3m ?? nodeStatus?.uptimePct ?? null;
  const tierLabel = nodeStatus?.tier === "vault" ? "Vault" : nodeStatus?.tier === "swarm" ? "Swarm" : null;

  const diskFree = stats?.availableDiskBytes;
  const diskFreeLabel = diskFree != null && isFinite(diskFree) ? formatBytes(diskFree) : null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full ${connected ? "bg-emerald-900/40 text-emerald-400" : stats?.nodeId ? "bg-red-900/40 text-red-400" : "bg-slate-700/60 text-slate-400"}`}>
          {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
          {connected ? "Connected to SwarmVault" : stats?.nodeId ? "Offline — reconnecting…" : "Node not registered"}
        </div>
      </div>

      {/* Uptime warning if below 50% */}
      {effectiveUptime != null && effectiveUptime < 50 && (
        <div className="flex items-start gap-2.5 bg-red-900/25 border border-red-500/30 rounded-xl p-3.5 text-xs text-red-300">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            Your node&apos;s 3-month average uptime is <strong>{effectiveUptime.toFixed(0)}%</strong> — below the 50% minimum. No rewards are earned until uptime exceeds 50%. Keep this app running to improve your average.
          </span>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Contribution */}
        <div className="bg-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <HardDrive size={14} /> Local Contribution
          </div>
          <div className="text-2xl font-semibold">{formatBytes(stats?.usedBytes ?? 0)}</div>
          <div className="text-xs text-slate-500">
            of <span className="text-slate-300">{formatBytes(stats?.pledgedBytes ?? 0)}</span> pledged to the network
          </div>
          <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
            <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${Math.min(usedPct, 100).toFixed(1)}%` }} />
          </div>
          {diskFreeLabel && (
            <div className={`text-xs flex items-center gap-1 ${(diskFree ?? 0) < (stats?.pledgedBytes ?? 0) - (stats?.usedBytes ?? 0) ? "text-amber-400" : "text-slate-500"}`}>
              <Info size={11} />
              {diskFreeLabel} free on disk
              {(diskFree ?? 0) < (stats?.pledgedBytes ?? 0) - (stats?.usedBytes ?? 0) && " — less than your pledge, consider reducing it"}
            </div>
          )}
        </div>

        {/* My cloud storage */}
        <div className="bg-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Cloud size={14} /> My Cloud Storage
          </div>
          <div className={`text-2xl font-semibold ${isOverQuota ? "text-amber-400" : ""}`}>{formatBytes(usedUserBytes)}</div>
          <div className="text-xs text-slate-500">
            of <span className="text-slate-300">{formatBytes(quotaBytes)}</span> available
            {isOverQuota && <span className="text-amber-400 ml-1">— quota exceeded, uploads paused</span>}
          </div>
          <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
            <div className={`h-full rounded-full transition-all ${isOverQuota ? "bg-amber-500" : "bg-cyan-500"}`} style={{ width: `${Math.min(quotaUsedPct, 100).toFixed(1)}%` }} />
          </div>
          <div className="text-xs text-slate-500 flex items-center gap-1">
            <Info size={11} />
            End-to-end encrypted · files safe even over quota
          </div>
        </div>

        {/* Credits */}
        <div className="bg-slate-800 rounded-xl p-4 space-y-1">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <TrendingUp size={14} /> SwarmCredits
          </div>
          <div className="text-2xl font-semibold">{rewards?.balance?.credits?.toFixed(2) ?? "—"}</div>
          <div className="text-xs text-slate-500 space-y-0.5">
            <div>{rewards?.balance?.lifetimeEarned?.toFixed(2) ?? "—"} earned lifetime</div>
            <div>1 credit = +1 GB storage quota</div>
          </div>
          {effectiveUptime != null && (
            <div className={`text-xs flex items-center gap-1 pt-1 ${uptimeLabel(effectiveUptime).color}`}>
              <span>
                Uptime {effectiveUptime.toFixed(0)}% — {uptimeLabel(effectiveUptime).text}
              </span>
            </div>
          )}
        </div>

        {/* Node status + Quick actions */}
        <div className="bg-slate-800 rounded-xl p-4 space-y-3">
          <div className="text-sm text-slate-400 mb-1">Node Status</div>

          {nodeStatus ? (
            <div className="space-y-1.5 text-xs text-slate-400">
              <div className="flex justify-between">
                <span>Tier</span>
                <span className={nodeStatus.tier === "vault" ? "text-violet-300 font-medium" : "text-cyan-300 font-medium"}>
                  {tierLabel}
                  {nodeStatus.tier === "vault" ? " · 1.5× multiplier" : " · 1.0× multiplier"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>7-day uptime</span>
                <span className={uptimeLabel(nodeStatus.uptimePct).color}>{nodeStatus.uptimePct.toFixed(0)}%</span>
              </div>
              {nodeStatus.uptimePct3m != null && (
                <div className="flex justify-between">
                  <span>3-month avg (rewards)</span>
                  <span className={uptimeLabel(nodeStatus.uptimePct3m).color}>{nodeStatus.uptimePct3m.toFixed(0)}%</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Status</span>
                <span className={nodeStatus.status === "online" ? "text-emerald-400" : "text-slate-400"}>{nodeStatus.status}</span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-500">Node not registered yet — go to Settings to set up contribution.</div>
          )}

          <div className="flex flex-col gap-2 pt-1 border-t border-slate-700/50">
            {stats?.paused ? (
              <button
                className="w-full text-xs py-2 rounded-lg bg-emerald-900/30 hover:bg-emerald-800/40 transition-colors text-emerald-400 flex items-center justify-center gap-1.5"
                onClick={() => window.swarmvault.resumeContribution().then(load)}>
                <PlayCircle size={13} /> Resume Contribution
              </button>
            ) : (
              <button className="w-full text-xs py-2 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors text-slate-300 flex items-center justify-center gap-1.5" onClick={() => window.swarmvault.pauseContribution().then(load)}>
                <PauseCircle size={13} /> Pause Contribution
              </button>
            )}
            <div className="text-[10px] text-slate-600 text-center leading-tight">{stats?.paused ? "Paused: no new chunks accepted. Existing stored data remains on disk." : "Accepting chunk requests from the network."}</div>
          </div>
        </div>
      </div>

      {/* How it works note */}
      <div className="bg-slate-900/60 border border-slate-700/50 rounded-xl p-4 text-xs text-slate-500 space-y-1">
        <div className="flex items-center gap-1.5 text-slate-400 font-medium text-[11px] mb-1.5">
          <CheckCircle2 size={12} className="text-emerald-400" /> How SwarmVault protects your data
        </div>
        <div>
          · Files are encrypted with <strong className="text-slate-300">AES-256-GCM</strong> on your device before leaving. The server never sees your data.
        </div>
        <div>
          · Files are split into shards with <strong className="text-slate-300">Reed-Solomon redundancy</strong> — they survive even if several nodes go offline.
        </div>
        <div>· Vault-tier nodes (≥ 80% uptime) get priority placement for the most reliable storage.</div>
      </div>
    </div>
  );
}
