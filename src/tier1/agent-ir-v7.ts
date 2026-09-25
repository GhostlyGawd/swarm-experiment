/** AE7: an exact, versioned cold exchange with a checked symbol seed.
 *
 * AE1 remains the semantic grammar. AE7 only changes two cold dictionary
 * representations. It never derives a binding identity from its spelling:
 * each symbol ID is regenerated from the declared SymbolSpace seed and its
 * explicit generation index, then the complete AE1/AST root is checked.
 */
import { freshSymbolId, type SymbolId } from './ids.ts';
import { rng } from '../util/rng.ts';
import { decode, encode, IrContext } from './agent-ir.ts';
import { AgentIrSessionV6, type AgentIrV6Decoded } from './agent-ir-v6.ts';
import { GraphStore } from './store.ts';
import type { Term } from './ast.ts';
import { validString } from '../fabric/encoding.ts';

export const AGENT_IR7_PROFILE = Object.freeze({
  format: 'aether.agent-ir-seeded-cold/7',
  cold: 'canonical AE1 grammar with exact root, checked seed indexes and decimal provenance',
  reference: 'R7 with exact 256-bit base root; AE6 semantics',
  edit: 'E7 with exact 256-bit base and result roots; AE6 semantics',
  maxWireBytes: 32 * 1024 * 1024,
  maxSeedBytes: 256,
  maxGeneratedSymbols: 4096,
});

const ROOT_MAX = 1n << 256n;
const PROVENANCE = /^prov:b3:([0-9a-f]{64})$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const INDEX = /^(0|[1-9][0-9]{0,3})$/;
type Module = Extract<Term, { kind: 'Module' }>;

function rootDecimal(root: string): string {
  if (!/^ast:b3:[0-9a-f]{64}$/.test(root)) throw new TypeError('Agent-IR7 AST root');
  return BigInt(`0x${root.slice(7)}`).toString(10);
}

function seedCheck(seed: string | null): void {
  if (seed === null) return;
  if (typeof seed !== 'string' || Buffer.byteLength(seed) > AGENT_IR7_PROFILE.maxSeedBytes)
    throw new RangeError('Agent-IR7 seed bound');
  validString(seed);
}

