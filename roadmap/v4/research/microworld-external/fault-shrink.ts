/** Bounded delta debugging of a real witnessed external-sink response fault. */
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { domainDigest, executionManifestDigest, type Digest } from '../../../../src/fabric/identity.ts';
import { assertLivingEffectAuthorizationV4 } from '../../../../src/tier3/living-effect-authorization.ts';
import { effectResourcePolicyDigestV2 } from '../../../../src/tier2/effect-resource-policy.ts';
import { auditExternalRaw, prepareExternal, runExternal, type ExternalCampaignResult,
  type ExternalFaultActionV1, type ExternalRegistration } from './harness.ts';
import { externalFixture, EXTERNAL_REPOSITORY } from './fixture.ts';

export const EXTERNAL_FAULT_SHRINK_PROFILE = 'aether.living-external-fault-shrink/1' as const;
export interface ExternalFaultObservationV1 {
  readonly format: 'aether.living-external-fault-observation/1';
  readonly ordinal: number; readonly actions: readonly ExternalFaultActionV1[];
  readonly candidateRoot: Digest; readonly executionManifestDigest: Digest;
  readonly effectPolicyBodyDigest: Digest; readonly registrationDigest: Digest;
  readonly resultDigest: Digest; readonly directory: string;
  readonly generated: number; readonly executed: number; readonly filtered: number;
  readonly attempted: number; readonly sinkDecisions: number; readonly elapsedNs: string;
  readonly property: 'committed-sink-unknown-host-then-signed-recovery';
}
export interface ExternalFaultCounterexampleV1 {
  readonly format: typeof EXTERNAL_FAULT_SHRINK_PROFILE;
  readonly seed: string; readonly candidateRoot: Digest;
  readonly original: ExternalFaultObservationV1;
  readonly shrunk: ExternalFaultObservationV1;
  readonly proposals: readonly ExternalFaultObservationV1[];
  readonly attempts: number; readonly reductions: number; readonly limitReached: boolean;
  readonly productionAuthorized: false;
}
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, encodeCanonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
  const dirFd = openSync(dirname(path), 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}
