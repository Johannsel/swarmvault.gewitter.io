import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { ipcMain as IpcMain, BrowserWindow } from "electron";
import { storageManager } from "./storage.js";
import { syncClient } from "./sync.js";

type IpcMainType = typeof IpcMain;

/** Fetch with an AbortController timeout (default 30 s). Prevents IPC handlers
 * from hanging indefinitely when the server is unreachable or slow. */
function fetchWithTimeout(url: string, options: RequestInit = {}, ms = 30_000): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

export const ipcHandlers = {
  register(ipcMain: IpcMainType, mainWindow: BrowserWindow | null): void {
    // ── Settings ──────────────────────────────────────────────────────────────

    ipcMain.handle("settings:get", () => {
      return storageManager.getSettings();
    });

    ipcMain.handle("settings:update", (_event, partial: Record<string, unknown>) => {
      // Whitelist permitted keys — prevents the renderer from writing arbitrary
      // entries (e.g. authToken, nodeId, relayToken) into the persistent store.
      const ALLOWED_SETTINGS = new Set(["pledgedBytes", "syncDir", "serverUrl"]);
      const safe = Object.fromEntries(Object.entries(partial).filter(([k]) => ALLOWED_SETTINGS.has(k)));
      const before = storageManager.getSettings();
      storageManager.updateSettings(safe);
      const after = storageManager.getSettings();
      // If the sync folder changed, restart the watcher on the new path
      if (after.syncDir !== before.syncDir && after.authToken && after.nodeId) {
        syncClient.startWatcher(after.syncDir);
      }
      return after;
    });

    // ── Authentication ────────────────────────────────────────────────────────

    ipcMain.handle("auth:login", async (_event, { email, password }: { email: string; password: string }) => {
      const settings = storageManager.getSettings();
      const res = await fetchWithTimeout(
        `${settings.serverUrl}/api/v1/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
        15_000,
      );
      if (!res.ok) {
        const text = await res.text();
        let msg = "Login failed";
        try {
          msg = (JSON.parse(text) as { error?: string }).error ?? msg;
        } catch {
          /* not JSON */
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { token: string; user: { id: string; email: string; username: string } };
      storageManager.updateSettings({ authToken: data.token });
      // Re-init sync if this node is already registered
      const updated = storageManager.getSettings();
      if (updated.nodeId) await syncClient.init();
      mainWindow?.webContents.send("auth:changed", { loggedIn: true, user: data.user });
      return data.user;
    });

    ipcMain.handle("auth:register", async (_event, { email, username, password }: { email: string; username: string; password: string }) => {
      const settings = storageManager.getSettings();
      const res = await fetchWithTimeout(
        `${settings.serverUrl}/api/v1/auth/register`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, username, password }),
        },
        15_000,
      );
      if (!res.ok) {
        const text = await res.text();
        let msg = "Registration failed";
        try {
          const err = JSON.parse(text) as { error?: string; details?: { fieldErrors?: Record<string, string[]> } };
          const fieldErrs = err.details?.fieldErrors;
          msg = fieldErrs
            ? Object.entries(fieldErrs)
                .map(([f, msgs]) => `${f}: ${msgs.join(", ")}`)
                .join(" | ")
            : (err.error ?? msg);
        } catch {
          /* not JSON */
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { token: string; user: { id: string; email: string; username: string } };
      storageManager.updateSettings({ authToken: data.token });
      mainWindow?.webContents.send("auth:changed", { loggedIn: true, user: data.user });
      return data.user;
    });

    ipcMain.handle("auth:logout", () => {
      storageManager.updateSettings({ authToken: null });
      syncClient.stop();
      mainWindow?.webContents.send("auth:changed", { loggedIn: false, user: null });
      return { ok: true };
    });

    ipcMain.handle(
      "node:register",
      async (
        _event,
        {
          displayName,
          tier,
          pledgedBytes,
        }: {
          displayName: string;
          tier: "vault" | "swarm";
          pledgedBytes: number;
        },
      ) => {
        const settings = storageManager.getSettings();
        if (!settings.authToken) throw new Error("Not authenticated");

        const res = await fetchWithTimeout(
          `${settings.serverUrl}/api/v1/nodes`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${settings.authToken}`,
            },
            body: JSON.stringify({ displayName, tier, pledgedBytes }),
          },
          15_000,
        );

        if (!res.ok) throw new Error(await res.text());
        const { node } = (await res.json()) as { node: { id: string; relayToken: string } };

        storageManager.updateSettings({
          nodeId: node.id,
          relayToken: node.relayToken,
          pledgedBytes,
          tier,
        });

        // Restart sync to pick up new credentials
        await syncClient.init();
        return node;
      },
    );

    // ── Storage stats ─────────────────────────────────────────────────────────

    ipcMain.handle("storage:stats", async () => {
      const [usedBytes, availableDiskBytes] = await Promise.all([storageManager.getUsedBytes(), storageManager.getAvailableDiskBytes()]);
      const settings = storageManager.getSettings();
      const sufficient = availableDiskBytes === Infinity || availableDiskBytes >= settings.pledgedBytes - usedBytes;
      return {
        usedBytes,
        pledgedBytes: settings.pledgedBytes,
        availableDiskBytes,
        sufficient,
        paused: storageManager.isPaused(),
        nodeId: settings.nodeId,
        tier: settings.tier,
      };
    });

    // Returns the user's own registered node record from the server (includes uptime, tier, status)
    ipcMain.handle("node:getOwn", async () => {
      const settings = storageManager.getSettings();
      if (!settings.authToken || !settings.nodeId) return null;
      try {
        const res = await fetchWithTimeout(`${settings.serverUrl}/api/v1/nodes`, {
          headers: { Authorization: `Bearer ${settings.authToken}` },
        });
        if (!res.ok) return null;
        const { nodes } = (await res.json()) as {
          nodes: Array<{
            id: string;
            displayName: string;
            tier: string;
            status: string;
            pledgedBytes: number;
            usedBytes: number;
            uptimePct: number;
            uptimePct3m: number | null;
            lastSeenAt: string | null;
            registeredAt: string;
          }>;
        };
        return nodes.find((n) => n.id === settings.nodeId) ?? null;
      } catch {
        return null;
      }
    });

    // ── Contribution control ──────────────────────────────────────────────────

    ipcMain.handle("contribution:pause", () => {
      storageManager.pauseContribution();
      return { paused: true };
    });

    ipcMain.handle("contribution:resume", () => {
      storageManager.resumeContribution();
      return { paused: false };
    });

    // ── File operations ───────────────────────────────────────────────────────

    ipcMain.handle("files:list", async (_event, params: { path?: string; status?: string }) => {
      const settings = storageManager.getSettings();
      const qs = new URLSearchParams();
      if (params.path) qs.set("path", params.path);
      if (params.status) qs.set("status", params.status);

      const res = await fetchWithTimeout(`${settings.serverUrl}/api/v1/files?${qs}`, {
        headers: { Authorization: `Bearer ${settings.authToken}` },
      });
      if (!res.ok) {
        if (res.status === 401) mainWindow?.webContents.send("auth:changed", { loggedIn: false, user: null });
        return { files: [], total: 0 };
      }
      const json = (await res.json()) as { files: Array<{ path: string; [key: string]: unknown }> };

      // Annotate each file with whether it exists in the local sync folder
      if (json?.files) {
        json.files = await Promise.all(
          json.files.map(async (file) => {
            const localPath = path.join(settings.syncDir, file.path.replace(/^\//, ""));
            let localSynced = false;
            try {
              await fs.access(localPath);
              localSynced = true;
            } catch {
              /* not present locally */
            }
            return { ...file, localSynced };
          }),
        );
      }

      return json;
    });

    ipcMain.handle("files:downloadToSync", async (_event, { fileId, filePath: virtualPath }: { fileId: string; filePath: string }) => {
      const settings = storageManager.getSettings();
      if (!settings.authToken) throw new Error("Not authenticated");
      // Strip leading slash — downloadFile joins with syncDir
      await syncClient.downloadFile(fileId, virtualPath.replace(/^\//, ""), settings);
      return { ok: true };
    });

    ipcMain.handle("files:deleteFromVault", async (_event, { fileId }: { fileId: string }) => {
      const settings = storageManager.getSettings();
      if (!settings.authToken) throw new Error("Not authenticated");
      const res = await fetchWithTimeout(`${settings.serverUrl}/api/v1/files/${fileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${settings.authToken}` },
      });
      if (res.status === 401) {
        mainWindow?.webContents.send("auth:changed", { loggedIn: false, user: null });
        throw new Error("Session expired");
      }
      if (!res.ok && res.status !== 404) throw new Error(await res.text());
      return { ok: true };
    });

    // ── Rewards ───────────────────────────────────────────────────────────────

    ipcMain.handle("rewards:get", async () => {
      const settings = storageManager.getSettings();
      if (!settings.authToken) return null;
      const res = await fetchWithTimeout(`${settings.serverUrl}/api/v1/rewards`, {
        headers: { Authorization: `Bearer ${settings.authToken}` },
      });
      if (!res.ok) return null;
      return res.json();
    });

    // ── Trash ─────────────────────────────────────────────────────────────────

    ipcMain.handle("files:trash", async () => {
      const settings = storageManager.getSettings();
      if (!settings.authToken) throw new Error("Not authenticated");
      const res = await fetchWithTimeout(`${settings.serverUrl}/api/v1/files/trash`, {
        headers: { Authorization: `Bearer ${settings.authToken}` },
      });
      if (!res.ok) {
        if (res.status === 401) mainWindow?.webContents.send("auth:changed", { loggedIn: false, user: null });
        return { files: [] };
      }
      return res.json();
    });

    ipcMain.handle("files:restore", async (_event, { fileId }: { fileId: string }) => {
      const settings = storageManager.getSettings();
      if (!settings.authToken) throw new Error("Not authenticated");
      const res = await fetchWithTimeout(`${settings.serverUrl}/api/v1/files/${fileId}/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.authToken}` },
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    });

    ipcMain.handle("files:deletePermanent", async (_event, { fileId }: { fileId: string }) => {
      const settings = storageManager.getSettings();
      if (!settings.authToken) throw new Error("Not authenticated");
      const res = await fetchWithTimeout(`${settings.serverUrl}/api/v1/files/${fileId}/permanent`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${settings.authToken}` },
      });
      if (!res.ok && res.status !== 404) throw new Error(await res.text());
      return { ok: true };
    });

    // ── Selective sync ────────────────────────────────────────────────────────

    ipcMain.handle("sync:getFolders", () => {
      return storageManager.getSettings().syncedFolders;
    });

    ipcMain.handle("sync:setFolders", async (_event, { folders }: { folders: string[] }) => {
      const current = storageManager.getSettings().syncedFolders;

      // Deselect folders that were removed
      for (const folder of current) {
        if (!folders.includes(folder)) {
          await syncClient.deselectFolder(folder);
        }
      }

      // Select newly added folders (deselectFolder already handled removals)
      storageManager.updateSettings({ syncedFolders: folders });

      // Download newly selected folders
      for (const folder of folders) {
        if (!current.includes(folder)) {
          await syncClient.selectFolder(folder);
        }
      }

      return { ok: true };
    });

    // ── File sharing ──────────────────────────────────────────────────────────

    ipcMain.handle("files:share", async (_event, { fileId }: { fileId: string }) => {
      const settings = storageManager.getSettings();
      if (!settings.authToken) throw new Error("Not authenticated");

      // Decrypt locally — server never sees plaintext
      const plaintext = await syncClient.downloadFileToBuffer(fileId, settings);

      // Upload shadow copy to server (5 min timeout — large files can take a while)
      const res = await fetchWithTimeout(
        `${settings.serverUrl}/api/v1/files/${fileId}/share`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.authToken}`,
            "Content-Type": "application/octet-stream",
          },
          body: plaintext,
        },
        300_000,
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ token: string; shareUrl: string; expiresAt: string }>;
    });

    ipcMain.handle("files:shareStatus", async (_event, { fileId }: { fileId: string }) => {
      const settings = storageManager.getSettings();
      if (!settings.authToken) throw new Error("Not authenticated");
      const res = await fetchWithTimeout(`${settings.serverUrl}/api/v1/files/${fileId}/share`, {
        headers: { Authorization: `Bearer ${settings.authToken}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ token: string; shareUrl: string; expiresAt: string }>;
    });

    ipcMain.handle("files:unshare", async (_event, { fileId }: { fileId: string }) => {
      const settings = storageManager.getSettings();
      if (!settings.authToken) throw new Error("Not authenticated");
      const res = await fetchWithTimeout(`${settings.serverUrl}/api/v1/files/${fileId}/share`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${settings.authToken}` },
      });
      if (!res.ok && res.status !== 404) throw new Error(await res.text());
      return { ok: true };
    });

    // ── System info ───────────────────────────────────────────────────────────

    ipcMain.handle("system:hostname", () => os.hostname());

    // ── Push events to renderer ───────────────────────────────────────────────

    // Direct poll — renderer calls this on mount to get the current state
    // without relying on timing-sensitive push events.
    ipcMain.handle("sync:isConnected", () => syncClient.isConnected());

    // Forward real-time WS connection status changes to the renderer
    syncClient.setStatusChangeCallback((connected) => {
      mainWindow?.webContents.send("sync:status", { connected });
    });

    // Notify renderer when a file has been uploaded so FileManager can refresh
    syncClient.setFilesChangedCallback(() => {
      mainWindow?.webContents.send("sync:changed");
    });

    ipcMain.on("renderer:ready", () => {
      // Send the actual current connection state (not hardcoded true)
      mainWindow?.webContents.send("sync:status", { connected: syncClient.isConnected() });
    });
  },
};
