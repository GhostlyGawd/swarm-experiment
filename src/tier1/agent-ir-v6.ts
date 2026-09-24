/** Cold-bound Agent-IR model exchange. The complete AE1 module is paid once;
 * R6 refers to an unchanged declaration and E6 carries one literal edit.
 * Every warm wire includes the full 256-bit cold root, encoded as canonical
 * decimal because both supported BPE vocabularies tokenize it more cheaply
 * than base64url on the declared ledger workload. No short session handle is
 * treated as a content identity. */
import { isDeepStrictEqual } from 'node:util';
import { children, scalarPayload, withChildren, type Term } from './ast.ts';
import { GraphStore } from './store.ts';
import { decode, encode, IrContext } from './agent-ir.ts';
import { decodeAgentIrBinary, encodeAgentIrBinary } from './agent-ir-v2.ts';
import { validString } from '../fabric/encoding.ts';

export const AGENT_IR6_PROFILE = Object.freeze({
  format: 'aether.agent-ir-cold-bound/6',
  cold: 'canonical complete AE1 Module',
  reference: 'R6:<full 256-bit cold root in canonical decimal>:<member index>',
  edit: 'E6:<cold root>:<member index>:<result declaration root>:<child path>:<integer literal>',
  editScope: 'one integer literal in a FunctionDecl body; all other fields are retained',
  maxMembers: 4096, maxWireBytes: 8192,
});

type Module = Extract<Term, { kind: 'Module' }>;
type FunctionDecl = Extract<Term, { kind: 'FunctionDecl' }>;
const ROOT_MAX = 1n << 256n;
const root = (term: Term): string => new GraphStore().intern(term);
const detach = <T extends Term>(term: T): T => decodeAgentIrBinary(encodeAgentIrBinary(term)) as T;
function decimalRoot(value: string): string {
  if (!/^ast:b3:[0-9a-f]{64}$/.test(value)) throw new TypeError('Agent-IR6 AST root');
  return BigInt(`0x${value.slice(7)}`).toString(10);
}
function parseDecimalRoot(value: string): string {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new SyntaxError('Agent-IR6 noncanonical root');
  const n = BigInt(value);
  if (n >= ROOT_MAX) throw new RangeError('Agent-IR6 root overflow');
  return `ast:b3:${n.toString(16).padStart(64, '0')}`;
}
function parseIndex(value: string, bound: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new SyntaxError('Agent-IR6 noncanonical index');
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index >= bound) throw new RangeError('Agent-IR6 member index');
  return index;
}
function candidatePath(base: FunctionDecl, candidate: FunctionDecl): number[] {
  if (!base.body || !candidate.body || !isDeepStrictEqual({ ...base, body: null }, { ...candidate, body: null }))
    throw new TypeError('Agent-IR6 edit must preserve declaration metadata and contracts');
  const store = new GraphStore();
  function visit(before: Term, after: Term, path: number[]): number[] {
    if (before.kind !== after.kind) throw new TypeError('Agent-IR6 edit changes AST shape');
    if (before.kind === 'Lit' && after.kind === 'Lit'
      && typeof before.value === 'bigint' && typeof after.value === 'bigint'
      && isDeepStrictEqual(before.ty, after.ty) && before.value !== after.value) return path;
    if (!isDeepStrictEqual(scalarPayload(before), scalarPayload(after)))
      throw new TypeError('Agent-IR6 edit changes nonliteral payload');
    const left = children(before), right = children(after);
    if (left.length !== right.length) throw new TypeError('Agent-IR6 edit changes AST shape');
    const changed: number[] = [];
    for (let i = 0; i < left.length; i++) if (store.intern(left[i]) !== store.intern(right[i])) changed.push(i);
    if (changed.length !== 1) throw new TypeError('Agent-IR6 edit requires exactly one changed literal');
    return visit(left[changed[0]], right[changed[0]], [...path, changed[0]]);
  }
  return visit(base.body, candidate.body, []);
}
function replaceLiteral(node: Term, path: readonly number[], value: bigint): Term {
  if (!path.length) {
    if (node.kind !== 'Lit' || typeof node.value !== 'bigint' || node.value === value)
      throw new TypeError('Agent-IR6 edit requires a changed integer literal');
    return { ...node, value };
  }
  const [index, ...tail] = path, next = [...children(node)];
  if (!Number.isSafeInteger(index) || index < 0 || index >= next.length) throw new RangeError('Agent-IR6 child path');
  next[index] = replaceLiteral(next[index], tail, value);
  return withChildren(node, next);
}

