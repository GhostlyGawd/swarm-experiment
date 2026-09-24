/** Admission contract for a future governor-driven pure Artifact/4 deployment.
 * It is deliberately separate from the Artifact/1–2 ProcessDeployment wire. */
import { decode as decodeIR } from '../tier1/agent-ir.ts';
import { type Term, type Ty, walk } from '../tier1/ast.ts';
import { type SymbolId } from '../tier1/ids.ts';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../tier1/persistence.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { validateVettedEvidence, type VettedEvidence } from '../fabric/evidence.ts';
import { effectPlanDigest, evidenceBundleDigest, migrationPlanDigest, promotionDigest,
  type PromotionBindingV1 } from '../fabric/promotion.ts';
import { runtimeSnapshotDigest, validateRuntimeSnapshot, type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { assertHostJournalWitnessCatalog, type HostJournalWitnessCatalog } from '../fabric/host-journal-witness.ts';
import { assertPureVirtualDeploymentWitnessV1,
  type PureVirtualDeploymentWitnessV1 } from './process-virtual-deployment-journal.ts';
import { validateProcessVirtualArtifactV4, processVirtualArtifactDigestV4,
  type ProcessVirtualArtifactV4 } from './process-virtual-artifact-v4.ts';
import { openProcessVirtualWorkerLineageV1, type ProcessVirtualWorkerTrustV1 } from './process-virtual-worker-contract.ts';
import type { TopologyPlan } from './topology.ts';

const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 };
const same = (a: unknown, b: unknown): boolean =>
  Buffer.from(encodeCanonical(a, LIMITS)).equals(Buffer.from(encodeCanonical(b, LIMITS)));
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T;

function schemaDigest(module: Term, archivedWrapper?: SymbolId): Digest {
  const signatures: unknown[] = [], types = new Map<string, Ty>();
  const add = (ty: Ty): void => { types.set(Buffer.from(encodeCanonical(ty)).toString('utf8'), ty); };
  const members = module.kind === 'Module'
    ? module.members.filter(member => member.kind !== 'FunctionDecl' || member.symbol !== archivedWrapper)
    : [module];
  for (const member of members) for (const node of walk(member)) {
    if (node.kind === 'TypeDecl') { signatures.push({ type: node.name, representation: node.ty }); add(node.ty); }
    if (node.kind === 'FunctionDecl' && node.symbol !== archivedWrapper) {
      signatures.push({ function: node.symbol, parameters: node.params.map(param => param.ty),
        returns: node.returns, typeParams: node.typeParams });
      node.params.forEach(param => add(param.ty)); add(node.returns);
    }
    if (node.kind === 'Let' || node.kind === 'RecordLit') add(node.ty);
  }
  signatures.sort((a, b) => Buffer.compare(encodeCanonical(a), encodeCanonical(b)));
  return domainDigest('aether.process-schema/1', { signatures,
    types: [...types].sort(([a], [b]) => a < b ? -1 : 1).map(([, value]) => value) });
}

/** A pure virtual worker has one unit and no broker or cross-unit routing. */
export function assertPureVirtualPlanV1(plan: TopologyPlan, artifact: ProcessVirtualArtifactV4): Digest {
  encodeCanonical(plan, LIMITS);
  const module = decodeIR(artifact.candidateIr);
  if (module.kind !== 'Module' || !Array.isArray(plan.units) || plan.units.length !== 1
    || !Array.isArray(plan.crossEdges) || plan.crossEdges.length !== 0)
    throw new TypeError('pure Artifact/4 deployment requires one unit without cross edges');
  const unit = plan.units[0]; identifier(unit.id);
  const members = module.members.filter(member => member.kind === 'FunctionDecl')
    .map(member => member.symbol).sort();
  if (!Array.isArray(unit.members) || !same([...unit.members].sort(), members)
    || !Array.isArray(unit.capabilities) || unit.capabilities.length !== 0
    || !['linked', 'container', 'edge'].includes(unit.placement)
    || !Number.isFinite(unit.memoryMb) || unit.memoryMb < 0)
    throw new TypeError('pure Artifact/4 plan does not place every declaration without effects');
  if (!Number.isFinite(plan.transportLatencyMsPerSecond) || plan.transportLatencyMsPerSecond !== 0
    || !Number.isFinite(plan.monthlyCost) || !Array.isArray(plan.recombinations)
    || !Array.isArray(plan.blockedMerges))
    throw new TypeError('invalid pure Artifact/4 topology cost');
  return domainDigest('aether.process-virtual-plan/1', plan, LIMITS);
}

