/**
 * Agent Intermediate Representation (FR-1.2).
 *
 * Agent-IR is a lossless linearization of an AST subtree with one consumer in
 * mind: a model with a finite context window. Three properties do the work.
 *
 *   1. **Post-order, arity-driven.** Every opcode's operand count is known, so
 *      the stream needs no brackets, no statement terminators and no
 *      indentation. A large share of the characters in a source file are
 *      structural punctuation that an RPN stream simply does not have.
 *
 *   2. **Names appear once per session.** In source text every occurrence of
 *      `receiverAccountBalance` is re-tokenized. Here identifiers live in a
 *      dictionary and each *use* is a fixed-width index. Token cost stops
 *      scaling with how descriptively code is named, which is what makes
 *      verbose, self-documenting naming free.
 *
 *   3. **One opcode, one token.** Every opcode and its operands are packed
 *      into a single alphanumeric run — indices are base-36 and fixed width,
 *      declared once per message. This matters more than it looks: a
 *      separator-heavy encoding like `C3,2` costs three BPE tokens where
 *      `C32` costs one, and a stream is mostly opcodes.
 *
 * The encoding is total and reversible: `decode(encode(t)) ≡ t` for every term
 * the substrate can represent.
 *
 * ### Grammar
 *
 * ```
 * stream   := header "\n" token*
 * header   := "AE1" "\n" "§w " width ( "\n" section )*
 * section  := "§" tag " " item ( "|" item )*
 * token    := fixed | opcode field* trailing?
 * field    := <width> base-36 digits
 * ```
 *
 * An *optional* index field uses 0 for "absent" and `i + 1` otherwise.
 */

import { children, type Objective, type Param, type Rigor, type SurfaceDomain, type Term, type Ty } from './ast.ts';
import type { CapabilityName, ProvenanceId, SymbolId, TypeName } from './ids.ts';
import { estimateTokens } from '../util/tokens.ts';

// ---------------------------------------------------------------------------
// dictionaries
// ---------------------------------------------------------------------------

class Pool<T> {
  private readonly index = new Map<string, number>();
  private readonly items: T[] = [];
  private readonly key: (v: T) => string;
  /** Entries below this index have already been shipped to the peer. */
  private watermark = 0;

  constructor(key: (v: T) => string = (v) => String(v)) {
    this.key = key;
  }

  intern(value: T): number {
    const k = this.key(value);
    const hit = this.index.get(k);
    if (hit !== undefined) return hit;
    this.index.set(k, this.items.length);
    this.items.push(value);
    return this.items.length - 1;
  }

  at(i: number): T {
    if (i < 0 || i >= this.items.length) throw new RangeError(`pool index ${i} out of range`);
    return this.items[i];
  }

  /** Entries added since the last commit — what this message's header carries. */
  delta(): readonly T[] {
    return this.items.slice(this.watermark);
  }

  commit(): void {
    this.watermark = this.items.length;
  }

  /** Absorb entries shipped by a peer's header. */
  absorb(values: readonly T[]): void {
    for (const v of values) this.intern(v);
    this.commit();
  }

  get size(): number {
    return this.items.length;
  }
}

interface Pools {
  readonly name: Pool<string>;
  readonly ty: Pool<string>;
  readonly str: Pool<string>;
  readonly cap: Pool<CapabilityName>;
  readonly label: Pool<string>;
  readonly prov: Pool<ProvenanceId>;
  readonly sym: Pool<SymbolId>;
}

/** Section order is load-bearing: type entries refer to name-pool indices. */
const SECTION_ORDER = ['n', 'y', 's', 'c', 'l', 'p', 'v'] as const;
type SectionTag = (typeof SECTION_ORDER)[number];

function freshPools(): Pools {
  return {
    name: new Pool<string>(),
    ty: new Pool<string>(),
    str: new Pool<string>(),
    cap: new Pool<CapabilityName>(),
    label: new Pool<string>(),
    prov: new Pool<ProvenanceId>(),
    sym: new Pool<SymbolId>(),
  };
}

