import { useState, useEffect } from "react";
import { LayoutDashboard, FolderOpen, Settings, Trophy, Info } from "lucide-react";
import Dashboard from "./components/Dashboard.js";
import FileManager from "./components/FileManager.js";
import SettingsPanel from "./components/Settings.js";
import Rewards from "./components/Rewards.js";
import InfoPage from "./components/Info.js";

type Tab = "dashboard" | "files" | "rewards" | "info" | "settings";

const tabs: { id: Tab; label: string; Icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { id: "files", label: "My Files", Icon: FolderOpen },
  { id: "rewards", label: "Rewards", Icon: Trophy },
  { id: "info", label: "Swarm Info", Icon: Info },
  { id: "settings", label: "Settings", Icon: Settings },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [statusLabel, setStatusLabel] = useState("Loading…");
  const [statusOk, setStatusOk] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const refreshStatus = async () => {
    try {
      const s = (await window.swarmvault.getSettings()) as { authToken: string | null; nodeId: string | null };
      if (!s.authToken) {
        setStatusLabel("Not logged in");
        setStatusOk(false);
      } else if (!s.nodeId) {
        setStatusLabel("No node");
        setStatusOk(false);
      } else {
        setStatusLabel("Node active");
        setStatusOk(true);
      }
    } catch {
      setStatusLabel("Error");
      setStatusOk(false);
    }
  };

  useEffect(() => {
    window.swarmvault.rendererReady();
    refreshStatus();
    const unsubAuth = window.swarmvault.onAuthChanged(() => refreshStatus());
    const unsubUnlock = window.swarmvault.onNeedsUnlock(() => setNeedsUnlock(true));
    return () => {
      unsubAuth();
      unsubUnlock();
    };
  }, []);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setUnlocking(true);
    setUnlockError(null);
    try {
      await window.swarmvault.unlock(unlockPassword);
      setNeedsUnlock(false);
      setUnlockPassword("");
      refreshStatus();
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : "Incorrect password");
    } finally {
      setUnlocking(false);
    }
  };

  if (needsUnlock) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-900 text-slate-100">
        <div className="w-80 bg-slate-800 rounded-xl border border-slate-700 p-8 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center text-sm font-bold">SV</div>
            <div>
              <div className="font-semibold">SwarmVault</div>
              <div className="text-xs text-slate-400">Vault locked</div>
            </div>
          </div>
          <p className="text-sm text-slate-400">Enter your password to unlock the vault and resume sync.</p>
          <form onSubmit={handleUnlock} className="space-y-3">
            <input
              type="password"
              placeholder="Password"
              autoFocus
              value={unlockPassword}
              onChange={(e) => setUnlockPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-700 border border-slate-600 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
            {unlockError && <p className="text-xs text-red-400">{unlockError}</p>}
            <button type="submit" disabled={unlocking || !unlockPassword} className="w-full py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium transition-colors">
              {unlocking ? "Unlocking…" : "Unlock"}
            </button>
          </form>
          <button
            onClick={() => {
              window.swarmvault.logout();
              setNeedsUnlock(false);
            }}
            className="w-full text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Sign out instead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-900 text-slate-100">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col">
        {/* Logo */}
        <div className="px-5 py-4 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center text-xs font-bold">SV</div>
            <span className="font-semibold text-slate-100">SwarmVault</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === id ? "bg-violet-600 text-white" : "text-slate-400 hover:text-slate-100 hover:bg-slate-700"}`}>
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>

        {/* Status badge */}
        <div className="p-3 border-t border-slate-700">
          <div
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer transition-colors ${statusOk ? "bg-emerald-900/30 text-emerald-400" : "bg-slate-700/50 text-slate-500 hover:bg-slate-700"}`}
            onClick={() => setActiveTab("settings")}
            title="Click to open Settings">
            <div className={`w-2 h-2 rounded-full ${statusOk ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`} />
            {statusLabel}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {activeTab === "dashboard" && <Dashboard />}
        {activeTab === "files" && <FileManager />}
        {activeTab === "rewards" && <Rewards />}
        {activeTab === "info" && <InfoPage />}
        {activeTab === "settings" && <SettingsPanel />}
      </main>
    </div>
  );
}