function property(result: ExternalCampaignResult, registration: ExternalRegistration): void {
  const root = externalFixture().manifest.candidateRoot;
  if (registration.authorization.executionManifest.astRoot !== root
    || result.format !== 'aether.living-external-campaign/3'
    || result.generated !== 15 || result.executed !== 15 || result.filtered !== 0
    || result.passed !== 15 || result.failed !== 0 || result.partitionAttempt.passed
    || result.partitionAttempt.filtered || result.partitionAttempt.externalEffects.indeterminate !== 1
    || result.partitionUnknown !== 1 || result.reconciled !== 1
    || result.candidateRestarts !== 1 || result.workerTermination !== 'SIGKILL'
    || result.sinkDecisions !== 9
    || result.pipeline.failedAttempts !== 1 || result.pipeline.filteredAttempts !== 0
    || result.pipeline.recoveries !== 2
    || result.pipeline.phases[0].complete || !result.pipeline.phases[1].complete
    || result.pipeline.phases[0].authorizationDigest !== result.pipeline.phases[1].authorizationDigest)
    throw new Error('external-sink fault property did not survive');
}
export async function observeExternalFault(directory: string, ordinal: number,
  actions: readonly ExternalFaultActionV1[]): Promise<ExternalFaultObservationV1> {
  if (existsSync(directory)) throw new Error('fault observation requires new directory');
  const privateDirectory = mkdtempSync(join(tmpdir(), 'aether-external-fault-private-'));
  try {
    const started = process.hrtime.bigint();
    const prepared = await prepareExternal(privateDirectory, directory);
    const result = await runExternal(prepared, directory, actions);
    property(result, prepared.registration);
    auditExternalRaw(directory, result, prepared.registration);
    write(join(directory, 'result.json'), result);
    const authorization = prepared.registration.authorization;
    if (authorization.format !== 'aether.living-effect-authorization/4') throw new TypeError('V4 fault authority required');
    const observation: ExternalFaultObservationV1 = {
      format: 'aether.living-external-fault-observation/1', ordinal, actions: [...actions],
      candidateRoot: authorization.executionManifest.astRoot,
      executionManifestDigest: executionManifestDigest(authorization.executionManifest),
      effectPolicyBodyDigest: effectResourcePolicyDigestV2(authorization.signedPolicy.body),
      registrationDigest: domainDigest('aether.living-external-registration/1', prepared.registration),
      resultDigest: domainDigest('aether.living-external-campaign/3', result),
      directory: `observations/${ordinal}`,
      generated: result.generated, executed: result.executed, filtered: result.filtered,
      attempted: result.attempted, sinkDecisions: result.sinkDecisions,
      elapsedNs: String(process.hrtime.bigint() - started),
      property: 'committed-sink-unknown-host-then-signed-recovery',
    };
    write(join(directory, 'observation.json'), observation);
    return observation;
  } finally { rmSync(privateDirectory, { recursive: true, force: true }); }
}
export async function shrinkExternalFault(root: string, seed: string,
  originalActions: readonly ExternalFaultActionV1[], limit: number): Promise<ExternalFaultCounterexampleV1> {
  if (existsSync(root) || !Number.isSafeInteger(limit) || limit < 1 || limit > 16
    || !seed || new Set(originalActions).size !== originalActions.length) throw new TypeError('invalid shrink registration');
  mkdirSync(join(root, 'observations'), { recursive: true });
  const original = await observeExternalFault(join(root, 'observations', '0'), 0, originalActions);
  let shrunk = original, current = [...originalActions], attempts = 0, reductions = 0;
  const proposals: ExternalFaultObservationV1[] = [];
  let changed = true;
  while (changed && attempts < limit) {
    changed = false;
    for (let index = 0; index < current.length && attempts < limit; index++) {
      const proposal = current.filter((_, candidate) => candidate !== index);
      const ordinal = proposals.length + 1;
      const observation = await observeExternalFault(join(root, 'observations', String(ordinal)), ordinal, proposal);
      proposals.push(observation); attempts++;
      if (observation.candidateRoot === original.candidateRoot
        && observation.executionManifestDigest === original.executionManifestDigest
        && observation.effectPolicyBodyDigest === original.effectPolicyBodyDigest
        && observation.property === original.property && proposal.length < current.length) {
        current = proposal; shrunk = observation; reductions++; changed = true; break;
      }
    }
  }
  const witness: ExternalFaultCounterexampleV1 = { format: EXTERNAL_FAULT_SHRINK_PROFILE,
    seed, candidateRoot: original.candidateRoot, original, shrunk, proposals,
    attempts, reductions, limitReached: attempts === limit, productionAuthorized: false };
  write(join(root, 'counterexample.json'), witness);
  return witness;
}
export function auditExternalFault(root: string, witness: ExternalFaultCounterexampleV1): void {
  const saved = JSON.parse(readFileSync(join(root, 'counterexample.json'), 'utf8'));
  if (Buffer.compare(Buffer.from(encodeCanonical(saved)), Buffer.from(encodeCanonical(witness))) !== 0
    || witness.format !== EXTERNAL_FAULT_SHRINK_PROFILE
    || witness.candidateRoot !== externalFixture().manifest.candidateRoot
    || witness.attempts !== witness.proposals.length
    || witness.reductions < 1 || witness.shrunk.actions.length >= witness.original.actions.length)
    throw new Error('external fault witness changed');
  for (const observation of [witness.original, ...witness.proposals]) {
    const path = join(root, observation.directory), savedObservation = JSON.parse(readFileSync(join(path, 'observation.json'), 'utf8')),
      registration = JSON.parse(readFileSync(join(path, 'registration.json'), 'utf8')) as ExternalRegistration,
      result = JSON.parse(readFileSync(join(path, 'result.json'), 'utf8')) as ExternalCampaignResult;
    const fixture = externalFixture();
    assertLivingEffectAuthorizationV4(registration.authorization, {
      candidateRoot: fixture.manifest.candidateRoot, campaignDigest: fixture.campaignDigest,
      repositoryId: EXTERNAL_REPOSITORY, policyEpoch: '1',
      signer: 'living-integrated-operator', key: registration.operatorPublicKeyPem });
    if (Buffer.compare(Buffer.from(encodeCanonical(savedObservation)), Buffer.from(encodeCanonical(observation))) !== 0
      || domainDigest('aether.living-external-registration/1', registration) !== observation.registrationDigest
      || domainDigest('aether.living-external-campaign/3', result) !== observation.resultDigest
      || executionManifestDigest(registration.authorization.executionManifest) !== observation.executionManifestDigest
      || registration.authorization.format !== 'aether.living-effect-authorization/4'
      || effectResourcePolicyDigestV2(registration.authorization.signedPolicy.body) !== observation.effectPolicyBodyDigest
      || JSON.stringify(result.faultActions) !== JSON.stringify(observation.actions)
      || BigInt(observation.elapsedNs) <= 0n
      || result.generated !== observation.generated || result.executed !== observation.executed
      || result.filtered !== observation.filtered || result.attempted !== observation.attempted
      || result.sinkDecisions !== observation.sinkDecisions)
      throw new Error('external fault observation changed');
    property(result, registration);
    auditExternalRaw(path, result, registration);
  }
  if (witness.shrunk.resultDigest !== witness.proposals.at(-1)?.resultDigest
    || witness.original.executionManifestDigest !== witness.shrunk.executionManifestDigest
    || witness.original.effectPolicyBodyDigest !== witness.shrunk.effectPolicyBodyDigest
    || witness.original.property !== witness.shrunk.property) throw new Error('shrunk external fault changed property');
}
