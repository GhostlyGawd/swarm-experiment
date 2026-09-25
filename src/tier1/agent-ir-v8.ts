/** Receiver-side exact graph slice over a paid AE7 module load. */
import { walk, type Term } from './ast.ts';
import { GraphStore } from './store.ts';
import { decode, encode, IrContext } from './agent-ir.ts';
import { AgentIrSessionV7, decodeAgentIrColdV7 } from './agent-ir-v7.ts';
import { validString } from '../fabric/encoding.ts';
import type { NodeRef } from './ids.ts';

export const AGENT_IR8_PROFILE = Object.freeze({
  format: 'aether.agent-ir-receiver-graph-slice/8',
  load: 'complete root-bound AE7 module paid once and interned at receiver',
  selection: 'S8:<exact base root>:<member index>',
  retrieval: 'D8 header binds member, contract and dependency roots; AE1 declaration uses paid dictionary',
  edit: 'R8/E8 exact AE7 reference and one-literal edit after validated retrieval',
  maxWireBytes: 32 * 1024 * 1024,
});

type Module = Extract<Term, { kind: 'Module' }>;
type FunctionDecl = Extract<Term, { kind: 'FunctionDecl' }>;
const ROOT_MAX = 1n << 256n;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
function decimal(root: string): string {
  if (!/^ast:b3:[0-9a-f]{64}$/.test(root)) throw new TypeError('Agent-IR8 AST root');
  return BigInt(`0x${root.slice(7)}`).toString(10);
}
function parseRoot(value: string): string {
  if (!DECIMAL.test(value)) throw new SyntaxError('Agent-IR8 noncanonical root');
  const n = BigInt(value);
  if (n >= ROOT_MAX) throw new RangeError('Agent-IR8 root overflow');
  return `ast:b3:${n.toString(16).padStart(64, '0')}`;
}
function parseIndex(value: string, bound: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new SyntaxError('Agent-IR8 noncanonical member index');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n >= bound) throw new RangeError('Agent-IR8 member index');
  return n;
}

export interface AgentIrV8Slice {
  readonly memberIndex: number;
  readonly declaration: FunctionDecl;
  readonly baseRoot: string;
  readonly declarationRoot: string;
  readonly contractRoot: string | null;
  readonly dependencies: ReadonlyArray<{ readonly memberIndex: number | null; readonly root: string }>;
  readonly effects: readonly string[];
}

/** No caller assertion is accepted: all commitments come from the stored AST. */
export class AgentIrGraphSliceSessionV8 {
  readonly #store = new GraphStore();
  readonly #module: Module;
  readonly #baseRoot: NodeRef;
  readonly #warm: AgentIrSessionV7;
  readonly #senderDictionary = new IrContext();
  readonly #receiverDictionary = new IrContext();
  #selected: number | null = null;