export function processVirtualMigrationPlanV1(snapshot: RuntimeSnapshotV1,
  artifactDigest: Digest, planDigest: Digest): TaggedValueV1 {
  validateRuntimeSnapshot(snapshot);
  validateDigest(artifactDigest, 'aether.process-artifact/4');
  validateDigest(planDigest, 'aether.process-virtual-plan/1');
  return { tag: 'sequence', items: [
    { tag: 'string', value: 'aether.pure-virtual-migration/1' },
    { tag: 'string', value: runtimeSnapshotDigest(snapshot) },
    { tag: 'string', value: artifactDigest },
    { tag: 'string', value: planDigest },
  ] };
}

export function processVirtualEffectPlanV1(artifactDigest: Digest, trustDigest: Digest,
  hostCatalog: HostJournalWitnessCatalog,
  deploymentWitness: PureVirtualDeploymentWitnessV1): TaggedValueV1 {
  validateDigest(artifactDigest, 'aether.process-artifact/4');
  validateDigest(trustDigest, 'aether.process-virtual-worker-trust/1');
  assertHostJournalWitnessCatalog(hostCatalog);
  assertPureVirtualDeploymentWitnessV1(deploymentWitness);
  if (hostCatalog.repositoryId !== deploymentWitness.repositoryId
    || hostCatalog.deploymentId !== deploymentWitness.deploymentId)
    throw new TypeError('pure Artifact/4 witnesses disagree on repository/deployment');
  return { tag: 'sequence', items: [
    { tag: 'string', value: 'aether.pure-virtual-no-effects/1' },
    { tag: 'string', value: artifactDigest },
    { tag: 'string', value: trustDigest },
    { tag: 'string', value: hostCatalog.digest },
    { tag: 'string', value: deploymentWitness.digest },
  ] };
}

export interface PureVirtualPreparedV1 {
  readonly format: 'aether.process-virtual-deployment-prepared/1';
  readonly binding: PromotionBindingV1;
  readonly sourceManifest: Digest;
  readonly candidateManifest: Digest;
  readonly artifactDigest: Digest;
  readonly executableSubjectDigest: Digest;
  readonly trustDigest: Digest;
  readonly hostWitnessCatalogDigest: Digest;
  readonly deploymentJournalWitnessDigest: Digest;
  readonly planDigest: Digest;
  readonly sourceSnapshotDigest: Digest;
  readonly sourceSchemaDigest: Digest;
  readonly candidateSchemaDigest: Digest;
  readonly seed: RuntimeSnapshotV1;
}

export function validatePureVirtualPreparedV1(value: unknown): PureVirtualPreparedV1 {
  encodeCanonical(value, LIMITS);
  const record = exactObject(value, ['format', 'binding', 'sourceManifest',
    'candidateManifest', 'artifactDigest', 'executableSubjectDigest', 'trustDigest',
    'hostWitnessCatalogDigest', 'deploymentJournalWitnessDigest', 'planDigest',
    'sourceSnapshotDigest', 'sourceSchemaDigest', 'candidateSchemaDigest', 'seed']);
  if (record.format !== 'aether.process-virtual-deployment-prepared/1')
    throw new TypeError('unsupported pure virtual prepared record');
  const binding = record.binding as PromotionBindingV1;
  if (binding?.format !== 'aether.promotion-binding/1'
    || binding.proposalDigest !== promotionDigest(binding.proposal)
    || binding.proposal.expectedParent !== record.sourceManifest
    || binding.proposal.candidateManifest !== record.candidateManifest
    || executionManifestDigest(binding.manifest) !== record.candidateManifest
    || binding.proposal.migrationPlanDigest !== migrationPlanDigest(binding.migrationPlan)
    || binding.proposal.effectPlanDigest !== effectPlanDigest(binding.effectPlan))
    throw new TypeError('pure virtual prepared governor binding mismatch');
  validateDigest(record.artifactDigest, 'aether.process-artifact/4');
  validateDigest(record.executableSubjectDigest, 'aether.measured-executable-subject/2');
  validateDigest(record.trustDigest, 'aether.process-virtual-worker-trust/1');
  validateDigest(record.hostWitnessCatalogDigest,
    'aether.process-host-journal-witness-catalog/1');
  validateDigest(record.deploymentJournalWitnessDigest,
    'aether.process-virtual-deployment-journal-witness/1');
  validateDigest(record.planDigest, 'aether.process-virtual-plan/1');
  validateDigest(record.sourceSnapshotDigest, 'aether.state/1');
  validateDigest(record.sourceSchemaDigest, 'aether.process-schema/1');
  if (record.sourceSchemaDigest !== record.candidateSchemaDigest)
    throw new TypeError('pure virtual prepared schema mismatch');
  validateRuntimeSnapshot(record.seed);
  if (record.seed.executionManifest !== record.candidateManifest
    || record.seed.ownership.some(owner => owner.epoch !== binding.generation))
    throw new TypeError('pure virtual prepared seed identity mismatch');
  return clone(value as PureVirtualPreparedV1);
}