export interface AgentIrV6Decoded {
  readonly memberIndex: number;
  readonly declaration: FunctionDecl;
  readonly module: Module;
  readonly baseRoot: string;
  readonly declarationRoot: string;
  readonly moduleRoot: string;
}

export class AgentIrSessionV6 {
  readonly #base: Module;
  readonly #root: string;
  readonly #decimal: string;

  constructor(coldWire: string) {
    if (typeof coldWire !== 'string' || Buffer.byteLength(coldWire) > 32 * 1024 * 1024)
      throw new RangeError('Agent-IR6 cold wire bound');
    const decoded = decode(coldWire, new IrContext());
    if (decoded.kind !== 'Module' || decoded.members.length > AGENT_IR6_PROFILE.maxMembers
      || encode(decoded, new IrContext()).text !== coldWire)
      throw new TypeError('Agent-IR6 requires a canonical paid cold module');
    this.#base = detach(decoded);
    this.#root = root(this.#base);
    this.#decimal = decimalRoot(this.#root);
  }
  get baseRoot(): string { return this.#root; }

  encode(memberIndex: number, declaration: Term): string {
    if (!Number.isSafeInteger(memberIndex) || memberIndex < 0 || memberIndex >= this.#base.members.length)
      throw new RangeError('Agent-IR6 member index');
    const original = this.#base.members[memberIndex];
    if (original.kind !== 'FunctionDecl' || declaration.kind !== 'FunctionDecl')
      throw new TypeError('Agent-IR6 requires a function member');
    const candidate = detach(declaration), candidateRoot = root(candidate);
    if (candidateRoot === root(original)) return `R6:${this.#decimal}:${memberIndex}`;
    const path = candidatePath(original, candidate);
    if (!path.length) throw new TypeError('Agent-IR6 body root literal edit is not supported');
    let changed: Term = candidate.body!;
    for (const index of path) changed = children(changed)[index];
    if (changed.kind !== 'Lit' || typeof changed.value !== 'bigint') throw new TypeError('Agent-IR6 integer literal');
    const wire = `E6:${this.#decimal}:${memberIndex}:${decimalRoot(candidateRoot)}:${path.map(n => n.toString(36)).join('.')}:${changed.value}`;
    if (Buffer.byteLength(wire) > AGENT_IR6_PROFILE.maxWireBytes) throw new RangeError('Agent-IR6 edit wire bound');
    return wire;
  }

  decode(wire: string): AgentIrV6Decoded {
    if (typeof wire !== 'string' || Buffer.byteLength(wire) > AGENT_IR6_PROFILE.maxWireBytes)
      throw new RangeError('Agent-IR6 warm wire bound');
    validString(wire);
    const parts = wire.split(':');
    if ((parts[0] !== 'R6' || parts.length !== 3) && (parts[0] !== 'E6' || parts.length !== 6))
      throw new SyntaxError('Agent-IR6 malformed wire');
    if (parseDecimalRoot(parts[1]) !== this.#root) throw new SyntaxError('Agent-IR6 stale base root');
    const memberIndex = parseIndex(parts[2], this.#base.members.length), original = this.#base.members[memberIndex];
    if (original.kind !== 'FunctionDecl') throw new TypeError('Agent-IR6 reference is not a function');
    let candidate: FunctionDecl = original;
    if (parts[0] === 'E6') {
      const expected = parseDecimalRoot(parts[3]);
      if (!/^(0|[1-9a-z][0-9a-z]*)(?:\.(?:0|[1-9a-z][0-9a-z]*))*$/.test(parts[4]) || parts[4].length > 384)
        throw new SyntaxError('Agent-IR6 noncanonical child path');
      if (!/^(0|-?[1-9][0-9]*)$/.test(parts[5]) || parts[5].replace('-', '').length > 4096)
        throw new SyntaxError('Agent-IR6 noncanonical integer literal');
      const path = parts[4].split('.').map(part => parseInt(part, 36));
      if (path.length > 64 || !original.body) throw new RangeError('Agent-IR6 child path bound');
      candidate = { ...original, body: replaceLiteral(original.body, path, BigInt(parts[5])) };
      if (root(candidate) !== expected) throw new SyntaxError('Agent-IR6 edited declaration root mismatch');
      if (this.encode(memberIndex, candidate) !== wire) throw new SyntaxError('Agent-IR6 noncanonical edit');
    } else if (this.encode(memberIndex, candidate) !== wire) throw new SyntaxError('Agent-IR6 noncanonical reference');
    const module = detach({ ...this.#base, members: this.#base.members.map((member, index) => index === memberIndex ? candidate : member) });
    return { memberIndex, declaration: detach(candidate), module, baseRoot: this.#root,
      declarationRoot: root(candidate), moduleRoot: root(module) };
  }
}
