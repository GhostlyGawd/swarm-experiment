import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { generateRecordFallbackCertificate } from '../../src/tier2/record-fallback-proof-producer.ts';
import { checkRecordFallbackCertificate } from '../../src/tier2/record-fallback-proof-checker.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { selectHostJournalWitness } from '../../src/fabric/host-journal-witness.ts';
import { ProcessHost, type ProcessHostOptions, type ProcessHostPhase } from '../../src/tier4/process-host.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
import { lowerProvedFallbackAst } from '../../roadmap/v4/research/native-fallback-ast/compiler.ts';
import { buildProgram } from '../../roadmap/v4/research/native-fallback-ast/verify.ts';
import { fallbackFixture } from '../tier3/fallback-tree-fixture.ts';

export const nativeRepositoryId = 'repo:native-fallback-host';
export const nativeDeploymentId = 'deployment:native-fallback-host';
export const nativeHostId = 'host:native-fallback';
export const nativeWitnessAuthority = 'operator:native-fallback';
interface ArtifactRecord { readonly executablePath: string; readonly expectedExecutableSha256: string;
  readonly sourceSha256: string }
function source(directory: string) {
  const f = fallbackFixture(join(directory, 'source-' + process.pid), 'fallback');
  const registry = new CapabilityRegistry();
  const digest = (value: string) => domainDigest('aether.native-fallback-host-test/1', value);
  const module = f.options.module, tier1 = f.options.tier1, tier2 = f.options.tier2;
  const manifest = createEvidenceManifest({ module, registry,
    specification: 'Witnessed native fallback host transaction.',
    semanticsVersion: 'reference/1', compilerDigest: digest('compiler'),
    capabilityPolicyDigest: digest('pure-policy'),
    target: { abiVersion: 'process/1', profileDigest: digest('profile'),
      artifactDigest: digest('artifact') } });
  const context = { module, manifest, tier2 };
  const certificate = generateRecordFallbackCertificate(context);
  if (!certificate) throw new Error('native host fixture lacks checked record proof');
  const checkedProof = checkRecordFallbackCertificate(context, certificate);
  const lowered = lowerProvedFallbackAst({ module, manifest, tier1, tier2,
    conservativeCertificate: certificate });
  const plan: TopologyPlan = { shape: 'containers',
    units: [{ id: 'worker', members: [tier1, tier2], capabilities: [],
      placement: 'container', memoryMb: 16 }], crossEdges: [],
    transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [],
    blockedMerges: [] };
  return { f, registry, module, manifest, tier1, tier2, plan, checkedProof, lowered };
}
/** Build the exact proof-bearing executable once. Later controllers read the
 * pinned expected digest rather than accepting whatever bytes are at the path. */
export function prepareNativeFallbackArtifact(directory: string): ArtifactRecord {
  const config = source(directory);
  const built = buildProgram(join(directory, 'native'), 'fallback',
    { module: config.module, manifest: config.manifest },
    generateRecordFallbackCertificate({ module: config.module,
      manifest: config.manifest, tier2: config.tier2 })!);
  if (built.lowered.sourceSha256 !== config.lowered.sourceSha256)
    throw new Error('native fallback source build differs from checked proof');
  const artifact = { executablePath: built.binary,
    expectedExecutableSha256: built.binarySha256,
    sourceSha256: built.lowered.sourceSha256 };
  writeFileSync(join(directory, 'native-artifact.json'), JSON.stringify(artifact), { mode: 0o600 });
  return artifact;
}
export function nativeFallbackHostFixture(directory: string) {
  const config = source(directory);
  const artifact = JSON.parse(readFileSync(join(directory, 'native-artifact.json'), 'utf8')) as ArtifactRecord;
  if (artifact.sourceSha256 !== config.lowered.sourceSha256)
    throw new Error('native fallback source/proof changed across controllers');
  const witness = createProcessWitnessClient({ socketPath: join(directory, 'witness.sock'),
    key: readFileSync(join(directory, 'witness.key')), timeoutMs: 10_000 });
  const hostCatalog = witness.hostCatalog({ authorityId: nativeWitnessAuthority,
    repositoryId: nativeRepositoryId, deploymentId: nativeDeploymentId });
  const hostJournalWitness = selectHostJournalWitness(hostCatalog, nativeHostId);
  let revoked = false;
  let recoveryAllowed = true;
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(57),
    repositoryId: nativeRepositoryId, clock: () => 100, policyEpoch: () => '0',
    revocationEpoch: () => revoked ? '1' : '0', isRevoked: () => revoked,
    authorizeIssue: () => true, authorizeDelegate: () => true });
  const base: ProcessHostOptions = { directory: join(directory, 'host'), module: config.module,
    manifest: config.manifest, plan: config.plan, registry: config.registry,
    sealer: new CapabilitySealer(new Uint8Array(32).fill(58), () => 100),
    scopedGrants: grants, hostJournalWitness, authorizeRecovery: () => recoveryAllowed,
    nativeFallback: { tier1: config.tier1, tier2: config.tier2,
      checkedProof: config.checkedProof, executablePath: artifact.executablePath,
      expectedExecutableSha256: artifact.expectedExecutableSha256,
      lowered: config.lowered } };
  return { ...config, artifact, hostJournalWitness,
    open: (onPhase?: (phase: ProcessHostPhase) => void) =>
      ProcessHost.open({ ...base, ...(onPhase ? { onPhase: phase => onPhase(phase) } : {}) }),
    tokens: (host: ProcessHost) => ({ tier1: host.issueScopedTokens(config.tier1),
      tier2: host.issueScopedTokens(config.tier2) }),
    revoke: () => { revoked = true; },
    denyRecovery: () => { recoveryAllowed = false; } };
}
