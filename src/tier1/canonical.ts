/**
 * Canonical encoding (FR-1.1).
 *
 * Content addressing is only sound if two values that are semantically the same
 * encode to exactly the same bytes, and two values that differ never collide.
 * JSON gives neither guarantee: key order is arbitrary and `"1"` vs `1` vs
 * `[1]` are not distinguished once concatenated. This encoder is therefore
 * tagged and length-prefixed — every value announces its type, every string its
 * byte length, every container its arity.
 */

export type Canonical =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly Canonical[]
  | { readonly [k: string]: Canonical | undefined };

const enc = new TextEncoder();

function write(out: number[], s: string): void {
  for (const b of enc.encode(s)) out.push(b);
}

function encodeInto(out: number[], v: Canonical): void {
  if (v === null || v === undefined) {
    out.push(0x6e); // 'n'
    return;
  }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 0x74 : 0x66); // 't' | 'f'
      return;
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`non-finite number is not canonical: ${v}`);
      if (!Number.isSafeInteger(v)) {
        // Doubles would make hashing depend on float formatting; Aether's
        // numeric tower is integral, so this is a bug rather than a limitation.
        throw new TypeError(`non-integral number is not canonical: ${v}`);
      }
      write(out, `i${v};`);
      return;
    case 'bigint':
      write(out, `I${v.toString()};`);
      return;
    case 'string': {
      const bytes = enc.encode(v);
      write(out, `s${bytes.length}:`);
      for (const b of bytes) out.push(b);
      return;
    }
    case 'object':
      break;
    default:
      throw new TypeError(`unsupported canonical type: ${typeof v}`);
  }
  if (Array.isArray(v)) {
    write(out, `a${v.length};`);
    for (const item of v) encodeInto(out, item as Canonical);
    return;
  }
  const obj = v as { readonly [k: string]: Canonical | undefined };
  // `undefined` fields are absent, not null: an optional field that was never
  // set must hash identically whether the producer omitted it or wrote undefined.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  write(out, `o${keys.length};`);
  for (const k of keys) {
    encodeInto(out, k);
    encodeInto(out, obj[k] as Canonical);
  }
}

/** Deterministic byte encoding of a canonical value. */
export function canonicalBytes(value: Canonical): Uint8Array {
  const out: number[] = [];
  encodeInto(out, value);
  return Uint8Array.from(out);
}

/** Debug rendering of the canonical form (the exact bytes, as text). */
export function canonicalText(value: Canonical): string {
  return new TextDecoder().decode(canonicalBytes(value));
}