/** Replay SymbolSpace.define, including its collision retry rule. */
function generated(seed: string, count: number): SymbolId[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > AGENT_IR7_PROFILE.maxGeneratedSymbols)
    throw new RangeError('Agent-IR7 generated symbol bound');
  const random = rng(seed), seen = new Set<string>(), ids: SymbolId[] = [];
  while (ids.length < count) {
    const id = freshSymbolId(() => random.next());
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function decimalProvenance(value: string): string {
  const match = PROVENANCE.exec(value);
  if (!match) throw new TypeError('Agent-IR7 provenance identity');
  return BigInt(`0x${match[1]}`).toString(10);
}
function hexProvenance(value: string): string {
  if (!DECIMAL.test(value)) throw new SyntaxError('Agent-IR7 noncanonical provenance');
  const n = BigInt(value);
  if (n >= ROOT_MAX) throw new RangeError('Agent-IR7 provenance overflow');
  return `prov:b3:${n.toString(16).padStart(64, '0')}`;
}

function toV7(ae1: string, seed: string | null, root: string): string {
  seedCheck(seed);
  const lines = ae1.split('\n');
  if (lines[0] !== 'AE1') throw new TypeError('Agent-IR7 requires AE1');
  lines[0] = 'AE7';
  lines.splice(1, 0, `§g ${JSON.stringify(seed)}`, `§h ${rootDecimal(root)}`);
  for (let i = 3; i < lines.length && lines[i].startsWith('§'); i++) {
    if (lines[i].startsWith('§p '))
      lines[i] = `§p ${lines[i].slice(3).split('|').map(decimalProvenance).join('|')}`;
    if (seed !== null && lines[i].startsWith('§v ')) {
      const symbols = lines[i].slice(3).split('|');
      const wanted = new Set(symbols), random = rng(seed), seen = new Set<string>();
      const positions = new Map<string, number>();
      for (let n = 0; n < AGENT_IR7_PROFILE.maxGeneratedSymbols && positions.size < wanted.size; n++) {
        let id = freshSymbolId(() => random.next());
        while (seen.has(id)) id = freshSymbolId(() => random.next());
        seen.add(id);
        if (wanted.has(id)) positions.set(id, n);
      }
      if (positions.size !== wanted.size || wanted.size !== symbols.length)
        throw new TypeError('Agent-IR7 seed does not reconstruct every exact symbol identity');
      lines[i] = `§v ${symbols.map(id => positions.get(id)!).join(',')}`;
    }
  }
  return lines.join('\n');
}

function toAe1(wire: string): { ae1: string; seed: string | null; expectedRoot: string } {
  if (typeof wire !== 'string' || Buffer.byteLength(wire) > AGENT_IR7_PROFILE.maxWireBytes)
    throw new RangeError('Agent-IR7 cold wire bound');
  validString(wire);
  const lines = wire.split('\n');
  if (lines[0] !== 'AE7' || !lines[1]?.startsWith('§g ') || !lines[2]?.startsWith('§h '))
    throw new SyntaxError('Agent-IR7 cold header');
  let seed: unknown;
  try { seed = JSON.parse(lines[1].slice(3)); }
  catch { throw new SyntaxError('Agent-IR7 seed syntax'); }
  if (seed !== null && typeof seed !== 'string') throw new SyntaxError('Agent-IR7 seed type');
  seedCheck(seed);
  if (JSON.stringify(seed) !== lines[1].slice(3)) throw new SyntaxError('Agent-IR7 noncanonical seed');
  const rootText = lines[2].slice(3);
  if (!DECIMAL.test(rootText)) throw new SyntaxError('Agent-IR7 noncanonical root');
  const rootNumber = BigInt(rootText);
  if (rootNumber >= ROOT_MAX) throw new RangeError('Agent-IR7 root overflow');
  const expectedRoot = `ast:b3:${rootNumber.toString(16).padStart(64, '0')}`;
  lines[0] = 'AE1';
  lines.splice(1, 2);
  let provenance = 0, symbols = 0;
  for (let i = 1; i < lines.length && lines[i].startsWith('§'); i++) {
    if (lines[i].startsWith('§p ')) {
      if (++provenance > 1) throw new SyntaxError('Agent-IR7 duplicate provenance section');
      lines[i] = `§p ${lines[i].slice(3).split('|').map(hexProvenance).join('|')}`;
    }
    if (lines[i].startsWith('§v ')) {
      if (++symbols > 1) throw new SyntaxError('Agent-IR7 duplicate symbol section');
      if (seed !== null) {
        const indexes = lines[i].slice(3).split(',').map(value => {
          if (!INDEX.test(value)) throw new SyntaxError('Agent-IR7 noncanonical symbol index');
          const index = Number(value);
          if (index >= AGENT_IR7_PROFILE.maxGeneratedSymbols) throw new RangeError('Agent-IR7 symbol index bound');
          return index;
        });
        if (new Set(indexes).size !== indexes.length) throw new SyntaxError('Agent-IR7 duplicate symbol index');
        const ids = generated(seed, Math.max(...indexes) + 1);
        lines[i] = `§v ${indexes.map(index => ids[index]).join('|')}`;
      }
    }
  }
  return { ae1: lines.join('\n'), seed, expectedRoot };
}

export function encodeAgentIrColdV7(module: Term, seed: string | null = null): string {
  if (module.kind !== 'Module') throw new TypeError('Agent-IR7 cold root must be a Module');
  return toV7(encode(module, new IrContext()).text, seed, new GraphStore().intern(module));
}

export function decodeAgentIrColdV7(wire: string): { module: Module; root: string; ae1: string; seed: string | null } {
  const { ae1, seed, expectedRoot } = toAe1(wire);
  const term = decode(ae1, new IrContext());
  const actualRoot = new GraphStore().intern(term);
  if (term.kind !== 'Module' || actualRoot !== expectedRoot
    || encode(term, new IrContext()).text !== ae1 || toV7(ae1, seed, actualRoot) !== wire)
    throw new TypeError('Agent-IR7 requires a canonical complete Module');
  return { module: term, root: actualRoot, ae1, seed };
}

/** AE6's checked unchanged/one-literal edit state machine over an AE7 cold wire. */
export class AgentIrSessionV7 {
  readonly #session: AgentIrSessionV6;
  readonly coldRoot: string;
  constructor(coldWire: string) {
    const cold = decodeAgentIrColdV7(coldWire);
    this.#session = new AgentIrSessionV6(cold.ae1);
    this.coldRoot = cold.root;
  }
  encode(memberIndex: number, declaration: Term): string {
    return this.#session.encode(memberIndex, declaration).replace(/^([RE])6:/, (_, kind: string) => `${kind}7:`);
  }
  decode(wire: string): AgentIrV6Decoded {
    if (!/^[RE]7:/.test(wire)) throw new SyntaxError('Agent-IR7 warm prefix');
    return this.#session.decode(wire.replace(/^([RE])7:/, (_, kind: string) => `${kind}6:`));
  }
}