function poolByTag(pools: Pools): Record<SectionTag, Pool<string>> {
  return {
    n: pools.name,
    y: pools.ty,
    s: pools.str,
    c: pools.cap as unknown as Pool<string>,
    l: pools.label,
    p: pools.prov as unknown as Pool<string>,
    v: pools.sym as unknown as Pool<string>,
  };
}

/**
 * A dictionary shared between an agent and the fabric for a session.
 *
 * Without one, every message re-ships the module's identifiers, and opaque
 * symbol ids are long. With one, the first message pays for the dictionary and
 * every later edit is body-only. That matches how agents actually work — load a
 * module once, then rewrite subtrees of it many times — and the marginal cost
 * of an edit is what a context budget actually feels.
 *
 * Both ends stay in step because every message carries its own dictionary
 * delta; a peer that replays the same message sequence ends with the same
 * pools.
 */
export class IrContext {
  /** @internal */
  readonly pools: Pools = freshPools();
  /** Cumulative dictionary cost paid so far, for reporting. */
  dictionaryTokens = 0;
}

// ---------------------------------------------------------------------------
// fixed-width base-36 fields
// ---------------------------------------------------------------------------

const b36 = (n: number, width: number): string => {
  const s = n.toString(36);
  if (s.length > width) throw new RangeError(`index ${n} does not fit in ${width} base-36 digits`);
  return s.padStart(width, '0');
};

function widthFor(pools: Pools): number {
  const largest = Math.max(1, ...Object.values(pools).map((p) => p.size));
  return Math.max(1, largest.toString(36).length);
}

/** Integers are decimal with a `z` sign marker, so they stay one alnum run. */
const encodeInt = (v: bigint): string => (v < 0n ? `z${-v}` : String(v));
const decodeInt = (s: string): bigint => (s[0] === 'z' ? -BigInt(s.slice(1)) : BigInt(s));

// ---------------------------------------------------------------------------
// opcode tables
// ---------------------------------------------------------------------------

const BIN_OPCODE: Record<string, string> = {
  add: '+', sub: '-', mul: '*', div: '/', mod: '%',
  eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=',
  and: '&', or: '|', concat: '~',
};
const OPCODE_BIN = Object.fromEntries(Object.entries(BIN_OPCODE).map(([k, v]) => [v, k]));
const UN_OPCODE: Record<string, string> = { not: '!', neg: '_' };
const OPCODE_UN = Object.fromEntries(Object.entries(UN_OPCODE).map(([k, v]) => [v, k]));

const RIGOR_CODE: Record<Rigor, string> = { formal: '0', property: '1' };
const CODE_RIGOR: Record<string, Rigor> = { '0': 'formal', '1': 'property' };
const OBJECTIVE_CODE: Record<Objective, string> = {
  minimize_latency: '0', minimize_cost: '1', minimize_memory: '2',
};
const CODE_OBJECTIVE: Record<string, Objective> = {
  '0': 'minimize_latency', '1': 'minimize_cost', '2': 'minimize_memory',
};

// ---------------------------------------------------------------------------
// type grammar
// ---------------------------------------------------------------------------

/**
 * `I` int, `B` bool, `S` str, `U` unit, `N`/`R`/`E` composite. Type names and
 * record field names are interned, so a handle as long as `type:ledger:account`
 * is written once per session rather than once per mention.
 */
function encodeTy(ty: Ty, name: (s: string) => number): string {
  switch (ty.t) {
    case 'Int': return 'I';
    case 'Bool': return 'B';
    case 'Str': return 'S';
    case 'Unit': return 'U';
    case 'Nominal': return `N${name(ty.name)}<${encodeTy(ty.repr, name)}>`;
    case 'Record':
      return `R${name(ty.name)}<${
        ty.fields.map(([n, t]) => `${name(n)}:${encodeTy(t, name)}`).join(',')
      }>`;
    case 'Result': return `E<${encodeTy(ty.ok, name)},${encodeTy(ty.err, name)}>`;
  }
}

