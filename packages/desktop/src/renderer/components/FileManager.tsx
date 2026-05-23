import { useEffect, useState } from "react";
import { Download, FileIcon, Loader2, CheckCircle, Clock, AlertTriangle, Share2, X, Copy, Trash2, HardDrive, Cloud, RotateCcw, AlertCircle } from "lucide-react";

interface SwarmFile {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: string;
  status: string;
  tier: "vault" | "swarm";
  createdAt: string;
  localSynced: boolean;
}

interface TrashedFile {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: string;
  status: string;
  tier: "vault" | "swarm";
  deletedAt: string;
  createdAt: string;
}

interface ShareInfo {
  token: string;
  shareUrl: string;
  expiresAt: string;
}

function formatBytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function daysUntilPurge(deletedAt: string): number {
  const ms = 30 * 24 * 60 * 60 * 1000 - (Date.now() - new Date(deletedAt).getTime());
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

const statusIcon: Record<string, JSX.Element> = {
  available: <CheckCircle size={14} className="text-emerald-400" />,
  pending: <Loader2 size={14} className="text-yellow-400 animate-spin" />,
  claimed: <Clock size={14} className="text-blue-400" />,
  retrieving: <Loader2 size={14} className="text-violet-400 animate-spin" />,
  degraded: <AlertTriangle size={14} className="text-orange-400" />,
};

const statusLabel: Record<string, string> = {
  available: "Available",
  pending: "Uploading…",
  claimed: "Claimed",
  retrieving: "Retrieving…",
  degraded: "Degraded",
};

export default function FileManager() {
  const [tab, setTab] = useState<"files" | "trash">("files");

  // ── Files tab state ────────────────────────────────────────────────────────
  const [files, setFiles] = useState<SwarmFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionResult, setActionResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [quota, setQuota] = useState<{ usedBytes: number; quotaBytes: number; overQuota: boolean } | null>(null);

  const [shares, setShares] = useState<Record<string, ShareInfo | null>>({});
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SwarmFile | null>(null);
  const [pendingPurge, setPendingPurge] = useState<TrashedFile | null>(null);

  // ── Trash tab state ────────────────────────────────────────────────────────
  const [trashFiles, setTrashFiles] = useState<TrashedFile[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [purgingId, setPurgingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const res = (await window.swarmvault.listFiles({}).catch(() => null)) as {
      files: SwarmFile[];
      quota?: { usedBytes: number; quotaBytes: number; overQuota: boolean };
    } | null;
    setFiles(res?.files ?? []);
    if (res?.quota) setQuota(res.quota);
    setLoading(false);
  };

  const loadTrash = async () => {
    setTrashLoading(true);
    const res = await window.swarmvault.listTrash().catch(() => null);
    setTrashFiles((res as { files: TrashedFile[] } | null)?.files ?? []);
    setTrashLoading(false);
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);
  // Immediately refresh when the sync client finishes uploading a file
  useEffect(() => {
    const unsub = window.swarmvault.onSyncChanged(() => load());
    return unsub;
  }, []);
  useEffect(() => {
    if (tab === "trash") loadTrash();
  }, [tab]);

  const fetchShareStatus = async (fileId: string) => {
    if (fileId in shares) return;
    const info = await window.swarmvault.getShareStatus(fileId).catch(() => null);
    setShares((prev) => ({ ...prev, [fileId]: info }));
  };

  const handleDownload = async (file: SwarmFile) => {
    setDownloadingId(file.id);
    setActionResult(null);
    try {
      await window.swarmvault.downloadFileToSync(file.id, file.path);
      setActionResult({ ok: true, msg: `✓ "${file.name}" downloaded to sync folder` });
      await load();
    } catch {
      setActionResult({ ok: false, msg: `✗ Download failed — is the node online?` });
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = (file: SwarmFile) => setPendingDelete(file);

  const confirmDelete = async (file: SwarmFile) => {
    setDeletingId(file.id);
    setActionResult(null);
    try {
      await window.swarmvault.deleteFileFromVault(file.id);
      setActionResult({ ok: true, msg: `✓ "${file.name}" moved to trash` });
      await load();
    } catch {
      setActionResult({ ok: false, msg: `✗ Delete failed` });
    } finally {
      setDeletingId(null);
    }
  };

  const handleRestore = async (file: TrashedFile) => {
    setRestoringId(file.id);
    try {
      await window.swarmvault.restoreFile(file.id);
      await loadTrash();
      await load();
    } catch {
      /* show nothing — rare */
    } finally {
      setRestoringId(null);
    }
  };

  const handlePurge = (file: TrashedFile) => setPendingPurge(file);

  const confirmPurge = async (file: TrashedFile) => {
    setPurgingId(file.id);
    try {
      await window.swarmvault.deleteFilePermanent(file.id);
      await loadTrash();
    } catch {
      /* ignore */
    } finally {
      setPurgingId(null);
    }
  };

  const handleShare = async (file: SwarmFile) => {
    setSharingId(file.id);
    setShareError(null);
    try {
      const info = await window.swarmvault.shareFile(file.id);
      setShares((prev) => ({ ...prev, [file.id]: info }));
    } catch (e) {
      setShareError(e instanceof Error ? e.message : "Share failed");
    } finally {
      setSharingId(null);
    }
  };

  const handleUnshare = async (fileId: string) => {
    setSharingId(fileId);
    try {
      await window.swarmvault.unshareFile(fileId);
      setShares((prev) => ({ ...prev, [fileId]: null }));
    } finally {
      setSharingId(null);
    }
  };

  const copyShareUrl = (fileId: string, url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(fileId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">My Files</h1>
        <div className="flex items-center gap-2">
          {/* Tab switcher */}
          <div className="flex rounded-lg overflow-hidden border border-slate-700 text-xs">
            <button onClick={() => setTab("files")} className={`px-3 py-1.5 transition-colors ${tab === "files" ? "bg-violet-600 text-white" : "text-slate-400 hover:text-slate-200"}`}>
              Files
            </button>
            <button onClick={() => setTab("trash")} className={`px-3 py-1.5 transition-colors flex items-center gap-1 ${tab === "trash" ? "bg-violet-600 text-white" : "text-slate-400 hover:text-slate-200"}`}>
              <Trash2 size={11} /> Trash
            </button>
          </div>
          <button onClick={tab === "files" ? load : loadTrash} className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors">
            Refresh
          </button>
        </div>
      </div>

      {actionResult && <div className={`text-xs px-4 py-2 rounded-lg ${actionResult.ok ? "bg-emerald-900/30 text-emerald-400" : "bg-red-900/30 text-red-400"}`}>{actionResult.msg}</div>}
      {shareError && <div className="text-xs px-4 py-2 rounded-lg bg-red-900/30 text-red-400">✗ {shareError}</div>}

      {/* Over-quota banner */}
      {quota?.overQuota && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-900/30 border border-amber-700/40 text-amber-300">
          <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
          <div className="text-xs leading-relaxed">
            <span className="font-medium">Storage quota reached.</span> {formatBytes(quota.usedBytes)} used of {formatBytes(quota.quotaBytes)}. Your existing files are safe — but new uploads are paused until you earn more credits by keeping
            your node online, or delete files to free up space.
          </div>
        </div>
      )}

      {/* ── Files tab ──────────────────────────────────────────────────────── */}
      {tab === "files" &&
        (loading ? (
          <div className="flex items-center justify-center h-48 text-slate-500">
            <Loader2 className="animate-spin mr-2" size={18} /> Loading…
          </div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-slate-500 text-sm">No files yet. Add files to your sync folder to get started.</div>
        ) : (
          <div className="space-y-2">
            {files.map((file) => {
              void fetchShareStatus(file.id);
              const share = shares[file.id];
              const isExpired = share ? new Date(share.expiresAt) < new Date() : false;
              const activeShare = share && !isExpired ? share : null;

              return (
                <div key={file.id} className="bg-slate-800 rounded-lg overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <FileIcon size={16} className="text-slate-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{file.name}</div>
                      <div className="text-xs text-slate-500 truncate">{file.path}</div>
                    </div>

                    {file.localSynced ? (
                      <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300">
                        <HardDrive size={11} /> synced
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">
                        <Cloud size={11} /> vault only
                      </span>
                    )}

                    <div className="flex items-center gap-1.5 text-xs text-slate-500" title={file.status}>
                      {statusIcon[file.status] ?? null}
                      {statusLabel[file.status] ?? file.status}
                    </div>
                    <div className="text-xs text-slate-500 w-16 text-right">{formatBytes(Number(file.sizeBytes))}</div>
                    <div
                      className={`text-xs px-2 py-0.5 rounded-full ${file.tier === "vault" ? "bg-violet-900/40 text-violet-300" : "bg-cyan-900/40 text-cyan-300"}`}
                      title={file.tier === "vault" ? "Stored on high-uptime Vault nodes — most reliable" : "Stored across Swarm nodes"}>
                      {file.tier}
                    </div>

                    {file.status === "available" && !file.localSynced && (
                      <button
                        onClick={() => handleDownload(file)}
                        disabled={downloadingId === file.id}
                        title="Download to sync folder"
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 transition-colors">
                        {downloadingId === file.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                        Download
                      </button>
                    )}

                    {file.status === "available" &&
                      (activeShare ? (
                        <button
                          onClick={() => handleUnshare(file.id)}
                          disabled={sharingId === file.id}
                          title="Revoke share"
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-rose-900/50 hover:bg-rose-800 text-rose-300 disabled:opacity-50 transition-colors">
                          {sharingId === file.id ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                          Unshare
                        </button>
                      ) : (
                        <button
                          onClick={() => handleShare(file)}
                          disabled={sharingId === file.id}
                          title="Create a 7-day public share link"
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-50 transition-colors">
                          {sharingId === file.id ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
                          Share
                        </button>
                      ))}

                    <button
                      onClick={() => handleDelete(file)}
                      disabled={deletingId === file.id}
                      title="Move to trash (kept 30 days; local copy is kept)"
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-slate-700 hover:bg-red-900/60 text-slate-400 hover:text-red-300 disabled:opacity-50 transition-colors">
                      {deletingId === file.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    </button>
                  </div>

                  {activeShare && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-sky-950/40 border-t border-sky-900/30 text-xs">
                      <span className="text-sky-400 truncate flex-1 font-mono">{activeShare.shareUrl}</span>
                      <span className="text-slate-500 flex-shrink-0">expires {new Date(activeShare.expiresAt).toLocaleDateString()}</span>
                      <button onClick={() => copyShareUrl(file.id, activeShare.shareUrl)} className="flex items-center gap-1 px-2 py-1 rounded bg-sky-800 hover:bg-sky-700 text-sky-200 transition-colors flex-shrink-0">
                        <Copy size={11} />
                        {copiedId === file.id ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

      {/* ── Trash tab ──────────────────────────────────────────────────────── */}
      {tab === "trash" &&
        (trashLoading ? (
          <div className="flex items-center justify-center h-48 text-slate-500">
            <Loader2 className="animate-spin mr-2" size={18} /> Loading…
          </div>
        ) : trashFiles.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-slate-500 text-sm">Trash is empty.</div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">Files in trash are permanently deleted after 30 days.</p>
            {trashFiles.map((file) => {
              const days = daysUntilPurge(file.deletedAt);
              return (
                <div key={file.id} className="bg-slate-800 rounded-lg flex items-center gap-3 px-4 py-3">
                  <FileIcon size={16} className="text-slate-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate text-slate-400">{file.name}</div>
                    <div className="text-xs text-slate-600 truncate">{file.path}</div>
                  </div>
                  <div className="text-xs text-slate-500 w-16 text-right">{formatBytes(Number(file.sizeBytes))}</div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${days <= 3 ? "bg-red-900/40 text-red-400" : "bg-slate-700 text-slate-400"}`}>{days}d left</span>

                  <button
                    onClick={() => handleRestore(file)}
                    disabled={restoringId === file.id}
                    title="Restore file"
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-300 disabled:opacity-50 transition-colors">
                    {restoringId === file.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                    Restore
                  </button>

                  <button
                    onClick={() => handlePurge(file)}
                    disabled={purgingId === file.id}
                    title="Delete forever"
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-slate-700 hover:bg-red-900/60 text-slate-400 hover:text-red-300 disabled:opacity-50 transition-colors">
                    {purgingId === file.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      {/* ── Inline confirmation dialogs ─────────────────────────────────────────────── */}
      {pendingDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setPendingDelete(null)}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-sm w-full mx-4 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">Move to Trash?</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              <span className="text-slate-200 font-medium">"{pendingDelete.name}"</span> will be moved to trash and permanently deleted after 30 days. Your local copy (if any) is kept.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setPendingDelete(null)} className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => { void confirmDelete(pendingDelete); setPendingDelete(null); }}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 transition-colors">
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingPurge && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setPendingPurge(null)}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-sm w-full mx-4 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-red-400">Permanently Delete?</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              <span className="text-slate-200 font-medium">"{pendingPurge.name}"</span> will be permanently deleted. <span className="text-red-400">This cannot be undone.</span>
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setPendingPurge(null)} className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => { void confirmPurge(pendingPurge); setPendingPurge(null); }}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-red-100 transition-colors">
                Delete Forever
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
