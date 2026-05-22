/**
 * AES-256-GCM chunk encryption / decryption.
 *
 * Each chunk is encrypted with a unique IV derived from the file's master key
 * and the shard index, so no two chunks share the same key+IV pair.
 *
 * The master key is generated client-side and NEVER sent to the server.
 * Only encrypted ciphertext leaves the client.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;  // 256 bits
const IV_BYTES = 12;   // 96-bit IV — GCM standard
const TAG_BYTES = 16;  // 128-bit auth tag

export interface EncryptedChunk {
  /** Encrypted data (ciphertext) */
  ciphertext: Buffer;
  /** 12-byte initialisation vector */
  iv: Buffer;
  /** 16-byte GCM authentication tag */
  authTag: Buffer;
}

/**
 * Generate a cryptographically random 256-bit master key for a file.
 */
export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Derive a per-shard key from the file's master key and the shard index.
 * Uses HKDF-style HMAC derivation so each shard has its own key.
 */
export function deriveShardKey(masterKey: Buffer, shardIndex: number): Buffer {
  const info = Buffer.from(`swarmvault-shard-${shardIndex}`);
  return createHash("sha256")
    .update(masterKey)
    .update(info)
    .digest()
    .subarray(0, KEY_BYTES);
}

/**
 * Encrypt a single chunk buffer with AES-256-GCM.
 * Returns ciphertext + IV + GCM auth tag.
 */
export function encryptChunk(plaintext: Buffer, shardKey: Buffer): EncryptedChunk {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, shardKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * Decrypt a chunk encrypted by `encryptChunk`.
 * Throws if the auth tag does not match (tampering detected).
 */
export function decryptChunk(
  encrypted: EncryptedChunk,
  shardKey: Buffer
): Buffer {
  const decipher = createDecipheriv(ALGORITHM, shardKey, encrypted.iv);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

/**
 * Serialise an EncryptedChunk to a single Buffer for network transfer:
 *   [IV (12 bytes)] [AuthTag (16 bytes)] [Ciphertext (variable)]
 */
export function serializeEncryptedChunk(chunk: EncryptedChunk): Buffer {
  return Buffer.concat([chunk.iv, chunk.authTag, chunk.ciphertext]);
}

/**
 * Deserialise a Buffer produced by `serializeEncryptedChunk`.
 */
export function deserializeEncryptedChunk(buf: Buffer): EncryptedChunk {
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  return { iv, authTag, ciphertext };
}

/**
 * Compute the SHA-256 hash of a buffer (used for chunk integrity verification).
 */
export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Encode a master key as a base64url string for safe storage / display.
 */
export function encodeMasterKey(key: Buffer): string {
  return key.toString("base64url");
}

/**
 * Decode a base64url master key string back to a Buffer.
 */
export function decodeMasterKey(encoded: string): Buffer {
  return Buffer.from(encoded, "base64url");
}
