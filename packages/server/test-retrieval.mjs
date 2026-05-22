/**
 * End-to-end Phase 2 smoke test: upload shards, then download + verify.
 * Run from packages/server:  node test-retrieval.mjs
 */
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const WS = _require("/Users/johannsel/Informatik/swarmvault.gewitter.io/node_modules/.pnpm/ws@8.20.1/node_modules/ws");
import crypto from "node:crypto";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const SERVER = "http://localhost:3000";
const DATA_SHARDS = 4;
const PARITY_SHARDS = 2;
const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS;

// ── Minimal GF(2^8) Reed-Solomon (mirrors shared/src/erasure.ts) ──────────────
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255]);
const gfDiv = (a, b) => {
  if (!b) throw new Error("GF div0");
  if (!a) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
};
function makeVandermonde(rows, cols) {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (r === 0 ? 1 : gfMul(GF_EXP[r - 1], c === 0 ? 1 : GF_EXP[((r - 1) * c) % 255]))));
}
function matMul(a, b) {
  return Array.from({ length: a.length }, (_, r) => Array.from({ length: b[0].length }, (_, c) => a[r].reduce((s, _, k) => s ^ gfMul(a[r][k], b[k][c]), 0)));
}
function invertMatrix(m) {
  const n = m.length;
  const work = m.map((r) => [...r]);
  const inv = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = col; r < n; r++)
      if (work[r][col]) {
        pivot = r;
        break;
      }
    if (pivot < 0) throw new Error("Singular");
    [work[col], work[pivot]] = [work[pivot], work[col]];
    [inv[col], inv[pivot]] = [inv[pivot], inv[col]];
    const scale = work[col][col];
    for (let c = 0; c < n; c++) {
      work[col][c] = gfDiv(work[col][c], scale);
      inv[col][c] = gfDiv(inv[col][c], scale);
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = work[r][col];
      for (let c = 0; c < n; c++) {
        work[r][c] ^= gfMul(f, work[col][c]);
        inv[r][c] ^= gfMul(f, inv[col][c]);
      }
    }
  }
  return inv;
}
function encodeFile(data, dataShards, parityShards) {
  const shardSize = Math.ceil(data.length / dataShards);
  const padded = Buffer.alloc(shardSize * dataShards);
  data.copy(padded);
  const shards = Array.from({ length: dataShards }, (_, i) => Buffer.from(padded.subarray(i * shardSize, (i + 1) * shardSize)));
  const vm = makeVandermonde(dataShards + parityShards, dataShards);
  for (let p = 0; p < parityShards; p++) {
    const pShard = Buffer.alloc(shardSize);
    const row = vm[dataShards + p];
    for (let b = 0; b < shardSize; b++) {
      let v = 0;
      for (let d = 0; d < dataShards; d++) v ^= gfMul(row[d], shards[d][b]);
      pShard[b] = v;
    }
    shards.push(pShard);
  }
  return shards;
}
function decodeFile(shards, dataShards, parityShards, originalSize) {
  const present = shards.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  if (present.length < dataShards) throw new Error("Not enough shards");
  if (shards.slice(0, dataShards).every(Boolean)) {
    return Buffer.concat(shards.slice(0, dataShards)).subarray(0, originalSize);
  }
  const used = present.slice(0, dataShards);
  const vm = makeVandermonde(dataShards + parityShards, dataShards);
  const subM = used.map((r) => vm[r]);
  const decodeMatrix = invertMatrix(subM);
  const shardSize = shards.find(Boolean).length;
  const recovered = Array.from({ length: dataShards }, (_, d) => {
    const row = decodeMatrix[d];
    const res = Buffer.alloc(shardSize);
    for (let b = 0; b < shardSize; b++) {
      let v = 0;
      for (let k = 0; k < dataShards; k++) v ^= gfMul(row[k], shards[used[k]][b]);
      res[b] = v;
    }
    return res;
  });
  return Buffer.concat(recovered).subarray(0, originalSize);
}

// ── AES-256-GCM (mirrors shared/src/crypto.ts) ───────────────────────────────
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function deriveShardKey(masterKey, index) {
  return createHash("sha256").update(masterKey).update(`swarmvault-shard-${index}`).digest().subarray(0, 32);
}
function encryptChunk(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}
function serializeEncryptedChunk({ ciphertext, iv, authTag }) {
  return Buffer.concat([iv, authTag, ciphertext]);
}
function deserializeEncryptedChunk(buf) {
  return { iv: buf.subarray(0, 12), authTag: buf.subarray(12, 28), ciphertext: buf.subarray(28) };
}
function decryptChunk({ ciphertext, iv, authTag }, key) {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(authTag);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Test body
// ═════════════════════════════════════════════════════════════════════════════

// 1. Auth
await fetch(`${SERVER}/api/v1/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "retrieve5@swarmvault.io", username: "retrievetest5", password: "Testing1234!" }),
}).catch(() => {});
const TOKEN = await fetch(`${SERVER}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "retrieve5@swarmvault.io", password: "Testing1234!" }),
})
  .then((r) => r.json())
  .then((d) => d.token);
console.log("Logged in");

// 2. Register node + WS auth
const nodeData = await fetch(`${SERVER}/api/v1/nodes`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ displayName: "Retrieval Node", tier: "swarm", pledgedBytes: 5_368_709_120 }),
}).then((r) => r.json());
const NODE_ID = nodeData.node.id,
  RELAY_TOKEN = nodeData.node.relayToken;

const ws = new WS("ws://localhost:3000/ws");
const storedChunks = new Map(); // chunkId -> Buffer (encrypted)