function parseTy(src: string, pos: number, nameAt: (i: number) => string): [Ty, number] {
  switch (src[pos]) {
    case 'I': return [{ t: 'Int' }, pos + 1];
    case 'B': return [{ t: 'Bool' }, pos + 1];
    case 'S': return [{ t: 'Str' }, pos + 1];
    case 'U': return [{ t: 'Unit' }, pos + 1];
    case 'N': {
      const open = src.indexOf('<', pos);
      const name = nameAt(Number(src.slice(pos + 1, open))) as TypeName;
      const [repr, after] = parseTy(src, open + 1, nameAt);
      return [{ t: 'Nominal', name, repr }, after + 1];
    }
    case 'R': {
      const open = src.indexOf('<', pos);
      const name = nameAt(Number(src.slice(pos + 1, open))) as TypeName;
      const fields: Array<readonly [string, Ty]> = [];
      let i = open + 1;
      while (src[i] !== '>') {
        if (src[i] === ',') i++;
        const colon = src.indexOf(':', i);
        const fname = nameAt(Number(src.slice(i, colon)));
        const [fty, after] = parseTy(src, colon + 1, nameAt);
        fields.push([fname, fty]);
        i = after;
      }
      return [{ t: 'Record', name, fields }, i + 1];
    }
    case 'E': {
      const [ok, afterOk] = parseTy(src, pos + 2, nameAt);
      const [err, afterErr] = parseTy(src, afterOk + 1, nameAt);
      return [{ t: 'Result', ok, err }, afterErr + 1];
    }
    default:
      throw new SyntaxError(`unparseable type at ${pos}: ${src.slice(pos, pos + 24)}`);
  }
}

/** `x` separates range bounds so the whole domain stays one alphanumeric run. */
function encodeDomain(d: SurfaceDomain, str: (s: string) => number, w: number): string {
  return d.d === 'choice'
    ? `c${d.options.map((o) => b36(str(o), w)).join('')}`
    : `r${encodeInt(d.min)}x${encodeInt(d.max)}x${encodeInt(d.step)}`;
}

function parseDomain(s: string, strAt: (i: number) => string, w: number): SurfaceDomain {
  if (s[0] === 'c') {
    const body = s.slice(1);
    const options: string[] = [];
    for (let i = 0; i < body.length; i += w) options.push(strAt(parseInt(body.slice(i, i + w), 36)));
    return { d: 'choice', options };
  }
  const [min, max, step] = s.slice(1).split('x').map(decodeInt);
  return { d: 'range', min, max, step };
}

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

export interface AgentIr {
  /** The full stream: dictionary delta then body. */
  readonly text: string;
  /** Dictionary delta. Nearly empty once the peer holds the entries. */
  readonly header: string;
  readonly body: string;
  readonly tokens: number;
  /** Tokens for the body alone — the marginal cost of one more edit. */
  readonly bodyTokens: number;
  readonly bytes: number;
  readonly nodeCount: number;
}

/**
 * Encode a hydrated term as an Agent-IR stream. Pass a `ctx` to share a
 * dictionary across a session; the header then carries only what is new.
 */
