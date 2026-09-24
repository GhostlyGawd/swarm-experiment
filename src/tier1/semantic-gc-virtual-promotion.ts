/** One pure, closed tail-forwarder cleanup under a signed V3 execution profile.
 * The proposal is an immutable sidecar. Only PromotionCoordinator makes the
 * durable decision; this module does not transport the descriptor to a remote
 * ProcessHost or effect broker. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCanonical, encodeCanonical, exactObject, identifier, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateDigest, validateExecutionManifest,
  type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { createEvidenceManifest, DEFAULT_EVIDENCE_POLICY_V2, DEFAULT_EVIDENCE_POLICY_V3,
  type EvidenceContext } from '../fabric/evidence.ts';
import { createPromotionHandle, effectPlanDigest, migrationPlanDigest, PromotionCoordinator,
  type PromotionBindingV1, type PromotionDriver, type PromotionInput } from '../fabric/promotion.ts';
import { children, type Term } from './ast.ts';
import { DurableGraphStore } from './durable-store.ts';
import { GraphStore } from './store.ts';
import { type NodeRef, type SymbolId } from './ids.ts';
import { CausalLineageLedger } from './causal-lineage.ts';
import { atomicWriteOnce } from './persistence.ts';
import { SemanticGarbageCollector, type SemanticGcPolicy, type SemanticRetention } from './semantic-gc.ts';
import { buildVirtualForwardCandidate, checkVirtualForwardDescriptor,
  type VirtualForwardDescriptor } from './semantic-gc-virtual-forward.ts';
import { CapabilityRegistry, PURE_COMPUTE } from '../tier2/ocap.ts';
import { typecheck } from '../tier2/typecheck.ts';
import { compileResumableProgram, RESUMABLE_PROFILE_DIGEST,
  virtualForwardResumableProfileDigest } from '../tier3/resumable-program.ts';

type Module = Extract<Term, { kind: 'Module' }>;
type Decl = Extract<Term, { kind: 'FunctionDecl' }>;
const FORMAT = 'aether.semantic-gc-virtual-promotion/2' as const;
const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 };
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T;
const same = (a: unknown, b: unknown): boolean =>
  Buffer.from(encodeCanonical(a, LIMITS)).equals(Buffer.from(encodeCanonical(b, LIMITS)));
const digest = (domain: string, value: unknown): Digest => domainDigest(domain, value, LIMITS);
const ordered = (records: readonly SemanticRetention[]) =>
  [...records].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export interface VirtualGcPromotionProposalV2 {
  readonly format: typeof FORMAT;
  readonly repositoryId: string;
  readonly sourceManifest: ExecutionManifestV1;
  readonly sourceManifestDigest: Digest;
  readonly candidateManifest: ExecutionManifestV1;
  readonly candidateManifestDigest: Digest;
  readonly descriptor: VirtualForwardDescriptor;
  readonly specification: string;
  readonly exportPolicy: SemanticGcPolicy;
  readonly exportPolicyDigest: Digest;
  readonly retained: readonly SemanticRetention[];
  readonly id: Digest;
}
export interface VirtualGcPromotionOptionsV2 {
  readonly directory: string;
  readonly repositoryId: string;
  readonly store: DurableGraphStore;
  readonly lineage: CausalLineageLedger;
  readonly registry: CapabilityRegistry;
  readonly policy: SemanticGcPolicy;
  readonly retentionLedger: SemanticGarbageCollector;
}

function* walk(term: Term): Generator<Term> { yield term; for (const child of children(term)) yield* walk(child); }
function moduleAt(store: DurableGraphStore, root: Digest): Module {
  validateDigest(root, 'ast');
  const module = store.hydrate(root as NodeRef);
  if (module.kind !== 'Module' || new GraphStore().intern(module) !== root)
    throw new Error('virtual GC requires exact stored module');
  return module;
}
function noEffects(module: Module, registry: CapabilityRegistry): void {
  const checked = typecheck(module, { registry });
  if (registry.names.some(name => name !== PURE_COMPUTE) || !checked.ok)
    throw new Error(`virtual GC V2 only admits typed, capability-free modules: ${checked.diagnostics.map(item => item.code).join(',')}`);
  for (const node of walk(module)) {
    if (node.kind === 'Invoke' || node.kind === 'Spawn' || node.kind === 'Await'
      || node.kind === 'Import' || node.kind === 'Lambda' || node.kind === 'Apply'
      || node.kind === 'SeqMap' || node.kind === 'SeqFold')
      throw new Error('virtual GC V2 cannot admit an effect, broker, ProcessHost, or dynamic call');
    if (node.kind === 'FunctionDecl' && (node.purity !== 'pure' || node.capabilities.length))
      throw new Error('virtual GC V2 requires pure declarations');
  }
}
function policyDigest(repositoryId: string, policy: SemanticGcPolicy): Digest {
  const value = exactObject(policy, ['epoch', 'exports', 'protectedSymbols']);
  identifier(value.epoch);
  for (const symbols of [value.exports, value.protectedSymbols]) {
    if (!Array.isArray(symbols) || new Set(symbols).size !== symbols.length)
      throw new TypeError('complete unique virtual GC export policy required');
    symbols.forEach(identifier);
  }
  if (!policy.exports.length) throw new TypeError('virtual GC requires a trusted export allowlist');
  return digest('aether.semantic-gc-virtual-policy/2', { repositoryId, policy });
}
function fencedSymbols(specification: string, repositoryId: string): Set<SymbolId> {
  const document = exactObject(decodeCanonical(Buffer.from(specification), LIMITS),
    ['format', 'repositoryId', 'specifications']);
  if (document.format !== 'aether.lineage-specification/1'
    || document.repositoryId !== repositoryId || !Array.isArray(document.specifications))
    throw new Error('virtual GC requires exact signed lineage specification');
  const result = new Set<SymbolId>();
  for (const item of document.specifications) {
    const spec = exactObject(item, ['id', 'revision', 'text', 'requirements']);
    if (!Array.isArray(spec.requirements)) throw new TypeError('invalid signed requirement set');
    for (const entry of spec.requirements) {
      const requirement = exactObject(entry, ['symbol', 'signature', 'requires', 'modifies', 'ensures']);
      identifier(requirement.symbol); result.add(requirement.symbol as SymbolId);
    }
  }
  return result;
}
function plan(proposal: VirtualGcPromotionProposalV2): TaggedValueV1 {
  return { tag: 'sequence', items: [
    { tag: 'string', value: FORMAT }, { tag: 'string', value: proposal.id },
    { tag: 'string', value: proposal.descriptor.id },
    { tag: 'string', value: proposal.descriptor.sourceRoot },
    { tag: 'string', value: proposal.descriptor.candidateRoot },
    { tag: 'string', value: proposal.sourceManifestDigest },
    { tag: 'string', value: proposal.candidateManifestDigest },
  ] };
}
function noEffectPlan(proposal: VirtualGcPromotionProposalV2): TaggedValueV1 {
  return { tag: 'sequence', items: [
    { tag: 'string', value: `${FORMAT}:no-effects` },
    { tag: 'string', value: proposal.id },
    { tag: 'string', value: proposal.descriptor.id },
    { tag: 'string', value: proposal.descriptor.sourceRoot },
    { tag: 'string', value: proposal.descriptor.candidateRoot },
    { tag: 'string', value: proposal.sourceManifestDigest },
    { tag: 'string', value: proposal.candidateManifestDigest },
  ] };
}

export class SemanticVirtualGcPromotionV2 {
  private readonly options: VirtualGcPromotionOptionsV2;
  constructor(options: VirtualGcPromotionOptionsV2) {
    identifier(options.repositoryId);
    policyDigest(options.repositoryId, options.policy);
    options.retentionLedger.assertRetentionAuthority(options);
    this.options = options;
    mkdirSync(options.directory, { recursive: true });
  }
  private path(id: Digest): string {
    validateDigest(id, FORMAT);
    return join(this.options.directory, `${id.split(':').at(-1)}.json`);
  }
  private check(input: VirtualGcPromotionProposalV2, current: boolean): void {
    const proposal = clone(input);
    exactObject(proposal, ['format', 'repositoryId', 'sourceManifest', 'sourceManifestDigest',
      'candidateManifest', 'candidateManifestDigest', 'descriptor', 'specification',
      'exportPolicy', 'exportPolicyDigest', 'retained', 'id']);
    const { id, ...body } = proposal;
    if (proposal.format !== FORMAT || proposal.repositoryId !== this.options.repositoryId
      || id !== digest(FORMAT, body)) throw new Error('virtual GC proposal identity mismatch');
    validateExecutionManifest(proposal.sourceManifest);
    validateExecutionManifest(proposal.candidateManifest);
    const sourceDigest = executionManifestDigest(proposal.sourceManifest);
    const candidateDigest = executionManifestDigest(proposal.candidateManifest);
    if (proposal.sourceManifestDigest !== sourceDigest
      || proposal.candidateManifestDigest !== candidateDigest)
      throw new Error('virtual GC manifest digest mismatch');
    if (!same(proposal.exportPolicy, this.options.policy)
      || proposal.exportPolicyDigest !== policyDigest(this.options.repositoryId, this.options.policy))
      throw new Error('virtual GC export/protection policy changed');
    const before = proposal.sourceManifest, after = proposal.candidateManifest;
    if (before.astRoot !== proposal.descriptor.sourceRoot
      || after.astRoot !== proposal.descriptor.candidateRoot
      || before.specRoot !== digest('aether.specification/1', proposal.specification)
      || after.specRoot !== before.specRoot
      || before.semanticsVersion !== 'aether-reference/1'
      || after.semanticsVersion !== before.semanticsVersion
      || after.compilerDigest !== before.compilerDigest
      || after.capabilityPolicyDigest !== before.capabilityPolicyDigest
      || before.target.abiVersion !== 'resumable/1'
      || after.target.abiVersion !== before.target.abiVersion
      || before.target.profileDigest !== RESUMABLE_PROFILE_DIGEST
      || after.target.profileDigest !== virtualForwardResumableProfileDigest(proposal.descriptor)
      || before.evidencePolicyDigest !== digest(DEFAULT_EVIDENCE_POLICY_V2.format, DEFAULT_EVIDENCE_POLICY_V2)
      || after.evidencePolicyDigest !== digest(DEFAULT_EVIDENCE_POLICY_V3.format, DEFAULT_EVIDENCE_POLICY_V3))
      throw new Error('virtual GC source or descriptor-bound V3 profile mismatch');
    const source = moduleAt(this.options.store, before.astRoot);
    const candidate = moduleAt(this.options.store, after.astRoot);
    noEffects(source, this.options.registry);
    noEffects(candidate, this.options.registry);
    const expected = buildVirtualForwardCandidate(source, proposal.descriptor.wrapper, proposal.descriptor.target);
    if (!same(expected.descriptor, proposal.descriptor)
      || new GraphStore().intern(expected.candidate) !== after.astRoot)
      throw new Error('virtual GC candidate differs from exact one-wrapper rewrite');
    checkVirtualForwardDescriptor(proposal.descriptor, source, candidate);
    const sourceMembers = new Set(source.members.filter((item): item is Decl => item.kind === 'FunctionDecl').map(item => item.symbol));
    if ([...this.options.policy.exports, ...this.options.policy.protectedSymbols]
      .some(symbol => !sourceMembers.has(symbol))
      || [...this.options.policy.exports, ...this.options.policy.protectedSymbols,
        ...fencedSymbols(proposal.specification, this.options.repositoryId)]
        .includes(proposal.descriptor.wrapper))
      throw new Error('virtual GC wrapper is exported, protected, or signed-fenced');
    if (!after.dependencies.some(dep => dep.symbol === proposal.descriptor.wrapper
      && dep.declaration === proposal.descriptor.wrapperDeclaration)
      || !after.dependencies.some(dep => dep.symbol === proposal.descriptor.target
        && dep.declaration === proposal.descriptor.targetDeclaration))
      throw new Error('virtual GC exact wrapper/target dependencies absent');
    const base = { specification: proposal.specification, semanticsVersion: before.semanticsVersion,
      compilerDigest: before.compilerDigest, capabilityPolicyDigest: before.capabilityPolicyDigest,
      registry: this.options.registry };
    const sourceContext: EvidenceContext = { ...base, module: source, target: before.target,
      policy: DEFAULT_EVIDENCE_POLICY_V2 };
    const candidateContext: EvidenceContext = { ...base, module: candidate, target: after.target,
      policy: DEFAULT_EVIDENCE_POLICY_V3, virtualForward: { source, descriptor: proposal.descriptor } };
    if (!same(createEvidenceManifest(sourceContext), before)
      || !same(createEvidenceManifest(candidateContext), after))
      throw new Error('virtual GC manifest dependency closure or evidence profile changed');
    // Compile the exact retained archived wrapper into the versioned in-process
    // resumable profile. No remote artifact transport is implied by this check.
    const wrapper = source.members.find((item): item is Decl =>
      item.kind === 'FunctionDecl' && item.symbol === proposal.descriptor.wrapper)!;
    compileResumableProgram(candidate, { manifest: after, registry: this.options.registry,
      dependencies: [wrapper], virtualForward: { source, descriptor: proposal.descriptor } });
    if (!Array.isArray(proposal.retained) || !same(ordered(proposal.retained), proposal.retained))
      throw new Error('virtual GC retention snapshot is not canonical');
    for (const root of [before.astRoot, after.astRoot, proposal.descriptor.wrapperDeclaration,
      proposal.descriptor.targetDeclaration]) this.options.store.hydrate(root as NodeRef);
    if (current) {
      if (!same(ordered(this.options.retentionLedger.retentions()), proposal.retained))
        throw new Error('retention changed; virtual GC must be reproved');
      this.options.lineage.assertCurrent(sourceDigest);
      this.options.lineage.assertCurrent(candidateDigest);
      this.options.lineage.assertNodeCurrent(sourceDigest, before.astRoot as NodeRef);
      this.options.lineage.assertNodeCurrent(candidateDigest, proposal.descriptor.wrapperDeclaration);
      const parents = new Set(this.options.lineage.lineage(before.astRoot as NodeRef)
        .filter(row => row.ancestry[0]?.body.executionManifest === sourceDigest).map(row => row.intent));
      if (!this.options.lineage.lineage(after.astRoot as NodeRef).some(row =>
        row.ancestry[0]?.body.executionManifest === candidateDigest
        && row.ancestry[0].body.parents.some(parent => parents.has(parent))))
        throw new Error('virtual GC candidate lacks signed source descendant intent');
    }
  }
  propose(sourceManifest: ExecutionManifestV1, candidateManifest: ExecutionManifestV1,
    specification: string, wrapper: SymbolId, target: SymbolId): VirtualGcPromotionProposalV2 {
    validateExecutionManifest(sourceManifest);
    validateExecutionManifest(candidateManifest);
    const source = moduleAt(this.options.store, sourceManifest.astRoot);
    const { descriptor } = buildVirtualForwardCandidate(source, wrapper, target);
    const body = { format: FORMAT, repositoryId: this.options.repositoryId,
      sourceManifest: clone(sourceManifest), sourceManifestDigest: executionManifestDigest(sourceManifest),
      candidateManifest: clone(candidateManifest), candidateManifestDigest: executionManifestDigest(candidateManifest),
      descriptor, specification, exportPolicy: clone(this.options.policy),
      exportPolicyDigest: policyDigest(this.options.repositoryId, this.options.policy),
      retained: clone(ordered(this.options.retentionLedger.retentions())) };
    const proposal = { ...body, id: digest(FORMAT, body) };
    this.check(proposal, true);
    this.options.store.retain(`semantic-gc-virtual-v2:${proposal.id}`,
      [descriptor.sourceRoot, descriptor.candidateRoot,
        descriptor.wrapperDeclaration, descriptor.targetDeclaration] as NodeRef[]);
    const file = this.path(proposal.id);
    atomicWriteOnce(file, Buffer.from(encodeCanonical(proposal, LIMITS)).toString());
    const directory = openSync(this.options.directory, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    if (!same(decodeCanonical(readFileSync(file), LIMITS), proposal))
      throw new Error('virtual GC immutable proposal conflict');
    return clone(proposal);
  }
  readProposal(id: Digest, current = false): VirtualGcPromotionProposalV2 {
    const file = this.path(id);
    if (statSync(file).size > LIMITS.maxFrameBytes) throw new RangeError('virtual GC proposal byte limit');
    const proposal = decodeCanonical(readFileSync(file), LIMITS) as unknown as VirtualGcPromotionProposalV2;
    if (proposal.id !== id) throw new Error('virtual GC proposal path mismatch');
    this.check(proposal, current);
    return clone(proposal);
  }
  /** The caller must use this plan verbatim in the governor-signed proposal. */
  promotionPlans(id: Digest): { migrationPlan: TaggedValueV1; effectPlan: TaggedValueV1 } {
    const proposal = this.readProposal(id, true);
    return { migrationPlan: plan(proposal), effectPlan: noEffectPlan(proposal) };
  }
  private binding(id: Digest, binding: PromotionBindingV1, current: boolean): VirtualGcPromotionProposalV2 {
    const proposal = this.readProposal(id, current);
    if (binding.proposal.expectedParent !== proposal.sourceManifestDigest
      || binding.proposal.candidateManifest !== proposal.candidateManifestDigest
      || !same(binding.manifest, proposal.candidateManifest)
      || !same(binding.migrationPlan, plan(proposal))
      || !same(binding.effectPlan, noEffectPlan(proposal))
      || binding.proposal.migrationPlanDigest !== migrationPlanDigest(plan(proposal))
      || binding.proposal.effectPlanDigest !== effectPlanDigest(noEffectPlan(proposal)))
      throw new Error('virtual GC promotion binding or persisted plan mismatch');
    return proposal;
  }
  /** The only admitted driver stages and commits the local DurableGraphStore
   * head. It compiles the exact candidate and archived wrapper before staging.
   * There is deliberately no caller-supplied ProcessHost/broker driver here. */
  private localDriver(id: Digest): PromotionDriver {
    const headName = 'production';
    const store = this.options.store;
    const driver: PromotionDriver = {
      prepare: async binding => {
        const proposal = this.binding(id, binding, true);
        const source = moduleAt(store, proposal.descriptor.sourceRoot);
        const candidate = moduleAt(store, proposal.descriptor.candidateRoot);
        const wrapper = source.members.find((item): item is Decl =>
          item.kind === 'FunctionDecl' && item.symbol === proposal.descriptor.wrapper)!;
        compileResumableProgram(candidate, { manifest: proposal.candidateManifest,
          registry: this.options.registry, dependencies: [wrapper],
          virtualForward: { source, descriptor: proposal.descriptor } });
        const head = store.head(headName);
        if (!head || head.root !== proposal.descriptor.sourceRoot)
          throw new Error('virtual GC local head is not the exact signed source');
        store.stagePromotion(binding.proposalDigest,
          { from: proposal.descriptor.sourceRoot, to: proposal.descriptor.candidateRoot });
        return createPromotionHandle(binding, { tag: 'int', value: String(head.generation) });
      },
      activate: async (binding, handle) => {
        if (handle.payload.tag !== 'int') throw new Error('virtual GC head generation absent');
        const proposal = this.binding(id, binding, false);
        store.finishPromotion(binding.proposalDigest, { kind: 'commit', name: headName,
          expected: { root: proposal.descriptor.sourceRoot, generation: Number(handle.payload.value) } });
      },
      abort: async binding => {
        if (store.roots().promotions[binding.proposalDigest])
          store.finishPromotion(binding.proposalDigest, { kind: 'abort' });
      },
      recover: async (binding, handle, decision) => {
        if (decision === 'commit') {
          if (!handle) throw new Error('committed virtual GC handle absent');
          await driver.activate(binding, handle);
        } else await driver.abort(binding, handle);
      },
    };
    return {
      prepare: async (binding, evidence) => {
        this.binding(id, binding, true);
        const handle = await driver.prepare(binding, evidence);
        this.binding(id, binding, true);
        return handle;
      },
      commitFence: (binding, commit) => {
        const proposal = this.binding(id, binding, true);
        const fenced = () => this.options.retentionLedger.withStableRetentions(proposal.retained, () => {
          this.binding(id, binding, true);
          commit();
        });
        fenced();
      },
      activate: async (binding, handle) => {
        this.binding(id, binding, false);
        await driver.activate(binding, handle);
      },
      abort: async (binding, handle) => {
        this.binding(id, binding, false);
        await driver.abort(binding, handle);
      },
      recover: async (binding, handle, decision) => {
        this.binding(id, binding, false);
        await driver.recover(binding, handle, decision);
      },
    };
  }
  async promote(id: Digest, input: PromotionInput, coordinator: PromotionCoordinator) {
    if (coordinator.admissionProfile !== 'strict-lineage-v1')
      throw new Error('virtual GC requires strict signed-lineage promotion');
    const proposal = this.readProposal(id, true);
    const virtual = input.context.virtualForward;
    if (!virtual || input.context.module.kind !== 'Module')
      throw new Error('virtual GC promotion requires exact V3 source/candidate context');
    checkVirtualForwardDescriptor(virtual.descriptor, virtual.source, input.context.module);
    if (!same(input.evidence.manifest, proposal.candidateManifest)
      || input.context.policy?.format !== DEFAULT_EVIDENCE_POLICY_V3.format
      || !same(virtual.descriptor, proposal.descriptor)
      || new GraphStore().intern(virtual.source) !== proposal.descriptor.sourceRoot
      || new GraphStore().intern(input.context.module) !== proposal.descriptor.candidateRoot)
      throw new Error('virtual GC promotion evidence context substitution');
    this.binding(id, { format: 'aether.promotion-binding/1', proposalDigest: digest('aether.promotion/1', input.proposal),
      proposal: input.proposal, manifest: input.evidence.manifest, generation: '0',
      migrationPlan: input.migrationPlan, effectPlan: input.effectPlan }, true);
    return coordinator.promote(input, this.localDriver(id));
  }
  /** Recover one durable decision through the same exact proposal and local
   * head. An alternate proposal ID fails before activation. */
  recover(id: Digest, coordinator: PromotionCoordinator) {
    if (coordinator.admissionProfile !== 'strict-lineage-v1')
      throw new Error('virtual GC recovery requires strict signed-lineage coordinator');
    return coordinator.recover(this.localDriver(id));
  }
}