await new Promise((resolve, reject) => {
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", payload: { nodeId: NODE_ID, relayToken: RELAY_TOKEN } })));
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "auth_ack") {
      console.log("WS auth_ack ✓");
      resolve();
    }
    if (msg.type === "error") reject(new Error(msg.payload.message));
  });
  ws.on("error", reject);
  setTimeout(() => reject(new Error("WS timeout")), 5000);
});

// Handle both chunk_relay (upload) and chunk_request (download)
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "chunk_relay") {
    const { fileId, shardIndex, chunkHash, data } = msg.payload;
    const key = `${fileId}-${shardIndex}`;
    const buf = Buffer.from(data, "base64");
    storedChunks.set(key, buf);
    console.log(`  [node] Stored shard ${shardIndex} (${buf.length} bytes)`);
    ws.send(JSON.stringify({ type: "chunk_ack", payload: { fileId, shardIndex, success: true, chunkHash } }));
  }

  if (msg.type === "chunk_request") {
    const { fileId, shardIndex } = msg.payload;
    const key = `${fileId}-${shardIndex}`;
    const buf = storedChunks.get(key);
    if (buf) {
      console.log(`  [node] Serving shard ${shardIndex} for retrieval`);
      ws.send(
        JSON.stringify({
          type: "chunk_response",
          payload: { fileId, shardIndex, data: buf.toString("base64"), chunkHash: sha256(buf) },
        }),
      );
    } else {
      console.warn(`  [node] Shard ${shardIndex} not found in local store`);
    }
  }
});

// 3. Online + 5 ghost nodes
await fetch(`${SERVER}/api/v1/nodes/heartbeat`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${RELAY_TOKEN}` },
  body: JSON.stringify({ nodeId: NODE_ID, status: "online", usedBytes: 0, pledgedBytes: 5_368_709_120 }),
});
for (let i = 0; i < 5; i++) {
  const g = await fetch(`${SERVER}/api/v1/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ displayName: `RGhost${i}`, tier: "swarm", pledgedBytes: 5_368_709_120 }),
  }).then((r) => r.json());
  await fetch(`${SERVER}/api/v1/nodes/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${g.node.relayToken}` },
    body: JSON.stringify({ nodeId: g.node.id, status: "online", usedBytes: 0, pledgedBytes: 5_368_709_120 }),
  });
}
console.log("6 nodes online");

// 4. Prepare original file + encode + encrypt shards
const originalData = crypto.randomBytes(800); // ~800 bytes of random plaintext
const masterKey = randomBytes(32);
const shards = encodeFile(originalData, DATA_SHARDS, PARITY_SHARDS);

// 5. Register file
const { file, shardAssignment } = await fetch(`${SERVER}/api/v1/files`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    name: "test-retrieval.bin",
    path: "/test-retrieval.bin",
    sizeBytes: originalData.length,
    tier: "swarm",
    contentHash: sha256(originalData),
    totalShards: DATA_SHARDS,
    parityShards: PARITY_SHARDS,
    encryptedMasterKey: masterKey.toString("base64url"),
  }),
}).then((r) => r.json());
console.log("File registered:", file.id);

// 6. Upload all shards (force all to our single WS-connected node)
for (let i = 0; i < TOTAL_SHARDS; i++) {
  const key = deriveShardKey(masterKey, i);
  const encrypted = encryptChunk(shards[i], key);
  const serialized = serializeEncryptedChunk(encrypted);
  const chunkHash = sha256(serialized);

  const res = await fetch(`${SERVER}/api/v1/chunks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${TOKEN}`,
      "X-File-Id": file.id,
      "X-Shard-Index": String(i),
      "X-Chunk-Hash": chunkHash,
      "X-Is-Data": String(i < DATA_SHARDS),
      "X-Node-Id": NODE_ID,
    },
    body: serialized,
  });
  if (!res.ok) throw new Error(`Shard ${i} upload failed: ${await res.text()}`);
  process.stdout.write(`  Uploaded shard ${i}/${TOTAL_SHARDS - 1}\r`);
}
console.log("\nAll shards uploaded ✓");

// 7. Download via GET /files/:id/download
const dlRes = await fetch(`${SERVER}/api/v1/files/${file.id}/download`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
if (!dlRes.ok) {
  const err = await dlRes.json().catch(() => ({}));
  throw new Error(`Download failed (${dlRes.status}): ${JSON.stringify(err)}`);
}
const dlBody = await dlRes.json();
console.log(`Download response: ${dlBody.shards.length} shards, file "${dlBody.name}"`);

// 8. Client-side: decrypt + reconstruct
const recoveredMasterKey = Buffer.from(dlBody.encryptedMasterKey, "base64url");
const totalShards = dlBody.totalShards + dlBody.parityShards;
const shardSlots = new Array(totalShards).fill(null);
for (const s of dlBody.shards) {
  const raw = Buffer.from(s.data, "base64");
  const enc = deserializeEncryptedChunk(raw);
  const shardKey = deriveShardKey(recoveredMasterKey, s.index);
  shardSlots[s.index] = decryptChunk(enc, shardKey);
}
const reconstructed = decodeFile(shardSlots, dlBody.totalShards, dlBody.parityShards, dlBody.sizeBytes);

// 9. Verify byte-for-byte match
const match = reconstructed.equals(originalData);
console.log(`Reconstruction: ${reconstructed.length} bytes, match = ${match}`);
console.log(`Hash orig=${sha256(originalData).slice(0, 16)}… recon=${sha256(reconstructed).slice(0, 16)}…`);

ws.close();
console.log(match ? "\nPASS ✓" : "\nFAIL ✗ — data mismatch");
process.exit(match ? 0 : 1);
