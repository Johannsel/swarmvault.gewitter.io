/**
 * Storage Manager — handles the node's local storage contribution.
 *
 * Responsibilities:
 *  - Manages the on-disk chunk store directory
 *  - Encrypts/decrypts chunks on behalf of the swarm
 *  - Reports used/pledged bytes to the server via heartbeat
 *  - Handles shutdown-after-download trigger
 */

import { app } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import Store from "electron-store";
import { encryptChunk, decryptChunk, deriveShardKey, decodeMasterKey, serializeEncryptedChunk, deserializeEncryptedChunk, sha256 } from "@swarmvault/shared";

interface Settings {
  pledgedBytes: number; // bytes contributed to swarm
  /** @deprecated Tier is now auto-assigned by the server based on uptime. */
  tier: "vault" | "swarm";
  chunkDir: string;
  syncDir: string;
  serverUrl: string;
  nodeId: string | null;
  relayToken: string | null;
  authToken: string | null;
  contributionPaused: boolean;
  /**
   * Vault folder paths that should be mirrored locally.
   * Empty array = sync everything (default).
   * Each entry is a virtual path prefix, e.g. "/photos".
   */
  syncedFolders: string[];
}

const DEFAULT_CHUNK_DIR = path.join(app.getPath("userData"), "chunks");
const DEFAULT_SYNC_DIR = path.join(app.getPath("home"), "SwarmVault");
const DEFAULT_SERVER_URL = process.env.NODE_ENV === "development" ? "http://localhost:3000" : "https://api.swarmvault.gewitter.io";

// Short-lived cache so hasCapacity() doesn't hammer the filesystem on every chunk write
let _usedBytesCache: { value: number; at: number } | null = null;
const USED_BYTES_TTL_MS = 30_000;

const store = new Store<Settings>({
  name: "swarmvault-settings",
  defaults: {
    pledgedBytes: 10 * 1024 * 1024 * 1024, // 10 GB default
    tier: "swarm",
    chunkDir: DEFAULT_CHUNK_DIR,
    syncDir: DEFAULT_SYNC_DIR,
    serverUrl: DEFAULT_SERVER_URL,
    nodeId: null,
    relayToken: null,
    authToken: null,
    contributionPaused: false,
    syncedFolders: [], // empty = sync all
  },
});

