/**
 * Sync Client — watches the local sync folder and keeps it mirrored with
 * the user's SwarmVault.
 *
 * Upload flow (local → vault):
 *  1. chokidar detects add / change in the sync folder
 *  2. Compare SHA-256 with server manifest cache — skip if already synced
 *  3. New file  → POST /api/v1/files  → upload shards
 *     Known file → PUT  /api/v1/files/:id → upload shards (preserves ID & shares)
 *  4. After re-upload, refresh the active share shadow if one exists
 *
 * Download flow (vault → local):
 *  1. On init: GET /manifest, compare with sync folder
 *  2. Missing files are downloaded; conflicting files get a conflict copy
 *  3. Any file can be manually downloaded via the IPC "files:downloadToSync" handler
 *
 * Deletion policy:
 *  - Local delete  → vault copy is kept (users manage vault via FileManager UI)
 *  - Vault delete  → local file is NOT touched (handled by IPC "files:deleteFromVault")
 */

import path from "node:path";
import fs from "node:fs/promises";
import chokidar, { FSWatcher } from "chokidar";
import { storageManager, getVaultKey } from "./storage.js";
import {
  encodeFile,
  generateMasterKey,
  deriveShardKey,
  encryptChunk,
  decryptChunk,
  serializeEncryptedChunk,
  deserializeEncryptedChunk,
  decodeFile,
  sha256,
  encryptMasterKey,
  decryptMasterKey,
  DEFAULT_DATA_SHARDS,
  DEFAULT_PARITY_SHARDS,
  HEARTBEAT_INTERVAL_MS,
} from "@swarmvault/shared";
import WebSocketLib from "ws";

// ─── Module-level state ────────────────────────────────────────────────────

let watcher: FSWatcher | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let authTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let ws: WebSocketLib | null = null;
let isAuthenticated = false;
let statusChangeCallback: ((connected: boolean) => void) | null = null;
let filesChangedCallback: (() => void) | null = null;
let uploadErrorCallback: ((message: string) => void) | null = null;

/** Paths currently being written by the sync client — suppress watcher events. */
const downloadingPaths = new Set<string>();

/**
 * Paths being removed by the sync client because the user deselected a folder.
 * These should NOT be trashed on the server — they're a deliberate local-only removal.
 */
const deselectingPaths = new Set<string>();

type ManifestEntry = {
  id: string;
  path: string;
  name: string;
  contentHash: string;
  sizeBytes: number;
  mimeType: string;
  status: string;
  updatedAt: string;
};
/** Virtual-path → server manifest entry.  Kept in sync after each upload. */
const serverManifest = new Map<string, ManifestEntry>();

// ─── Sync client ──────────────────────────────────────────────────────────

