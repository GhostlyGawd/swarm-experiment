/**
 * Canonical encoding (FR-1.1).
 *
 * Content addressing is only sound if two values that are semantically the
 * same encode to exactly the same bytes, and two values that differ never
 * collide. JSON gives neither guarantee: key order is arbitrary, and `"1"`,
 * `1` and `[1]` are indistinguishable once concatenated. This encoder is
 * therefore tagged and length-prefixed — every value announces its type, every
 * string its byte length, every container its arity.
 *
 * It is also on the hot path of every write to the graph, so it writes into a
 * reusable growable buffer rather than building an array of numbers. The
 * encoder is not reentrant, which is fine: encoding is a synchronous,
 * non-nested operation.
 */

export type Canonical =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly Canonical[]
  | { readonly [k: string]: Canonical | undefined };

const encoder = new TextEncoder();

let buffer = new Uint8Array(4096);
let length = 0;
let active = false;

function ensure(extra: number): void {
  const needed = length + extra;
  if (needed <= buffer.length) return;
  let next = buffer.length * 2;
  while (next < needed) next *= 2;
  const grown = new Uint8Array(next);
  grown.set(buffer.subarray(0, length));
  buffer = grown;
}

/** Write a string known to contain only ASCII (tags, digits, separators). */
function putAscii(s: string): void {
  ensure(s.length);
  for (let i = 0; i < s.length; i++) buffer[length++] = s.charCodeAt(i);
}

function putByte(b: number): void {
  ensure(1);
  buffer[length++] = b;
}

function putString(s: string): void {
  // The common case in an AST is ASCII, where the byte length is known up
  // front and the copy is a tight loop. Anything else goes through TextEncoder.
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    putAscii(`s${s.length}:`);
    putAscii(s);
    return;
  }
  const bytes = encoder.encode(s);
  putAscii(`s${bytes.length}:`);
  ensure(bytes.length);
  buffer.set(bytes, length);
  length += bytes.length;
}

function encodeValue(v: Canonical): void {
  if (v === null || v === undefined) {
    putByte(0x6e); // 'n'
    return;
  }
  switch (typeof v) {
    case 'boolean':
      putByte(v ? 0x74 : 0x66); // 't' | 'f'
      return;
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`non-finite number is not canonical: ${v}`);
      if (!Number.isSafeInteger(v)) {
        // Doubles would make hashing depend on float formatting; Aether's
        // numeric tower is integral, so this is a bug rather than a limitation.
        throw new TypeError(`non-integral number is not canonical: ${v}`);
      }
      putAscii(`i${v};`);
      return;
    case 'bigint':
      putAscii(`I${v};`);
      return;
    case 'string':
      putString(v);
      return;
    case 'object':
      break;
    default:
      throw new TypeError(`unsupported canonical type: ${typeof v}`);
  }

  if (Array.isArray(v)) {
    putAscii(`a${v.length};`);
    for (const item of v) encodeValue(item as Canonical);
    return;
  }

  const obj = v as { readonly [k: string]: Canonical | undefined };
  // `undefined` fields are absent, not null: an optional field that was never
  // set must hash identically whether the producer omitted it or wrote undefined.
  const keys: string[] = [];
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) keys.push(k);
  }
  keys.sort();
  putAscii(`o${keys.length};`);
  for (const k of keys) {
    putString(k);
    encodeValue(obj[k] as Canonical);
  }
}

/**
 * Deterministic byte encoding of a canonical value.
 *
 * The returned array is a fresh copy, so callers may retain it.
 */
export function canonicalBytes(value: Canonical): Uint8Array {
  if (active) throw new Error('canonicalBytes is not reentrant');
  active = true;
  length = 0;
  try {
    encodeValue(value);
    return buffer.slice(0, length);
  } finally {
    active = false;
  }
}

/** Debug rendering of the canonical form (the exact bytes, as text). */
export function canonicalText(value: Canonical): string {
  return new TextDecoder().decode(canonicalBytes(value));
}