export const storageManager = {
  async init(): Promise<void> {
    const chunkDir = store.get("chunkDir");
    const syncDir = store.get("syncDir");

    for (const dir of [chunkDir, syncDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    console.log("[storage] Chunk dir:", chunkDir);
    console.log("[storage] Sync dir:", syncDir);
  },

  getSettings(): Settings {
    const s = store.store;
    // Normalize empty/missing serverUrl so callers always get a valid URL
    if (!s.serverUrl || !s.serverUrl.trim()) {
      s.serverUrl = DEFAULT_SERVER_URL;
    }
    return s;
  },

  updateSettings(partial: Partial<Settings>): void {
    if (partial.serverUrl !== undefined) {
      const trimmed = partial.serverUrl.trim();
      if (trimmed === "") {
        // Empty string → revert to default instead of erroring
        partial = { ...partial, serverUrl: DEFAULT_SERVER_URL };
      } else {
        try {
          new URL(trimmed);
          partial = { ...partial, serverUrl: trimmed };
        } catch {
          throw new Error(`Invalid server URL: "${partial.serverUrl}". Must include protocol, e.g. https://api.example.com`);
        }
      }
    }
    for (const [k, v] of Object.entries(partial)) {
      store.set(k as keyof Settings, v);
    }
  },

  clearNodeCredentials(): void {
    store.delete("nodeId");
    store.delete("relayToken");
    console.log("[storage] Cleared stale node credentials");
  },

  getSyncDir(): string {
    return store.get("syncDir");
  },

  pauseContribution(): void {
    store.set("contributionPaused", true);
    console.log("[storage] Contribution paused");
  },

  resumeContribution(): void {
    store.set("contributionPaused", false);
    console.log("[storage] Contribution resumed");
  },

  isPaused(): boolean {
    return store.get("contributionPaused");
  },

  // ─── Chunk I/O ────────────────────────────────────────────────────────────

  chunkPath(chunkId: string): string {
    // Two-level directory sharding to avoid huge flat directories
    const prefix = chunkId.slice(0, 2);
    return path.join(store.get("chunkDir"), prefix, `${chunkId}.svchunk`);
  },

  async writeChunk(chunkId: string, plaintext: Buffer, masterKey: string, shardIndex: number): Promise<string> {
    if (!(await this.hasCapacity(plaintext.length))) {
      throw new Error(`[storage] Refusing chunk ${chunkId}: capacity limit reached`);
    }
    const key = deriveShardKey(decodeMasterKey(masterKey), shardIndex);
    const encrypted = encryptChunk(plaintext, key);
    const serialized = serializeEncryptedChunk(encrypted);
    const chunkHash = sha256(serialized);

    const p = this.chunkPath(chunkId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, serialized);
    _usedBytesCache = null; // invalidate after write

    return chunkHash;
  },

  /**
   * Write an already-encrypted chunk as-is.
   * Used by the WebSocket relay receiver — the uploader already encrypted the
   * bytes; the node just stores them opaquely and returns them on request.
   */
  async writeRawChunk(chunkId: string, encryptedData: Buffer): Promise<void> {
    if (!(await this.hasCapacity(encryptedData.length))) {
      throw new Error(`[storage] Refusing chunk ${chunkId}: capacity limit reached`);
    }
    const p = this.chunkPath(chunkId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, encryptedData);
    _usedBytesCache = null; // invalidate after write
  },

  /** Read raw encrypted bytes without decrypting (for retrieval relay back to server). */
  async readRawChunk(chunkId: string): Promise<Buffer> {
    return fs.readFile(this.chunkPath(chunkId));
  },

  async readChunk(chunkId: string, masterKey: string, shardIndex: number): Promise<Buffer> {
    const p = this.chunkPath(chunkId);
    const serialized = await fs.readFile(p);
    const encrypted = deserializeEncryptedChunk(serialized);
    const key = deriveShardKey(decodeMasterKey(masterKey), shardIndex);
    return decryptChunk(encrypted, key);
  },

  async deleteChunk(chunkId: string): Promise<void> {
    const p = this.chunkPath(chunkId);
    if (existsSync(p)) {
      await fs.unlink(p);
      _usedBytesCache = null;
    }
  },

  async deleteRawChunk(chunkId: string): Promise<void> {
    return this.deleteChunk(chunkId);
  },

  async getUsedBytes(): Promise<number> {
    if (_usedBytesCache && Date.now() - _usedBytesCache.at < USED_BYTES_TTL_MS) {
      return _usedBytesCache.value;
    }
    const chunkDir = store.get("chunkDir");
    let total = 0;
    try {
      for await (const entry of await fs.readdir(chunkDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const subDir = path.join(chunkDir, entry.name);
          const files = await fs.readdir(subDir);
          for (const file of files) {
            const stat = await fs.stat(path.join(subDir, file));
            total += stat.size;
          }
        }
      }
    } catch {
      // Directory may be empty
    }
    _usedBytesCache = { value: total, at: Date.now() };
    return total;
  },

  /**
   * Returns the number of bytes available on the filesystem where the chunk
   * directory lives. Uses `fs.statfs` (Node 18.15+ / Electron 28+).
   * Falls back to Infinity on older runtimes so we don't block writes.
   */
  async getAvailableDiskBytes(): Promise<number> {
    try {
      // fs.promises.statfs is available since Node 18.15 (Electron 28+)
      const stats = await (fs as typeof fs & { statfs(path: string): Promise<{ bsize: number; bavail: number }> }).statfs(store.get("chunkDir"));
      return stats.bavail * stats.bsize;
    } catch {
      return Infinity;
    }
  },

  /**
   * Returns true if the node has both the logical capacity (usedBytes + incoming ≤ pledgedBytes)
   * AND enough real disk space (leaving a 500 MB OS safety buffer).
   */
  async hasCapacity(incomingBytes: number): Promise<boolean> {
    if (this.isPaused()) return false;
    const pledgedBytes = store.get("pledgedBytes");
    const usedBytes = await this.getUsedBytes();
    if (usedBytes + incomingBytes > pledgedBytes) return false;
    const SAFETY_BUFFER = 500 * 1024 * 1024; // 500 MB
    const diskFree = await this.getAvailableDiskBytes();
    return diskFree > incomingBytes + SAFETY_BUFFER;
  },

  // ─── Shutdown after download ───────────────────────────────────────────────

  async initiateShutdown(delaySeconds = 30): Promise<void> {
    console.log(`[storage] Shutdown in ${delaySeconds} seconds…`);
    setTimeout(() => {
      const { exec } = require("node:child_process");
      const cmd = process.platform === "win32" ? `shutdown /s /t 0` : process.platform === "darwin" ? "osascript -e 'tell application \"System Events\" to shut down'" : "shutdown -h now";
      exec(cmd);
    }, delaySeconds * 1000);
  },
};
