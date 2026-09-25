/** Separate witnessed journal for governor-promoted pure Artifact/4 deployment.
 * This module establishes durable record custody; the promotion driver is a
 * separate integration step. Legacy ProcessDeployment never reads this wire. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from '../tier1/persistence.ts';
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier,
  validateTaggedValue, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import type { ProcessHostCallResult } from './process-host.ts';

const FORMAT = 'aether.process-virtual-deployment/1' as const;
const WITNESS_FORMAT = 'aether.process-virtual-deployment-journal-witness/1' as const;
const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 };
export interface PureVirtualDeploymentJournalV1 {
  readonly format: typeof FORMAT;
  readonly witnessRevision: string;
  readonly witnessDigest: Digest;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly admissionProfile: 'strict-lineage-v1';
  readonly genesisManifest: Digest;
  readonly active: Readonly<{ manifest: Digest; generation: string;
    artifactDigest: Digest | null }>;
  readonly readiness: 'ready' | 'preparing' | 'prepared';
  readonly pendingProposal: Digest | null;
  readonly preparedDigest: Digest | null;
  readonly trustDigest: Digest;
  readonly hostWitnessCatalogDigest: Digest;
}
export interface PureVirtualInvocationV2 {
  readonly operationId: string;
  readonly requestDigest: Digest;
  readonly manifest: Digest;
  readonly generation: string;
  readonly symbol: string;
  readonly args: readonly TaggedValueV1[];
  readonly phase: 'pending' | 'settled';
  readonly result: ProcessHostCallResult | null;
}
export interface PureVirtualDeploymentJournalV2 extends Omit<PureVirtualDeploymentJournalV1, 'format'> {
  readonly format: 'aether.process-virtual-deployment/2';
  readonly invocations: readonly PureVirtualInvocationV2[];
}
export interface PureVirtualDeploymentJournalV3 extends Omit<PureVirtualDeploymentJournalV2, 'format'> {
  readonly format: 'aether.process-virtual-deployment/3';
  readonly sourcePlanDigest: Digest;
  readonly candidatePlanDigest: Digest;
  readonly sourceInitialSnapshotDigest: Digest | null;
  readonly sealerIdentityDigest: Digest;
  readonly recoveryAuthorityDigest: Digest;
}
export type PureVirtualDeploymentJournal = PureVirtualDeploymentJournalV1
  | PureVirtualDeploymentJournalV2 | PureVirtualDeploymentJournalV3;
export function pureVirtualInvocationDigestV2(row: Pick<PureVirtualInvocationV2,
  'manifest' | 'generation' | 'symbol' | 'args'>): Digest {
  return domainDigest('aether.process-virtual-invocation/2',
    { manifest: row.manifest, generation: row.generation, symbol: row.symbol, args: row.args }, LIMITS);
}
export interface PureVirtualDeploymentWitnessV1 {
  readonly format: typeof WITNESS_FORMAT;
  readonly authorityId: string;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly digest: Digest;
}
export interface PureVirtualDeploymentHeadV1 {
  readonly revision: string;
  readonly journal: string | null;
}
interface Source {
  readonly read: () => PureVirtualDeploymentHeadV1;
  readonly advance: (expectedRevision: string, journal: string) => PureVirtualDeploymentHeadV1;
  lastRevision: bigint;
  lastJournal: string | null;
  genesis: Digest | null;
  trust: Digest | null;
  hostCatalog: Digest | null;
  format: string | null;
  sourcePlan: Digest | null;
  candidatePlan: Digest | null;
  initialSnapshot: Digest | null;
  sealer: Digest | null;
  recoveryAuthority: Digest | null;
}
const sources = new WeakMap<object, Source>();
const canonical = (value: unknown): string => Buffer.from(encodeCanonical(value, LIMITS)).toString('utf8');
function assertStableIdentity(source: Source, journal: PureVirtualDeploymentJournal): void {
  if (source.genesis !== null && (journal.format !== source.format
    || journal.genesisManifest !== source.genesis
    || journal.trustDigest !== source.trust
    || journal.hostWitnessCatalogDigest !== source.hostCatalog
    || journal.format === 'aether.process-virtual-deployment/3'
      && (journal.sourcePlanDigest !== source.sourcePlan
        || journal.candidatePlanDigest !== source.candidatePlan
        || journal.sourceInitialSnapshotDigest !== source.initialSnapshot
        || journal.sealerIdentityDigest !== source.sealer
        || journal.recoveryAuthorityDigest !== source.recoveryAuthority)))
    throw new Error('pure virtual witness genesis/authority changed');
}

export function validatePureVirtualDeploymentJournalV1(value: unknown,
  witness: PureVirtualDeploymentWitnessV1): PureVirtualDeploymentJournal {
  encodeCanonical(value, LIMITS);
  const raw = value as { format?: unknown };
  const journal = exactObject(value, ['format', 'witnessRevision', 'witnessDigest',
    'repositoryId', 'deploymentId', 'admissionProfile', 'genesisManifest', 'active',
    'readiness', 'pendingProposal', 'preparedDigest', 'trustDigest', 'hostWitnessCatalogDigest',
    ...(['aether.process-virtual-deployment/2', 'aether.process-virtual-deployment/3']
      .includes(raw.format as string) ? ['invocations'] : []),
    ...(raw.format === 'aether.process-virtual-deployment/3'
      ? ['sourcePlanDigest', 'candidatePlanDigest', 'sourceInitialSnapshotDigest',
        'sealerIdentityDigest', 'recoveryAuthorityDigest'] : [])]);
  if (![FORMAT, 'aether.process-virtual-deployment/2',
    'aether.process-virtual-deployment/3'].includes(journal.format as string)
    || journal.admissionProfile !== 'strict-lineage-v1'
    || journal.repositoryId !== witness.repositoryId
    || journal.deploymentId !== witness.deploymentId
    || journal.witnessDigest !== witness.digest)
    throw new TypeError('pure virtual deployment journal identity/profile mismatch');
  decimal(journal.witnessRevision);
  validateDigest(journal.genesisManifest, 'aether.execution/1');
  validateDigest(journal.trustDigest, 'aether.process-virtual-worker-trust/1');
  validateDigest(journal.hostWitnessCatalogDigest,
    'aether.process-host-journal-witness-catalog/1');
  const active = exactObject(journal.active, ['manifest', 'generation', 'artifactDigest']);
  validateDigest(active.manifest, 'aether.execution/1'); decimal(active.generation);
  if (active.artifactDigest !== null)
    validateDigest(active.artifactDigest, 'aether.process-artifact/4');
  if (active.generation === '0' ? active.manifest !== journal.genesisManifest
    || active.artifactDigest !== null : active.artifactDigest === null)
    throw new TypeError('pure virtual deployment active generation/artifact mismatch');
  if (!['ready', 'preparing', 'prepared'].includes(journal.readiness as string)
    || (journal.readiness === 'ready') !== (journal.pendingProposal === null)
    || (journal.readiness === 'prepared') !== (journal.preparedDigest !== null))
    throw new TypeError('invalid pure virtual preparation state');
  if (journal.pendingProposal !== null)
    validateDigest(journal.pendingProposal, 'aether.promotion/1');
  if (journal.preparedDigest !== null) {
    validateDigest(journal.preparedDigest);
    if (!journal.preparedDigest.startsWith('aether.process-virtual-deployment-prepared/1:')
      && !journal.preparedDigest.startsWith('aether.process-virtual-deployment-prepared/2:'))
      throw new TypeError('unsupported pure virtual prepared version');
  }
  if (journal.format === 'aether.process-virtual-deployment/3') {
    validateDigest(journal.sourcePlanDigest, 'aether.process-virtual-source-plan/1');
    validateDigest(journal.candidatePlanDigest, 'aether.process-virtual-plan/1');
    if (journal.sourceInitialSnapshotDigest !== null)
      validateDigest(journal.sourceInitialSnapshotDigest, 'aether.state/1');
    validateDigest(journal.sealerIdentityDigest, 'aether.process-virtual-sealer-identity/1');
    validateDigest(journal.recoveryAuthorityDigest,
      'aether.process-virtual-recovery-authority/1');
  }
  if (journal.format === 'aether.process-virtual-deployment/2'
    || journal.format === 'aether.process-virtual-deployment/3') {
    if (!Array.isArray(journal.invocations)) throw new TypeError('missing virtual invocation inventory');
    const operations = new Set<string>();
    for (const item of journal.invocations) {
      const row = exactObject(item, ['operationId', 'requestDigest', 'manifest',
        'generation', 'symbol', 'args', 'phase', 'result']);
      identifier(row.operationId); identifier(row.symbol); decimal(row.generation);
      validateDigest(row.manifest, 'aether.execution/1');
      validateDigest(row.requestDigest, 'aether.process-virtual-invocation/2');
      if (operations.has(row.operationId) || !Array.isArray(row.args)
        || !['pending', 'settled'].includes(row.phase as string))
        throw new TypeError('invalid virtual invocation inventory');
      operations.add(row.operationId);
      row.args.forEach(arg => validateTaggedValue(arg));
      if (row.requestDigest !== pureVirtualInvocationDigestV2(row as unknown as PureVirtualInvocationV2)
        || row.phase === 'settled' && row.result === null)
        throw new TypeError('virtual invocation request/result mismatch');
      if (row.result !== null) {
        const result = row.result as ProcessHostCallResult;
        const outcome = exactObject(result, result.state === 'completed'
          ? ['state', 'operationId', 'generation', 'unit', 'execution']
          : ['state', 'operationId', 'generation', 'unit', 'reason']);
        identifier(outcome.unit);
        if (result.operationId !== row.operationId || result.generation !== row.generation
          || !['completed', 'aborted', 'indeterminate'].includes(result.state)
          || row.phase === 'settled' && result.state === 'indeterminate')
          throw new TypeError('virtual invocation result identity mismatch');
        if (result.state === 'completed') {
          const execution = exactObject(result.execution,
            result.execution?.ok === true ? ['ok', 'value', 'steps'] : ['ok', 'fault', 'steps']);
          if (typeof execution.steps !== 'number' || !Number.isSafeInteger(execution.steps)
            || execution.steps < 0 || typeof execution.ok !== 'boolean')
            throw new TypeError('invalid virtual invocation execution');
          if (execution.ok) validateTaggedValue(execution.value);
          else if (!execution.fault || typeof execution.fault !== 'object')
            throw new TypeError('invalid virtual invocation fault');
        } else if (typeof result.reason !== 'string' || !result.reason)
          throw new TypeError('invalid virtual invocation noncommit reason');
      }
    }
  }
  return value as PureVirtualDeploymentJournal;
}

function checked(witness: PureVirtualDeploymentWitnessV1, source: Source,
  value: PureVirtualDeploymentHeadV1): PureVirtualDeploymentHeadV1 {
  const head = exactObject(value, ['revision', 'journal']); decimal(head.revision);
  const revision = BigInt(head.revision as string);
  if ((revision === 0n) !== (head.journal === null))
    throw new TypeError('pure virtual witness genesis/journal mismatch');
  let journal: PureVirtualDeploymentJournal | null = null;
  if (revision > 0n) {
    if (typeof head.journal !== 'string' || !head.journal.length)
      throw new TypeError('missing pure virtual witness journal');
    const decoded = decodeCanonical(Buffer.from(head.journal, 'utf8'), LIMITS);
    if (canonical(decoded) !== head.journal) throw new TypeError('noncanonical virtual witness journal');
    journal = validatePureVirtualDeploymentJournalV1(decoded, witness);
    if (journal.witnessRevision !== head.revision)
      throw new Error('pure virtual witness revision mismatch');
    assertStableIdentity(source, journal);
  }
  if (revision < source.lastRevision || revision === source.lastRevision
    && head.journal !== source.lastJournal)
    throw new Error('pure virtual deployment witness rolled back or equivocated');
  if (journal) {
    source.genesis = journal.genesisManifest;
    source.trust = journal.trustDigest;
    source.hostCatalog = journal.hostWitnessCatalogDigest;
    source.format = journal.format;
    if (journal.format === 'aether.process-virtual-deployment/3') {
      source.sourcePlan = journal.sourcePlanDigest;
      source.candidatePlan = journal.candidatePlanDigest;
      source.initialSnapshot = journal.sourceInitialSnapshotDigest;
      source.sealer = journal.sealerIdentityDigest;
      source.recoveryAuthority = journal.recoveryAuthorityDigest;
    }
  }
  source.lastRevision = revision; source.lastJournal = head.journal as string | null;
  return { revision: head.revision as string, journal: head.journal as string | null };
}

export function createPureVirtualDeploymentWitnessV1(options: Readonly<{
  authorityId: string; repositoryId: string; deploymentId: string;
  read: () => PureVirtualDeploymentHeadV1;
  advance: (expectedRevision: string, journal: string) => PureVirtualDeploymentHeadV1;
}>): PureVirtualDeploymentWitnessV1 {
  for (const id of [options.authorityId, options.repositoryId, options.deploymentId]) identifier(id);
  if (typeof options.read !== 'function' || typeof options.advance !== 'function')
    throw new TypeError('independent pure virtual witness callbacks required');
  const body = { format: WITNESS_FORMAT, authorityId: options.authorityId,
    repositoryId: options.repositoryId, deploymentId: options.deploymentId };
  const witness = Object.freeze({ ...body, digest: domainDigest(WITNESS_FORMAT, body) });
  sources.set(witness, { read: options.read, advance: options.advance,
    lastRevision: -1n, lastJournal: null, genesis: null, trust: null, hostCatalog: null,
    format: null, sourcePlan: null, candidatePlan: null, initialSnapshot: null,
    sealer: null, recoveryAuthority: null });
  readPureVirtualDeploymentHeadV1(witness);
  return witness;
}
export function assertPureVirtualDeploymentWitnessV1(value: unknown):
  asserts value is PureVirtualDeploymentWitnessV1 {
  if (!value || typeof value !== 'object' || !sources.has(value))
    throw new TypeError('independently supplied pure virtual witness required');
}
export function readPureVirtualDeploymentHeadV1(witness: PureVirtualDeploymentWitnessV1):
  PureVirtualDeploymentHeadV1 {
  assertPureVirtualDeploymentWitnessV1(witness);
  const source = sources.get(witness)!;
  return checked(witness, source, source.read());
}
export function advancePureVirtualDeploymentHeadV1(witness: PureVirtualDeploymentWitnessV1,
  expectedRevision: string, journal: PureVirtualDeploymentJournal): PureVirtualDeploymentHeadV1 {
  assertPureVirtualDeploymentWitnessV1(witness); decimal(expectedRevision);
  const next = String(BigInt(expectedRevision) + 1n);
  validatePureVirtualDeploymentJournalV1(journal, witness);
  if (journal.witnessRevision !== next) throw new Error('pure virtual witness next revision mismatch');
  const source = sources.get(witness)!;
  if (readPureVirtualDeploymentHeadV1(witness).revision !== expectedRevision)
    throw new Error('stale pure virtual witness revision');
  assertStableIdentity(source, journal);
  const bytes = canonical(journal);
  const accepted = checked(witness, source, source.advance(expectedRevision, bytes));
  if (accepted.revision !== next || accepted.journal !== bytes)
    throw new Error('pure virtual witness did not accept exact journal');
  const retained = readPureVirtualDeploymentHeadV1(witness);
  if (retained.revision !== next || retained.journal !== bytes)
    throw new Error('pure virtual witness did not retain exact journal');
  return retained;
}

/** The witnessed journal is authoritative. The local file is a recoverable
 * mirror; a crash between witness CAS and file rename never creates two heads. */
