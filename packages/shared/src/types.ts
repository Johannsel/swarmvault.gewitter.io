// ─────────────────────────────────────────────
//  User & Auth
// ─────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  username: string;
  createdAt: Date;
  storageQuotaBytes: number; // base + earned credits in bytes
  usedStorageBytes: number;
}

export interface AuthTokenPayload {
  sub: string; // user id
  email: string;
  username: string;
  iat: number;
  exp: number;
}

// ─────────────────────────────────────────────
//  Storage Tiers
// ─────────────────────────────────────────────

/** Tier 1: homeserver / always-on  — always accessible, 1.5× rewards */
export const STORAGE_TIER_VAULT = "vault" as const;
/** Tier 2: consumer PC / best-effort — claimable downloads, 1.0× rewards */
export const STORAGE_TIER_SWARM = "swarm" as const;

export type StorageTier = typeof STORAGE_TIER_VAULT | typeof STORAGE_TIER_SWARM;

// ─────────────────────────────────────────────
//  Nodes (desktop client registrations)
// ─────────────────────────────────────────────

export type NodeStatus = "online" | "offline" | "maintenance";

export interface StorageNode {
  id: string;
  userId: string;
  displayName: string;
  tier: StorageTier;
  status: NodeStatus;
  /** Total bytes the node has pledged to the swarm */
  pledgedBytes: number;
  /** Bytes currently used by chunks on this node */
  usedBytes: number;
  /** Server-side address used for chunk relay (not exposed to other users) */
  relayEndpoint?: string;
  lastSeenAt: Date;
  registeredAt: Date;
  /** Running uptime percentage (0–100) for reward calculation */
  uptimePct: number;
}

// ─────────────────────────────────────────────
//  Files & Chunks
// ─────────────────────────────────────────────

export type FileStatus =
  | "pending" // upload in progress
  | "available" // all chunks stored, file accessible
  | "degraded" // some chunks missing, repair in progress
  | "claimed" // Tier-2 retrieval job queued
  | "retrieving" // retrieval job running
  | "deleted";

export interface SwarmFile {
  id: string;
  ownerId: string;
  name: string;
  path: string; // virtual path inside the user's vault
  mimeType: string;
  sizeBytes: number;
  status: FileStatus;
  tier: StorageTier;
  /** SHA-256 of the original plaintext file */
  contentHash: string;
  /** Total number of data shards */
  totalShards: number;
  /** Total number of parity shards */
  parityShards: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileChunk {
  id: string;
  fileId: string;
  /** 0-based shard index */
  shardIndex: number;
  /** true = data shard, false = parity shard */
  isData: boolean;
  /** Size of this encrypted chunk in bytes */
  sizeBytes: number;
  /** SHA-256 of the encrypted chunk data */
  chunkHash: string;
}

export interface ChunkLocation {
  chunkId: string;
  nodeId: string;
  storedAt: Date;
  verified: boolean;
}

// ─────────────────────────────────────────────
//  Retrieval Jobs (Tier-2 claim flow)
// ─────────────────────────────────────────────

export type RetrievalJobStatus =
  | "queued"
  | "waiting_nodes" // not enough contributor nodes online yet
  | "assembling"
  | "done"
  | "failed";

export interface RetrievalJob {
  id: string;
  fileId: string;
  requestedBy: string; // userId
  status: RetrievalJobStatus;
  /** If true, the desktop client should initiate system shutdown after download */
  shutdownAfterDownload: boolean;
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

// ─────────────────────────────────────────────
//  Rewards
// ─────────────────────────────────────────────

export interface RewardBalance {
  userId: string;
  /** SwarmCredits balance (1 credit ≈ 1 GB of extra quota) */
  credits: number;
  /** Lifetime earned credits */
  lifetimeEarned: number;
  updatedAt: Date;
}

export interface ContributionSnapshot {
  nodeId: string;
  userId: string;
  tier: StorageTier;
  pledgedBytes: number;
  uptimePct: number;
  /** Credits earned in this snapshot period */
  creditsEarned: number;
  snapshotAt: Date;
}

// ─────────────────────────────────────────────
//  WebSocket / IPC message types
// ─────────────────────────────────────────────

export type WsMessageType = "heartbeat" | "heartbeat_ack" | "chunk_store_request" | "chunk_store_ack" | "chunk_retrieve_request" | "chunk_retrieve_response" | "retrieval_job_update" | "node_status_update";

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
  ts: number; // Unix ms
}

export interface HeartbeatPayload {
  nodeId: string;
  status: NodeStatus;
  usedBytes: number;
  pledgedBytes: number;
}

export interface ChunkStoreRequest {
  chunkId: string;
  fileId: string;
  shardIndex: number;
  /** Base64-encoded encrypted chunk data */
  data: string;
}

export interface ChunkRetrieveRequest {
  chunkId: string;
  jobId: string;
}

export interface ChunkRetrieveResponse {
  chunkId: string;
  jobId: string;
  /** Base64-encoded encrypted chunk data */
  data: string;
}
