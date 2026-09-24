/** Operator-run, process-external journal witness. The secret is supplied as
 * bytes by the caller and is never placed in an argument or environment value.
 * The caller must keep the service storage outside runtime-writable paths. */
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier } from './encoding.ts';
import { domainDigest, validateDigest } from './identity.ts';
import { runtimeSnapshotDigest, validateRuntimeSnapshot } from './snapshot.ts';
import { validateSinkAdapterArtifactDigest, validateSinkPublicAnchor, type SinkPublicAnchorV1 } from './sink-receipt.ts';
import { createNamespacedEffectJournalWitness, createNamespacedEffectJournalWitnessCatalog,
  type NamespacedEffectJournalWitnessCatalog } from './effect-journal-witness.ts';
import { createHostJournalWitness, createHostJournalWitnessCatalog,
  type HostJournalWitnessCatalog } from './host-journal-witness.ts';
import { createDeploymentJournalWitness, type DeploymentJournalWitness } from './deployment-journal-witness.ts';
import { createPureVirtualDeploymentWitnessV1,
  type PureVirtualDeploymentWitnessV1 } from '../tier4/process-virtual-deployment-journal.ts';
import { createSinkStateWitness, validateSinkStateJournalV2, type SinkStateWitnessV1 } from './sink-state-witness.ts';
import { createBudgetJournalWitness, type BudgetJournalWitness, type BudgetJournalKind } from './budget-journal-witness.ts';
import { JournalLock } from './journal-lock.ts';

const FORMAT = 'aether.witness-service/1';
// A canonical 16 MiB journal can nearly double when quoted as the journal
// field of the signed JSON frame. Keep the outer bound above that worst case.
const MAX_FRAME = 36 * 1024 * 1024;
const MAX_JOURNAL = 16 * 1024 * 1024;
const LIMITS = { maxFrameBytes: MAX_FRAME, maxDecompressedBytes: MAX_FRAME, maxObjects: 500_000, maxDepth: 128 };
const HEX = /^[0-9a-f]{64}$/;
const WIRE_WORKER = `import net from 'node:net';
const s=net.createConnection(process.argv[1]);
s.on('connect',()=>process.stdin.pipe(s));
s.on('data',c=>{if(!process.stdout.write(c))s.pause()});
process.stdout.on('drain',()=>s.resume());
s.on('error',()=>process.exitCode=3);
s.on('end',()=>{if(!s.destroyed)s.destroy()});
`;

export type WitnessIdentity =
  | Readonly<{ kind: 'effect'; authorityId: string; repositoryId: string; catalogDeploymentId: string; operationId: string; clockDomain: string }>
  | Readonly<{ kind: 'host'; authorityId: string; repositoryId: string; deploymentId: string; hostId: string }>
  | Readonly<{ kind: 'deployment'; authorityId: string; repositoryId: string; deploymentId: string }>
  | Readonly<{ kind: 'virtual-deployment'; authorityId: string; repositoryId: string; deploymentId: string }>
  | Readonly<{ kind: 'sink'; authorityId: string; repositoryId: string; sinkAuthorityId: string; sinkId: string;
    sinkAnchorDigest: string; adapterArtifactDigest: string }>
  | Readonly<{ kind: 'budget'; authorityId: string; repositoryId: string; deploymentId: string;
    journalKind: BudgetJournalKind; journalId: string }>;
export type WitnessNamespace = Exclude<WitnessIdentity, { kind: 'sink' }>
  | Readonly<{ kind: 'effect-scope'; authorityId: string; repositoryId: string; catalogDeploymentId: string; clockDomain: string }>
  | Readonly<{ kind: 'host-scope'; authorityId: string; repositoryId: string; deploymentId: string }>
  | Readonly<{ kind: 'sink-scope'; authorityId: string; anchor: SinkPublicAnchorV1; adapterArtifactDigest: string }>;
export interface WitnessService { readonly socketPath: string; close(): Promise<void> }
export interface WitnessServiceOptions {
  readonly socketPath: string;
  readonly storageDir: string;
  readonly key: Uint8Array;
  readonly namespaces: readonly WitnessNamespace[];
}
export interface WitnessClientOptions { readonly socketPath: string; readonly key: Uint8Array; readonly timeoutMs?: number }

function assertKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) throw new TypeError('witness key requires at least 32 bytes');
  return Buffer.from(key);
}
function canonical(value: unknown): Buffer { return Buffer.from(encodeCanonical(value, LIMITS)); }
function parse(bytes: Buffer): unknown {
  const value = decodeCanonical(bytes, LIMITS);
  if (!canonical(value).equals(bytes)) throw new TypeError('noncanonical witness frame');
  return value;
}
function frame(value: unknown): Buffer {
  const body = canonical(value);
  if (body.length > MAX_FRAME) throw new RangeError('oversized witness frame');
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
function unframe(bytes: Buffer): unknown {
  if (bytes.length < 4) throw new TypeError('incomplete witness frame');
  const length = bytes.readUInt32BE(0);
  if (!length || length > MAX_FRAME || bytes.length !== length + 4) throw new TypeError('invalid witness frame length');
  return parse(bytes.subarray(4));
}
function mac(key: Buffer, value: unknown): string {
  return createHmac('sha256', key).update(canonical(value)).digest('hex');
}
function matchMac(key: Buffer, body: unknown, signature: unknown): boolean {
  if (typeof signature !== 'string' || !HEX.test(signature)) return false;
  return timingSafeEqual(Buffer.from(mac(key, body), 'hex'), Buffer.from(signature, 'hex'));
}
function identity(value: unknown): WitnessIdentity {
  const record = value as Record<string, unknown>;
  if (!record || typeof record !== 'object') throw new TypeError('missing witness identity');
  if (record.kind === 'sink') {
    exactObject(record, ['kind', 'authorityId', 'repositoryId', 'sinkAuthorityId', 'sinkId',
      'sinkAnchorDigest', 'adapterArtifactDigest']);
    for (const field of ['authorityId', 'repositoryId', 'sinkAuthorityId', 'sinkId']) identifier(record[field]);
    validateDigest(record.sinkAnchorDigest, 'aether.sink-anchor/1');
    validateSinkAdapterArtifactDigest(record.adapterArtifactDigest);
    return record as unknown as WitnessIdentity;
  }
  if (record.kind === 'budget') {
    exactObject(record, ['kind', 'authorityId', 'repositoryId', 'deploymentId', 'journalKind', 'journalId']);
    for (const field of ['authorityId', 'repositoryId', 'deploymentId', 'journalId']) identifier(record[field]);
    if (record.journalKind !== 'ledger' && record.journalKind !== 'bridge')
      throw new TypeError('unsupported budget witness journal kind');
    return record as unknown as WitnessIdentity;
  }
  const fields = record.kind === 'effect'
    ? ['kind', 'authorityId', 'repositoryId', 'catalogDeploymentId', 'operationId', 'clockDomain']
    : record.kind === 'host' ? ['kind', 'authorityId', 'repositoryId', 'deploymentId', 'hostId']
    : record.kind === 'deployment' ? ['kind', 'authorityId', 'repositoryId', 'deploymentId']
    : record.kind === 'virtual-deployment' ? ['kind', 'authorityId', 'repositoryId', 'deploymentId']
    : null;
  if (!fields) throw new TypeError('unsupported witness identity');
  exactObject(record, fields);
  for (const field of fields.slice(1)) identifier(record[field]);
  return record as unknown as WitnessIdentity;
}
function scope(value: unknown): WitnessNamespace {
  const record = value as Record<string, unknown>;
  if (record?.kind === 'sink-scope') {
    exactObject(record, ['kind', 'authorityId', 'anchor', 'adapterArtifactDigest']);
    identifier(record.authorityId); validateSinkPublicAnchor(record.anchor);
    validateSinkAdapterArtifactDigest(record.adapterArtifactDigest);
    return record as unknown as WitnessNamespace;
  }
  if (record?.kind === 'effect-scope') {
    exactObject(record, ['kind', 'authorityId', 'repositoryId', 'catalogDeploymentId', 'clockDomain']);
    for (const field of ['authorityId', 'repositoryId', 'catalogDeploymentId', 'clockDomain']) identifier(record[field]);
    return record as unknown as WitnessNamespace;
  }
  if (record?.kind === 'host-scope') {
    exactObject(record, ['kind', 'authorityId', 'repositoryId', 'deploymentId']);
    for (const field of ['authorityId', 'repositoryId', 'deploymentId']) identifier(record[field]);
    return record as unknown as WitnessNamespace;
  }
  if (record?.kind === 'sink') throw new TypeError('sink witness requires a configured anchor scope');
  return identity(value) as Exclude<WitnessIdentity, { kind: 'sink' }>;
}
function allowed(id: WitnessIdentity, list: readonly WitnessNamespace[]): boolean {
  const exact = canonical(id).toString('utf8');
  return list.some(entry => {
    if (entry.kind === id.kind && canonical(entry).toString('utf8') === exact) return true;
    if (id.kind === 'effect' && entry.kind === 'effect-scope')
      return id.authorityId === entry.authorityId && id.repositoryId === entry.repositoryId
        && id.catalogDeploymentId === entry.catalogDeploymentId && id.clockDomain === entry.clockDomain;
    if (id.kind === 'host' && entry.kind === 'host-scope')
      return id.authorityId === entry.authorityId && id.repositoryId === entry.repositoryId
        && id.deploymentId === entry.deploymentId;
    if (id.kind === 'sink' && entry.kind === 'sink-scope')
      return id.authorityId === entry.authorityId && id.repositoryId === entry.anchor.repositoryId
        && id.sinkAuthorityId === entry.anchor.sinkAuthorityId && id.sinkId === entry.anchor.sinkId
        && id.sinkAnchorDigest === domainDigest('aether.sink-anchor/1', entry.anchor)
        && id.adapterArtifactDigest === entry.adapterArtifactDigest;
    return false;
  });
}
function location(dir: string, id: WitnessIdentity): string {
  return path.join(dir, `${createHash('sha256').update(canonical(id)).digest('hex')}.json`);
}
type Head = Readonly<{ revision: string; journal: string | null }>;
function readHead(dir: string, id: WitnessIdentity, namespaces: readonly WitnessNamespace[]): Head {
  const file = location(dir, id);
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: '0', journal: null };
    throw error;
  }
  const record = exactObject(parse(bytes), ['format', 'identity', 'head']);
  if (record.format !== FORMAT || canonical(record.identity).toString('utf8') !== canonical(id).toString('utf8'))
    throw new Error('witness storage identity mismatch');
  const head = exactObject(record.head, ['revision', 'journal']);
  decimal(head.revision);
  if ((head.revision === '0') !== (head.journal === null)
    || (head.journal !== null && typeof head.journal !== 'string')) throw new Error('invalid witness stored head');
  const result = { revision: head.revision as string, journal: head.journal as string | null };
  if (result.journal !== null) validateJournal(id, result.revision, result.journal, namespaces);
  return result;
}
function validateJournal(id: WitnessIdentity, revision: string, journal: string,
  namespaces: readonly WitnessNamespace[]): void {
  if (!journal || Buffer.byteLength(journal, 'utf8') > MAX_JOURNAL) throw new TypeError('invalid witness journal size');
  const bytes = Buffer.from(journal, 'utf8');
  const value = parse(bytes);
  const record = value as Record<string, unknown>;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('invalid witness journal');
  const expectedFormat = id.kind === 'effect' ? ['aether.effect-journal/2', 'aether.effect-journal/3', 'aether.effect-journal/4', 'aether.effect-journal/5']
    : id.kind === 'host' ? ['aether.process-host/4', 'aether.process-host/5']
      : id.kind === 'virtual-deployment' ? 'aether.process-virtual-deployment/2'
      : id.kind === 'sink' ? 'aether.attested-sink-state/2'
        : id.kind === 'budget' ? (id.journalKind === 'ledger'
          ? 'aether.resource-journal/1' : 'aether.resource-budget-bridge-journal/1')
        : ['aether.process-deployment/9', 'aether.process-deployment/10', 'aether.process-deployment/11', 'aether.process-deployment/12'];
  // The service owns transport, identity, CAS and durable custody. Runtime
  // wrappers validate the richer journal semantics before calling advance.
  const journalFormat = id.kind === 'budget' && id.journalKind === 'bridge'
    ? (record.body as Record<string, unknown> | undefined)?.format : record.format;
  if (Array.isArray(expectedFormat) ? !expectedFormat.includes(journalFormat as string)
    : journalFormat !== expectedFormat)
    throw new TypeError('invalid witness journal format');
  if (id.kind === 'effect') {
    const { kind: _kind, ...parts } = id;
    const body = { format: 'aether.effect-journal-witness/2', ...parts };
    if (record.revision !== revision || record.witnessDigest !== domainDigest(body.format, body)
      || record.clockDomain !== id.clockDomain) throw new TypeError('effect journal witness binding mismatch');
    if (record.format === 'aether.effect-journal/3' || record.format === 'aether.effect-journal/4'
      || record.format === 'aether.effect-journal/5') {
      identifier(record.deploymentId);
      validateDigest(record.approvedAdapterArtifactDigest);
      validateSinkPublicAnchor(record.sinkAnchor);
      if (record.deploymentId !== id.catalogDeploymentId
        || (record.sinkAnchor as { repositoryId: string }).repositoryId !== id.repositoryId)
        throw new TypeError('attested effect journal identity mismatch');
      if (record.format === 'aether.effect-journal/4' || record.format === 'aether.effect-journal/5')
        validateDigest(record.sinkStateWitnessDigest, 'aether.sink-state-witness/1');
      if (record.format === 'aether.effect-journal/5')
        validateDigest(record.budgetBridgeProfileDigest, 'aether.resource-budget-bridge/1');
    }
  }
  if (id.kind === 'budget') {
    const row = id.journalKind === 'ledger'
      ? exactObject(record, ['format', 'ledgerDigest', 'records'])
      : exactObject(exactObject(record, ['body', 'signature']).body,
        ['format', 'profileDigest', 'records']);
    if (id.journalKind === 'bridge' && typeof record.signature !== 'string')
      throw new TypeError('unsigned bridge witness journal');
    validateDigest(id.journalKind === 'ledger' ? row.ledgerDigest : row.profileDigest);
    if (!Array.isArray(row.records)) throw new TypeError('invalid budget witness history');
  }
  if (id.kind === 'deployment') {
    const { kind: _kind, ...parts } = id;
    const body = { format: 'aether.process-deployment-journal-witness/1', ...parts };
    if (record.deploymentJournalWitnessDigest !== domainDigest(body.format, body))
      throw new TypeError('deployment journal witness binding mismatch');
    if (record.format === 'aether.process-deployment/10'
      || record.format === 'aether.process-deployment/11'
      || record.format === 'aether.process-deployment/12') {
      if (record.capabilityProfile !== (record.format === 'aether.process-deployment/12'
        ? 'scoped-anchored-sink-v12' : record.format === 'aether.process-deployment/11'
        ? 'scoped-anchored-sink-v11' : 'scoped-anchored-sink-v10')
        || record.sinkDeploymentId !== id.deploymentId)
        throw new TypeError('sink deployment witness namespace mismatch');
      validateDigest(record.sinkAnchorDigest, 'aether.sink-anchor/1');
      validateDigest(record.sinkStateWitnessDigest, 'aether.sink-state-witness/1');
      validateSinkAdapterArtifactDigest(record.approvedAdapterArtifactDigest);
      if (record.format === 'aether.process-deployment/12') {
        validateDigest(record.activeSinkTableDigest, 'aether.declarative-adapter-table/2');
        validateDigest(record.activeSinkPolicyDigest, 'aether.effect-resource-policy/7');
        if (record.activeRetirementProofDigest !== null)
          validateDigest(record.activeRetirementProofDigest, 'aether.semantic-sink-retirement/2');
        if (record.activePredecessorArtifactDigest !== null)
          validateDigest(record.activePredecessorArtifactDigest, 'aether.process-artifact/2');
        validateDigest(record.semanticExportPolicyDigest, 'aether.semantic-sink-export-policy/2');
        const active = exactObject(record.active, ['id', 'manifest', 'artifactDigest', 'generation']);
        validateDigest(active.artifactDigest, 'aether.process-artifact/2');
      }
    }
  }
  if (id.kind === 'virtual-deployment') {
    const { kind: _kind, ...parts } = id;
    const body = { format: 'aether.process-virtual-deployment-journal-witness/1', ...parts };
    if (record.witnessDigest !== domainDigest(body.format, body)
      || record.repositoryId !== id.repositoryId
      || record.deploymentId !== id.deploymentId
      || record.admissionProfile !== 'strict-lineage-v1'
      || !Array.isArray(record.invocations))
      throw new TypeError('pure virtual deployment witness binding mismatch');
  }
  if (id.kind === 'sink') {
    const configured = namespaces.find(entry => entry.kind === 'sink-scope' && allowed(id, [entry]));
    if (!configured || configured.kind !== 'sink-scope') throw new TypeError('sink witness lacks an operator anchor');
    const trusted = createSinkStateWitness({ authorityId: configured.authorityId,
      anchor: configured.anchor, adapterArtifactDigest: configured.adapterArtifactDigest,
      read: () => ({ revision: '0', journal: null }),
      advance: () => { throw new Error('validation-only sink witness'); } });
    validateSinkStateJournalV2(record, trusted, revision);
  }
  if (id.kind === 'host' && record.format === 'aether.process-host/5') {
    if (!Array.isArray(record.nativeFallbacks)) throw new TypeError('missing native fallback inventory');
    const seen = new Set<string>();
    for (const entry of record.nativeFallbacks) {
      const row = exactObject(entry, ['binding', 'before', 'state', 'result', 'resultDigest']);
      const binding = exactObject(row.binding, ['format', 'id', 'operationId', 'configuration',
        'generation', 'unit', 'processHead', 'manifestDigest', 'astRoot', 'tier1', 'tier2', 'frame',
        'proofDigest', 'compilerProfileDigest', 'sourceSha256', 'executableSha256']);
      if (binding.format !== 'aether.process-native-fallback-binding/1')
        throw new TypeError('invalid native fallback binding format');
      validateDigest(binding.id, 'aether.process-native-fallback-binding/1');
      const { id: _id, ...body } = binding;
      if (binding.id !== domainDigest('aether.process-native-fallback-binding/1', body))
        throw new TypeError('invalid native fallback binding digest');
      if (binding.configuration !== record.configuration)
        throw new TypeError('native fallback binding differs from host configuration');
      if (seen.has(binding.id as string)) throw new TypeError('duplicate native fallback binding');
      seen.add(binding.id as string);
      validateRuntimeSnapshot(row.before);
      if ((binding.frame as { sourceSnapshot?: unknown })?.sourceSnapshot !== runtimeSnapshotDigest(row.before)
        || binding.manifestDigest !== (row.before as { executionManifest: string }).executionManifest)
        throw new TypeError('native fallback binding differs from retained before snapshot');
      if (!['requested', 'running', 'committed', 'aborted'].includes(row.state as string))
        throw new TypeError('invalid native fallback state');
      if (row.state === 'requested' || row.state === 'running') {
        if (row.result !== null || row.resultDigest !== null)
          throw new TypeError('pending native fallback cannot have a result');
      } else {
        if (row.result === null || row.resultDigest === null)
          throw new TypeError('terminal native fallback requires a result and digest');
        validateDigest(row.resultDigest, 'aether.process-native-fallback-outcome/1');
        if (row.resultDigest !== domainDigest('aether.process-native-fallback-outcome/1', row.result))
          throw new TypeError('native fallback result digest mismatch');
      }
    }
  }
  if (id.kind !== 'effect' && id.kind !== 'budget' && record.witnessRevision !== revision)
    throw new TypeError('witness journal revision mismatch');
}
/** Prevent a key holder from pruning already witnessed operation inventory.
 * This is a monotonicity guard, not independent proof of program semantics or
 * of an external sink's commitment. */
