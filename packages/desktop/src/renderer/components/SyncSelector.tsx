import { useEffect, useState } from "react";
import { FolderIcon, Loader2 } from "lucide-react";

interface FolderEntry {
  virtualPath: string; // e.g. "/photos"
  fileCount: number;
}

/** Derive unique top-level virtual folder names from a flat list of file virtual paths. */
function deriveFolders(filePaths: string[]): FolderEntry[] {
  const counts = new Map<string, number>();
  for (const p of filePaths) {
    // p looks like "/photos/dog.jpg" or "/dog.jpg"
    const parts = p.replace(/^\//, "").split("/");
    const folder = parts.length > 1 ? `/${parts[0]}` : "/";
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([virtualPath, fileCount]) => ({ virtualPath, fileCount }));
}

export default function SyncSelector() {
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [syncedFolders, setSyncedFolders] = useState<string[]>([]);
  const [loadingFolder, setLoadingFolder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      const [filesRes, synced] = await Promise.all([
        window.swarmvault.listFiles({}).catch(() => null) as Promise<{ files: { path: string }[] } | null>,
        window.swarmvault.getSyncedFolders().catch(() => [] as string[]),
      ]);
      const paths = (filesRes?.files ?? []).map((f) => f.path);
      setFolders(deriveFolders(paths));
      setSyncedFolders(synced);
      setLoading(false);
    };
    void init();
  }, []);

  /** True when the folder is (or should be) synced locally.
   * Empty syncedFolders = everything is synced. */
  const isSelected = (virtualPath: string): boolean => {
    if (syncedFolders.length === 0) return true;
    return syncedFolders.includes(virtualPath);
  };

  const handleToggle = async (virtualPath: string, nowChecked: boolean) => {
    setLoadingFolder(virtualPath);
    try {
      if (nowChecked) {
        // When enabling from "sync all" state, we first pin everything else
        let next: string[];
        if (syncedFolders.length === 0) {
          // Was "sync all" → switching to explicit selection, select everything except nothing
          next = folders.map((f) => f.virtualPath);
        } else {
          next = [...syncedFolders, virtualPath];
        }
        await window.swarmvault.setSyncedFolders(next);
        setSyncedFolders(next);
      } else {
        // When disabling from "sync all" state, pin all others
        let current = syncedFolders;
        if (current.length === 0) {
          // Was "sync all" → build explicit list without this one
          current = folders.map((f) => f.virtualPath);
        }
        const next = current.filter((f) => f !== virtualPath);
        await window.swarmvault.setSyncedFolders(next);
        setSyncedFolders(next);
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingFolder(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
        <Loader2 size={14} className="animate-spin" /> Loading folders…
      </div>
    );
  }

  if (folders.length === 0) {
    return (
      <p className="text-xs text-slate-500 py-2">
        No folders yet. Drop files into your sync directory to get started — they&apos;ll appear here once uploaded.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {syncedFolders.length === 0 && (
        <p className="text-xs text-slate-500 pb-1">
          All folders are synced to this device. Uncheck a folder to stop keeping a local copy
          — your files remain safely in the vault.
        </p>
      )}
      {folders.map(({ virtualPath, fileCount }) => {
        const selected = isSelected(virtualPath);
        const spinning = loadingFolder === virtualPath;

        return (
          <label
            key={virtualPath}
            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800 cursor-pointer hover:bg-slate-700 transition-colors select-none"
          >
            {spinning ? (
              <Loader2 size={15} className="animate-spin text-violet-400 flex-shrink-0" />
            ) : (
              <input
                type="checkbox"
                checked={selected}
                onChange={(e) => handleToggle(virtualPath, e.target.checked)}
                className="accent-violet-500"
                disabled={spinning}
              />
            )}
            <FolderIcon size={14} className={selected ? "text-violet-300" : "text-slate-500"} />
            <span className={`text-sm flex-1 ${selected ? "text-slate-200" : "text-slate-500"}`}>
              {virtualPath === "/" ? "/ (top-level files)" : virtualPath.replace(/^\//, "")}
            </span>
            <span className="text-xs text-slate-600">{fileCount} file{fileCount !== 1 ? "s" : ""}</span>
          </label>
        );
      })}
    </div>
  );
}
