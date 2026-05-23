/**
 * Preload script — exposes a typed, safe API surface to the renderer
 * via contextBridge. The renderer never gets direct access to Node.js APIs.
 */

import { contextBridge, ipcRenderer } from "electron";

const api = {
  // Settings
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (partial: Record<string, unknown>) => ipcRenderer.invoke("settings:update", partial),

  // Authentication
  login: (email: string, password: string) => ipcRenderer.invoke("auth:login", { email, password }),
  register: (email: string, username: string, password: string) => ipcRenderer.invoke("auth:register", { email, username, password }),
  logout: () => ipcRenderer.invoke("auth:logout"),
  /** Re-derive the vault key after an app restart without going to the server. */
  unlock: (password: string) => ipcRenderer.invoke("auth:unlock", { password }) as Promise<{ ok: boolean }>,

  // Node management
  registerNode: (opts: { displayName: string; tier: "vault" | "swarm"; pledgedBytes: number }) => ipcRenderer.invoke("node:register", opts),

  // Storage
  getStorageStats: () => ipcRenderer.invoke("storage:stats"),
  getNodeStatus: () => ipcRenderer.invoke("node:getOwn"),

  // Contribution control
  pauseContribution: () => ipcRenderer.invoke("contribution:pause"),
  resumeContribution: () => ipcRenderer.invoke("contribution:resume"),

  // File operations
  listFiles: (params: { path?: string; status?: string }) => ipcRenderer.invoke("files:list", params),
  downloadFileToSync: (fileId: string, filePath: string) => ipcRenderer.invoke("files:downloadToSync", { fileId, filePath }) as Promise<{ ok: boolean }>,
  deleteFileFromVault: (fileId: string) => ipcRenderer.invoke("files:deleteFromVault", { fileId }) as Promise<{ ok: boolean }>,

  // Rewards
  getRewards: () => ipcRenderer.invoke("rewards:get"),

  // Trash
  listTrash: () => ipcRenderer.invoke("files:trash") as Promise<{ files: unknown[] }>,
  restoreFile: (fileId: string) => ipcRenderer.invoke("files:restore", { fileId }) as Promise<{ file: unknown }>,
  deleteFilePermanent: (fileId: string) => ipcRenderer.invoke("files:deletePermanent", { fileId }) as Promise<{ ok: boolean }>,

  // Selective sync
  getSyncedFolders: () => ipcRenderer.invoke("sync:getFolders") as Promise<string[]>,
  setSyncedFolders: (folders: string[]) => ipcRenderer.invoke("sync:setFolders", { folders }) as Promise<{ ok: boolean }>,

  // File sharing
  shareFile: (fileId: string) => ipcRenderer.invoke("files:share", { fileId }) as Promise<{ token: string; shareUrl: string; expiresAt: string }>,
  getShareStatus: (fileId: string) => ipcRenderer.invoke("files:shareStatus", { fileId }) as Promise<{ token: string; shareUrl: string; expiresAt: string } | null>,
  unshareFile: (fileId: string) => ipcRenderer.invoke("files:unshare", { fileId }) as Promise<{ ok: boolean }>,

  // Direct poll — get current WS connection state without waiting for an event
  getSyncConnected: () => ipcRenderer.invoke("sync:isConnected") as Promise<boolean>,

  // System info
  getSystemHostname: () => ipcRenderer.invoke("system:hostname") as Promise<string>,

  // Live swarm-wide statistics (no auth required)
  getSwarmStats: () =>
    ipcRenderer.invoke("swarm:stats") as Promise<{
      onlineNodes: number;
      totalNodes: number;
      onlinePledgedBytes: number;
      totalPledgedBytes: number;
      usedBytes: number;
    } | null>,

  // Fires when the sync client uploads a file (use to refresh FileManager)
  onSyncChanged: (cb: () => void) => {
    ipcRenderer.on("sync:changed", cb);
    return () => ipcRenderer.removeListener("sync:changed", cb);
  },

  // Fires when a sync upload fails — passes the error message
  onUploadError: (cb: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on("sync:upload-error", listener);
    return () => ipcRenderer.removeListener("sync:upload-error", listener);
  },

  // Event subscriptions
  onSyncStatus: (cb: (status: { connected: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: { connected: boolean }) => cb(status);
    ipcRenderer.on("sync:status", listener);
    return () => ipcRenderer.removeListener("sync:status", listener);
  },
  onAuthChanged: (cb: (state: { loggedIn: boolean; user: { email: string; username: string } | null }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { loggedIn: boolean; user: { email: string; username: string } | null }) => cb(state);
    ipcRenderer.on("auth:changed", listener);
    return () => ipcRenderer.removeListener("auth:changed", listener);
  },

  /** Fires once on startup when there is a saved session but the vault key needs re-entry. */
  onNeedsUnlock: (cb: () => void) => {
    ipcRenderer.once("auth:needsUnlock", cb);
    return () => ipcRenderer.removeListener("auth:needsUnlock", cb);
  },

  // Signal renderer is ready
  rendererReady: () => ipcRenderer.send("renderer:ready"),
} as const;

contextBridge.exposeInMainWorld("swarmvault", api);

export type SwarmVaultAPI = typeof api;
