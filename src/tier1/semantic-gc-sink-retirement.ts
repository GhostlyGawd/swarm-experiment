/** Pure V2 retirement proposal and independent verifier for attested sink
 * registrations. The witnessed ProcessDeployment decision, not this module,
 * chooses the live table. No adapter is loaded, unloaded or dispatched here. */
import type { KeyObject } from 'node:crypto';
import { decodeCanonical, encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateExecutionManifest,
  type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { typecheck } from '../tier2/typecheck.ts';
import { assertDeclarativeSinkTablePolicyV2, declarativeSinkTableDigestV2,
  type DeclarativeSinkTableV2 } from '../tier2/declarative-sink-table.ts';
import { effectResourcePolicyDigestV7, type SignedEffectResourcePolicyV7 } from '../tier2/effect-resource-policy.ts';
import { generatePortableCertificate } from '../tier2/portable-proof-producer.ts';
import { checkPortableCertificate, type PortableCertificateV1 } from '../tier2/portable-proof-checker.ts';
import { children, type Term } from './ast.ts';
import * as b from './build.ts';
import type { DurableGraphStore } from './durable-store.ts';
import { capability, type CapabilityName, type NodeRef, type SymbolId } from './ids.ts';
import type { SemanticGcPolicy, SemanticRetention, SemanticGarbageCollector } from './semantic-gc.ts';
import { GraphStore } from './store.ts';
import { SymbolSpace } from './symbols.ts';

export interface SinkRetirementSelectionV2 {
  readonly table: DeclarativeSinkTableV2;
  readonly policy: SignedEffectResourcePolicyV7;
  readonly manifest: ExecutionManifestV1;
}
export interface SemanticSinkRetirementContextV2 {
  readonly repositoryId: string;
  readonly store: DurableGraphStore;
  readonly registry: CapabilityRegistry;
  readonly exportPolicy: SemanticGcPolicy;
  readonly retentionLedger: SemanticGarbageCollector;
  /** Historical source and current candidate keys come from operator trust. */
  readonly sourceSignerKey: KeyObject | string;
  readonly candidateSignerKey: KeyObject | string;
  readonly sourcePolicyEpoch: string;
  readonly candidatePolicyEpoch: string;
}
interface RetirementBodyV2 {
  readonly format: 'aether.semantic-sink-retirement/2';
  readonly repositoryId: string;
  readonly exportPolicyDigest: Digest;
  readonly specification: string;
  readonly source: SinkRetirementSelectionV2;
  readonly candidate: SinkRetirementSelectionV2;
  readonly retained: readonly SemanticRetention[];
  readonly reachable: readonly SymbolId[];
  readonly usedCapabilities: readonly CapabilityName[];
  readonly removed: readonly string[];
}
export interface SemanticSinkRetirementProposalV2 extends RetirementBodyV2 {
  readonly witness: {
    readonly root: NodeRef;
    readonly specification: string;
    readonly manifest: ExecutionManifestV1;
    readonly certificate: PortableCertificateV1;
  };
  readonly id: Digest;
}
type Decl = Extract<Term, { kind: 'FunctionDecl' }>;
const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 };
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T;
const same = (a: unknown, b: unknown): boolean =>
  Buffer.from(encodeCanonical(a, LIMITS)).equals(Buffer.from(encodeCanonical(b, LIMITS)));
