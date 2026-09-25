/**
 * A bounded, exact-source descriptor for one semantic-GC tail forwarder.
 *
 * This module only checks an AST rewrite and derives its reference-runtime
 * event order. It does not authorize promotion, prove a general equivalence,
 * or change a Runtime. A consumer must bind the returned Call object identities
 * from the *candidate it loaded* before applying any virtual-frame behavior.
 */
import { types as nodeTypes } from 'node:util';
import { encodeCanonical, exactObject, validString } from '../fabric/encoding.ts';
import { domainDigest, type Digest } from '../fabric/identity.ts';
import { children, linkGroups, withLinkGroups, type Term } from './ast.ts';
import { canonicalBytes, type Canonical } from './canonical.ts';
import { isNodeRef, type NodeRef, type SymbolId } from './ids.ts';
import { GraphStore, type Step } from './store.ts';

type Module = Extract<Term, { kind: 'Module' }>;
type FunctionDecl = Extract<Term, { kind: 'FunctionDecl' }>;
type Call = Extract<Term, { kind: 'Call' }>;

export const VIRTUAL_FORWARD_DESCRIPTOR_FORMAT = 'aether.gc-virtual-forward-descriptor/1';
const LIMITS = { maxFrameBytes: 4 * 1024 * 1024, maxDecompressedBytes: 4 * 1024 * 1024,
  maxObjects: 40_000, maxDepth: 128 } as const;
const MAX_AST_NODES = 10_000;
const MAX_SITES = 1_000;

/** Successful-path events after the original caller's Call and arguments have
 * been evaluated. A fault at any tick suppresses every later event. */
export const VIRTUAL_FORWARD_EVENT_SCRIPT = [
  'call:wrapper', 'tick:Block', 'tick:Return', 'tick:Call', 'tick:Var',
  'call:target', 'return:target', 'return:wrapper',
] as const;

export interface VirtualForwardSite {
  readonly caller: SymbolId;
  readonly sourcePath: readonly Step[];
  readonly candidatePath: readonly Step[];
  readonly sourceCall: NodeRef;
  readonly candidateCall: NodeRef;
}

export interface VirtualForwardDescriptor {
  readonly format: typeof VIRTUAL_FORWARD_DESCRIPTOR_FORMAT;
  readonly sourceRoot: NodeRef;
  readonly candidateRoot: NodeRef;
  readonly wrapper: SymbolId;
  readonly target: SymbolId;
  readonly wrapperDeclaration: NodeRef;
  readonly targetDeclaration: NodeRef;
  readonly eventScript: readonly (typeof VIRTUAL_FORWARD_EVENT_SCRIPT)[number][];
  readonly sites: readonly VirtualForwardSite[];
  readonly id: Digest;
}

export interface VirtualForwardBinding {
  readonly caller: SymbolId;
  /** The exact Call object in the candidate Module passed to the checker. */
  readonly candidateCall: Call;
  readonly wrapper: FunctionDecl;
  readonly target: SymbolId;
  readonly sourcePath: readonly Step[];
  readonly candidatePath: readonly Step[];
}

function equal(a: unknown, b: unknown): boolean {
  return Buffer.compare(encodeCanonical(a, LIMITS), encodeCanonical(b, LIMITS)) === 0;
}

function sameType(a: unknown, b: unknown): boolean { return equal(a, b); }

function emptyContract(term: Term | null): boolean {
  return term?.kind === 'Contract' && term.requires.length === 0
    && term.ensures.length === 0 && term.modifies.length === 0;
}

function closedScalarDeclaration(decl: FunctionDecl): boolean {
  return decl.purity === 'pure' && decl.capabilities.length === 0
    && decl.typeParams.length === 0 && decl.surfaces.length === 0
    && decl.params.length === 1 && ['Int', 'Bool'].includes(decl.params[0].ty.t)
    && ['Int', 'Bool'].includes(decl.returns.t) && emptyContract(decl.contract)
    && decl.body !== null;
}

