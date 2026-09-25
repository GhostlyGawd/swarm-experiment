import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessWitnessClient } from '../../../../src/fabric/witness-service.ts';
import { LivingCampaign } from '../../../../src/tier3/living-campaign.ts';
import { externalFixture, EXTERNAL_ARTIFACT, EXTERNAL_CLOCK, EXTERNAL_DEPLOYMENT,
  EXTERNAL_REPOSITORY, EXTERNAL_WITNESS_AUTHORITY } from './fixture.ts';
import { auditExternalRaw, prepareExternal, runExternal } from './harness.ts';

const directories: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'aether-external-test-')); directories.push(path); return path; };
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));

test('same signed candidate uses witnessed external sink and refuses partition status until rejoin', async () => {
  const root = temp(), prepared = await prepareExternal(join(root, 'private'), join(root, 'public'));
  const witness = createProcessWitnessClient({ socketPath: prepared.witnessSocket,
    key: readFileSync(prepared.witnessKeyFile) });
  const services = { client: { execute: () => { throw new Error('test client dispatch forbidden'); },
    status: () => ({ state: 'unknown' as const }) },
    sinkStateWitness: witness.sinkStateWitness({ authorityId: EXTERNAL_WITNESS_AUTHORITY,
      anchor: prepared.registration.anchor, adapterArtifactDigest: EXTERNAL_ARTIFACT }),
    effectCatalog: witness.effectCatalog({ authorityId: EXTERNAL_WITNESS_AUTHORITY,
      repositoryId: EXTERNAL_REPOSITORY, deploymentId: EXTERNAL_DEPLOYMENT, clockDomain: EXTERNAL_CLOCK }) };
  const fixture = externalFixture(), trust = { repositoryId: EXTERNAL_REPOSITORY, policyEpoch: '1',
    signer: 'living-integrated-operator', key: prepared.registration.operatorPublicKeyPem };
  const authorization = prepared.registration.authorization;
  if (authorization.format !== 'aether.living-effect-authorization/4') throw new Error('V4 registration expected');
  const candidate = new LivingCampaign({ manifest: fixture.manifest, module: fixture.module,
    registry: fixture.registry, directory: join(root, 'preflight'),
    effectAuthorization: authorization, effectTrust: trust,
    externalEffectServices: services });
  assert.throws(() => candidate.runEffectful(), /external complete-run audit/);
  assert.throws(() => new LivingCampaign({ manifest: fixture.manifest, module: fixture.module,
    registry: fixture.registry, directory: join(root, 'forged'), effectTrust: trust,
    externalEffectServices: services, effectAuthorization: {
      ...authorization, externalSink: {
        ...authorization.externalSink, deploymentId: 'deployment:forged',
      },
    } }), /forged external campaign authorization/);
  const result = await runExternal(prepared, join(root, 'public'),
    ['malformed-command', 'truncated-command', 'healthy-case']);
  assert.equal(result.generated, 15); assert.equal(result.executed, 15);
  assert.equal(result.filtered, 0); assert.equal(result.passed, 15);
  assert.equal(result.partitionAttempt.passed, false);
  assert.equal(result.partitionAttempt.externalEffects.indeterminate, 1);
  assert.equal(result.partitionUnknown, 1); assert.equal(result.reconciled, 1);
  assert.equal(result.sinkDecisions, 9); assert.equal(result.sinkWitnessRevision, '9');
  assert.equal(result.attempted, 18);
  assert.equal(result.pipeline.generated, 15); assert.equal(result.pipeline.executed, 15);
  assert.equal(result.pipeline.attemptedExecutions, 18);
  assert.equal(result.pipeline.failedAttempts, 1); assert.equal(result.pipeline.filteredAttempts, 0);
  assert.equal(result.pipeline.recoveries, 2);
  assert.equal(result.pipeline.phases[0].complete, false);
  assert.equal(result.pipeline.phases[1].complete, true);
  assert.equal(result.candidateRestarts, 1);
  assert.equal(result.workerTermination, 'SIGKILL');
  auditExternalRaw(join(root, 'public'), result, prepared.registration);
  const sinkState = join(root, 'public', 'sink-store', 'sink-state-v2.json');
  const originalSink = readFileSync(sinkState, 'utf8');
  writeFileSync(sinkState, originalSink.replace('executionManifest', 'changedManifest'));
  assert.throws(() => auditExternalRaw(join(root, 'public'), result, prepared.registration),
    /external sink decision outside signed execution|external sink receipt changed|external sink witness head changed/);
  writeFileSync(sinkState, originalSink);
  const attempts = join(root, 'public', 'pipeline', 'phase-1', 'attempts');
  const first = join(attempts, readdirSync(attempts).find(name => name.endsWith('.json'))!);
  writeFileSync(first, readFileSync(first, 'utf8').replace('original', 'forged'));
  assert.throws(() => auditExternalRaw(join(root, 'public'), result, prepared.registration),
    /living pipeline attempt changed/);
});