export class PureVirtualDeploymentJournalStoreV1 {
  private readonly file: string;
  readonly directory: string;
  readonly witness: PureVirtualDeploymentWitnessV1;
  constructor(directory: string, witness: PureVirtualDeploymentWitnessV1) {
    assertPureVirtualDeploymentWitnessV1(witness);
    this.directory = directory; this.witness = witness;
    this.file = join(directory, 'virtual-deployment.json');
  }
  read(): PureVirtualDeploymentJournal | null {
    const head = readPureVirtualDeploymentHeadV1(this.witness);
    if (head.journal === null) {
      if (existsSync(this.file)) throw new Error('local virtual journal exists before witness genesis');
      return null;
    }
    if (existsSync(this.file)) {
      if (statSync(this.file).size > LIMITS.maxFrameBytes)
        throw new RangeError('local virtual journal exceeds bound');
      const local = readFileSync(this.file, 'utf8');
      if (local !== head.journal) {
        // The independent witness wins; a stale or modified mirror cannot be
        // interpreted as deployment authority.
        atomicWrite(this.file, head.journal);
        this.syncDirectory();
      }
    } else { atomicWrite(this.file, head.journal); this.syncDirectory(); }
    return validatePureVirtualDeploymentJournalV1(
      decodeCanonical(Buffer.from(head.journal, 'utf8'), LIMITS), this.witness);
  }
  write(expectedRevision: string, journal: PureVirtualDeploymentJournal): PureVirtualDeploymentJournal {
    advancePureVirtualDeploymentHeadV1(this.witness, expectedRevision, journal);
    const bytes = canonical(journal);
    atomicWrite(this.file, bytes); this.syncDirectory();
    return this.read()!;
  }
  private syncDirectory(): void {
    const fd = openSync(dirname(this.file), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