function sourceDeclarations(source: Module): Map<SymbolId, FunctionDecl> {
  if (source.symbolTable.kind !== 'SymbolTable') throw new Error('virtual forwarder requires a closed symbol table');
  const functions = new Map<SymbolId, FunctionDecl>();
  for (const member of source.members) {
    if (member.kind === 'Import') throw new Error('virtual forwarder cannot resolve imports');
    if (member.kind !== 'FunctionDecl') continue;
    if (functions.has(member.symbol)) throw new Error('duplicate function declaration');
    functions.set(member.symbol, member);
  }
  return functions;
}

function assertForwarder(wrapper: FunctionDecl, target: FunctionDecl): void {
  if (wrapper.symbol === target.symbol || !closedScalarDeclaration(wrapper)
    || !closedScalarDeclaration(target)
    || !sameType(wrapper.params[0].ty, target.params[0].ty)
    || !sameType(wrapper.returns, target.returns))
    throw new Error('unsupported virtual forwarder signature or contract');
  const body = wrapper.body;
  if (body?.kind !== 'Block' || body.stmts.length !== 1
    || body.stmts[0].kind !== 'Return'
    || body.stmts[0].value.kind !== 'Call'
    || body.stmts[0].value.callee !== target.symbol
    || body.stmts[0].value.args.length !== 1
    || body.stmts[0].value.args[0].kind !== 'Var'
    || body.stmts[0].value.args[0].symbol !== wrapper.params[0].symbol)
    throw new Error('wrapper is not an exact one-argument tail forwarder');
}

function preflight(module: Module, rejectSharedCalls: boolean): void {
  // Tier-1 AST literals contain bigint, which wire JSON deliberately rejects.
  // Validate the object graph before using the AST's own bigint-aware encoder.
  let objects = 0;
  const active = new Set<object>();
  const validate = (value: unknown, depth: number): void => {
    if (depth > LIMITS.maxDepth || ++objects > LIMITS.maxObjects)
      throw new RangeError('virtual forwarder canonical depth/object bound exceeded');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      validString(value);
      if (Buffer.byteLength(value) > LIMITS.maxFrameBytes) throw new RangeError('AST string bound exceeded');
      return;
    }
    if (typeof value === 'bigint') {
      if (value.toString().length > 4096) throw new RangeError('AST integer bound exceeded');
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('unsafe AST number');
      return;
    }
    if (typeof value !== 'object' || nodeTypes.isProxy(value) || active.has(value))
      throw new TypeError('noncanonical or cyclic AST value');
    active.add(value);
    if (Array.isArray(value)) {
      if (value.length > LIMITS.maxObjects || Object.keys(value).length !== value.length
        || Reflect.ownKeys(value).length !== value.length + 1)
        throw new TypeError('invalid AST array');
      for (let index = 0; index < value.length; index++) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (!item || !('value' in item)) throw new TypeError('AST array accessor or hole');
        validate(item.value, depth + 1);
      }
    } else {
      const keys = Object.keys(value);
      exactObject(value, keys);
      for (const key of keys) { validString(key); validate((value as Record<string, unknown>)[key], depth + 1); }
    }
    active.delete(value);
  };
  validate(module, 0);
  if (canonicalBytes(module as Canonical).byteLength > LIMITS.maxFrameBytes)
    throw new RangeError('virtual forwarder AST byte bound exceeded');
  let count = 0;
  const pending: Term[] = [module];
  const seenCalls = new Set<Call>();
  while (pending.length) {
    const term = pending.pop()!;
    if (++count > MAX_AST_NODES) throw new RangeError('virtual forwarder AST bound exceeded');
    if (term.kind === 'Call' && rejectSharedCalls) {
      // Runtime dispatch uses the candidate Call object as a site key. If the
      // same object occurs twice, its identity cannot distinguish the paths.
      if (seenCalls.has(term)) throw new Error('candidate shares a Call object across sites');
      seenCalls.add(term);
    }
    if (['Lambda', 'Apply', 'SeqMap', 'SeqFold', 'Spawn', 'Await'].includes(term.kind))
      throw new Error('virtual forwarder cannot close dynamic or concurrent calls');
    pending.push(...children(term));
  }
}

