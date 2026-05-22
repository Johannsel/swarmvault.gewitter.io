import { useEffect, useState } from "react";
import { Trophy, TrendingUp, Clock, Info, AlertTriangle } from "lucide-react";

interface RewardData {
  balance?: { credits: number; lifetimeEarned: number };
  recentSnapshots?: {
    id: string;
    creditsEarned: number;
    pledgedBytes: string;
    tier: string;
    uptimePct: number;
    snapshotAt: string;
  }[];
  quota?: { storageQuotaBytes: string; usedStorageBytes: string };
  creditsToBytes?: number;
}

function formatBytes(n: number): string {
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Mirrors the server-side uptimeRewardFactor function */
function uptimeRewardFactor(pct: number): number {
  if (pct >= 80) return 1;
  if (pct >= 50) return (pct - 50) / 30;
  return 0;
}

function uptimeBadge(pct: number): { label: string; color: string } {
  if (pct >= 80) return { label: "Full reward", color: "text-emerald-400" };
  if (pct >= 50) return { label: "Partial reward", color: "text-amber-400" };
  return { label: "No reward", color: "text-red-400" };
}

export default function Rewards() {
  const [data, setData] = useState<RewardData | null>(null);

  useEffect(() => {
    window.swarmvault.getRewards().then(setData).catch(console.error);
    const timer = setInterval(() => window.swarmvault.getRewards().then(setData).catch(console.error), 30_000);
    return () => clearInterval(timer);
  }, []);

  const baseBytes = 2 * 1024 ** 3; // 2 GB free for everyone
  const totalQuota = data?.quota ? Number(data.quota.storageQuotaBytes) : baseBytes;
  const earnedBytes = Math.max(0, totalQuota - baseBytes);

  // Projected daily credits from the most recent snapshot's rate (× 24 h)
  const recentSnaps = data?.recentSnapshots ?? [];
  const latestSnap = recentSnaps[0];
  const projectedDaily = latestSnap ? latestSnap.creditsEarned * 24 : null;

  // Effective uptime from latest snapshot
  const latestUptime = latestSnap?.uptimePct ?? null;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold flex items-center gap-2">
        <Trophy size={20} className="text-yellow-400" /> SwarmCredits & Rewards
      </h1>

      {/* Low-uptime warning */}
      {latestUptime != null && latestUptime < 50 && (
        <div className="flex items-start gap-2.5 bg-red-900/25 border border-red-500/30 rounded-xl p-3.5 text-xs text-red-300">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            Your effective uptime is <strong>{latestUptime.toFixed(0)}%</strong> — below the 50% threshold. You&apos;re currently earning <strong>no credits</strong>. Keep this app running consistently to cross 50%.
          </span>
        </div>
      )}

      {/* Balance cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-slate-800 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-400 flex items-center gap-1.5">
            <Trophy size={12} className="text-yellow-400" /> Current Credits
          </div>
          <div className="text-3xl font-bold text-yellow-400">{data?.balance?.credits?.toFixed(2) ?? "—"}</div>
          <div className="text-xs text-slate-500">available to spend</div>
        </div>

        <div className="bg-slate-800 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-400 flex items-center gap-1.5">
            <TrendingUp size={12} /> Lifetime Earned
          </div>
          <div className="text-3xl font-bold">{data?.balance?.lifetimeEarned?.toFixed(2) ?? "—"}</div>
          <div className="text-xs text-slate-500">credits total</div>
        </div>

        <div className="bg-slate-800 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-400">Earned Extra Storage</div>
          <div className="text-3xl font-bold text-cyan-400">{formatBytes(earnedBytes)}</div>
          <div className="text-xs text-slate-500">on top of 2 GB base quota</div>
        </div>
      </div>

      {/* Projected earnings */}
      {projectedDaily != null && (
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4 flex items-center gap-3 text-xs text-slate-400">
          <Info size={14} className="shrink-0 text-slate-500" />
          <span>
            At your current rate: <span className="text-yellow-400 font-medium">~{projectedDaily.toFixed(3)} credits/day</span> ≈{" "}
            <span className="text-cyan-400 font-medium">{formatBytes(projectedDaily * (data?.creditsToBytes ?? 1e9))}</span> of extra quota per day.
            {latestUptime != null && latestUptime >= 50 && latestUptime < 80 && <span className="text-amber-400"> Reach 80% uptime for full rewards.</span>}
          </span>
        </div>
      )}

      {/* How it works */}
      <div className="bg-slate-800 rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-medium text-slate-300">How Credits Work</h2>
        <div className="space-y-2 text-xs text-slate-400">
          <div className="flex justify-between items-center border-b border-slate-700 pb-2">
            <span>Vault tier (homeserver / high uptime)</span>
            <span className="text-violet-300 font-medium">1.5× multiplier</span>
          </div>
          <div className="flex justify-between items-center border-b border-slate-700 pb-2">
            <span>Swarm tier (consumer PC)</span>
            <span className="text-cyan-300 font-medium">1.0× multiplier</span>
          </div>
          <div className="flex justify-between items-center border-b border-slate-700 pb-2">
            <span>Base storage (free for everyone)</span>
            <span className="text-slate-300">2 GB</span>
          </div>
          <div className="flex justify-between items-center">
            <span>1 credit =</span>
            <span className="text-emerald-300">+1 GB storage quota</span>
          </div>
        </div>

        <div className="pt-2 space-y-1.5 text-xs text-slate-500">
          <div className="font-medium text-slate-400">Uptime reward ramp (3-month rolling average)</div>
          <div className="flex items-center gap-2">
            <div className="w-28 h-1.5 rounded-full bg-slate-700 overflow-hidden">
              <div className="h-full rounded-full bg-red-500" style={{ width: "33%" }} />
            </div>
            <span>
              Below 50% → <span className="text-red-400">no reward</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-28 h-1.5 rounded-full bg-slate-700 overflow-hidden">
              <div className="h-full rounded-full bg-amber-400" style={{ width: "66%" }} />
            </div>
            <span>
              50–80% → <span className="text-amber-400">partial reward (linear ramp)</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-28 h-1.5 rounded-full bg-slate-700 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-400" style={{ width: "100%" }} />
            </div>
            <span>
              ≥ 80% → <span className="text-emerald-400">full reward</span>
            </span>
          </div>
        </div>

        <p className="text-xs text-slate-500 pt-1 font-mono bg-slate-900/60 rounded p-2.5">credits/hour = pledged_gb × (1/24) × uptime_factor × tier_multiplier</p>
        <p className="text-xs text-slate-600">Tier is assigned automatically: nodes with ≥ 80% 7-day uptime are promoted to Vault tier.</p>
      </div>

      {/* Recent snapshots */}
      {recentSnaps.length > 0 && (
        <div className="bg-slate-800 rounded-xl p-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-300 flex items-center gap-1.5">
            <Clock size={13} /> Recent Hourly Snapshots
          </h2>
          <p className="text-xs text-slate-500">Uptime shown is the effective 3-month rolling average used for reward calculation. New nodes use a 7-day window until enough history accumulates (≥24 snapshots).</p>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {recentSnaps.map((snap) => {
              const badge = uptimeBadge(snap.uptimePct);
              return (
                <div key={snap.id} className="flex items-center justify-between text-xs py-1.5 border-b border-slate-700/50 last:border-0">
                  <div className="text-slate-400 space-x-1.5">
                    <span>{new Date(snap.snapshotAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    <span className={snap.tier === "vault" ? "text-violet-300" : "text-cyan-300"}>{snap.tier}</span>
                    <span>{formatBytes(Number(snap.pledgedBytes))} pledged</span>
                    <span className={badge.color}>
                      {snap.uptimePct.toFixed(0)}% — {badge.label}
                    </span>
                  </div>
                  <div className="text-yellow-400 font-medium shrink-0 ml-2">+{snap.creditsEarned.toFixed(4)} cr</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