function validateRetention(id: WitnessIdentity, priorBytes: string | null, nextBytes: string): void {
  if (priorBytes === null) return;
  const prior = parse(Buffer.from(priorBytes, 'utf8')) as Record<string, unknown>;
  const next = parse(Buffer.from(nextBytes, 'utf8')) as Record<string, unknown>;
  if (prior.format !== next.format) throw new Error('witnessed journal format changed');
  const same = (left: unknown, right: unknown): boolean => canonical(left).equals(canonical(right));
  const array = (record: Record<string, unknown>, field: string): unknown[] => {
    if (!Array.isArray(record[field])) throw new TypeError(`invalid witnessed ${field} inventory`);
    return record[field] as unknown[];
  };
  const prefix = (field: string, check: (oldRow: Record<string, unknown>, newRow: Record<string, unknown>) => void): void => {
    const oldRows = array(prior, field), newRows = array(next, field);
    if (newRows.length < oldRows.length) throw new Error(`witnessed ${field} inventory was removed`);
    for (let index = 0; index < oldRows.length; index++) {
      const oldRow = oldRows[index] as Record<string, unknown>, newRow = newRows[index] as Record<string, unknown>;
      if (!oldRow || !newRow || typeof oldRow !== 'object' || typeof newRow !== 'object')
        throw new TypeError(`invalid witnessed ${field} row`);
      check(oldRow, newRow);
    }
  };
  const fixed = (oldRow: Record<string, unknown>, newRow: Record<string, unknown>, fields: readonly string[]): void => {
    if (fields.some(field => !same(oldRow[field], newRow[field])))
      throw new Error('witnessed operation identity changed');
  };
  const forward = (oldState: unknown, newState: unknown, graph: Record<string, readonly string[]>): void => {
    if (typeof oldState !== 'string' || typeof newState !== 'string'
      || !graph[oldState]?.includes(newState)) throw new Error('witnessed operation state regressed');
  };
  if (id.kind === 'budget') {
    const previous = id.journalKind === 'ledger' ? prior : prior.body as Record<string, unknown>;
    const updated = id.journalKind === 'ledger' ? next : next.body as Record<string, unknown>;
    if (!same(id.journalKind === 'ledger' ? previous.ledgerDigest : previous.profileDigest,
      id.journalKind === 'ledger' ? updated.ledgerDigest : updated.profileDigest))
      throw new Error('witnessed budget identity changed');
    if (id.journalKind === 'ledger') {
      prefix('records', (oldRow, newRow) => {
        if (!same(oldRow, newRow)) throw new Error('witnessed resource transition changed');
      });
      if (array(next, 'records').length !== array(prior, 'records').length + 1)
        throw new Error('resource witness advance must append one transition');
    } else {
      const oldRows = array(previous, 'records'), newRows = array(updated, 'records');
      if (newRows.length < oldRows.length) throw new Error('witnessed budget grants removed');
      oldRows.forEach((oldRowValue, index) => {
        const oldRow = oldRowValue as Record<string, unknown>, newRow = newRows[index] as Record<string, unknown>;
        fixed(oldRow, newRow, ['request', 'grantId', 'reserve']);
        for (const field of ['reserveReceipt', 'settlement', 'settlementReceipt'])
          if (oldRow[field] !== null && !same(oldRow[field], newRow[field]))
            throw new Error('witnessed budget settlement history changed');
        if (oldRow.settlement !== null && newRow.reserveReceipt === null)
          throw new Error('witnessed budget reservation regressed');
      });
      if (newRows.length > oldRows.length + 1)
        throw new Error('budget witness advance added multiple grants');
    }
    return;
  }
  if (id.kind === 'effect') {
    if ((prior.format === 'aether.effect-journal/3' || prior.format === 'aether.effect-journal/4'
      || prior.format === 'aether.effect-journal/5')
      && (!same(prior.sinkAnchor, next.sinkAnchor)
        || !same(prior.deploymentId, next.deploymentId)
        || !same(prior.approvedAdapterArtifactDigest, next.approvedAdapterArtifactDigest)))
      throw new Error('witnessed sink authority or artifact changed');
    if ((prior.format === 'aether.effect-journal/4' || prior.format === 'aether.effect-journal/5')
      && !same(prior.sinkStateWitnessDigest, next.sinkStateWitnessDigest))
      throw new Error('witnessed sink decision authority changed');
    if (prior.format === 'aether.effect-journal/5'
      && !same(prior.budgetBridgeProfileDigest, next.budgetBridgeProfileDigest))
      throw new Error('witnessed budget bridge authority changed');
    const budgeted = prior.format === 'aether.effect-journal/5';
    prefix('records', (oldRow, newRow) => {
      fixed(oldRow, newRow, ['sequence', 'requestDigest', 'adapterId', 'adapterSemanticsDigest']);
      forward(oldRow.state, newRow.state, {
        requested: budgeted ? ['requested', 'reserved', 'rejected', 'aborted', 'indeterminate']
          : ['requested', 'reserved', 'rejected', 'aborted'],
        reserved: budgeted ? ['reserved', 'prepared', 'aborted', 'committed', 'indeterminate']
          : ['reserved', 'prepared', 'aborted'],
        prepared: ['prepared', 'committed', 'indeterminate', 'rejected', 'aborted'],
        indeterminate: ['indeterminate', 'committed', 'aborted'],
        committed: ['committed'], rejected: ['rejected'], aborted: ['aborted'],
      });
      const oldTransitions = array(oldRow, 'transitions'), newTransitions = array(newRow, 'transitions');
      if (newTransitions.length < oldTransitions.length
        || oldTransitions.some((row, index) => !same(row, newTransitions[index])))
        throw new Error('witnessed effect transition prefix changed');
      if (oldRow.signedSinkReceipt !== null && oldRow.signedSinkReceipt !== undefined
        && !same(oldRow.signedSinkReceipt, newRow.signedSinkReceipt))
        throw new Error('witnessed sink receipt changed');
      if (['committed', 'rejected', 'aborted'].includes(oldRow.state as string) && !same(oldRow, newRow))
        throw new Error('witnessed terminal effect changed');
    });
    return;
  }
  if (id.kind === 'sink') {
    prefix('decisions', (oldRow, newRow) => {
      if (!same(oldRow, newRow)) throw new Error('witnessed sink decision changed');
    });
    if (array(next, 'decisions').length !== array(prior, 'decisions').length + 1)
      throw new Error('sink witness advance must add exactly one decision');
    return;
  }
  if (id.kind === 'host') {
    if (prior.format === 'aether.process-host/5') {
      prefix('nativeFallbacks', (oldRow, newRow) => {
        fixed(oldRow, newRow, ['binding', 'before']);
        forward(oldRow.state, newRow.state, {
          requested: ['requested', 'running', 'committed', 'aborted'],
          running: ['running', 'committed', 'aborted'],
          committed: ['committed'], aborted: ['aborted'],
        });
        if (['committed', 'aborted'].includes(oldRow.state as string) && !same(oldRow, newRow))
          throw new Error('witnessed terminal native fallback changed');
      });
    }
    prefix('calls', (oldRow, newRow) => {
      fixed(oldRow, newRow, ['operationId', 'requestDigest', 'symbol', 'generation', 'unit']);
      forward(oldRow.state, newRow.state, {
        running: ['running', 'indeterminate', 'completed', 'aborted'],
        indeterminate: ['indeterminate', 'completed', 'aborted'],
        completed: ['completed'], aborted: ['aborted'],
      });
      const oldEffects = array(oldRow, 'effects'), newEffects = array(newRow, 'effects');
      if (newEffects.length < oldEffects.length) throw new Error('witnessed host effect inventory was removed');
      oldEffects.forEach((effect, index) => {
        const before = effect as Record<string, unknown>, after = newEffects[index] as Record<string, unknown>;
        fixed(before, after, ['id', 'requestDigest', 'capability', 'parentOperationId', 'index']);
        forward(before.state, after.state, {
          requested: ['requested', 'dispatching', 'committed', 'rejected', 'aborted', 'indeterminate'],
          dispatching: ['dispatching', 'committed', 'rejected', 'aborted', 'indeterminate'],
          indeterminate: ['indeterminate', 'committed', 'rejected', 'aborted'],
          committed: ['committed'], rejected: ['rejected'], aborted: ['aborted'],
        });
        if (['committed', 'rejected', 'aborted'].includes(before.state as string) && !same(before, after))
          throw new Error('witnessed terminal host effect changed');
      });
      const oldBoundaries = array(oldRow, 'boundaries'), newBoundaries = array(newRow, 'boundaries');
      if (newBoundaries.length < oldBoundaries.length || oldBoundaries.some((row, index) => !same(row, newBoundaries[index])))
        throw new Error('witnessed call boundary history changed');
      if (['completed', 'aborted'].includes(oldRow.state as string)) {
        const { recovery: oldRecovery, ...oldBody } = oldRow;
        const { recovery: newRecovery, ...newBody } = newRow;
        if (!same(oldBody, newBody) || oldRecovery !== null && !same(oldRecovery, newRecovery)
          || oldRecovery === null && newRecovery !== null &&
            (oldRow.state !== 'completed' || (newRecovery as Record<string, unknown>)?.strategy !== 'isolated-replay'))
          throw new Error('witnessed terminal host call changed');
      }
    });
    prefix('allocations', (oldRow, newRow) => {
      if (!same(oldRow, newRow)) throw new Error('witnessed allocation receipt changed');
    });
    prefix('migrations', (oldRow, newRow) => {
      fixed(oldRow, newRow, ['migrationId', 'requestDigest', 'symbol', 'target', 'fromGeneration',
        'toGeneration', 'beforePlan', 'afterPlan', 'before', 'after', 'decisionDigest']);
      forward(oldRow.state, newRow.state, {
        requested: ['requested', 'prepared', 'aborted'], prepared: ['prepared', 'committed', 'aborted'],
        committed: ['committed', 'finalized'], finalized: ['finalized'], aborted: ['aborted'],
      });
      if (['finalized', 'aborted'].includes(oldRow.state as string) && !same(oldRow, newRow))
        throw new Error('witnessed terminal migration changed');
    });
    prefix('checkpointLeases', (oldRow, newRow) => {
      fixed(oldRow, newRow, ['binding']);
      forward(oldRow.state, newRow.state, {
        active: ['active', 'committed', 'aborted'], committed: ['committed'], aborted: ['aborted'],
      });
      const oldCheckpoints = array(oldRow, 'checkpoints'), newCheckpoints = array(newRow, 'checkpoints');
      if (newCheckpoints.length < oldCheckpoints.length
        || oldCheckpoints.some((row, index) => !same(row, newCheckpoints[index])))
        throw new Error('witnessed checkpoint ancestry changed');
      if (newCheckpoints.length === 0 || newRow.latestCheckpoint !== newCheckpoints.at(-1))
        throw new Error('witnessed checkpoint head differs from retained ancestry');
      if (['committed', 'aborted'].includes(oldRow.state as string) && !same(oldRow, newRow))
        throw new Error('witnessed terminal checkpoint lease changed');
    });
    for (const field of ['heads', 'snapshots', 'checkpointControls', 'checkpointReceipts']) {
      if (prior[field] === undefined && next[field] === undefined) continue;
      prefix(field, (oldRow, newRow) => { if (!same(oldRow, newRow)) throw new Error(`witnessed ${field} history changed`); });
    }
    return;
  }
  if (id.kind === 'virtual-deployment') {
    if (prior.genesisManifest !== next.genesisManifest
      || prior.trustDigest !== next.trustDigest
      || prior.hostWitnessCatalogDigest !== next.hostWitnessCatalogDigest)
      throw new Error('witnessed pure virtual deployment authority changed');
    const previous = prior.active as Record<string, unknown>;
    const updated = next.active as Record<string, unknown>;
    const oldState = prior.readiness as string, newState = next.readiness as string;
    if (!({ ready: ['ready', 'preparing'], preparing: ['prepared', 'ready'],
      prepared: ['ready'] } as Record<string, string[]>)[oldState]?.includes(newState))
      throw new Error('witnessed pure virtual preparation state regressed');
    if (oldState === 'ready' && newState === 'preparing'
      && (next.pendingProposal === null || next.preparedDigest !== null))
      throw new Error('witnessed pure virtual preparation lacks proposal');
    if (oldState === 'preparing' && newState === 'prepared'
      && (prior.pendingProposal !== next.pendingProposal || next.preparedDigest === null))
      throw new Error('witnessed pure virtual prepared binding changed');
    if (oldState !== 'ready' && newState === 'ready'
      && (next.pendingProposal !== null || next.preparedDigest !== null))
      throw new Error('witnessed pure virtual terminal preparation did not clear');
    if (oldState === 'ready' && newState === 'ready' && !same(previous, updated))
      throw new Error('witnessed pure virtual active target changed without preparation');
    if (previous.generation !== updated.generation
      && !(previous.generation === '0' && updated.generation === '1'
        && prior.readiness === 'prepared' && next.readiness === 'ready'))
      throw new Error('witnessed pure virtual generation changed without prepared commit');
    if (previous.generation === updated.generation && !same(previous, updated))
      throw new Error('witnessed pure virtual active target changed');
    prefix('invocations', (oldRow, newRow) => {
      fixed(oldRow, newRow, ['operationId', 'requestDigest', 'manifest', 'generation', 'symbol', 'args']);
      forward(oldRow.phase, newRow.phase, { pending: ['pending', 'settled'], settled: ['settled'] });
      if (oldRow.phase === 'settled' && !same(oldRow, newRow))
        throw new Error('witnessed pure virtual settled operation changed');
    });
    if (array(next, 'invocations').length > array(prior, 'invocations').length
      && !(oldState === 'ready' && newState === 'ready'))
      throw new Error('witnessed pure virtual call was added while promotion frozen');
    return;
  }
  if ((prior.format === 'aether.process-deployment/10'
      || prior.format === 'aether.process-deployment/11'
      || prior.format === 'aether.process-deployment/12')
    && ['sinkAnchorDigest', 'sinkDeploymentId', 'approvedAdapterArtifactDigest',
      'sinkStateWitnessDigest'].some(field => !same(prior[field], next[field])))
    throw new Error('witnessed sink deployment identity changed');
  if (prior.format === 'aether.process-deployment/12'
    && !same(prior.semanticExportPolicyDigest, next.semanticExportPolicyDigest))
    throw new Error('witnessed semantic export authority changed');
  prefix('invocations', (oldRow, newRow) => {
    fixed(oldRow, newRow, ['operationId', 'requestDigest', 'heapId', 'deployment', 'symbol', 'unit']);
    forward(oldRow.phase, newRow.phase, { pending: ['pending', 'settled'], settled: ['settled'] });
    if (oldRow.phase === 'settled' && !same(oldRow, newRow))
      throw new Error('witnessed settled invocation changed');
  });
  prefix('allocations', (oldRow, newRow) => {
    fixed(oldRow, newRow, ['operationId', 'requestDigest', 'heapId', 'deployment']);
    if (oldRow.result !== null && !same(oldRow, newRow))
      throw new Error('witnessed settled allocation changed');
  });
}
function writeHead(dir: string, id: WitnessIdentity, head: Head): void {
  const dest = location(dir, id);
  const tmp = path.join(dir, `.witness-${randomBytes(16).toString('hex')}.tmp`);
  const bytes = canonical({ format: FORMAT, identity: id, head });
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, dest);
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function signedResponse(key: Buffer, nonce: string, result: { ok: true; head: Head } | { ok: false; code: string }): Buffer {
  const body = { format: FORMAT, nonce, ...result };
  return frame({ ...body, mac: mac(key, body) });
}
function processRequest(bytes: Buffer, key: Buffer, namespaces: readonly WitnessNamespace[], dir: string): Buffer | null {
  let request: Record<string, unknown>;
  try {
    request = exactObject(unframe(bytes), ['format', 'nonce', 'op', 'identity', 'expectedRevision', 'journal', 'mac']);
    if (request.format !== FORMAT || typeof request.nonce !== 'string' || !HEX.test(request.nonce)
      || !['read', 'advance'].includes(request.op as string)) return null;
    const body = { format: request.format, nonce: request.nonce, op: request.op,
      identity: request.identity, expectedRevision: request.expectedRevision, journal: request.journal };
    if (!matchMac(key, body, request.mac)) return null;
  } catch { return null; }
  const nonce = request.nonce as string;
  try {
    const id = identity(request.identity);
    if (!allowed(id, namespaces)) return signedResponse(key, nonce, { ok: false, code: 'DENIED' });
    if (request.op === 'read') {
      if (request.expectedRevision !== null || request.journal !== null) throw new TypeError('invalid read request');
      return signedResponse(key, nonce, { ok: true, head: readHead(dir, id, namespaces) });
    }
    decimal(request.expectedRevision);
    if (typeof request.journal !== 'string') throw new TypeError('missing witness journal');
    const nextRevision = String(BigInt(request.expectedRevision) + 1n);
    validateJournal(id, nextRevision, request.journal, namespaces);
    const current = readHead(dir, id, namespaces);
    if (current.revision !== request.expectedRevision) return signedResponse(key, nonce, { ok: false, code: 'STALE' });
    validateRetention(id, current.journal, request.journal);
    const head = { revision: nextRevision, journal: request.journal };
    try {
      writeHead(dir, id, head);
      return signedResponse(key, nonce, { ok: true, head: readHead(dir, id, namespaces) });
    } catch {
      // Rename may have committed before fsync/read failed. The caller must
      // reread and reconcile; never report a definite validation failure.
      return signedResponse(key, nonce, { ok: false, code: 'UNCERTAIN' });
    }
  } catch {
    return signedResponse(key, nonce, { ok: false, code: 'INVALID' });
  }
}

