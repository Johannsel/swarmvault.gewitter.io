import { useState, useEffect } from "react";
import { LayoutDashboard, FolderOpen, Settings, Trophy } from "lucide-react";
import Dashboard from "./components/Dashboard.js";
import FileManager from "./components/FileManager.js";
import SettingsPanel from "./components/Settings.js";
import Rewards from "./components/Rewards.js";

type Tab = "dashboard" | "files" | "rewards" | "settings";

const tabs: { id: Tab; label: string; Icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { id: "files", label: "My Files", Icon: FolderOpen },
  { id: "rewards", label: "Rewards", Icon: Trophy },
  { id: "settings", label: "Settings", Icon: Settings },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [statusLabel, setStatusLabel] = useState("Loading…");
  const [statusOk, setStatusOk] = useState(false);

  const refreshStatus = async () => {
    try {
      const s = await window.swarmvault.getSettings() as { authToken: string | null; nodeId: string | null };
      if (!s.authToken) { setStatusLabel("Not logged in"); setStatusOk(false); }
      else if (!s.nodeId) { setStatusLabel("No node"); setStatusOk(false); }
      else { setStatusLabel("Node active"); setStatusOk(true); }
    } catch { setStatusLabel("Error"); setStatusOk(false); }
  };

  useEffect(() => {
    window.swarmvault.rendererReady();
    refreshStatus();
    const unsub = window.swarmvault.onAuthChanged(() => refreshStatus());
    return unsub;
  }, []);

  return (
    <div className="flex h-screen bg-slate-900 text-slate-100">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col">
        {/* Logo */}
        <div className="px-5 py-4 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center text-xs font-bold">
              SV
            </div>
            <span className="font-semibold text-slate-100">SwarmVault</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                activeTab === id
                  ? "bg-violet-600 text-white"
                  : "text-slate-400 hover:text-slate-100 hover:bg-slate-700"
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>

        {/* Status badge */}
        <div className="p-3 border-t border-slate-700">
          <div
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer transition-colors ${
              statusOk ? "bg-emerald-900/30 text-emerald-400" : "bg-slate-700/50 text-slate-500 hover:bg-slate-700"
            }`}
            onClick={() => setActiveTab("settings")}
            title="Click to open Settings"
          >
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
        {activeTab === "settings" && <SettingsPanel />}
      </main>
    </div>
  );
}
