// ─────────────────────────────────────────────
//  Storage
// ─────────────────────────────────────────────
export const CHUNK_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB per shard
// Beta: reduced shard counts so uploads work with fewer online nodes.
// Restore to 4 data + 2 parity for production.
export const DEFAULT_DATA_SHARDS = 1;
export const DEFAULT_PARITY_SHARDS = 1; // tolerate up to 1 missing shard
export const MIN_NODES_FOR_STORE = DEFAULT_DATA_SHARDS + DEFAULT_PARITY_SHARDS;
export const BASE_STORAGE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB free for everyone

// ─────────────────────────────────────────────
//  Reward system
// ─────────────────────────────────────────────
/** Credits earned per GB contributed per 24h period (before tier multiplier) */
export const CREDITS_PER_GB_PER_DAY = 1;
/** 1 SwarmCredit = 1 GB of extra storage quota */
export const BYTES_PER_CREDIT = 1024 * 1024 * 1024;
/** Tier multipliers — intentionally low because each file is stored on multiple
 *  nodes, so contributed capacity fills up faster than a dedicated store would. */
export const TIER_MULTIPLIER: Record<string, number> = {
  vault: 0.5, // persistent / always-on
  swarm: 0.2, // consumer PC / best-effort
};
/** Maximum usable storage = base + credits (no artificial cap beyond credits) */

// ─────────────────────────────────────────────
//  Node health
// ─────────────────────────────────────────────
/** A node is considered offline after this many ms without a heartbeat */
export const NODE_OFFLINE_THRESHOLD_MS = 90_000; // 90 seconds
/** Heartbeat interval recommended for clients */
export const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

// ─────────────────────────────────────────────
//  Retrieval (Tier-2 claim)
// ─────────────────────────────────────────────
/** How long a retrieval job waits for nodes before failing */
export const RETRIEVAL_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─────────────────────────────────────────────
//  API
// ─────────────────────────────────────────────
export const API_VERSION = "v1";
export const API_BASE = `/api/${API_VERSION}`;