export async function startWitnessService(options: WitnessServiceOptions): Promise<WitnessService> {
  const key = assertKey(options.key);
  if (!path.isAbsolute(options.socketPath) || !path.isAbsolute(options.storageDir))
    throw new TypeError('witness paths must be absolute');
  if (!Array.isArray(options.namespaces) || !options.namespaces.length) throw new TypeError('empty witness allowlist');
  const namespaces = options.namespaces.map(scope);
  const socketParent = fs.lstatSync(path.dirname(options.socketPath));
  if (!socketParent.isDirectory() || socketParent.isSymbolicLink()
    || socketParent.uid !== process.getuid?.() || (socketParent.mode & 0o022))
    throw new Error('witness socket parent must be service-owned and non-writable to clients');
  fs.mkdirSync(options.storageDir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(options.storageDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid?.()
    || (dirStat.mode & 0o077))
    throw new Error('witness storage directory must be private');
  const lock = new JournalLock({ directory: path.join(options.storageDir, '.service-lock'),
    domain: 'aether.witness-service', maxTickets: 10_000, busyError: 'witness storage already served' });
  lock.recoverDeadWriter(false);
  let release!: () => void;
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  let ready!: (service: WitnessService) => void;
  let failed!: (reason: unknown) => void;
  const started = new Promise<WitnessService>((resolve, reject) => { ready = resolve; failed = reject; });
  const serving = lock.runAsync(async () => {
    try {
      try {
        const prior = fs.lstatSync(options.socketPath);
        if (!prior.isSocket()) throw new Error('witness socket path occupied');
        await new Promise<void>((resolve, reject) => {
          const probe = net.createConnection(options.socketPath);
          probe.once('connect', () => { probe.destroy(); reject(new Error('witness socket already live')); });
          probe.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ECONNREFUSED') resolve(); else reject(error);
          });
        });
        fs.unlinkSync(options.socketPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const server = net.createServer({ allowHalfOpen: true }, socket => {
        const chunks: Buffer[] = []; let size = 0; let rejected = false;
        socket.setTimeout(5000, () => socket.destroy());
        socket.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_FRAME + 4 || (size >= 4 && Buffer.concat(chunks.concat(chunk), Math.min(size, 4)).readUInt32BE(0) > MAX_FRAME)) {
            rejected = true; socket.destroy(); return;
          }
          chunks.push(chunk);
        });
        socket.on('end', () => {
          if (rejected) return;
          const response = processRequest(Buffer.concat(chunks, size), key, namespaces, options.storageDir);
          if (response) socket.end(response); else socket.destroy();
        });
        socket.on('error', () => socket.destroy());
      });
      server.maxConnections = 4;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(options.socketPath, () => { server.off('error', reject); resolve(); });
      });
      fs.chmodSync(options.socketPath, 0o600);
      ready({ socketPath: options.socketPath, close: async () => {
        try {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        } finally {
          release();
          await serving;
        }
      } });
      await lifetime;
    } catch (error) { failed(error); throw error; }
  }, 250);
  serving.catch(failed);
  return started;
}

