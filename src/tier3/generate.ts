/**
 * Adversarial input generation (FR-3.2).
 *
 * A generated case is *plain data*, not live heap values. That matters more
 * than it sounds: a case has to be runnable in a fresh runtime — to replay it,
 * to shrink it, to race it against itself — and heap references do not travel
 * between runtimes. Keeping cases as data makes every one of those operations
 * a materialisation rather than a graft.
 *
 * Generation is boundary-biased rather than uniform. Uniformly sampling a
 * 64-bit integer essentially never produces 0, 1, -1 or an overflow boundary,
 * which is where the bugs are, so about half of all draws come from a curated
 * set of values that have historically broken things.
 *
 * Aliasing is generated on purpose: two parameters of the same record type
 * sometimes receive the *same* reference. That is precisely the case the
 * verifier assumes away, so it is the case the micro-world must cover.
 */

import type { Param, Ty } from '../tier1/ast.ts';
import type { CapabilityName } from '../tier1/ids.ts';
import { underlying } from '../tier2/typecheck.ts';
import type { Rng } from '../util/rng.ts';
import type { Ref, Value } from './values.ts';

/**
 * Anything a generated case can be materialised into.
 *
 * Deliberately the narrowest possible surface: a case needs to allocate
 * records and nothing else. Typing this to the development `Runtime` would
 * have excluded the production one for no reason, and the two are compared
 * against each other on every generated case.
 */
export interface Allocator {
  allocateRecord(ty: Ty, fields: Record<string, Value>): Ref;
}

/** A generated argument, independent of any runtime. */
export type Plain =
  | { readonly k: 'int'; readonly v: bigint }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'str'; readonly v: string }
  | { readonly k: 'unit' }
  | { readonly k: 'result'; readonly variant: 'ok' | 'err'; readonly value: Plain }
  | { readonly k: 'seq'; readonly items: readonly Plain[] }
  | { readonly k: 'fn'; readonly capabilities: readonly CapabilityName[]; readonly result: Plain }
  | { readonly k: 'record'; readonly ty: Ty; readonly fields: Readonly<Record<string, Plain>> }
  /** The same reference as an earlier argument — the aliased case. */
  | { readonly k: 'alias'; readonly index: number };

/** Integer values that break things more often than chance would suggest. */
const INTEGER_BOUNDARIES: readonly bigint[] = [
  0n, 1n, -1n, 2n, -2n, 10n, -10n, 100n, -100n,
  127n, 128n, -128n, 255n, 256n,
  32767n, 32768n, -32768n,
  2147483647n, 2147483648n, -2147483648n,
  9223372036854775807n, -9223372036854775808n,
];

const STRING_BOUNDARIES: readonly string[] = [
  '', ' ', 'a', '0', 'null', 'undefined', 'NaN',
  "'; DROP TABLE accounts; --",
  '../../etc/passwd',
  '\u0000', '\n', '\t', '‮', '👩‍👩‍👧‍👦', 'é'.normalize('NFD'),
  'x'.repeat(1024),
];

export interface GenerationOptions {
  /** Magnitude of non-boundary draws. */
  readonly size?: number;
  /** Probability that a draw comes from the boundary set. */
  readonly boundaryBias?: number;
  /** Probability that two same-typed record parameters are made to alias. */
  readonly aliasBias?: number;
}

export function generateInt(random: Rng, opts: GenerationOptions = {}): bigint {
  const size = BigInt(opts.size ?? 1000);
  return random.bool(opts.boundaryBias ?? 0.5)
    ? random.pick(INTEGER_BOUNDARIES)
    : random.bigint(-size, size);
}

export function generateString(random: Rng, opts: GenerationOptions = {}): string {
  if (random.bool(opts.boundaryBias ?? 0.5)) return random.pick(STRING_BOUNDARIES);
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-';
  const length = random.int(0, 16);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[random.int(0, alphabet.length - 1)];
  return out;
}

export function generatePlain(ty: Ty, random: Rng, opts: GenerationOptions = {}): Plain {
  const base = underlying(ty);
  switch (base.t) {
    case 'Int': return { k: 'int', v: generateInt(random, opts) };
    case 'Bool': return { k: 'bool', v: random.bool() };
    case 'Str': return { k: 'str', v: generateString(random, opts) };
    case 'Unit': return { k: 'unit' };
    case 'Result': {
      const variant = random.bool() ? 'ok' : 'err';
      return { k: 'result', variant, value: generatePlain(variant === 'ok' ? base.ok : base.err, random, opts) };
    }
    case 'Seq': {
      const length = random.int(0, Math.max(0, Math.min(8, opts.size ?? 4)));
      return { k: 'seq', items: Array.from({ length }, () => generatePlain(base.element, random, opts)) };
    }
    case 'Fn': return { k: 'fn', capabilities: base.capabilities, result: generatePlain(base.returns, random, opts) };
    case 'Record': {
      const fields: Record<string, Plain> = {};
      for (const [name, fieldTy] of base.fields) fields[name] = generatePlain(fieldTy, random, opts);
      return { k: 'record', ty, fields };
    }
    default:
      throw new TypeError(`cannot generate a value of type ${base.t}`);
  }
}

