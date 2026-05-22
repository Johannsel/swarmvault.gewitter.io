/**
 * End-to-end chunk relay smoke test.
 * Run from packages/server:  node test-relay.mjs
 */
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
// pnpm hoists ws into the virtual store; resolve it by absolute path
const WebSocket = _require(
  "/Users/johannsel/Informatik/swarmvault.gewitter.io/node_modules/.pnpm/ws@8.20.1/node_modules/ws"
);
import crypto from "node:crypto";

const SERVER = "http://localhost:3000";

// ── 1. Auth ───────────────────────────────────────────────────────────────────
await fetch(`${SERVER}/api/v1/auth/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "relay4@swarmvault.io", username: "relaytest4", password: "Testing1234!" }),
}).catch(() => {});

const TOKEN = await fetch(`${SERVER}/api/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "relay4@swarmvault.io", password: "Testing1234!" }),
}).then(r => r.json()).then(d => d.token);
console.log("Logged in");

// ── 2. Register node + authenticate WebSocket ─────────────────────────────────
const nodeData = await fetch(`${SERVER}/api/v1/nodes`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ displayName: "Relay Test Node", tier: "swarm", pledgedBytes: 5_368_709_120 }),
}).then(r => r.json());
const NODE_ID = nodeData.node.id;
const RELAY_TOKEN = nodeData.node.relayToken;

const ws = new WebSocket("ws://localhost:3000/ws");
const storedChunks = new Map();

// Wait for auth_ack
await new Promise((resolve, reject) => {
  ws.on("open", () =>
    ws.send(JSON.stringify({ type: "auth", payload: { nodeId: NODE_ID, relayToken: RELAY_TOKEN } }))
  );
  ws.on("message", raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "auth_ack") { console.log("WS auth_ack received ✓"); resolve(); }
    if (msg.type === "error")   reject(new Error(msg.payload.message));
  });
  ws.on("error", reject);
  setTimeout(() => reject(new Error("WS auth timeout")), 5000);
});

// Handle chunk_relay from server
ws.on("message", raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "chunk_relay") {
    const { fileId, shardIndex, chunkHash, data } = msg.payload;
    const buf = Buffer.from(data, "base64");
    storedChunks.set(`${fileId}:${shardIndex}`, buf);
    console.log(`  Node received shard ${shardIndex} (${buf.length} bytes) ✓`);
    ws.send(JSON.stringify({ type: "chunk_ack", payload: { fileId, shardIndex, success: true, chunkHash } }));
  }
});

// ── 3. Mark our node online; spin up 5 ghost nodes to hit the 6-node minimum ──
await fetch(`${SERVER}/api/v1/nodes/heartbeat`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${RELAY_TOKEN}` },
  body: JSON.stringify({ nodeId: NODE_ID, status: "online", usedBytes: 0, pledgedBytes: 5_368_709_120 }),
});
for (let i = 0; i < 5; i++) {
  const g = await fetch(`${SERVER}/api/v1/nodes`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ displayName: `Ghost${i}`, tier: "swarm", pledgedBytes: 5_368_709_120 }),
  }).then(r => r.json());
  await fetch(`${SERVER}/api/v1/nodes/heartbeat`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${g.node.relayToken}` },
    body: JSON.stringify({ nodeId: g.node.id, status: "online", usedBytes: 0, pledgedBytes: 5_368_709_120 }),
  });
}
console.log("6 nodes online");

// ── 4. Register a file ────────────────────────────────────────────────────────
const HASH = "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3";
const { file, shardAssignment } = await fetch(`${SERVER}/api/v1/files`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    name: "relay.bin", path: "/relay.bin", sizeBytes: 256,
    tier: "swarm", contentHash: HASH, totalShards: 4, parityShards: 2, encryptedMasterKey: "dGVzdA",
  }),
}).then(r => r.json());
console.log("File registered:", file.id, "  assignment:", shardAssignment.length, "shards");

// ── 5. Upload shard 0 to our WS-connected node ────────────────────────────────
const chunkData = crypto.randomBytes(256);
const chunkHash = crypto.createHash("sha256").update(chunkData).digest("hex");

const chunkRes = await fetch(`${SERVER}/api/v1/chunks`, {
  method: "POST",
  headers: {
    "Content-Type": "application/octet-stream",
    Authorization: `Bearer ${TOKEN}`,
    "X-File-Id": file.id, "X-Shard-Index": "0",
    "X-Chunk-Hash": chunkHash, "X-Is-Data": "true", "X-Node-Id": NODE_ID,
  },
  body: chunkData,
});
const result = await chunkRes.json();
console.log(`POST /chunks → HTTP ${chunkRes.status}  ${JSON.stringify(result)}`);
console.log(`In-memory node store: ${storedChunks.size} shard(s), first shard: ${[...storedChunks.values()][0]?.length} bytes`);

ws.close();
console.log(chunkRes.ok ? "PASS ✓" : "FAIL ✗");
process.exit(chunkRes.ok ? 0 : 1);
