/**
 * BLAKE3 — pure TypeScript implementation (hash + XOF).
 *
 * FR-1.1 mandates that every AST node be indexed by the BLAKE3 hash of its
 * normalized semantic structure. Aether therefore cannot depend on an optional
 * native addon for its most load-bearing primitive: the node identity function
 * must be available, deterministic and identical in every process that touches
 * the graph. This is a direct transcription of the reference implementation
 * (BLAKE3 spec §2), validated against the official test vectors in
 * `test/tier1/blake3.test.ts`.
 */

const OUT_LEN = 32;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

const CHUNK_START = 1 << 0;
const CHUNK_END = 1 << 1;
const PARENT = 1 << 2;
const ROOT = 1 << 3;
const KEYED_HASH = 1 << 4;
const DERIVE_KEY_CONTEXT = 1 << 5;
const DERIVE_KEY_MATERIAL = 1 << 6;

const IV = Uint32Array.of(
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
);

const MSG_PERMUTATION = Uint8Array.of(2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function g(s: Uint32Array, a: number, b: number, c: number, d: number, mx: number, my: number): void {
  s[a] = (s[a] + s[b] + mx) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b] + my) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 7);
}

function round(s: Uint32Array, m: Uint32Array): void {
  g(s, 0, 4, 8, 12, m[0], m[1]);
  g(s, 1, 5, 9, 13, m[2], m[3]);
  g(s, 2, 6, 10, 14, m[4], m[5]);
  g(s, 3, 7, 11, 15, m[6], m[7]);
  g(s, 0, 5, 10, 15, m[8], m[9]);
  g(s, 1, 6, 11, 12, m[10], m[11]);
  g(s, 2, 7, 8, 13, m[12], m[13]);
  g(s, 3, 4, 9, 14, m[14], m[15]);
}

const PERM_SCRATCH = new Uint32Array(16);

function permute(m: Uint32Array): void {
  for (let i = 0; i < 16; i++) PERM_SCRATCH[i] = m[MSG_PERMUTATION[i]];
  m.set(PERM_SCRATCH);
}

// Compression runs on every node written to the graph, so it uses fixed
// scratch rather than allocating a state and a message buffer per call. It is
// strictly sequential and never nested, which is what makes that safe.
const STATE = new Uint32Array(16);
const MESSAGE = new Uint32Array(16);

/**
 * The BLAKE3 compression function. Writes all 16 output words into `out`,
 * which must not alias `cv`. Words 0..7 are the chaining value.
 */
function compressInto(
  cv: Uint32Array,
  blockWords: Uint32Array,
  counter: bigint,
  blockLen: number,
  flags: number,
  out: Uint32Array,
): void {
  STATE[0] = cv[0]; STATE[1] = cv[1]; STATE[2] = cv[2]; STATE[3] = cv[3];
  STATE[4] = cv[4]; STATE[5] = cv[5]; STATE[6] = cv[6]; STATE[7] = cv[7];
  STATE[8] = IV[0]; STATE[9] = IV[1]; STATE[10] = IV[2]; STATE[11] = IV[3];
  STATE[12] = Number(counter & 0xffffffffn) >>> 0;
  STATE[13] = Number((counter >> 32n) & 0xffffffffn) >>> 0;
  STATE[14] = blockLen >>> 0;
  STATE[15] = flags >>> 0;

  MESSAGE.set(blockWords);
  for (let r = 0; r < 7; r++) {
    round(STATE, MESSAGE);
    if (r < 6) permute(MESSAGE);
  }
  for (let i = 0; i < 8; i++) {
    out[i] = (STATE[i] ^ STATE[i + 8]) >>> 0;
    out[i + 8] = (STATE[i + 8] ^ cv[i]) >>> 0;
  }
}

function wordsFromLEBytes(bytes: Uint8Array, out: Uint32Array): void {
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] =
      ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0);
  }
}

/** A finalizable node of the BLAKE3 tree (a chunk tail or a parent node). */
interface Output {
  cv: Uint32Array;
  blockWords: Uint32Array;
  counter: bigint;
  blockLen: number;
  flags: number;
}

const CV_SCRATCH = new Uint32Array(16);

/** Finalize a tree node into `out` (8 words). */
function chainingValueInto(o: Output, out: Uint32Array): void {
  compressInto(o.cv, o.blockWords, o.counter, o.blockLen, o.flags, CV_SCRATCH);
  out.set(CV_SCRATCH.subarray(0, 8));
}

function chainingValue(o: Output): Uint32Array {
  const out = new Uint32Array(8);
  chainingValueInto(o, out);
  return out;
}

/** Extendable output: the root node is squeezed for as many bytes as asked. */
function rootOutputBytes(o: Output, out: Uint8Array): void {
  const words = new Uint32Array(16);
  let counter = 0n;
  for (let offset = 0; offset < out.length; offset += 2 * OUT_LEN) {
    compressInto(o.cv, o.blockWords, counter, o.blockLen, o.flags | ROOT, words);
    for (let i = 0; i < words.length; i++) {
      const base = offset + i * 4;
      if (base >= out.length) break;
      const w = words[i];
      out[base] = w & 0xff;
      if (base + 1 < out.length) out[base + 1] = (w >>> 8) & 0xff;
      if (base + 2 < out.length) out[base + 2] = (w >>> 16) & 0xff;
      if (base + 3 < out.length) out[base + 3] = (w >>> 24) & 0xff;
    }
    counter++;
  }
}

