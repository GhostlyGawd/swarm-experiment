/**
 * Deterministic pseudo-randomness.
 *
 * Every source of randomness in Aether is seeded and reproducible: the
 * bit-level determinism requirement (NFR 6.2) means an agent must be able to
 * replay a micro-world failure, a fuzzing campaign or a synthesis attempt and
 * get byte-identical results. `Math.random` appears nowhere below Tier 0.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Uniform bigint in [min, max]. */
  bigint(min: bigint, max: bigint): bigint;
  bool(pTrue?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** A fresh, independent stream derived from this one. */
  fork(label: string): Rng;
}

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLabel(label: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function rng(seed: number | string = 0): Rng {
  const numericSeed = typeof seed === 'string' ? hashLabel(seed, 0x811c9dc5) : seed >>> 0;
  const next = splitmix32(numericSeed);
  const self: Rng = {
    next,
    int(min, max) {
      if (max < min) throw new RangeError(`empty range [${min}, ${max}]`);
      return min + Math.floor(next() * (max - min + 1));
    },
    bigint(min, max) {
      if (max < min) throw new RangeError(`empty range [${min}, ${max}]`);
      const span = max - min + 1n;
      // Accumulate 32 bits at a time so large ranges stay uniform.
      let bits = 0n;
      let acc = 0n;
      while ((1n << bits) < span) {
        acc = (acc << 32n) | BigInt(Math.floor(next() * 4294967296));
        bits += 32n;
      }
      return min + (acc % span);
    },
    bool(pTrue = 0.5) {
      return next() < pTrue;
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('cannot pick from an empty list');
      return items[self.int(0, items.length - 1)];
    },
    fork(label) {
      return rng(hashLabel(label, numericSeed));
    },
  };
  return self;
}