/** Generate a whole argument vector, sometimes aliasing same-typed records. */
export function generateCase(
  params: readonly Param[],
  random: Rng,
  opts: GenerationOptions = {},
): Plain[] {
  const args: Plain[] = [];
  const recordsByType = new Map<string, number[]>();
  const aliasBias = opts.aliasBias ?? 0.15;

  params.forEach((param, index) => {
    const base = underlying(param.ty);
    if (base.t === 'Record') {
      const seen = recordsByType.get(base.name);
      if (seen?.length && random.bool(aliasBias)) {
        args.push({ k: 'alias', index: random.pick(seen) });
        return;
      }
      recordsByType.set(base.name, [...(seen ?? []), index]);
    }
    args.push(generatePlain(param.ty, random, opts));
  });
  return args;
}

/** Allocate a generated case into a runtime's heap. */
export function materialise(args: readonly Plain[], rt: Allocator): Value[] {
  const out: Value[] = [];
  for (const arg of args) {
    out.push(materialiseOne(arg, rt, out));
  }
  return out;
}

function materialiseOne(arg: Plain, rt: Allocator, earlier: readonly Value[]): Value {
  switch (arg.k) {
    case 'int': return arg.v;
    case 'bool': return arg.v;
    case 'str': return arg.v;
    case 'unit': return null;
    case 'result': return { variant: arg.variant, value: materialiseOne(arg.value, rt, earlier) };
    case 'seq': return arg.items.map((item) => materialiseOne(item, rt, earlier));
    case 'fn': {
      const result = materialiseOne(arg.result, rt, earlier);
      return { closure: true, capabilities: arg.capabilities, invoke: () => result };
    }
    case 'alias': {
      const target = earlier[arg.index];
      if (target === undefined) throw new RangeError(`alias to argument ${arg.index}, which is not yet bound`);
      return target;
    }
    case 'record': {
      const fields: Record<string, Value> = {};
      for (const [name, value] of Object.entries(arg.fields)) {
        fields[name] = materialiseOne(value, rt, earlier);
      }
      return rt.allocateRecord(arg.ty, fields);
    }
  }
}

export function formatPlain(arg: Plain): string {
  switch (arg.k) {
    case 'int': return String(arg.v);
    case 'bool': return String(arg.v);
    case 'str': return JSON.stringify(arg.v);
    case 'unit': return '()';
    case 'result': return `${arg.variant}(${formatPlain(arg.value)})`;
    case 'seq': return `[${arg.items.map(formatPlain).join(', ')}]`;
    case 'fn': return `<generated closure => ${formatPlain(arg.result)}>`;
    case 'alias': return `<same as argument ${arg.index}>`;
    case 'record':
      return `{ ${Object.entries(arg.fields).map(([k, v]) => `${k}: ${formatPlain(v)}`).join(', ')} }`;
  }
}

/**
 * Candidate simplifications of a generated value, simplest first.
 *
 * Shrinking earns its keep: `amount = -1` names a bug where
 * `amount = -8443113199` merely reports one. Records shrink field-wise, so a
 * reduced case keeps its shape and stays runnable.
 */
export function shrinkPlain(arg: Plain): Plain[] {
  switch (arg.k) {
    case 'int': {
      const v = arg.v;
      const out: bigint[] = [];
      if (v !== 0n) out.push(0n);
      if (v > 1n || v < -1n) out.push(v / 2n);
      if (v > 0n) out.push(1n, v - 1n);
      if (v < 0n) out.push(-1n, v + 1n);
      return [...new Set(out)].filter((c) => c !== v).map((c) => ({ k: 'int', v: c }));
    }
    case 'str': {
      if (arg.v === '') return [];
      const candidates = new Set(['', arg.v.slice(0, Math.floor(arg.v.length / 2)), arg.v.slice(0, 1)]);
      candidates.delete(arg.v);
      return [...candidates].map((v) => ({ k: 'str', v }));
    }
    case 'bool': return arg.v ? [{ k: 'bool', v: false }] : [];
    case 'unit': return [];
    case 'result': return shrinkPlain(arg.value).map((value) => ({ ...arg, value }));
    case 'seq': {
      const out: Plain[] = arg.items.length ? [{ k: 'seq', items: [] }] : [];
      if (arg.items.length > 1) out.push({ k: 'seq', items: arg.items.slice(0, Math.floor(arg.items.length / 2)) });
      return out;
    }
    case 'fn': return shrinkPlain(arg.result).map((result) => ({ ...arg, result }));
    case 'alias': return []; // un-aliasing changes which case this is
    case 'record': {
      const out: Plain[] = [];
      for (const [name, value] of Object.entries(arg.fields)) {
        for (const smaller of shrinkPlain(value)) {
          out.push({ ...arg, fields: { ...arg.fields, [name]: smaller } });
        }
      }
      return out;
    }
  }
}
