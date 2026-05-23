import { useEffect, useState } from "react";
import { Save, HardDrive, Server, User, LogIn, LogOut, UserPlus, AlertTriangle, Info } from "lucide-react";
import SyncSelector from "./SyncSelector";

interface Settings {
  pledgedBytes: number;
  tier: "vault" | "swarm";
  syncDir: string;
  serverUrl: string;
  nodeId: string | null;
  relayToken: string | null;
  authToken: string | null;
  contributionPaused: boolean;
}

function gbToBytes(gb: number): number {
  return Math.round(gb * 1024 ** 3);
}

function bytesToGb(bytes: number): number {
  return bytes / 1024 ** 3;
}

type AuthMode = "login" | "register";

export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pledgedGb, setPledgedGb] = useState(10);
  const [saved, setSaved] = useState(false);
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);
  const [storageStats, setStorageStats] = useState<{
    availableDiskBytes: number | null;
    sufficient: boolean;
  } | null>(null);
  const [nodeStatus, setNodeStatus] = useState<{
    tier: string;
    uptimePct: number;
    uptimePct3m: number | null;
    status: string;
  } | null>(null);

  // Auth form
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [loggedInUser, setLoggedInUser] = useState<{ email: string; username: string } | null>(null);

  const reload = async () => {
    const s = (await window.swarmvault.getSettings()) as Settings;
    setSettings(s);
    setPledgedGb(Math.round(bytesToGb(s.pledgedBytes)));
    // Refresh disk stats + live node status in the background
    window.swarmvault
      .getStorageStats()
      .then((stats: { availableDiskBytes: number | null; sufficient: boolean }) => {
        setStorageStats(stats);
      })
      .catch(() => null);
    window.swarmvault
      .getNodeStatus()
      .then((n: { tier: string; uptimePct: number; uptimePct3m: number | null; status: string } | null) => {
        setNodeStatus(n);
      })
      .catch(() => null);
    // If authToken is set but we don't know who's logged in, just show token as indicator
    if (s.authToken && !loggedInUser) {
      setLoggedInUser({ email: "—", username: "—" });
    } else if (!s.authToken) {
      setLoggedInUser(null);
    }
  };

  useEffect(() => {
    reload();
    const unsub = window.swarmvault.onAuthChanged((state) => {
      setLoggedInUser(state.loggedIn ? state.user : null);
      reload();
    });
    return unsub;
  }, []);

  const handleAuth = async () => {
    setAuthError("");
    setAuthLoading(true);
    try {
      if (authMode === "login") {
        const user = (await window.swarmvault.login(email, password)) as { email: string; username: string };
        setLoggedInUser(user);
        setEmail("");
        setPassword("");
        await reload();
      } else {
        const user = (await window.swarmvault.register(email, username, password)) as { email: string; username: string };
        setLoggedInUser(user);
        setEmail("");
        setUsername("");
        setPassword("");
        await reload();
      }
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    await window.swarmvault.logout();
    setLoggedInUser(null);
    await reload();
  };

  const handleSave = async () => {
    if (!settings) return;
    const urlValue = settings.serverUrl.trim();
    if (urlValue !== "") {
      try {
        new URL(urlValue);
        setServerUrlError(null);
      } catch {
        setServerUrlError("Enter a valid URL including protocol, e.g. https://api.example.com");
        return;
      }
    } else {
      // Empty → revert to default in the UI as well
      setServerUrlError(null);
    }
    await window.swarmvault.updateSettings({
      pledgedBytes: gbToBytes(pledgedGb),
      syncDir: settings.syncDir,
      serverUrl: settings.serverUrl,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleRegisterNode = async () => {
    if (!settings) return;
    try {
      await window.swarmvault.registerNode({
        displayName: `My PC`,
        tier: "swarm", // server auto-promotes based on uptime
        pledgedBytes: gbToBytes(pledgedGb),
      });
      const updated = (await window.swarmvault.getSettings()) as Settings;
      setSettings(updated);
    } catch (err) {
      console.error("Node registration failed:", err);
    }
  };

  if (!settings) {
    return <div className="p-6 text-slate-500">Loading…</div>;
  }

  const isLoggedIn = !!settings.authToken;

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <h1 className="text-xl font-semibold flex items-center gap-2">
        <Server size={20} /> Settings
      </h1>

      {/* Account / Auth */}
      <section className="bg-slate-800 rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <User size={15} /> Account
        </h2>

        {isLoggedIn ? (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-emerald-400 font-medium">✓ Logged in</div>
              {loggedInUser && loggedInUser.email !== "—" && <div className="text-xs text-slate-400 mt-0.5">{loggedInUser.email}</div>}
            </div>
            <button onClick={handleLogout} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-red-900/40 hover:text-red-300 transition-colors text-slate-400">
              <LogOut size={13} /> Log out
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Login / Register toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                }}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors ${authMode === "login" ? "bg-violet-600 text-white" : "bg-slate-700 text-slate-400 hover:text-slate-200"}`}>
                <LogIn size={13} /> Log in
              </button>
              <button
                onClick={() => {
                  setAuthMode("register");
                  setAuthError("");
                }}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors ${authMode === "register" ? "bg-violet-600 text-white" : "bg-slate-700 text-slate-400 hover:text-slate-200"}`}>
                <UserPlus size={13} /> Register
              </button>
            </div>

            <div className="space-y-2">
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAuth()}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-violet-500 placeholder:text-slate-500"
              />
              {authMode === "register" && (
                <input
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAuth()}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-violet-500 placeholder:text-slate-500"
                />
              )}
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAuth()}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-violet-500 placeholder:text-slate-500"
              />
            </div>

            {authError && <div className="text-xs text-red-400 bg-red-900/20 rounded-lg px-3 py-2">{authError}</div>}

            <button
              onClick={handleAuth}
              disabled={authLoading || !email || !password || (authMode === "register" && !username)}
              className="w-full py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium transition-colors">
              {authLoading ? "…" : authMode === "login" ? "Log in" : "Create account"}
            </button>
          </div>
        )}
      </section>
      <section className="bg-slate-800 rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <HardDrive size={15} /> Storage Contribution
        </h2>

        <div className="space-y-2">
          <div className="text-xs bg-slate-700/60 rounded-lg px-4 py-3 text-slate-400 leading-relaxed">
            <span className="text-violet-300 font-medium">Tier is automatic.</span> Nodes with ≥ 80% uptime are automatically promoted to <span className="text-violet-300">Vault tier</span> and earn higher rewards. Nodes below 80% stay on{" "}
            <span className="text-cyan-300">Swarm tier</span>. Keep your PC online to earn more.
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-slate-400">
            Pledged Storage: <span className="text-white font-medium">{pledgedGb} GB</span>
            {storageStats?.availableDiskBytes != null && <span className="ml-2 text-slate-500">· {Math.floor(storageStats.availableDiskBytes / 1024 ** 3)} GB free on disk</span>}
            <span className="ml-2 text-slate-600">· ~{(pledgedGb / 24).toFixed(3)} cr/day at full uptime (swarm)</span>
          </label>
          <input type="range" min={5} max={2000} step={5} value={pledgedGb} onChange={(e) => setPledgedGb(Number(e.target.value))} className="w-full accent-violet-500" />
          <div className="flex justify-between text-xs text-slate-500">
            <span>5 GB</span>
            <span>2 TB</span>
          </div>
          {storageStats?.availableDiskBytes != null && pledgedGb * 1024 ** 3 > storageStats.availableDiskBytes && (
            <div className="flex items-start gap-2 text-xs px-3 py-2 rounded-lg bg-amber-900/30 text-amber-400">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>Only {Math.floor(storageStats.availableDiskBytes / 1024 ** 3)} GB is free on disk. Your pledge exceeds available space — reduce it or free up disk space to avoid write failures.</span>
            </div>
          )}
        </div>

        {!settings.nodeId ? (
          <button onClick={handleRegisterNode} className="w-full py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm font-medium transition-colors">
            Register This PC as a Node
          </button>
        ) : (
          <div className="text-xs text-emerald-400 flex items-center gap-1.5">
            ✓ Node registered <code className="text-slate-300">{settings.nodeId?.slice(0, 8)}…</code>
            {nodeStatus && (
              <span className="ml-2 text-slate-400">
                · <span className={nodeStatus.tier === "vault" ? "text-violet-300" : "text-cyan-300"}>{nodeStatus.tier}</span>
                {" · "}
                <span className={nodeStatus.uptimePct >= 80 ? "text-emerald-400" : nodeStatus.uptimePct >= 50 ? "text-amber-400" : "text-red-400"}>{(nodeStatus.uptimePct3m ?? nodeStatus.uptimePct).toFixed(0)}% uptime</span>
              </span>
            )}
          </div>
        )}
      </section>

      {/* Sync Folder */}
      <section className="bg-slate-800 rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <HardDrive size={15} /> Sync Folder
        </h2>
        <div className="space-y-1.5">
          <label className="text-xs text-slate-400">Local Sync Directory</label>
          <input
            type="text"
            value={settings.syncDir}
            onChange={(e) => setSettings((s) => (s ? { ...s, syncDir: e.target.value } : s))}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-violet-500"
          />
          <div className="flex items-start gap-1.5 text-xs text-slate-500">
            <Info size={11} className="shrink-0 mt-0.5" />
            Files here are AES-256-GCM encrypted on your device before upload. The server never sees your data. Changes are detected automatically and synced in real time.
          </div>
        </div>

        <div className="space-y-2 pt-1">
          <label className="text-xs text-slate-400">Selective Sync — choose which folders to keep on this device</label>
          <div className="text-xs text-slate-500 -mt-1">Unchecked folders stay in your vault but won&apos;t take up space on this device.</div>
          <SyncSelector />
        </div>
      </section>

      {/* Server URL */}
      <section className="bg-slate-800 rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-medium text-slate-300">Server</h2>
        <div className="space-y-1.5">
          <label className="text-xs text-slate-400">Orchestration Server URL</label>
          <input
            type="text"
            value={settings.serverUrl}
            placeholder="https://api.swarmvault.gewitter.io (default)"
            onChange={(e) => {
              setServerUrlError(null);
              setSettings((s) => (s ? { ...s, serverUrl: e.target.value } : s));
            }}
            className={`w-full bg-slate-700 border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-violet-500 placeholder:text-slate-600 ${serverUrlError ? "border-red-500" : "border-slate-600"}`}
          />
          {serverUrlError && (
            <div className="flex items-start gap-1.5 text-xs text-red-400">
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              {serverUrlError}
            </div>
          )}
          <div className="flex items-start gap-1.5 text-xs text-slate-500">
            <Info size={11} className="shrink-0 mt-0.5" />
            Leave as default for the public SwarmVault network. Only change if connecting to a private or self-hosted server.
          </div>
        </div>
      </section>

      {/* Save */}
      <button onClick={handleSave} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors ${saved ? "bg-emerald-600 text-white" : "bg-violet-600 hover:bg-violet-500 text-white"}`}>
        <Save size={15} />
        {saved ? "Saved!" : "Save Settings"}
      </button>
    </div>
  );
}