export const syncClient = {
  async init(): Promise<void> {
    const settings = storageManager.getSettings();
    if (!settings.authToken) {
      console.log("[sync] Not logged in — skipping sync init");
      return;
    }

    // Start WS connection only if this PC is also a registered storage node.
    // Uploading files to the vault only requires an auth token.
    if (settings.nodeId && settings.relayToken) {
      this.startWebSocket(settings.serverUrl, settings.nodeId, settings.relayToken);
    }

    // Populate manifest before starting the watcher so onFileAdded can skip
    // files that are already in sync.
    await this.refreshManifest(settings).catch((e) => console.error("[sync] Manifest fetch failed:", e));

    this.startWatcher(settings.syncDir);

    // Reconcile in the background — downloads anything missing locally.
    this.reconcile(settings).catch((e) => console.error("[sync] Reconcile failed:", e));
  },

  // ─── Watcher ─────────────────────────────────────────────────────────────

  startWatcher(syncDir: string): void {
    if (watcher) watcher.close();

    watcher = chokidar.watch(syncDir, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    });

    watcher
      .on("add", (filePath) => void this.onFileAdded(filePath))
      .on("change", (filePath) => void this.onFileChanged(filePath))
      .on("unlink", (filePath) => void this.onFileRemoved(filePath));

    console.log(`[sync] Watching: ${syncDir}`);
  },

  async onFileAdded(filePath: string): Promise<void> {
    // Ignore files being written by the sync client itself
    if (downloadingPaths.has(filePath)) return;

    const settings = storageManager.getSettings();
    if (!settings.authToken) return;

    const virtualPath = this.toVirtualPath(filePath, settings.syncDir);

    // Ignore files outside the user's selected sync folders
    if (!this.isPathSynced(virtualPath, settings.syncedFolders)) return;

    try {
      const data = await fs.readFile(filePath);
      const localHash = sha256(data);
      const entry = serverManifest.get(virtualPath);

      if (entry?.contentHash === localHash && entry?.status === "available") {
        // Already fully uploaded and available — nothing to do
        return;
      }

      // If status is "pending" (previous upload left orphaned shards) we fall
      // through and re-upload using the existing file ID so the server resets
      // the record instead of hitting the unique-path constraint.
      console.log(`[sync] Uploading: ${virtualPath}`);
      await this.uploadFile(filePath, virtualPath, settings, entry?.status === "pending" ? entry.id : undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync] Upload failed for ${virtualPath}:`, msg);
      uploadErrorCallback?.(`Upload failed for ${virtualPath}: ${msg}`);
    }
  },

  async onFileChanged(filePath: string): Promise<void> {
    if (downloadingPaths.has(filePath)) return;

    const settings = storageManager.getSettings();
    if (!settings.authToken) return;

    const virtualPath = this.toVirtualPath(filePath, settings.syncDir);

    if (!this.isPathSynced(virtualPath, settings.syncedFolders)) return;

    try {
      const data = await fs.readFile(filePath);
      const localHash = sha256(data);
      const entry = serverManifest.get(virtualPath);

      if (entry?.contentHash === localHash && entry?.status === "available") return; // no change

      console.log(`[sync] Re-uploading changed file: ${virtualPath}`);
      const fileId = await this.uploadFile(filePath, virtualPath, settings, entry?.id);

      // If there was an active share, refresh the shadow with the new plaintext.
      if (fileId) await this.refreshShareShadow(fileId, settings);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync] Re-upload failed for ${virtualPath}:`, msg);
      uploadErrorCallback?.(`Re-upload failed for ${virtualPath}: ${msg}`);
    }
  },

  async onFileRemoved(filePath: string): Promise<void> {
    // If this removal was triggered by the sync client (folder deselection), do NOT
    // touch the server — the vault copy should be preserved.
    if (deselectingPaths.has(filePath)) {
      deselectingPaths.delete(filePath);
      return;
    }

    const settings = storageManager.getSettings();
    if (!settings.authToken) return;

    const virtualPath = this.toVirtualPath(filePath, settings.syncDir);
    const entry = serverManifest.get(virtualPath);
    if (!entry) return; // file wasn't known to the server anyway

    // Soft-delete (trash) — stays in vault for 30 days then auto-purged
    try {
      await fetch(`${settings.serverUrl}/api/v1/files/${entry.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${settings.authToken}` },
      });
      serverManifest.delete(virtualPath);
      console.log(`[sync] Moved to trash: ${virtualPath}`);
    } catch (err) {
      console.error(`[sync] Trash failed for ${virtualPath}:`, err);
    }
  },

  /**
   * Deselect a folder from local sync: removes local files without trashing them
   * on the server, then updates the syncedFolders setting.
   *
   * @param folderVirtualPath  e.g. "/photos" — the folder to stop syncing locally
   */
  async deselectFolder(folderVirtualPath: string): Promise<void> {
    const settings = storageManager.getSettings();
    const normalised = folderVirtualPath.endsWith("/") ? folderVirtualPath : folderVirtualPath + "/";

    // Find all locally synced files in this folder and delete them without trashing
    for (const [virtualPath] of serverManifest.entries()) {
      const fileInFolder = virtualPath === folderVirtualPath || virtualPath.startsWith(normalised);
      if (!fileInFolder) continue;

      const localPath = path.join(settings.syncDir, virtualPath.replace(/^\//, ""));
      deselectingPaths.add(localPath);
      try {
        await fs.unlink(localPath);
      } catch {
        deselectingPaths.delete(localPath); // file didn't exist anyway
      }
    }

    // Persist the updated selection
    const updated = settings.syncedFolders.filter((f) => f !== folderVirtualPath);
    storageManager.updateSettings({ syncedFolders: updated });
    console.log(`[sync] Deselected folder (local files removed, vault copy kept): ${folderVirtualPath}`);
  },

  /**
   * Add a folder back to the local sync selection and immediately download
   * any files in it that are missing locally.
   */
  async selectFolder(folderVirtualPath: string): Promise<void> {
    const settings = storageManager.getSettings();
    const already = settings.syncedFolders.includes(folderVirtualPath);
    if (!already) {
      storageManager.updateSettings({
        syncedFolders: [...settings.syncedFolders, folderVirtualPath],
      });
    }
    // Trigger a reconcile to download any missing files
    const fresh = storageManager.getSettings();
    await this.refreshManifest(fresh);
    await this.reconcile(fresh);
    console.log(`[sync] Selected folder for sync: ${folderVirtualPath}`);
  },

  // ─── Upload ────────────────────────────────────────────────────────────────

  /**
   * Encrypt, shard, and upload a file.
   * - Provide `existingFileId` to update an existing vault file in-place (PUT).
   * - Omit it to register a new file (POST).
   * Returns the file's vault ID (useful for post-upload share refresh).
   */
  async uploadFile(filePath: string, virtualPath: string, settings: ReturnType<typeof storageManager.getSettings>, existingFileId?: string): Promise<string | null> {
    console.log(`[sync] uploadFile start: ${virtualPath} → ${settings.serverUrl} (existingId=${existingFileId ?? "new"})`);
    const data = await fs.readFile(filePath);

    const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
    if (data.length > MAX_FILE_BYTES) {
      throw new Error(`File too large (${(data.length / 1024 / 1024).toFixed(1)} MB). Maximum supported size is 100 MB.`);
    }

    const contentHash = sha256(data);
    const mimeType = "application/octet-stream";

    const masterKey = generateMasterKey();
    const shards = encodeFile(data, DEFAULT_DATA_SHARDS, DEFAULT_PARITY_SHARDS);
    const totalShards = DEFAULT_DATA_SHARDS + DEFAULT_PARITY_SHARDS;

    const bodyPayload = {
      name: path.basename(filePath),
      path: virtualPath,
      mimeType,
      sizeBytes: data.length,
      contentHash,
      totalShards: DEFAULT_DATA_SHARDS,
      parityShards: DEFAULT_PARITY_SHARDS,
      encryptedMasterKey: encryptMasterKey(masterKey, getVaultKey()),
    };

    const url = existingFileId ? `${settings.serverUrl}/api/v1/files/${existingFileId}` : `${settings.serverUrl}/api/v1/files`;
    const method = existingFileId ? "PUT" : "POST";

    const regRes = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.authToken}`,
      },
      body: JSON.stringify(bodyPayload),
    });

    console.log(`[sync] File registration response: ${regRes.status}`);
    if (!regRes.ok && regRes.status !== 202) {
      const err = await regRes.json().catch(() => ({}));
      throw new Error(`Server rejected file (HTTP ${regRes.status}): ${JSON.stringify(err)}`);
    }

    const regData = (await regRes.json()) as {
      file: { id: string };
      shardAssignment: { shardIndex: number; nodeId: string; nodeRelayToken: string }[] | null;
      queued: boolean;
    };

    let shardAssignment = regData.shardAssignment;
    if (regData.queued || !shardAssignment) {
      console.log(`[sync] Queued (not enough online nodes) — polling for shard assignment for ${virtualPath}`);
      shardAssignment = await this.pollForAssignment(regData.file.id, settings.serverUrl, settings.authToken!);
      if (!shardAssignment) {
        throw new Error(`Timed out waiting for shard assignment — no online nodes available for ${virtualPath}`);
      }
    } else {
      console.log(`[sync] Got shard assignment for ${virtualPath}: ${shardAssignment.length} shard(s)`);
    }

    for (let i = 0; i < totalShards; i++) {
      const shard = shards[i]!;
      const key = deriveShardKey(masterKey, i);
      const encrypted = encryptChunk(shard, key);
      const serialized = serializeEncryptedChunk(encrypted);
      const chunkHash = sha256(serialized);
      const targetNode = shardAssignment[i % shardAssignment.length]!;

      console.log(`[sync] Uploading shard ${i}/${totalShards - 1} (${serialized.length} bytes) → node ${targetNode.nodeId}`);
      const chunkRes = await fetch(`${settings.serverUrl}/api/v1/chunks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${settings.authToken}`,
          "X-File-Id": regData.file.id,
          "X-Shard-Index": String(i),
          "X-Chunk-Hash": chunkHash,
          "X-Is-Data": String(i < DEFAULT_DATA_SHARDS),
          "X-Node-Id": targetNode.nodeId,
        },
        body: serialized,
      });
      console.log(`[sync] Shard ${i} response: ${chunkRes.status}`);

      if (!chunkRes.ok) {
        const errBody = await chunkRes.json().catch(() => ({}));
        throw new Error(`Shard ${i} upload failed (HTTP ${chunkRes.status}): ${JSON.stringify(errBody)}`);
      }
    }

    // Update the in-memory manifest so subsequent watcher events are skipped
    serverManifest.set(virtualPath, {
      id: regData.file.id,
      path: virtualPath,
      name: path.basename(filePath),
      contentHash,
      sizeBytes: data.length,
      mimeType,
      status: "pending",
      updatedAt: new Date().toISOString(),
    });

    console.log(`[sync] Uploaded: ${virtualPath} (${shards.length} shards)`);
    filesChangedCallback?.();
    return regData.file.id;
  },

  // ─── Manifest ─────────────────────────────────────────────────────────────

  async refreshManifest(settings: ReturnType<typeof storageManager.getSettings>): Promise<void> {
    if (!settings.authToken) return;
    const res = await fetch(`${settings.serverUrl}/api/v1/files/manifest`, {
      headers: { Authorization: `Bearer ${settings.authToken}` },
    });
    if (!res.ok) return;
    const { files } = (await res.json()) as { files: ManifestEntry[] };
    serverManifest.clear();
    for (const f of files) serverManifest.set(f.path, f);
    console.log(`[sync] Manifest loaded: ${files.length} file(s)`);
  },

  // ─── Reconcile (startup mirror) ────────────────────────────────────────────

  async reconcile(settings: ReturnType<typeof storageManager.getSettings>): Promise<void> {
    if (!settings.authToken) return;

    let downloaded = 0;
    let conflicts = 0;

    for (const [virtualPath, entry] of serverManifest.entries()) {
      if (entry.status !== "available") continue;

      // Only reconcile folders that are in the user's sync selection
      if (!this.isPathSynced(virtualPath, settings.syncedFolders)) continue;

      const localPath = path.join(settings.syncDir, virtualPath.replace(/^\//, ""));

      let localData: Buffer | null = null;
      try {
        localData = await fs.readFile(localPath);
      } catch {
        /* file doesn't exist locally */
      }

      if (localData === null) {
        // File missing locally — download it
        console.log(`[sync] Reconcile: downloading ${virtualPath}`);
        downloadingPaths.add(localPath);
        try {
          await this.downloadFile(entry.id, virtualPath.replace(/^\//, ""), settings);
          downloaded++;
        } catch (err) {
          console.error(`[sync] Reconcile: download failed for ${virtualPath}:`, err);
        } finally {
          setTimeout(() => downloadingPaths.delete(localPath), 3000);
        }
      } else {
        const localHash = sha256(localData);
        if (localHash === entry.contentHash) continue; // already in sync

        // Both sides have content — check which is newer
        const stat = await fs.stat(localPath).catch(() => null);
        const localMtime = stat?.mtime.getTime() ?? 0;
        const serverMtime = new Date(entry.updatedAt).getTime();

        if (localMtime > serverMtime) {
          // Local is newer — watcher will pick it up and re-upload
          console.log(`[sync] Reconcile: local ${virtualPath} is newer — will re-upload`);
        } else {
          // Server is newer — keep both: rename local to conflict copy, download server version
          const ext = path.extname(localPath);
          const base = path.basename(localPath, ext);
          const dir = path.dirname(localPath);
          const dateStr = new Date().toISOString().split("T")[0];
          const conflictPath = path.join(dir, `${base} (conflict ${dateStr})${ext}`);

          await fs.rename(localPath, conflictPath).catch(() => {});
          console.log(`[sync] Reconcile: conflict for ${virtualPath} — local saved as ${path.basename(conflictPath)}`);
          conflicts++;

          downloadingPaths.add(localPath);
          try {
            await this.downloadFile(entry.id, virtualPath.replace(/^\//, ""), settings);
            downloaded++;
          } catch (err) {
            console.error(`[sync] Reconcile: download failed for ${virtualPath}:`, err);
          } finally {
            setTimeout(() => downloadingPaths.delete(localPath), 3000);
          }
        }
      }
    }

    if (downloaded > 0 || conflicts > 0) {
      console.log(`[sync] Reconcile complete: ${downloaded} downloaded, ${conflicts} conflict(s)`);
    }
  },

  // ─── Share shadow refresh ─────────────────────────────────────────────────

  async refreshShareShadow(fileId: string, settings: ReturnType<typeof storageManager.getSettings>): Promise<void> {
    if (!settings.authToken) return;
    const check = await fetch(`${settings.serverUrl}/api/v1/files/${fileId}/share`, {
      headers: { Authorization: `Bearer ${settings.authToken}` },
    }).catch(() => null);
    if (!check?.ok) return; // no active share

    try {
      const plaintext = await this.downloadFileToBuffer(fileId, settings);
      await fetch(`${settings.serverUrl}/api/v1/files/${fileId}/share`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.authToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: plaintext,
      });
      console.log(`[sync] Share shadow refreshed for file ${fileId}`);
    } catch (err) {
      console.error(`[sync] Share shadow refresh failed:`, err);
    }
  },

  // ─── Download ─────────────────────────────────────────────────────────────

  async downloadFile(fileId: string, saveName: string, settings: ReturnType<typeof storageManager.getSettings>): Promise<void> {
    const original = await this.downloadFileToBuffer(fileId, settings);
    const outPath = path.join(settings.syncDir, saveName);
    // Guard against path traversal: resolved path must stay inside syncDir
    const syncDirResolved = path.resolve(settings.syncDir);
    const outPathResolved = path.resolve(outPath);
    if (!outPathResolved.startsWith(syncDirResolved + path.sep) && outPathResolved !== syncDirResolved) {
      throw new Error(`Path traversal detected in server-supplied path: ${saveName}`);
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, original);
    console.log(`[sync] Downloaded: ${saveName} (${original.length} bytes)`);
  },

  async downloadFileToBuffer(fileId: string, settings: ReturnType<typeof storageManager.getSettings>): Promise<Buffer> {
    if (!settings.authToken) throw new Error("Not authenticated");

    const res = await fetch(`${settings.serverUrl}/api/v1/files/${fileId}/download`, {
      headers: { Authorization: `Bearer ${settings.authToken}` },
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`Download failed (${res.status}): ${JSON.stringify(errBody)}`);
    }

    const body = (await res.json()) as {
      name: string;
      sizeBytes: number;
      encryptedMasterKey: string;
      totalShards: number;
      parityShards: number;
      shards: { index: number; data: string; chunkHash: string }[];
    };

    const masterKey = decryptMasterKey(body.encryptedMasterKey, getVaultKey());
    const totalShards = body.totalShards + body.parityShards;

    const shardSlots: (Buffer | null)[] = new Array(totalShards).fill(null);
    for (const s of body.shards) {
      const raw = Buffer.from(s.data, "base64");
      const encChunk = deserializeEncryptedChunk(raw);
      const shardKey = deriveShardKey(masterKey, s.index);
      shardSlots[s.index] = decryptChunk(encChunk, shardKey);
    }

    return decodeFile(shardSlots, body.totalShards, body.parityShards, body.sizeBytes);
  },

  // ─── WebSocket / heartbeat ────────────────────────────────────────────────

  startWebSocket(serverUrl: string, nodeId: string, relayToken: string): void {
    const wsUrl = serverUrl.replace(/^http/, "ws") + "/ws";

    const connect = () => {
      isAuthenticated = false;
      ws = new WebSocketLib(wsUrl, { maxPayload: 120 * 1024 * 1024 }); // allow up to 120 MB binary frames

      ws.onopen = () => {
        console.log("[ws] Connected to server — authenticating");
        // Don't report connected yet; wait for auth_ack so the status only
        // shows "Connected" after the server has confirmed the credentials.
        ws!.send(JSON.stringify({ type: "auth", payload: { nodeId, relayToken } }));
        // If auth_ack is not received within 10 s the server is either not
        // responding or silently rejecting the credentials — close and retry.
        authTimeoutTimer = setTimeout(() => {
          if (!isAuthenticated) {
            console.warn("[ws] Auth timeout — no auth_ack received, reconnecting");
            ws?.close();
          }
        }, 10_000);
      };

      ws.onmessage = (event) => {
        const rawData = event.data;

        // ── Binary frame: chunk_relay ──────────────────────────────────────
        // Layout: [4-byte metadata length (BE uint32)][metadata JSON][raw chunk bytes]
        // Using binary avoids the 33% base64 overhead and large JSON.parse cost.
        if (Buffer.isBuffer(rawData)) {
          try {
            const metaLen = rawData.readUInt32BE(0);
            const meta = JSON.parse(rawData.subarray(4, 4 + metaLen).toString("utf8")) as {
              type: string;
              fileId: string;
              shardIndex: number;
              chunkHash: string;
              isData: boolean;
              ackNonce: string;
            };
            if (meta.type === "chunk_relay") {
              const chunkData = rawData.subarray(4 + metaLen);
              storageManager
                .writeRawChunk(`${meta.fileId}-${meta.shardIndex}`, chunkData)
                .then(() => {
                  ws?.send(
                    JSON.stringify({
                      type: "chunk_ack",
                      payload: { fileId: meta.fileId, shardIndex: meta.shardIndex, ackNonce: meta.ackNonce, success: true, chunkHash: meta.chunkHash },
                    }),
                  );
                })
                .catch((err) => {
                  console.error("[ws] Failed to store chunk:", err);
                  ws?.send(
                    JSON.stringify({
                      type: "chunk_ack",
                      payload: { fileId: meta.fileId, shardIndex: meta.shardIndex, ackNonce: meta.ackNonce, success: false, chunkHash: meta.chunkHash },
                    }),
                  );
                });
            }
          } catch (e) {
            console.error("[ws] Failed to parse binary frame:", e);
          }
          return;
        }

        // ── Text frame: JSON messages ──────────────────────────────────────
        try {
          const msg = JSON.parse(rawData as string) as { type: string; payload: unknown };

          // auth_ack: credentials accepted — mark connected and start heartbeat
          if (msg.type === "auth_ack") {
            console.log("[ws] Authenticated");
            if (authTimeoutTimer) {
              clearTimeout(authTimeoutTimer);
              authTimeoutTimer = null;
            }
            isAuthenticated = true;
            statusChangeCallback?.(true);
            void this.sendHeartbeat(nodeId, relayToken);
            heartbeatTimer = setInterval(() => void this.sendHeartbeat(nodeId, relayToken), HEARTBEAT_INTERVAL_MS);
            return;
          }

          this.handleWsMessage(msg);
        } catch {
          /* ignore malformed messages */
        }
      };

      ws.onclose = (event) => {
        const code = (event as { code?: number }).code;
        const reason = (event as { reason?: string }).reason ?? "";
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (authTimeoutTimer) {
          clearTimeout(authTimeoutTimer);
          authTimeoutTimer = null;
        }
        isAuthenticated = false;
        statusChangeCallback?.(false);

        // Code 4001: server explicitly rejected credentials.
        // Clear the stale node registration so the user can re-register.
        if (code === 4001) {
          console.warn("[ws] Server rejected node credentials — clearing stale node registration");
          storageManager.clearNodeCredentials();
          return; // stop reconnecting
        }

        console.log(`[ws] Disconnected (code: ${code}${reason ? ", reason: " + reason : ""}) — reconnecting in 10s`);
        setTimeout(connect, 10_000);
      };

      ws.onerror = (err) => console.error("[ws] Error:", (err as { message?: string }).message ?? err);
    };

    connect();
  },

  async sendHeartbeat(nodeId: string, relayToken: string): Promise<void> {
    if (!ws || ws.readyState !== WebSocketLib.OPEN) return;
    const settings = storageManager.getSettings();
    const usedBytes = await storageManager.getUsedBytes();
    ws.send(
      JSON.stringify({
        type: "heartbeat",
        payload: {
          nodeId,
          relayToken,
          status: storageManager.isPaused() ? "maintenance" : "online",
          usedBytes,
          pledgedBytes: settings.pledgedBytes,
        },
      }),
    );
  },

  handleWsMessage(msg: { type: string; payload: unknown }): void {
    if (msg.type === "chunk_request") {
      const { fileId, shardIndex, requestNonce } = msg.payload as { fileId: string; shardIndex: number; requestNonce: string };
      const chunkId = `${fileId}-${shardIndex}`;
      storageManager
        .readRawChunk(chunkId)
        .then((data) => {
          ws?.send(
            JSON.stringify({
              type: "chunk_response",
              payload: { fileId, shardIndex, requestNonce, data: data.toString("base64"), chunkHash: sha256(data) },
            }),
          );
        })
        .catch((err) => {
          console.error("[ws] Failed to read chunk:", err);
        });
      return;
    }

    if (msg.type === "chunk_delete") {
      const { fileId, shardIndex } = msg.payload as { fileId: string; shardIndex: number };
      const chunkId = `${fileId}-${shardIndex}`;
      storageManager
        .deleteRawChunk(chunkId)
        .then(() => console.log(`[ws] Deleted redistributed chunk ${chunkId}`))
        .catch((err) => console.error(`[ws] Failed to delete chunk ${chunkId}:`, err));
    }
  },

  stop(): void {
    watcher?.close();
    ws?.close();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (authTimeoutTimer) {
      clearTimeout(authTimeoutTimer);
      authTimeoutTimer = null;
    }
    isAuthenticated = false;
  },

  // ─── Helpers ──────────────────────────────────────────────────────────────

  toVirtualPath(absolutePath: string, syncDir: string): string {
    return "/" + path.relative(syncDir, absolutePath).replace(/\\/g, "/");
  },

  /**
   * Returns true if `virtualPath` should be synced locally.
   * When `syncedFolders` is empty, all paths are synced.
   * Otherwise a path is synced if it falls under one of the selected folders.
   */
  isPathSynced(virtualPath: string, syncedFolders: string[]): boolean {
    if (syncedFolders.length === 0) return true;
    return syncedFolders.some((folder) => {
      const prefix = folder.endsWith("/") ? folder : folder + "/";
      return virtualPath === folder || virtualPath.startsWith(prefix);
    });
  },

  async pollForAssignment(fileId: string, serverUrl: string, authToken: string): Promise<{ shardIndex: number; nodeId: string; nodeRelayToken: string }[] | null> {
    const POLL_INTERVAL_MS = 10_000;
    const MAX_ATTEMPTS = 30;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // First attempt: check immediately (nodes may have just come online).
      // Subsequent attempts: wait before polling.
      if (attempt > 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const res = await fetch(`${serverUrl}/api/v1/files/${fileId}/assignment`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.ok) {
          const { shardAssignment } = (await res.json()) as {
            shardAssignment: { shardIndex: number; nodeId: string; nodeRelayToken: string }[];
          };
          return shardAssignment;
        }
      } catch {
        /* network hiccup — keep trying */
      }
      console.log(`[sync] Waiting for node assignment (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    }
    return null;
  },

  isConnected(): boolean {
    return isAuthenticated;
  },

  setStatusChangeCallback(cb: (connected: boolean) => void): void {
    statusChangeCallback = cb;
  },

  setFilesChangedCallback(cb: () => void): void {
    filesChangedCallback = cb;
  },

  setUploadErrorCallback(cb: (message: string) => void): void {
    uploadErrorCallback = cb;
  },
};