export function pureVirtualPreparedDigestV1(record: PureVirtualPreparedV1): Digest {
  return domainDigest('aether.process-virtual-deployment-prepared/1',
    validatePureVirtualPreparedV1(record), LIMITS);
}

/** The prepared record is immutable and content addressed. It is rechecked
 * against live Artifact/4, snapshot, plan and authority at the commit fence. */
export class PureVirtualPreparedStoreV1 {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  private path(proposal: Digest): string {
    validateDigest(proposal, 'aether.promotion/1');
    return join(this.directory, `${proposal.split(':').at(-1)!}.json`);
  }
  write(record: PureVirtualPreparedV1): Digest {
    const checked = validatePureVirtualPreparedV1(record);
    const digest = pureVirtualPreparedDigestV1(checked);
    mkdirSync(this.directory, { recursive: true });
    const path = this.path(checked.binding.proposalDigest);
    if (existsSync(path)) {
      this.read(checked.binding.proposalDigest, digest);
      return digest;
    }
    atomicWrite(path, Buffer.from(encodeCanonical(checked, LIMITS)).toString('utf8'));
    const fd = openSync(this.directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return digest;
  }
  read(proposal: Digest, expectedDigest: Digest): PureVirtualPreparedV1 {
    validateDigest(expectedDigest, 'aether.process-virtual-deployment-prepared/1');
    const path = this.path(proposal);
    if (statSync(path).size > LIMITS.maxFrameBytes)
      throw new RangeError('pure virtual prepared record exceeds bound');
    const record = validatePureVirtualPreparedV1(decodeCanonical(readFileSync(path), LIMITS));
    if (record.binding.proposalDigest !== proposal
      || pureVirtualPreparedDigestV1(record) !== expectedDigest)
      throw new TypeError('pure virtual prepared record changed');
    return record;
  }
}

function rebind(snapshot: RuntimeSnapshotV1, manifest: Digest, generation: string,
  unit: string): RuntimeSnapshotV1 {
  const value = (item: TaggedValueV1): TaggedValueV1 => item.tag === 'authority'
    ? (() => { throw new TypeError('pure virtual migration cannot reissue stored authority'); })()
    : item.tag === 'ref' ? { tag: 'ref', value: { ...item.value, ownerEpoch: generation } }
    : item.tag === 'sequence' ? { tag: 'sequence', items: item.items.map(value) }
    : item.tag === 'result' ? { ...item, value: value(item.value) } : item;
  const seed: RuntimeSnapshotV1 = { ...snapshot, executionManifest: manifest,
    records: snapshot.records.map(record => ({ ...record,
      fields: record.fields.map(([name, item]) => [name, value(item)] as const) })),
    ownership: snapshot.ownership.map(owner => ({ ...owner, unit, epoch: generation })) };
  validateRuntimeSnapshot(seed);
  return seed;
}

/** Prepare-time check. The coordinator still owns governor signature, expiry,
 * strict lineage and commit. A deployment driver must repeat this check under
 * its commit fence and durably record the returned payload before launching. */
export function preparePureVirtualPromotionV1(input: Readonly<{
  binding: PromotionBindingV1;
  evidence: VettedEvidence;
  artifact: ProcessVirtualArtifactV4;
  trust: ProcessVirtualWorkerTrustV1;
  plan: TopologyPlan;
  sourceSnapshot: RuntimeSnapshotV1;
  sourceGeneration: string;
  hostWitnessCatalog: HostJournalWitnessCatalog;
  deploymentJournalWitness: PureVirtualDeploymentWitnessV1;
}>): PureVirtualPreparedV1 {
  const { binding, trust, sourceSnapshot, sourceGeneration, plan } = input;
  if (binding.format !== 'aether.promotion-binding/1') throw new TypeError('invalid virtual promotion binding');
  validateRuntimeSnapshot(sourceSnapshot);
  if (!/^0$|^[1-9][0-9]*$/.test(sourceGeneration)
    || BigInt(binding.generation) !== BigInt(sourceGeneration) + 1n)
    throw new TypeError('stale pure virtual source generation');
  const lineage = openProcessVirtualWorkerLineageV1(trust);
  const artifact = validateProcessVirtualArtifactV4(input.artifact, lineage);
  const sourceManifest = executionManifestDigest(artifact.sourceEvidence.manifest);
  const candidateManifest = executionManifestDigest(artifact.candidateEvidence.manifest);
  if (binding.proposal.expectedParent !== sourceManifest
    || binding.proposal.candidateManifest !== candidateManifest
    || executionManifestDigest(binding.manifest) !== candidateManifest
    || !same(binding.manifest, artifact.candidateEvidence.manifest)
    || sourceSnapshot.executionManifest !== sourceManifest)
    throw new TypeError('pure virtual promotion source/candidate binding changed');
  validateVettedEvidence(input.evidence, binding.manifest);
  if (binding.proposal.evidenceBundleDigest !== evidenceBundleDigest(artifact.candidateEvidence))
    throw new TypeError('pure virtual promotion evidence differs from signed Artifact/4');
  const artifactDigest = processVirtualArtifactDigestV4(artifact);
  const planDigest = assertPureVirtualPlanV1(plan, artifact);
  const source = decodeIR(artifact.sourceIr), candidate = decodeIR(artifact.candidateIr);
  // D16 removes only the wrapper declaration; its exact archived body and
  // calls are separately bound by Artifact/4. Retained data layouts and the
  // remaining callable signatures must stay byte-identical.
  const sourceSchemaDigest = schemaDigest(source, artifact.archivedWrapper.symbol);
  const candidateSchemaDigest = schemaDigest(candidate);
  if (sourceSchemaDigest !== candidateSchemaDigest)
    throw new TypeError('pure virtual migration changes the record/function schema');
  const unit = plan.units[0].id;
  if (sourceSnapshot.ownership.some(owner => owner.epoch !== sourceGeneration))
    throw new TypeError('pure virtual snapshot generation changed');
  const trustDigest = domainDigest('aether.process-virtual-worker-trust/1', trust, LIMITS);
  if (trust.repositoryId !== binding.proposal.repositoryId
    || input.hostWitnessCatalog.repositoryId !== trust.repositoryId
    || input.deploymentJournalWitness.repositoryId !== trust.repositoryId
    || input.hostWitnessCatalog.deploymentId !== input.deploymentJournalWitness.deploymentId)
    throw new TypeError('pure virtual trust/witness repository differs from approval');
  const migrationPlan = processVirtualMigrationPlanV1(sourceSnapshot, artifactDigest, planDigest);
  const effectPlan = processVirtualEffectPlanV1(artifactDigest, trustDigest,
    input.hostWitnessCatalog, input.deploymentJournalWitness);
  if (!same(binding.migrationPlan, migrationPlan)
    || !same(binding.effectPlan, effectPlan)
    || binding.proposal.migrationPlanDigest !== migrationPlanDigest(migrationPlan)
    || binding.proposal.effectPlanDigest !== effectPlanDigest(effectPlan))
    throw new TypeError('approved pure virtual migration/effect plan changed');
  return validatePureVirtualPreparedV1({ format: 'aether.process-virtual-deployment-prepared/1', binding,
    sourceManifest, candidateManifest, artifactDigest,
    executableSubjectDigest: artifact.executableSubject.digest,
    trustDigest, hostWitnessCatalogDigest: input.hostWitnessCatalog.digest,
    deploymentJournalWitnessDigest: input.deploymentJournalWitness.digest,
    planDigest, sourceSnapshotDigest: runtimeSnapshotDigest(sourceSnapshot),
    sourceSchemaDigest, candidateSchemaDigest,
    seed: rebind(sourceSnapshot, candidateManifest, binding.generation, unit) });
}
