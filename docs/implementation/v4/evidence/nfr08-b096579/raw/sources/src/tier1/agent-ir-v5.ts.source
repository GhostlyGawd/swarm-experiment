/** Opt-in exact-root warm reference. A receiver must first obtain the full
 * base module through a paid cold message; this wire never creates code from
 * an untrusted short index alone. Changed declarations require a separate
 * base-bound edit protocol and are not encoded by AE5R. */
import type { Term } from './ast.ts';
import { GraphStore } from './store.ts';
import { decodeAgentIrBinary, encodeAgentIrBinary } from './agent-ir-v2.ts';
import { validString } from '../fabric/encoding.ts';

export const AGENT_IR5_REFERENCE_PROFILE = Object.freeze({ format: 'aether.agent-ir-warm-reference/1',
  wire: 'AE5R:<full 256-bit base root in canonical base64url>:<decimal module-member index>',
  base: 'an exact cold module already decoded and retained in the same receiver context',
  allowed: 'unchanged FunctionDecl member only', maxMembers: 4096 });

function detached<T extends Term>(term: T): T {
  return decodeAgentIrBinary(encodeAgentIrBinary(term)) as T;
}
function rootToken(root: string): string {
  if (!/^ast:b3:[0-9a-f]{64}$/.test(root)) throw new TypeError('AE5 base root identity');
  return Buffer.from(root.slice(7), 'hex').toString('base64url');
}
export class AgentIrWarmReferenceV5 {
  readonly #base: Extract<Term, { kind: 'Module' }>;
  readonly #root: string;
  readonly #token: string;

  constructor(base: Term) {
    const copied = detached(base);
    if (copied.kind !== 'Module' || copied.members.length > AGENT_IR5_REFERENCE_PROFILE.maxMembers)
      throw new TypeError('AE5 requires a bounded cold module');
    this.#base = copied;
    this.#root = new GraphStore().intern(copied);
    this.#token = rootToken(this.#root);
  }
  get baseRoot(): string { return this.#root; }

  encode(memberIndex: number, declaration: Term): string {
    if (!Number.isSafeInteger(memberIndex) || memberIndex < 0 || memberIndex >= this.#base.members.length)
      throw new RangeError('AE5 member index');
    const original = this.#base.members[memberIndex];
    if (original.kind !== 'FunctionDecl' || declaration.kind !== 'FunctionDecl'
      || new GraphStore().intern(detached(declaration)) !== new GraphStore().intern(original))
      throw new TypeError('AE5 reference cannot encode a changed or nonfunction declaration');
    return `AE5R:${this.#token}:${memberIndex}`;
  }

  decode(wire: string): Extract<Term, { kind: 'FunctionDecl' }> {
    if (typeof wire !== 'string' || Buffer.byteLength(wire) > 80) throw new RangeError('AE5 reference wire bound');
    validString(wire);
    const match = /^AE5R:([A-Za-z0-9_-]{43}):(0|[1-9][0-9]*)$/.exec(wire);
    if (!match || match[1] !== this.#token || rootToken(this.#root) !== match[1])
      throw new SyntaxError('AE5 reference base mismatch or malformed wire');
    const index = Number(match[2]);
    if (!Number.isSafeInteger(index) || index >= this.#base.members.length)
      throw new RangeError('AE5 reference index');
    const member = this.#base.members[index];
    if (member.kind !== 'FunctionDecl') throw new TypeError('AE5 reference does not name a function');
    return detached(member) as Extract<Term, { kind: 'FunctionDecl' }>;
  }
}
