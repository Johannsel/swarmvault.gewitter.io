/**
 * Pure-TypeScript Reed-Solomon erasure coding (Vandermonde matrix / GF(2^8)).
 *
 * Splits a file into `dataShards` data shards and `parityShards` parity shards.
 * Any `dataShards` out of `dataShards + parityShards` shards can reconstruct
 * the original file.
 *
 * Implementation reference: Backblaze Reed-Solomon blog post algorithm.
 */

// ─────────────────────────────────────────────
//  Galois Field GF(2^8) — polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
// ─────────────────────────────────────────────

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

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a]! + GF_LOG[b]!) % 255];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("GF division by zero");
  if (a === 0) return 0;
  return GF_EXP[((GF_LOG[a]! - GF_LOG[b]!) + 255) % 255]!;
}

// ─────────────────────────────────────────────
//  Matrix operations (over GF(2^8))
// ─────────────────────────────────────────────

type Matrix = number[][];

function makeVandermonde(rows: number, cols: number): Matrix {
  const m: Matrix = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(r === 0 ? 1 : gfMul(GF_EXP[r - 1]!, c === 0 ? 1 : GF_EXP[(r - 1) * c % 255]!));
    }
    m.push(row);
  }
  return m;
}

function identityMatrix(n: number): Matrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
}

function matrixMultiply(a: Matrix, b: Matrix): Matrix {
  const rows = a.length;
  const cols = b[0]!.length;
  const inner = b.length;
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) =>
      a[r]!.reduce((acc, _, k) => acc ^ gfMul(a[r]![k]!, b[k]![c]!), 0)
    )
  );
}

function subMatrix(m: Matrix, rows: number[]): Matrix {
  return rows.map((r) => [...m[r]!]);
}

function invertMatrix(m: Matrix): Matrix {
  const n = m.length;
  const work = m.map((row) => [...row]);
  const inv = identityMatrix(n);

  for (let col = 0; col < n; col++) {
    // Pivot
    let pivotRow = -1;
    for (let r = col; r < n; r++) {
      if (work[r]![col] !== 0) { pivotRow = r; break; }
    }
    if (pivotRow === -1) throw new Error("Matrix is not invertible");
    [work[col], work[pivotRow]] = [work[pivotRow]!, work[col]!];
    [inv[col], inv[pivotRow]] = [inv[pivotRow]!, inv[col]!];

    const scale = work[col]![col]!;
    for (let c = 0; c < n; c++) {
      work[col]![c] = gfDiv(work[col]![c]!, scale);
      inv[col]![c] = gfDiv(inv[col]![c]!, scale);
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = work[r]![col]!;
      for (let c = 0; c < n; c++) {
        work[r]![c] ^= gfMul(factor, work[col]![c]!);
        inv[r]![c] ^= gfMul(factor, inv[col]![c]!);
      }
    }
  }
  return inv;
}

// ─────────────────────────────────────────────
//  Encoding
// ─────────────────────────────────────────────

/**
 * Encode a Buffer into `dataShards + parityShards` shards.
 * The first `dataShards` shards contain the original data (possibly zero-padded).
 * The remaining `parityShards` shards are parity (Reed-Solomon).
 */
export function encodeFile(
  data: Buffer,
  dataShards: number,
  parityShards: number
): Buffer[] {
  const totalShards = dataShards + parityShards;
  // Pad data so it divides evenly into dataShards
  const shardSize = Math.ceil(data.length / dataShards);
  const padded = Buffer.alloc(shardSize * dataShards);
  data.copy(padded);

  // Split into data shards
  const shards: Buffer[] = [];
  for (let i = 0; i < dataShards; i++) {
    shards.push(padded.subarray(i * shardSize, (i + 1) * shardSize));
  }

  // Build encoding matrix: top is identity (preserves data shards),
  // bottom is Vandermonde-derived parity rows
  const vm = makeVandermonde(totalShards, dataShards);
  const encMatrix = vm; // first dataShards rows are identity-ish

  // Compute parity shards
  for (let p = 0; p < parityShards; p++) {
    const pShard = Buffer.alloc(shardSize);
    const row = encMatrix[dataShards + p]!;
    for (let byteIdx = 0; byteIdx < shardSize; byteIdx++) {
      let val = 0;
      for (let d = 0; d < dataShards; d++) {
        val ^= gfMul(row[d]!, shards[d]![byteIdx]!);
      }
      pShard[byteIdx] = val;
    }
    shards.push(pShard);
  }

  return shards;
}

/**
 * Reconstruct the original file from any `dataShards` of the total shards.
 *
 * @param shards   Array of length `dataShards + parityShards`. Missing shards
 *                 must be `null`.
 * @param originalSize  The exact size of the original file (to strip padding).
 */
export function decodeFile(
  shards: (Buffer | null)[],
  dataShards: number,
  parityShards: number,
  originalSize: number
): Buffer {
  const totalShards = dataShards + parityShards;
  if (shards.length !== totalShards) {
    throw new Error(`Expected ${totalShards} shard slots, got ${shards.length}`);
  }

  const presentIndices = shards
    .map((s, i) => (s !== null ? i : -1))
    .filter((i) => i >= 0);

  if (presentIndices.length < dataShards) {
    throw new Error(
      `Need at least ${dataShards} shards, only ${presentIndices.length} available`
    );
  }

  // If all data shards are present, skip reconstruction
  const allDataPresent = shards.slice(0, dataShards).every((s) => s !== null);
  if (allDataPresent) {
    const complete = Buffer.concat(shards.slice(0, dataShards) as Buffer[]);
    return complete.subarray(0, originalSize);
  }

  // Take exactly dataShards present shards
  const usedIndices = presentIndices.slice(0, dataShards);
  const vm = makeVandermonde(totalShards, dataShards);
  const subM = subMatrix(vm, usedIndices);
  const decodeMatrix = invertMatrix(subM);

  const shardSize = (shards.find((s) => s !== null) as Buffer).length;
  const recovered: Buffer[] = [];

  for (let d = 0; d < dataShards; d++) {
    const row = decodeMatrix[d]!;
    const result = Buffer.alloc(shardSize);
    for (let byteIdx = 0; byteIdx < shardSize; byteIdx++) {
      let val = 0;
      for (let k = 0; k < dataShards; k++) {
        val ^= gfMul(row[k]!, (shards[usedIndices[k]!]!)[byteIdx]!);
      }
      result[byteIdx] = val;
    }
    recovered.push(result);
  }

  const complete = Buffer.concat(recovered);
  return complete.subarray(0, originalSize);
}
