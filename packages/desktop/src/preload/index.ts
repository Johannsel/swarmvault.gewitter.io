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

  // Event subscriptions
  onSyncStatus: (cb: (status: { connected: boolean }) => void) => {
    ipcRenderer.on("sync:status", (_event, status) => cb(status));
    return () => ipcRenderer.removeAllListeners("sync:status");
  },
  onAuthChanged: (cb: (state: { loggedIn: boolean; user: { email: string; username: string } | null }) => void) => {
    ipcRenderer.on("auth:changed", (_event, state) => cb(state));
    return () => ipcRenderer.removeAllListeners("auth:changed");
  },

  // Signal renderer is ready
  rendererReady: () => ipcRenderer.send("renderer:ready"),
} as const;

contextBridge.exposeInMainWorld("swarmvault", api);

export type SwarmVaultAPI = typeof api;