const digest = (domain: string, value: unknown): Digest => domainDigest(domain, value, LIMITS);
function* visit(term: Term): Generator<Term> { yield term; for (const child of children(term)) yield* visit(child); }
function retentionSnapshot(ledger: SemanticGarbageCollector): readonly SemanticRetention[] {
  return clone([...ledger.retentions()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function exportPolicyDigest(context: SemanticSinkRetirementContextV2): Digest {
  identifier(context.repositoryId);
  const policy = exactObject(context.exportPolicy, ['epoch', 'exports', 'protectedSymbols']);
  identifier(policy.epoch);
  if (!Array.isArray(policy.exports) || !policy.exports.length
    || !Array.isArray(policy.protectedSymbols)
    || new Set(policy.exports).size !== policy.exports.length
    || new Set(policy.protectedSymbols).size !== policy.protectedSymbols.length)
    throw new TypeError('complete export/protected symbol policy required');
  [...policy.exports, ...policy.protectedSymbols].forEach(identifier);
  return digest('aether.semantic-sink-export-policy/2', {
    repositoryId: context.repositoryId, policy: context.exportPolicy,
    registry: [...context.registry.names].sort().map(name => context.registry.get(name)),
  });
}
function signedFences(specification: string, repositoryId: string, manifest: ExecutionManifestV1): SymbolId[] {
  if (digest('aether.specification/1', specification) !== manifest.specRoot)
    throw new Error('retirement specification differs from signed manifest');
  const document = exactObject(decodeCanonical(Buffer.from(specification), LIMITS),
    ['format', 'repositoryId', 'specifications']);
  if (document.format !== 'aether.lineage-specification/1'
    || document.repositoryId !== repositoryId || !Array.isArray(document.specifications))
    throw new Error('invalid signed retirement specification');
  return document.specifications.flatMap(item => {
    const spec = exactObject(item, ['id', 'revision', 'text', 'requirements']);
    identifier(spec.id);
    if (!Array.isArray(spec.requirements)) throw new Error('invalid signed fence requirements');
    return spec.requirements.map(requirement => {
      const row = exactObject(requirement, ['symbol', 'signature', 'requires', 'modifies', 'ensures']);
      identifier(row.symbol);
      return row.symbol as SymbolId;
    });
  });
}
function closed(context: SemanticSinkRetirementContextV2, root: NodeRef): Map<SymbolId, Decl> {
  const module = context.store.hydrate(root);
  if (module.kind !== 'Module' || module.symbolTable.kind !== 'SymbolTable'
    || new GraphStore().intern(module) !== root)
    throw new Error('retirement requires an exact closed module');
  const nodes = [...visit(module)];
  if (nodes.length > 10_000 || nodes.some(node =>
    ['Import', 'Lambda', 'Apply', 'Spawn', 'Await', 'SeqMap', 'SeqFold'].includes(node.kind)))
    throw new Error('unresolved import or dynamic adapter liveness');
  if (!typecheck(module, { registry: context.registry }).ok)
    throw new Error('ill-typed sink retirement module');
  const declarations = new Map<SymbolId, Decl>();
  for (const member of module.members) {
    if (member.kind === 'FunctionDecl') {
      if (declarations.has(member.symbol)) throw new Error('duplicate declaration');
      declarations.set(member.symbol, member);
    } else if (member.kind !== 'TypeDecl') throw new Error('unsupported declaration lifecycle');
  }
  if (declarations.size > 128) throw new RangeError('adapter liveness declaration bound');
  for (const declaration of declarations.values())
    for (const node of visit(declaration))
      if (node.kind === 'Call' && !declarations.has(node.callee))
        throw new Error('unresolved external adapter use');
  return declarations;
}
function analyze(context: SemanticSinkRetirementContextV2, root: NodeRef,
  specification: string, manifest: ExecutionManifestV1,
  retained: readonly SemanticRetention[]) {
  const declarations = closed(context, root);
  const contractRoots = [...declarations.values()].filter(decl => decl.surfaces.length
    || decl.contract?.kind === 'Contract'
      && (decl.contract.requires.length || decl.contract.modifies.length || decl.contract.ensures.length))
    .map(decl => decl.symbol);
  const pending = [...context.exportPolicy.exports, ...context.exportPolicy.protectedSymbols,
    ...signedFences(specification, context.repositoryId, manifest), ...contractRoots];
  const reachable = new Set<SymbolId>(), used = new Set<CapabilityName>();
  while (pending.length) {
    const symbol = pending.pop()!;
    if (reachable.has(symbol)) continue;
    const declaration = declarations.get(symbol);
    if (!declaration) throw new Error('missing exported/protected/fenced declaration');
    reachable.add(symbol);
    declaration.capabilities.forEach(name => used.add(name));
    for (const node of visit(declaration)) {
      if (node.kind === 'Call') pending.push(node.callee);
      if (node.kind === 'Invoke') used.add(node.capability);
    }
  }
  for (const pin of retained) {
    exactObject(pin, ['kind', 'reference', 'root']); identifier(pin.reference);
    if (!['audit', 'replay', 'active-task', 'unstable-replication'].includes(pin.kind))
      throw new Error('unknown retention kind');
    const retainedModule = closed(context, pin.root);
    if (pin.kind === 'audit') continue;
    // Old entry points and pending continuations may call any declaration.
    for (const declaration of retainedModule.values()) {
      declaration.capabilities.forEach(name => used.add(name));
      for (const node of visit(declaration)) if (node.kind === 'Invoke') used.add(node.capability);
    }
  }
  return { reachable: [...reachable].sort(), usedCapabilities: [...used].sort() };
}
function harness(body: RetirementBodyV2): { module: Term; specification: string; manifest: ExecutionManifestV1 } {
  const symbols = new SymbolSpace('semantic-sink-retirement-proof');
  const query = symbols.define('capability-index');
  const registrations = body.source.table.registrations;
  const lookup = (table: DeclarativeSinkTableV2): Term =>
    registrations.reduceRight<Term>((otherwise, registration, index) =>
      b.cond(b.eq(b.v(query), b.int(index)),
        b.int(table.registrations.some(item => item.id === registration.id) ? index + 1 : 0), otherwise), b.int(0));
  const live = registrations.reduce<Term>((condition, registration, index) =>
    body.usedCapabilities.includes(registration.capability)
      ? b.or(condition, b.eq(b.v(query), b.int(index))) : condition, b.bool(false));
  const expression = b.or(b.not(live), b.eq(lookup(body.source.table), lookup(body.candidate.table)));
  const fn = b.fn({ symbol: symbols.define('dispatch-preserved'),
    params: [b.param(query, b.Int)], returns: b.Bool,
    contract: b.contract({ ensures: [b.clause(b.result(), 'all-reachable-dispatch-identities-preserved')] }),
    body: b.ret(expression) });
  const module = b.module_({ symbol: symbols.define('witness'), members: [fn], symbolTable: symbols.table() });
  const specification = Buffer.from(encodeCanonical({
    claim: 'Every reachable or retained sink dispatch keeps its exact registration. Retired entries were unreachable under the signed specification and complete retention snapshot. No adapter is unloaded or invoked by this proof.',
    body,
  }, LIMITS)).toString();
  const root = new GraphStore().intern(module);
  const d = (part: string) => digest('aether.semantic-sink-retirement-proof-context/2', {
    source: executionManifestDigest(body.source.manifest),
    candidate: executionManifestDigest(body.candidate.manifest), part, specification });
  const manifest: ExecutionManifestV1 = {
    format: 'aether.execution/1', astRoot: root,
    specRoot: domainDigest('aether.specification/1', specification), dependencies: [],
    semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'),
    target: { abiVersion: 'sink-registry-equivalence/2', profileDigest: d('profile'), artifactDigest: d('artifact') },
    capabilityPolicyDigest: d('no-effects'), evidencePolicyDigest: d('portable-checker'),
  };
  return { module, specification, manifest };
}
function verifyBody(context: SemanticSinkRetirementContextV2, body: RetirementBodyV2): void {
  exactObject(body.source, ['table', 'policy', 'manifest']);
  exactObject(body.candidate, ['table', 'policy', 'manifest']);
  if (body.repositoryId !== context.repositoryId
    || body.exportPolicyDigest !== exportPolicyDigest(context))
    throw new Error('retirement export policy or repository mismatch');
  validateExecutionManifest(body.source.manifest);
  validateExecutionManifest(body.candidate.manifest);
  if (body.source.manifest.astRoot !== body.candidate.manifest.astRoot
    || !same(body.candidate.manifest, {
      ...body.source.manifest,
      capabilityPolicyDigest: body.candidate.manifest.capabilityPolicyDigest,
    })) throw new Error('retirement candidate changed the execution AST or non-policy manifest');
  if (body.source.policy.body.policyEpoch !== context.sourcePolicyEpoch
    || body.candidate.policy.body.policyEpoch !== context.candidatePolicyEpoch
    || BigInt(context.candidatePolicyEpoch) < BigInt(context.sourcePolicyEpoch))
    throw new Error('retirement policy epoch mismatch');
  const module = context.store.hydrate(body.source.manifest.astRoot as NodeRef);
  assertDeclarativeSinkTablePolicyV2({ ...body.source,
    currentEpoch: context.sourcePolicyEpoch, signerKey: context.sourceSignerKey, module });
  assertDeclarativeSinkTablePolicyV2({ ...body.candidate,
    currentEpoch: context.candidatePolicyEpoch, signerKey: context.candidateSignerKey, module });
  if (body.source.table.repositoryId !== context.repositoryId
    || body.candidate.table.repositoryId !== context.repositoryId
    || body.source.policy.body.astRoot !== body.candidate.policy.body.astRoot
    || body.source.policy.body.repositoryId !== body.candidate.policy.body.repositoryId)
    throw new Error('retirement changed signed sink repository or AST');
  if (digest('aether.specification/1', body.specification) !== body.source.manifest.specRoot)
    throw new Error('retirement specification differs from signed source');
  const current = retentionSnapshot(context.retentionLedger);
  if (!same(current, body.retained)) throw new Error('retention changed; retirement must be reproved');
  const analysis = analyze(context, body.source.manifest.astRoot as NodeRef,
    body.specification, body.source.manifest, current);
  const removed = body.source.table.registrations
    .filter(entry => !analysis.usedCapabilities.includes(entry.capability)).map(entry => entry.id);
  if (!removed.length || !same(body.reachable, analysis.reachable)
    || !same(body.usedCapabilities, analysis.usedCapabilities)
    || !same(body.removed, removed))
    throw new Error('retirement liveness or removed registration mismatch');
  const kept = body.source.table.registrations.filter(entry => !removed.includes(entry.id));
  const after: DeclarativeSinkTableV2 = { ...body.source.table, registrations: kept };
  if (!same(body.candidate.table, after)
    || body.candidate.policy.body.adapterTableDigest !== declarativeSinkTableDigestV2(after))
    throw new Error('retirement changed a live registration');
  const keepCaps = new Set(kept.map(entry => entry.capability));
  const expectedPolicyBody = {
    ...body.source.policy.body,
    policyEpoch: context.candidatePolicyEpoch,
    adapterTableDigest: declarativeSinkTableDigestV2(after),
    rules: body.source.policy.body.rules.filter(rule => keepCaps.has(rule.capability)),
  };
  if (!same(body.candidate.policy.body, expectedPolicyBody)
    || effectResourcePolicyDigestV7(body.candidate.policy.body, module)
      !== body.candidate.manifest.capabilityPolicyDigest)
    throw new Error('retirement changed signed live effect rules');
}
export function verifySemanticSinkRetirementV2(context: SemanticSinkRetirementContextV2,
  input: SemanticSinkRetirementProposalV2): void {
  const proposal = clone(input);
  exactObject(proposal, ['format', 'repositoryId', 'exportPolicyDigest', 'specification',
    'source', 'candidate', 'retained', 'reachable', 'usedCapabilities', 'removed', 'witness', 'id']);
  if (proposal.format !== 'aether.semantic-sink-retirement/2')
    throw new Error('unsupported semantic sink retirement format');
  const { witness, id, ...body } = proposal;
  if (id !== digest('aether.semantic-sink-retirement/2', { ...body, witness }))
    throw new Error('semantic sink retirement identity mismatch');
  verifyBody(context, body);
  const expected = harness(body);
  exactObject(witness, ['root', 'specification', 'manifest', 'certificate']);
  if (witness.root !== expected.manifest.astRoot
    || witness.specification !== expected.specification
    || !same(witness.manifest, expected.manifest))
    throw new Error('semantic sink retirement witness substitution');
  // Deliberately no proof producer call here. A consumer derives every
  // obligation from the supplied exact source/candidate selection.
  checkPortableCertificate(expected.module, witness.certificate, {
    expectedManifest: expected.manifest, specification: expected.specification,
  });
}
export function proposeSemanticSinkRetirementV2(context: SemanticSinkRetirementContextV2,
  source: SinkRetirementSelectionV2, candidate: SinkRetirementSelectionV2,
  specification: string): SemanticSinkRetirementProposalV2 | null {
  const retained = retentionSnapshot(context.retentionLedger);
  const analysis = analyze(context, source.manifest.astRoot as NodeRef,
    specification, source.manifest, retained);
  const removed = source.table.registrations
    .filter(entry => !analysis.usedCapabilities.includes(entry.capability)).map(entry => entry.id);
  if (!removed.length) return null;
  const body: RetirementBodyV2 = {
    format: 'aether.semantic-sink-retirement/2', repositoryId: context.repositoryId,
    exportPolicyDigest: exportPolicyDigest(context), specification,
    source: clone(source), candidate: clone(candidate), retained,
    ...analysis, removed,
  };
  verifyBody(context, body);
  const expected = harness(body);
  const certificate = generatePortableCertificate(expected.module, {
    ...expected, expectedManifest: expected.manifest,
  });
  if (!certificate) throw new Error('sink dispatch/no-effect obligation not proved');
  const complete = { ...body, witness: {
    root: expected.manifest.astRoot as NodeRef,
    specification: expected.specification,
    manifest: expected.manifest,
    certificate,
  } };
  const proposal = { ...complete, id: digest('aether.semantic-sink-retirement/2', complete) };
  verifySemanticSinkRetirementV2(context, proposal);
  return clone(proposal);
}