function resolveTerm(root: Term, path: readonly Step[]): Term {
  let node = root;
  for (const step of path) {
    const group = linkGroups(node).find(item => item.field === step.field);
    const next = group?.links[step.index];
    if (!next) throw new Error('virtual forwarder site path is invalid');
    node = next;
  }
  return node;
}

function derive(source: Module, candidate: Module, wrapperId: SymbolId, targetId: SymbolId):
  { descriptor: VirtualForwardDescriptor; bindings: readonly VirtualForwardBinding[] } {
  preflight(source, false);
  preflight(candidate, true);
  const declarations = sourceDeclarations(source);
  const wrapper = declarations.get(wrapperId), target = declarations.get(targetId);
  if (!wrapper || !target) throw new Error('virtual forwarder declaration missing');
  assertForwarder(wrapper, target);
  const sourceStore = new GraphStore();
  const sourceRoot = sourceStore.intern(source);
  const candidateRoot = new GraphStore().intern(candidate);
  const sites: VirtualForwardSite[] = [];
  const bindings: VirtualForwardBinding[] = [];

  const rewrite = (term: Term, caller: SymbolId, sourcePath: readonly Step[],
    candidatePath: readonly Step[], inBody: boolean): Term => {
    if (term.kind === 'Call' && term.callee === wrapperId && !inBody)
      throw new Error('wrapper call in annotation is unsupported');
    if ((term.kind === 'SeqMap' || term.kind === 'SeqFold') && term.callee === wrapperId)
      throw new Error('dynamic wrapper reference is unsupported');
    const groups = new Map(linkGroups(term).map(group => [group.field,
      group.links.map((child, index) => rewrite(child, caller,
        [...sourcePath, { field: group.field, index }],
        [...candidatePath, { field: group.field, index }], inBody))]));
    const copied = withLinkGroups(term, groups);
    if (copied.kind !== 'Call' || copied.callee !== wrapperId) return copied;
    if (!inBody) throw new Error('wrapper call outside a function body');
    if (sites.length >= MAX_SITES) throw new RangeError('virtual forwarder site bound exceeded');
    const changed: Call = { ...copied, callee: targetId };
    const candidateNode = resolveTerm(candidate, candidatePath);
    if (candidateNode.kind !== 'Call' || candidateNode.callee !== targetId)
      throw new Error('candidate call site does not match the source rewrite');
    sites.push({ caller, sourcePath, candidatePath,
      sourceCall: sourceStore.intern(term), candidateCall: new GraphStore().intern(changed) });
    bindings.push({ caller, candidateCall: candidateNode, wrapper, target: targetId,
      sourcePath, candidatePath });
    return changed;
  };

  const candidateMembers: Term[] = [];
  for (let sourceIndex = 0; sourceIndex < source.members.length; sourceIndex++) {
    const member = source.members[sourceIndex];
    if (member.kind === 'FunctionDecl' && member.symbol === wrapperId) continue;
    const candidateIndex = candidateMembers.length;
    if (member.kind !== 'FunctionDecl') {
      candidateMembers.push(member);
      continue;
    }
    for (const pending of [member.contract ? [member.contract] : [], [...member.surfaces]]) {
      while (pending.length) {
        const node = pending.pop()!;
        if (node.kind === 'Call' && node.callee === wrapperId)
          throw new Error('wrapper call in annotation is unsupported');
        pending.push(...children(node));
      }
    }
    const rewrittenBody = member.body === null ? null : rewrite(member.body, member.symbol,
      [{ field: 'members', index: sourceIndex }, { field: 'body', index: 0 }],
      [{ field: 'members', index: candidateIndex }, { field: 'body', index: 0 }], true);
    candidateMembers.push({ ...member, body: rewrittenBody });
  }
  if (!sites.length) throw new Error('virtual forwarder has no rewritten call sites');
  const expectedCandidate: Module = { ...source, members: candidateMembers };
  if (new GraphStore().intern(expectedCandidate) !== candidateRoot)
    throw new Error('candidate is not the exact one-wrapper rewrite');
  sites.sort((a, b) => JSON.stringify(a.sourcePath).localeCompare(JSON.stringify(b.sourcePath)));
  bindings.sort((a, b) => JSON.stringify(a.sourcePath).localeCompare(JSON.stringify(b.sourcePath)));
  const body = { format: VIRTUAL_FORWARD_DESCRIPTOR_FORMAT as typeof VIRTUAL_FORWARD_DESCRIPTOR_FORMAT, sourceRoot, candidateRoot,
    wrapper: wrapperId, target: targetId, wrapperDeclaration: sourceStore.intern(wrapper),
    targetDeclaration: sourceStore.intern(target), eventScript: [...VIRTUAL_FORWARD_EVENT_SCRIPT],
    sites };
  const descriptor: VirtualForwardDescriptor = { ...body,
    id: domainDigest(VIRTUAL_FORWARD_DESCRIPTOR_FORMAT, body, LIMITS) };
  return { descriptor, bindings };
}

