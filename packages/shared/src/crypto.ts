/**
 * AES-256-GCM chunk encryption / decryption.
 *
 * Each chunk is encrypted with a unique IV derived from the file's master key
 * and the shard index, so no two chunks share the same key+IV pair.
 *
 * The master key is generated client-side and NEVER sent to the server.
 * Only encrypted ciphertext leaves the client.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash, pbkdf2 } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // 256 bits
const IV_BYTES = 12; // 96-bit IV — GCM standard
const TAG_BYTES = 16; // 128-bit auth tag

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
  return createHash("sha256").update(masterKey).update(info).digest().subarray(0, KEY_BYTES);
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
export function decryptChunk(encrypted: EncryptedChunk, shardKey: Buffer): Buffer {
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

// ─── Vault key: password-derived key used to wrap each file's master key ────

/**
 * Derive a 256-bit vault key from the user's password + their server-assigned
 * userId.  PBKDF2-SHA256 with 200 000 iterations.
 *
 * Deterministic: same password + userId → same vault key on any device.
 * The vault key NEVER leaves the client — only the AES-GCM-wrapped master key
 * is sent to / stored by the server.
 */
export async function deriveVaultKey(password: string, userId: string): Promise<Buffer> {
  // Salt = "swarmvault-vault-v1:" + userId prevents cross-user key reuse
  const salt = Buffer.from(`swarmvault-vault-v1:${userId}`, "utf8");
  return pbkdf2Async(password, salt, 200_000, KEY_BYTES, "sha256");
}

/**
 * Derive the authentication key that is sent to the server in place of the raw password.
 *
 * This ensures the server NEVER sees the master password and therefore cannot
 * derive the vault key.  The two keys are independent:
 *   authKey  = PBKDF2(password, "swarmvault-auth-v1:"  + email.toLowerCase(), 100 000, 32, sha256)
 *   vaultKey = PBKDF2(password, "swarmvault-vault-v1:" + userId,              200 000, 32, sha256)
 *
 * The server stores argon2(authKey) — even a compromised server cannot work
 * backwards from authKey to vaultKey because the salts and iteration counts differ.
 *
 * Returns a 64-character lowercase hex string suitable for JSON transport.
 */
export async function deriveAuthKey(password: string, email: string): Promise<string> {
  const salt = Buffer.from(`swarmvault-auth-v1:${email.toLowerCase()}`, "utf8");
  const key = await pbkdf2Async(password, salt, 100_000, KEY_BYTES, "sha256");
  return key.toString("hex");
}

/**
 * Wrap (encrypt) a file master key with the vault key.
 *
 * Wire format (all base64url-encoded as one string):
 *   [IV 12 bytes][GCM auth-tag 16 bytes][ciphertext 32 bytes]  →  60 raw bytes → 80 base64url chars
 *
 * This is what is stored in SwarmFile.encryptedMasterKey on the server.
 * The server never sees the plaintext master key.
 */
export function encryptMasterKey(masterKey: Buffer, vaultKey: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, vaultKey, iv);
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64url");
}

/**
 * Unwrap (decrypt) a master key that was encrypted with `encryptMasterKey`.
 */
export function decryptMasterKey(encoded: string, vaultKey: Buffer): Buffer {
  const buf = Buffer.from(encoded, "base64url");

  // [IV 12][authTag 16][ciphertext 32]
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, vaultKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