export function encode(term: Term, ctx?: IrContext): AgentIr {
  const pools: Pools = ctx ? ctx.pools : freshPools();

  // Pass 1: intern everything, so the field width is known before emitting.
  const internName = (n: string) => pools.name.intern(n);
  const internAll = (t: Term): void => {
    for (const c of children(t)) internAll(c);
    switch (t.kind) {
      case 'Lit':
        pools.ty.intern(encodeTy(t.ty, internName));
        if (typeof t.value === 'string') pools.str.intern(t.value);
        break;
      case 'Var': pools.sym.intern(t.symbol); break;
      case 'Call': pools.sym.intern(t.callee); break;
      case 'Field': internName(t.field); break;
      case 'RecordLit':
        pools.ty.intern(encodeTy(t.ty, internName));
        for (const [n] of t.fields) internName(n);
        break;
      case 'ResultValue':
        pools.ty.intern(encodeTy(t.ty, internName));
        break;
      case 'MatchResult':
        pools.sym.intern(t.okSymbol);
        pools.sym.intern(t.errSymbol);
        break;
      case 'Invoke': pools.cap.intern(t.capability); break;
      case 'Place':
        pools.sym.intern(t.symbol);
        for (const p of t.path) internName(p);
        break;
      case 'Let':
        pools.sym.intern(t.symbol);
        pools.ty.intern(encodeTy(t.ty, internName));
        break;
      case 'Assert': pools.label.intern(t.label); break;
      case 'Clause': pools.label.intern(t.label); break;
      case 'FunctionDecl':
        pools.sym.intern(t.symbol);
        pools.ty.intern(encodeTy(t.returns, internName));
        for (const p of t.params) {
          pools.sym.intern(p.symbol);
          pools.ty.intern(encodeTy(p.ty, internName));
        }
        for (const c of t.capabilities) pools.cap.intern(c);
        if (t.provenance) pools.prov.intern(t.provenance);
        break;
      case 'TypeDecl':
        internName(t.name);
        pools.ty.intern(encodeTy(t.ty, internName));
        if (t.provenance) pools.prov.intern(t.provenance);
        break;
      case 'Surface':
        pools.sym.intern(t.symbol);
        if (typeof t.current === 'string') pools.str.intern(t.current);
        if (t.domain.d === 'choice') for (const o of t.domain.options) pools.str.intern(o);
        break;
      case 'SymbolTable':
        for (const [s, n] of t.entries) {
          pools.sym.intern(s);
          internName(n);
        }
        break;
      case 'Module':
        pools.sym.intern(t.symbol);
        if (t.provenance) pools.prov.intern(t.provenance);
        break;
      default: break;
    }
  };
  internAll(term);

  const w = widthFor(pools);
  const f = (n: number) => b36(n, w);
  const optional = (v: string | null | undefined, idx: () => number) =>
    v === null || v === undefined ? f(0) : f(idx() + 1);
  const ty = (t: Ty) => f(pools.ty.intern(encodeTy(t, internName)));
  const sym = (s: SymbolId) => f(pools.sym.intern(s));
  const nm = (n: string) => f(internName(n));

  const out: string[] = [];
  let nodeCount = 0;

  const emit = (t: Term): void => {
    nodeCount++;
    for (const child of children(t)) emit(child); // post-order
    switch (t.kind) {
      case 'Lit': {
        const encoded = encodeTy(t.ty, internName);
        if (typeof t.value === 'bigint') {
          out.push(encoded === 'I' ? `i${encodeInt(t.value)}` : `j${ty(t.ty)}${encodeInt(t.value)}`);
        } else if (typeof t.value === 'boolean') {
          out.push(encoded === 'B' ? (t.value ? 't' : 'f') : `k${ty(t.ty)}${t.value ? 1 : 0}`);
        } else if (typeof t.value === 'string') {
          const idx = f(pools.str.intern(t.value));
          out.push(encoded === 'S' ? `m${idx}` : `n${ty(t.ty)}${idx}`);
        } else {
          out.push(encoded === 'U' ? 'u' : `l${ty(t.ty)}`);
        }
        return;
      }
      case 'Var': out.push(`v${sym(t.symbol)}`); return;
      case 'Bin': out.push(BIN_OPCODE[t.op]); return;
      case 'Un': out.push(UN_OPCODE[t.op]); return;
      case 'Cond': out.push('?'); return;
      case 'Call': out.push(`C${sym(t.callee)}${f(t.args.length)}`); return;
      case 'Field': out.push(`F${nm(t.field)}`); return;
      case 'RecordLit':
        out.push(`R${ty(t.ty)}${f(t.fields.length)}${t.fields.map(([n]) => nm(n)).join('')}`);
        return;
      case 'ResultValue':
        out.push(`O${t.variant === 'ok' ? 0 : 1}${ty(t.ty)}`);
        return;
      case 'MatchResult':
        out.push(`J${sym(t.okSymbol)}${sym(t.errSymbol)}`);
        return;
      case 'Old': out.push('@'); return;
      case 'ResultRef': out.push('$'); return;
      case 'Invoke': out.push(`X${f(pools.cap.intern(t.capability))}${f(t.args.length)}`); return;
      case 'Place':
        out.push(`P${sym(t.symbol)}${f(t.path.length)}${t.path.map(nm).join('')}`);
        return;
      case 'Let': out.push(`L${sym(t.symbol)}${ty(t.ty)}`); return;
      case 'Assign': out.push('='); return;
      case 'If': out.push(t.otherwise ? 'I1' : 'I0'); return;
      case 'While': out.push(`W${f(t.invariants.length)}${t.variant ? 1 : 0}`); return;
      case 'Return': out.push('N'); return;
      case 'Assert': out.push(`A${f(pools.label.intern(t.label))}`); return;
      case 'ExprStmt': out.push('E'); return;
      case 'Block': out.push(`B${f(t.stmts.length)}`); return;
      case 'Clause':
        out.push(`Q${f(pools.label.intern(t.label))}${RIGOR_CODE[t.rigor]}`);
        return;
      case 'Contract':
        out.push(`K${f(t.requires.length)}${f(t.ensures.length)}${f(t.modifies.length)}`);
        return;
      case 'FunctionDecl':
        out.push(
          `D${sym(t.symbol)}${ty(t.returns)}` +
            `${t.purity === 'pure' ? 0 : 1}${t.contract ? 1 : 0}${t.body ? 1 : 0}` +
            `${f(t.surfaces.length)}` +
            `${optional(t.provenance, () => pools.prov.intern(t.provenance!))}` +
            `${f(t.params.length)}` +
            `${t.params.map((p: Param) => `${sym(p.symbol)}${ty(p.ty)}`).join('')}` +
            `${f(t.capabilities.length)}` +
            `${t.capabilities.map((c) => f(pools.cap.intern(c))).join('')}`,
        );
        return;
      case 'TypeDecl':
        out.push(
          `Y${nm(t.name)}${ty(t.ty)}` +
            `${optional(t.provenance, () => pools.prov.intern(t.provenance!))}`,
        );
        return;
      case 'Surface':
        out.push(
          `Z${sym(t.symbol)}${OBJECTIVE_CODE[t.objective]}`,
          encodeDomain(t.domain, (s) => pools.str.intern(s), w),
          typeof t.current === 'bigint' ? `h${encodeInt(t.current)}` : `m${f(pools.str.intern(t.current))}`,
        );
        return;
      case 'SymbolTable':
        out.push(
          `G${f(t.entries.length)}` +
            t.entries.map(([s, n]) => `${sym(s)}${nm(n)}`).join(''),
        );
        return;
      case 'Module':
        out.push(
          `M${sym(t.symbol)}${f(t.members.length)}` +
            `${optional(t.provenance, () => pools.prov.intern(t.provenance!))}`,
        );
        return;
    }
  };

  emit(term);

  const sections = ['AE1', `§w ${w}`];
  const byTag = poolByTag(pools);
  for (const tag of SECTION_ORDER) {
    const delta = byTag[tag].delta();
    if (delta.length) sections.push(`§${tag} ${delta.join('|')}`);
  }
  for (const tag of SECTION_ORDER) byTag[tag].commit();

  const header = sections.join('\n');
  const body = out.join(' ');
  const text = `${header}\n${body}`;
  const bodyTokens = estimateTokens(body);
  if (ctx) ctx.dictionaryTokens += estimateTokens(header);
  return {
    text,
    header,
    body,
    tokens: estimateTokens(text),
    bodyTokens,
    bytes: new TextEncoder().encode(text).length,
    nodeCount,
  };
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

/**
 * Decode an Agent-IR stream back into the exact term it came from. Pass the
 * context that was fed the same message sequence to resolve dictionary entries
 * shipped by earlier messages.
 */
export function decode(ir: string, ctx?: IrContext): Term {
  const lines = ir.split('\n');
  if (lines[0] !== 'AE1') throw new SyntaxError(`expected AE1 header, got ${lines[0]}`);

  const pools: Pools = ctx ? ctx.pools : freshPools();
  const byTag = poolByTag(pools);

  let w = 1;
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('§')) break;
    const space = line.indexOf(' ');
    const tag = line.slice(1, space);
    const payload = line.slice(space + 1);
    if (tag === 'w') {
      w = Number(payload);
      if (!Number.isInteger(w) || w < 1) throw new SyntaxError(`bad field width ${payload}`);
      continue;
    }
    const target = byTag[tag as SectionTag];
    if (!target) throw new SyntaxError(`unknown Agent-IR section §${tag}`);
    target.absorb(payload.split('|'));
  }
  const body = lines.slice(i).join('\n').trim();

  const at = (tag: SectionTag) => (idx: number): string => {
    const pool = byTag[tag];
    if (idx < 0 || idx >= pool.size) throw new RangeError(`§${tag} has no entry ${idx}`);
    return pool.at(idx);
  };
  const nameAt = at('n');
  const strAt = at('s');
  const symAt = (idx: number) => at('v')(idx) as SymbolId;
  const capAt = (idx: number) => at('c')(idx) as CapabilityName;
  const labelAt = at('l');
  const provAt = (idx: number) => at('p')(idx) as ProvenanceId;
  const tyAt = (idx: number): Ty => parseTy(at('y')(idx), 0, nameAt)[0];

  /** Cursor over the fixed-width fields of one token. */
  const reader = (tok: string, start: number) => {
    let pos = start;
    return {
      field(): number {
        const v = parseInt(tok.slice(pos, pos + w), 36);
        if (Number.isNaN(v)) throw new SyntaxError(`bad field in ${tok} at ${pos}`);
        pos += w;
        return v;
      },
      digit(): string {
        return tok[pos++];
      },
      rest(): string {
        return tok.slice(pos);
      },
      optional(): number | null {
        const v = this.field();
        return v === 0 ? null : v - 1;
      },
    };
  };

  const stack: Term[] = [];
  const popN = (n: number): Term[] => {
    if (n > stack.length) throw new SyntaxError(`stack underflow: needed ${n}, have ${stack.length}`);
    return stack.splice(stack.length - n, n);
  };

  const tokens = body.split(/\s+/).filter(Boolean);
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];

    if (tok in OPCODE_BIN) {
      const [left, right] = popN(2);
      stack.push({ kind: 'Bin', op: OPCODE_BIN[tok] as never, left, right });
      continue;
    }
    if (tok in OPCODE_UN) {
      const [operand] = popN(1);
      stack.push({ kind: 'Un', op: OPCODE_UN[tok] as never, operand });
      continue;
    }
    switch (tok) {
      case 't': stack.push({ kind: 'Lit', ty: { t: 'Bool' }, value: true }); continue;
      case 'f': stack.push({ kind: 'Lit', ty: { t: 'Bool' }, value: false }); continue;
      case 'u': stack.push({ kind: 'Lit', ty: { t: 'Unit' }, value: null }); continue;
      case '$': stack.push({ kind: 'ResultRef' }); continue;
      case '@': { const [expr] = popN(1); stack.push({ kind: 'Old', expr }); continue; }
      case '?': {
        const [c, then, otherwise] = popN(3);
        stack.push({ kind: 'Cond', cond: c, then, otherwise });
        continue;
      }
      case '=': {
        const [target, value] = popN(2);
        stack.push({ kind: 'Assign', target, value });
        continue;
      }
      case 'N': { const [value] = popN(1); stack.push({ kind: 'Return', value }); continue; }
      case 'E': { const [expr] = popN(1); stack.push({ kind: 'ExprStmt', expr }); continue; }
      case 'I0': {
        const [c, then] = popN(2);
        stack.push({ kind: 'If', cond: c, then, otherwise: null });
        continue;
      }
      case 'I1': {
        const [c, then, otherwise] = popN(3);
        stack.push({ kind: 'If', cond: c, then, otherwise });
        continue;
      }
      default: break;
    }

    const r = reader(tok, 1);
    switch (tok[0]) {
      case 'i': stack.push({ kind: 'Lit', ty: { t: 'Int' }, value: decodeInt(r.rest()) }); continue;
      case 'j': {
        const t = tyAt(r.field());
        stack.push({ kind: 'Lit', ty: t, value: decodeInt(r.rest()) });
        continue;
      }
      case 'k': {
        const t = tyAt(r.field());
        stack.push({ kind: 'Lit', ty: t, value: r.digit() === '1' });
        continue;
      }
      case 'l': stack.push({ kind: 'Lit', ty: tyAt(r.field()), value: null }); continue;
      case 'm': stack.push({ kind: 'Lit', ty: { t: 'Str' }, value: strAt(r.field()) }); continue;
      case 'n': {
        const t = tyAt(r.field());
        stack.push({ kind: 'Lit', ty: t, value: strAt(r.field()) });
        continue;
      }
      case 'v': stack.push({ kind: 'Var', symbol: symAt(r.field()) }); continue;
      case 'F': {
        const [object] = popN(1);
        stack.push({ kind: 'Field', object, field: nameAt(r.field()) });
        continue;
      }
      case 'C': {
        const callee = symAt(r.field());
        stack.push({ kind: 'Call', callee, args: popN(r.field()) });
        continue;
      }
      case 'X': {
        const capability = capAt(r.field());
        stack.push({ kind: 'Invoke', capability, args: popN(r.field()) });
        continue;
      }
      case 'R': {
        const t = tyAt(r.field());
        const n = r.field();
        const names = Array.from({ length: n }, () => nameAt(r.field()));
        const values = popN(n);
        stack.push({
          kind: 'RecordLit',
          ty: t,
          fields: names.map((nm2, idx) => [nm2, values[idx]] as const),
        });
        continue;
      }
      case 'O': {
        const variant = r.digit() === '0' ? 'ok' : 'err';
        const t = tyAt(r.field());
        if (t.t !== 'Result') throw new SyntaxError('ResultValue requires a Result type');
        const [value] = popN(1);
        stack.push({ kind: 'ResultValue', variant, ty: t, value });
        continue;
      }
      case 'J': {
        const okSymbol = symAt(r.field());
        const errSymbol = symAt(r.field());
        const [value, ok, err] = popN(3);
        stack.push({ kind: 'MatchResult', value, okSymbol, ok, errSymbol, err });
        continue;
      }
      case 'P': {
        const symbol = symAt(r.field());
        const len = r.field();
        stack.push({
          kind: 'Place',
          symbol,
          path: Array.from({ length: len }, () => nameAt(r.field())),
        });
        continue;
      }
      case 'L': {
        const symbol = symAt(r.field());
        const t = tyAt(r.field());
        const [init] = popN(1);
        stack.push({ kind: 'Let', symbol, ty: t, init });
        continue;
      }
      case 'W': {
        const nInv = r.field();
        const hasVar = r.digit() === '1' ? 1 : 0;
        const popped = popN(1 + nInv + hasVar + 1);
        stack.push({
          kind: 'While',
          cond: popped[0],
          invariants: popped.slice(1, 1 + nInv),
          variant: hasVar ? popped[1 + nInv] : null,
          body: popped[popped.length - 1],
        });
        continue;
      }
      case 'A': {
        const label = labelAt(r.field());
        const [expr] = popN(1);
        stack.push({ kind: 'Assert', expr, label });
        continue;
      }
      case 'B': stack.push({ kind: 'Block', stmts: popN(r.field()) }); continue;
      case 'Q': {
        const label = labelAt(r.field());
        const rigor = CODE_RIGOR[r.digit()];
        const [expr] = popN(1);
        stack.push({ kind: 'Clause', expr, label, rigor });
        continue;
      }
      case 'K': {
        const nr = r.field();
        const ne = r.field();
        const nm2 = r.field();
        const popped = popN(nr + ne + nm2);
        stack.push({
          kind: 'Contract',
          requires: popped.slice(0, nr),
          ensures: popped.slice(nr, nr + ne),
          modifies: popped.slice(nr + ne),
        });
        continue;
      }
      case 'D': {
        const symbol = symAt(r.field());
        const returns = tyAt(r.field());
        const purity = r.digit() === '0' ? 'pure' : 'effectful';
        const hasContract = r.digit() === '1';
        const hasBody = r.digit() === '1';
        const nSurf = r.field();
        const provIdx = r.optional();
        const nParams = r.field();
        const params: Param[] = Array.from({ length: nParams }, () => ({
          symbol: symAt(r.field()),
          ty: tyAt(r.field()),
        }));
        const nCaps = r.field();
        const capabilities = Array.from({ length: nCaps }, () => capAt(r.field()));
        const popped = popN((hasContract ? 1 : 0) + (hasBody ? 1 : 0) + nSurf);
        let c = 0;
        const contract = hasContract ? popped[c++] : null;
        const bodyTerm = hasBody ? popped[c++] : null;
        stack.push({
          kind: 'FunctionDecl',
          symbol,
          params,
          returns,
          capabilities,
          purity,
          contract,
          body: bodyTerm,
          surfaces: popped.slice(c),
          provenance: provIdx === null ? null : provAt(provIdx),
        });
        continue;
      }
      case 'Y': {
        const name = nameAt(r.field()) as TypeName;
        const t = tyAt(r.field());
        const provIdx = r.optional();
        stack.push({
          kind: 'TypeDecl',
          name,
          ty: t,
          provenance: provIdx === null ? null : provAt(provIdx),
        });
        continue;
      }
      case 'Z': {
        const symbol = symAt(r.field());
        const objective = CODE_OBJECTIVE[r.digit()];
        const domain = parseDomain(tokens[++k], strAt, w);
        const cur = tokens[++k];
        stack.push({
          kind: 'Surface',
          symbol,
          objective,
          domain,
          current: cur[0] === 'h' ? decodeInt(cur.slice(1)) : strAt(parseInt(cur.slice(1), 36)),
        });
        continue;
      }
      case 'G': {
        const n = r.field();
        stack.push({
          kind: 'SymbolTable',
          entries: Array.from(
            { length: n },
            () => [symAt(r.field()), nameAt(r.field())] as const,
          ),
        });
        continue;
      }
      case 'M': {
        const symbol = symAt(r.field());
        const n = r.field();
        const provIdx = r.optional();
        const popped = popN(n + 1);
        stack.push({
          kind: 'Module',
          symbol,
          members: popped.slice(0, n),
          symbolTable: popped[popped.length - 1],
          provenance: provIdx === null ? null : provAt(provIdx),
        });
        continue;
      }
      default:
        throw new SyntaxError(`unknown Agent-IR opcode: ${tok}`);
    }
  }

  if (stack.length !== 1) {
    throw new SyntaxError(`Agent-IR stream left ${stack.length} values on the stack, expected 1`);
  }
  return stack[0];
}