class ChunkState {
  readonly cv = new Uint32Array(8);
  chunkCounter: bigint;
  block = new Uint8Array(BLOCK_LEN);
  blockLen = 0;
  blocksCompressed = 0;
  readonly flags: number;
  private readonly words = new Uint32Array(16);
  private readonly out = new Uint32Array(16);

  constructor(key: Uint32Array, chunkCounter: bigint, flags: number) {
    this.cv.set(key.subarray(0, 8));
    this.chunkCounter = chunkCounter;
    this.flags = flags;
  }

  len(): number {
    return BLOCK_LEN * this.blocksCompressed + this.blockLen;
  }

  private startFlag(): number {
    return this.blocksCompressed === 0 ? CHUNK_START : 0;
  }

  update(input: Uint8Array): void {
    let pos = 0;
    while (pos < input.length) {
      if (this.blockLen === BLOCK_LEN) {
        wordsFromLEBytes(this.block, this.words);
        compressInto(
          this.cv, this.words, this.chunkCounter, BLOCK_LEN,
          this.flags | this.startFlag(), this.out,
        );
        this.cv.set(this.out.subarray(0, 8));
        this.blocksCompressed++;
        this.block.fill(0);
        this.blockLen = 0;
      }
      const want = BLOCK_LEN - this.blockLen;
      const take = Math.min(want, input.length - pos);
      this.block.set(input.subarray(pos, pos + take), this.blockLen);
      this.blockLen += take;
      pos += take;
    }
  }

  output(): Output {
    const blockWords = new Uint32Array(16);
    wordsFromLEBytes(this.block, blockWords);
    return {
      cv: Uint32Array.from(this.cv),
      blockWords,
      counter: this.chunkCounter,
      blockLen: this.blockLen,
      flags: this.flags | this.startFlag() | CHUNK_END,
    };
  }
}

function parentOutput(
  left: Uint32Array,
  right: Uint32Array,
  key: Uint32Array,
  flags: number,
): Output {
  const blockWords = new Uint32Array(16);
  blockWords.set(left.subarray(0, 8), 0);
  blockWords.set(right.subarray(0, 8), 8);
  return { cv: Uint32Array.from(key), blockWords, counter: 0n, blockLen: BLOCK_LEN, flags: flags | PARENT };
}

/** Incremental BLAKE3 hasher. Not safe for concurrent use across `await` points. */
export class Blake3 {
  private chunk: ChunkState;
  private readonly key: Uint32Array;
  private readonly stack: Uint32Array[] = [];
  private readonly flags: number;

  private constructor(key: Uint32Array, flags: number) {
    this.key = Uint32Array.from(key);
    this.flags = flags;
    this.chunk = new ChunkState(this.key, 0n, flags);
  }

  static create(): Blake3 {
    return new Blake3(IV, 0);
  }

  /** Keyed hashing (MAC / domain-separated node identity). `key` must be 32 bytes. */
  static keyed(key: Uint8Array): Blake3 {
    if (key.length !== 32) throw new RangeError(`BLAKE3 key must be 32 bytes, got ${key.length}`);
    const words = new Uint32Array(8);
    wordsFromLEBytes(key, words);
    return new Blake3(words, KEYED_HASH);
  }

  /** Key derivation: `context` should be a hardcoded, globally unique string. */
  static deriveKey(context: string): Blake3 {
    const ctxHasher = new Blake3(IV, DERIVE_KEY_CONTEXT);
    ctxHasher.update(new TextEncoder().encode(context));
    const ctxKey = ctxHasher.digest(32);
    const words = new Uint32Array(8);
    wordsFromLEBytes(ctxKey, words);
    return new Blake3(words, DERIVE_KEY_MATERIAL);
  }

  private addChunkChainingValue(cv: Uint32Array, totalChunks: bigint): void {
    let newCv = cv;
    let n = totalChunks;
    while ((n & 1n) === 0n) {
      const left = this.stack.pop();
      if (!left) break;
      newCv = Uint32Array.from(chainingValue(parentOutput(left, newCv, this.key, this.flags)));
      n >>= 1n;
    }
    this.stack.push(newCv);
  }

  update(input: Uint8Array): this {
    let pos = 0;
    while (pos < input.length) {
      if (this.chunk.len() === CHUNK_LEN) {
        const cv = Uint32Array.from(chainingValue(this.chunk.output()));
        const totalChunks = this.chunk.chunkCounter + 1n;
        this.addChunkChainingValue(cv, totalChunks);
        this.chunk = new ChunkState(this.key, totalChunks, this.flags);
      }
      const want = CHUNK_LEN - this.chunk.len();
      const take = Math.min(want, input.length - pos);
      this.chunk.update(input.subarray(pos, pos + take));
      pos += take;
    }
    return this;
  }

  /** Squeeze `length` bytes of output. The hasher may be read more than once. */
  digest(length = OUT_LEN): Uint8Array {
    let output = this.chunk.output();
    for (let i = this.stack.length - 1; i >= 0; i--) {
      output = parentOutput(this.stack[i], Uint32Array.from(chainingValue(output)), this.key, this.flags);
    }
    const out = new Uint8Array(length);
    rootOutputBytes(output, out);
    return out;
  }

  hex(length = OUT_LEN): string {
    return bytesToHex(this.digest(length));
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** One-shot BLAKE3 over bytes or UTF-8 text. */
export function blake3(input: Uint8Array | string, length = OUT_LEN): Uint8Array {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return Blake3.create().update(bytes).digest(length);
}

export function blake3Hex(input: Uint8Array | string, length = OUT_LEN): string {
  return bytesToHex(blake3(input, length));
}

export { OUT_LEN, BLOCK_LEN, CHUNK_LEN };