export function createProcessWitnessClient(options: WitnessClientOptions): {
  effectCatalog(namespace: Readonly<{ authorityId: string; repositoryId: string; deploymentId: string; clockDomain: string }>): NamespacedEffectJournalWitnessCatalog;
  hostCatalog(namespace: Readonly<{ authorityId: string; repositoryId: string; deploymentId: string }>): HostJournalWitnessCatalog;
  deploymentWitness(namespace: Readonly<{ authorityId: string; repositoryId: string; deploymentId: string }>): DeploymentJournalWitness;
  virtualDeploymentWitness(namespace: Readonly<{ authorityId: string; repositoryId: string; deploymentId: string }>): PureVirtualDeploymentWitnessV1;
  sinkStateWitness(namespace: Readonly<{ authorityId: string; anchor: SinkPublicAnchorV1;
    adapterArtifactDigest: string }>): SinkStateWitnessV1;
  budgetJournalWitness(namespace: Readonly<{ authorityId: string; repositoryId: string;
    deploymentId: string; journalKind: BudgetJournalKind; journalId: string }>): BudgetJournalWitness;
} {
  const key = assertKey(options.key);
  if (!path.isAbsolute(options.socketPath)) throw new TypeError('witness socket path must be absolute');
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new TypeError('invalid witness timeout');
  const call = (id: WitnessIdentity, op: 'read' | 'advance', expectedRevision: string | null,
    journal: string | null): Head => {
    identity(id);
    const nonce = randomBytes(32).toString('hex');
    const body = { format: FORMAT, nonce, op, identity: id, expectedRevision, journal };
    const request = frame({ ...body, mac: mac(key, body) });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', WIRE_WORKER, options.socketPath],
      { input: request, encoding: 'buffer', maxBuffer: MAX_FRAME + 4, timeout });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout))
      throw new Error('uncertain witness response');
    let response: Record<string, unknown>;
    try {
      const candidate = unframe(result.stdout) as Record<string, unknown>;
      response = exactObject(candidate, ['format', 'nonce', 'ok', candidate?.ok === true ? 'head' : 'code', 'mac']);
      if (response.format !== FORMAT || response.nonce !== nonce || typeof response.ok !== 'boolean')
        throw new TypeError('wrong witness response');
      const signed = response.ok
        ? { format: response.format, nonce: response.nonce, ok: response.ok, head: response.head }
        : { format: response.format, nonce: response.nonce, ok: response.ok, code: response.code };
      if (!matchMac(key, signed, response.mac)) throw new TypeError('altered witness response');
      if (!response.ok) {
        if (response.code === 'UNCERTAIN') throw new Error('uncertain witness response');
        if (!['STALE', 'DENIED', 'INVALID'].includes(response.code as string)) throw new TypeError('unknown witness error');
        throw new Error(`witness ${response.code}`);
      }
      const head = exactObject(response.head, ['revision', 'journal']);
      decimal(head.revision);
      if ((head.revision === '0') !== (head.journal === null) || (head.journal !== null && typeof head.journal !== 'string'))
        throw new TypeError('invalid witness head');
      return { revision: head.revision as string, journal: head.journal as string | null };
    } catch (error) {
      if (error instanceof Error && /^witness (STALE|DENIED|INVALID)$/.test(error.message)) throw error;
      throw new Error('uncertain witness response', { cause: error });
    }
  };
  return {
    effectCatalog: namespace => {
      const selected = new Map<string, ReturnType<typeof createNamespacedEffectJournalWitness>>();
      return createNamespacedEffectJournalWitnessCatalog({ ...namespace,
      witnessFor: operationId => {
        const prior = selected.get(operationId);
        if (prior) return prior;
        const id = { kind: 'effect' as const, authorityId: namespace.authorityId,
          repositoryId: namespace.repositoryId, catalogDeploymentId: namespace.deploymentId,
          operationId, clockDomain: namespace.clockDomain };
        const witness = createNamespacedEffectJournalWitness({ ...id,
          read: () => call(id, 'read', null, null),
          advance: (revision, journal) => call(id, 'advance', revision, journal) });
        selected.set(operationId, witness);
        return witness;
      } });
    },
    hostCatalog: namespace => {
      const selected = new Map<string, ReturnType<typeof createHostJournalWitness>>();
      return createHostJournalWitnessCatalog({ ...namespace,
      witnessFor: hostId => {
        const prior = selected.get(hostId);
        if (prior) return prior;
        const id = { kind: 'host' as const, ...namespace, hostId };
        const witness = createHostJournalWitness({ ...namespace, hostId,
          read: () => call(id, 'read', null, null),
          advance: (revision, journal) => call(id, 'advance', revision, journal) });
        selected.set(hostId, witness);
        return witness;
      } });
    },
    deploymentWitness: namespace => {
      const id = { kind: 'deployment' as const, ...namespace };
      return createDeploymentJournalWitness({ ...namespace,
        read: () => call(id, 'read', null, null),
        advance: (revision, journal) => call(id, 'advance', revision, journal) });
    },
    virtualDeploymentWitness: namespace => {
      const id = { kind: 'virtual-deployment' as const, ...namespace };
      return createPureVirtualDeploymentWitnessV1({ ...namespace,
        read: () => call(id, 'read', null, null),
        advance: (revision, journal) => call(id, 'advance', revision, journal) });
    },
    sinkStateWitness: namespace => {
      validateSinkPublicAnchor(namespace.anchor);
      validateSinkAdapterArtifactDigest(namespace.adapterArtifactDigest);
      const id = { kind: 'sink' as const, authorityId: namespace.authorityId,
        repositoryId: namespace.anchor.repositoryId, sinkAuthorityId: namespace.anchor.sinkAuthorityId,
        sinkId: namespace.anchor.sinkId,
        sinkAnchorDigest: domainDigest('aether.sink-anchor/1', namespace.anchor),
        adapterArtifactDigest: namespace.adapterArtifactDigest };
      return createSinkStateWitness({ ...namespace,
        read: () => call(id, 'read', null, null),
        advance: (revision, journal) => call(id, 'advance', revision, journal) });
    },
    budgetJournalWitness: namespace => {
      const id = { kind: 'budget' as const, ...namespace };
      return createBudgetJournalWitness({ ...namespace,
        read: () => call(id, 'read', null, null),
        advance: (revision, journal) => call(id, 'advance', revision, journal) });
    },
  };
}