/** Create a descriptor from the two exact AST roots, without caller-supplied
 * fuel or trace claims. This does not itself authorize the candidate. */
export function deriveVirtualForwardDescriptor(source: Module, candidate: Module,
  wrapper: SymbolId, target: SymbolId): VirtualForwardDescriptor {
  return derive(source, candidate, wrapper, target).descriptor;
}

/** Construct the exact one-wrapper candidate before a separate consumer
 * rechecks it. This does not authorize publication or production execution. */
export function buildVirtualForwardCandidate(source: Module, wrapper: SymbolId,
  target: SymbolId): { readonly candidate: Module; readonly descriptor: VirtualForwardDescriptor } {
  preflight(source, false);
  const snapshot = structuredClone(source);
  const redirect = (term: Term): Term => {
    const groups = new Map(linkGroups(term).map(group =>
      [group.field, group.links.map(redirect)]));
    const copied = withLinkGroups(term, groups);
    return copied.kind === 'Call' && copied.callee === wrapper
      ? { ...copied, callee: target } : copied;
  };
  const candidate: Module = { ...snapshot, members: snapshot.members
    .filter(member => member.kind !== 'FunctionDecl' || member.symbol !== wrapper)
    .map(member => member.kind === 'FunctionDecl'
      ? { ...member, body: member.body === null ? null : redirect(member.body) }
      : member) };
  return { candidate, descriptor: derive(snapshot, candidate, wrapper, target).descriptor };
}

/** Recompute the rewrite, roots, site paths, event script and digest from both
 * ASTs. The returned bindings point into `candidate`, not an internal copy. */
export function checkVirtualForwardDescriptor(value: unknown, source: Module,
  candidate: Module): readonly VirtualForwardBinding[] {
  encodeCanonical(value, LIMITS);
  if (value === null || typeof value !== 'object') throw new TypeError('invalid virtual forwarder descriptor');
  const claimed = value as Partial<VirtualForwardDescriptor>;
  if (claimed.format !== VIRTUAL_FORWARD_DESCRIPTOR_FORMAT
    || typeof claimed.wrapper !== 'string' || typeof claimed.target !== 'string'
    || !isNodeRef(claimed.sourceRoot) || !isNodeRef(claimed.candidateRoot))
    throw new TypeError('invalid virtual forwarder version or roots');
  const expected = derive(source, candidate, claimed.wrapper, claimed.target);
  if (!equal(value, expected.descriptor))
    throw new Error('virtual forwarder descriptor differs from exact AST derivation');
  return expected.bindings;
}