  constructor(coldWire: string) {
    const cold = decodeAgentIrColdV7(coldWire);
    this.#module = cold.module;
    this.#baseRoot = cold.root as NodeRef;
    if (this.#store.intern(cold.module) !== this.#baseRoot) throw new Error('Agent-IR8 graph load root');
    this.#warm = new AgentIrSessionV7(coldWire);
    encode(cold.module, this.#senderDictionary);
    decode(cold.ae1, this.#receiverDictionary);
  }
  get baseRoot(): string { return this.#baseRoot; }

  /** Load an exact imported module before selecting a caller that needs it. */
  loadDependency(coldWire: string): string {
    const cold = decodeAgentIrColdV7(coldWire);
    return this.#store.intern(cold.module);
  }

  #storedModule(): Module {
    const module = this.#store.hydrate(this.#baseRoot);
    if (module.kind !== 'Module' || this.#store.intern(module) !== this.#baseRoot)
      throw new TypeError('Agent-IR8 missing or stale module graph');
    return module;
  }

  #closure(index: number): AgentIrV8Slice {
    const module = this.#storedModule();
    const member = module.members[index];
    if (member?.kind !== 'FunctionDecl') throw new TypeError('Agent-IR8 selected member is not a function');
    const bySymbol = new Map(module.members.flatMap((term, i) =>
      term.kind === 'FunctionDecl' ? [[term.symbol, i] as const] : []));
    const imported = new Map(module.members.flatMap(term =>
      term.kind === 'Import' ? term.symbols.map(symbol => [symbol, term.module] as const) : []));
    const visited = new Set<number>([index]);
    const dependencies = new Map<string, { memberIndex: number | null; root: string }>();
    const effects = new Set<string>();
    const scan = (declaration: FunctionDecl) => {
      for (const node of walk(declaration)) {
        if (node.kind === 'Invoke') {
          effects.add(node.capability);
        }
        const callee = node.kind === 'Call' || node.kind === 'SeqMap' || node.kind === 'SeqFold'
          ? node.callee : null;
        if (!callee) continue;
        const localIndex = bySymbol.get(callee);
        if (localIndex !== undefined) {
          if (visited.has(localIndex)) continue;
          const local = module.members[localIndex];
          if (local.kind !== 'FunctionDecl') throw new TypeError('Agent-IR8 local dependency kind');
          const dependencyRoot = this.#store.intern(local);
          dependencies.set(`${localIndex}`, { memberIndex: localIndex, root: dependencyRoot });
          visited.add(localIndex);
          scan(local);
          continue;
        }
        const importRoot = imported.get(callee);
        if (!importRoot || !this.#store.has(importRoot))
          throw new ReferenceError('Agent-IR8 missing imported dependency root');
        const importedModule = this.#store.hydrate(importRoot);
        if (importedModule.kind !== 'Module' || this.#store.intern(importedModule) !== importRoot)
          throw new TypeError('Agent-IR8 stale imported dependency root');
        dependencies.set(`i:${importRoot}`, { memberIndex: null, root: importRoot });
      }
    };
    scan(member);
    return {
      memberIndex: index, declaration: member, baseRoot: this.#baseRoot,
      declarationRoot: this.#store.intern(member),
      contractRoot: member.contract ? this.#store.intern(member.contract) : null,
      dependencies: [...dependencies.values()].sort((a, b) =>
        (a.memberIndex ?? Number.MAX_SAFE_INTEGER) - (b.memberIndex ?? Number.MAX_SAFE_INTEGER)
        || a.root.localeCompare(b.root)),
      effects: [...effects].sort(),
    };
  }

  select(memberIndex: number): string {
    this.#storedModule();
    if (!Number.isSafeInteger(memberIndex) || memberIndex < 0 || memberIndex >= this.#module.members.length)
      throw new RangeError('Agent-IR8 member index');
    this.#closure(memberIndex);
    return `S8:${decimal(this.#baseRoot)}:${memberIndex}`;
  }
  #parseSelection(wire: string): number {
    if (typeof wire !== 'string' || Buffer.byteLength(wire) > 256) throw new RangeError('Agent-IR8 selection bound');
    const fields = wire.split(':');
    if (fields.length !== 3 || fields[0] !== 'S8') throw new SyntaxError('Agent-IR8 selection syntax');
    if (parseRoot(fields[1]) !== this.#baseRoot) throw new SyntaxError('Agent-IR8 stale base root');
    const index = parseIndex(fields[2], this.#module.members.length);
    if (this.select(index) !== wire) throw new SyntaxError('Agent-IR8 noncanonical selection');
    return index;
  }

  /** The slice includes exact declaration bytes and commitments; no short alias is authoritative. */
  retrieve(selectionWire: string): string {
    const index = this.#parseSelection(selectionWire), slice = this.#closure(index);
    const body = encode(slice.declaration, this.#senderDictionary).text;
    const deps = slice.dependencies.map(dep => `${dep.memberIndex === null ? 'i' : dep.memberIndex}@${decimal(dep.root)}`).join(',');
    const header = `D8;${decimal(slice.baseRoot)};${index};${decimal(slice.declarationRoot)};`
      + `${slice.contractRoot ? decimal(slice.contractRoot) : '-'};${deps};${slice.effects.join(',')}`;
    const wire = `${header}\n${body}`;
    if (Buffer.byteLength(wire) > AGENT_IR8_PROFILE.maxWireBytes) throw new RangeError('Agent-IR8 retrieval bound');
    this.#selected = index;
    return wire;
  }

  acceptRetrieval(wire: string): AgentIrV8Slice {
    if (typeof wire !== 'string' || Buffer.byteLength(wire) > AGENT_IR8_PROFILE.maxWireBytes)
      throw new RangeError('Agent-IR8 retrieval bound');
    validString(wire);
    const newline = wire.indexOf('\n'), header = wire.slice(0, newline);
    const fields = header.split(';');
    if (newline < 0 || fields.length !== 7 || fields[0] !== 'D8')
      throw new SyntaxError('Agent-IR8 retrieval syntax');
    if (parseRoot(fields[1]) !== this.#baseRoot) throw new SyntaxError('Agent-IR8 stale base root');
    const index = parseIndex(fields[2], this.#module.members.length);
    const slice = this.#closure(index);
    if (parseRoot(fields[3]) !== slice.declarationRoot
      || (fields[4] === '-' ? null : parseRoot(fields[4])) !== slice.contractRoot)
      throw new SyntaxError('Agent-IR8 declaration or contract root mismatch');
    const previousSelection = this.#selected;
    try {
      const expected = this.retrieve(this.select(index));
      if (wire !== expected) throw new SyntaxError('Agent-IR8 dependency/effect/canonical slice mismatch');
      const decoded = decode(wire.slice(newline + 1), this.#receiverDictionary);
      if (this.#store.intern(decoded) !== slice.declarationRoot)
        throw new SyntaxError('Agent-IR8 retrieved declaration root mismatch');
      this.#selected = index;
      return slice;
    } catch (error) {
      this.#selected = previousSelection;
      throw error;
    }
  }

  #selectedClosure(): AgentIrV8Slice {
    if (this.#selected === null) throw new ReferenceError('Agent-IR8 missing selected slice');
    return this.#closure(this.#selected);
  }
  encode(memberIndex: number, declaration: Term): string {
    if (this.#selectedClosure().memberIndex !== memberIndex)
      throw new SyntaxError('Agent-IR8 stale selected slice');
    return this.#warm.encode(memberIndex, declaration).replace(/^([RE])7:/, (_, kind: string) => `${kind}8:`);
  }
  decode(wire: string) {
    const selected = this.#selectedClosure();
    if (typeof wire !== 'string' || !/^[RE]8:/.test(wire)) throw new SyntaxError('Agent-IR8 edit prefix');
    const decoded = this.#warm.decode(wire.replace(/^([RE])8:/, (_, kind: string) => `${kind}7:`));
    if (decoded.memberIndex !== selected.memberIndex || this.#store.intern(selected.declaration) !== selected.declarationRoot
      || (decoded.declaration.contract ? this.#store.intern(decoded.declaration.contract) : null) !== selected.contractRoot)
      throw new SyntaxError('Agent-IR8 stale slice or contract root');
    return decoded;
  }
}
