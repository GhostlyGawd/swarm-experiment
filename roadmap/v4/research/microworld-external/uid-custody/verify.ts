/** Independent, offline verification of public three-UID custody evidence. */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { domainDigest } from '../../../../../src/fabric/identity.ts';
import { assertLivingEffectAuthorizationV4 } from '../../../../../src/tier3/living-effect-authorization.ts';
import { auditExternalRaw, type ExternalCampaignResult, type ExternalRegistration } from '../harness.ts';
import { externalFixture, EXTERNAL_REPOSITORY } from '../fixture.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const evidence = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'evidence', 'uid-custody-v1'));
const report = JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'));
const registration = JSON.parse(readFileSync(join(evidence, 'registration.json'), 'utf8')) as ExternalRegistration;
if (report.format !== 'aether.living-external-uid-custody/1' || !/^[0-9a-f]{40}$/.test(report.sourceBaseCommit)
  || report.sameVmRootController !== true || report.independentOperators !== false || report.crossMachine !== false)
  throw new Error('custody profile or trust boundary mismatch');
if (report.identities.candidate !== 10001 || report.identities.sink !== 10002
  || report.identities.witness !== 10003 || report.sharedGroup !== 20000)
  throw new Error('custody identity profile mismatch');
if (!String(report.machine.kernel).includes('Linux')
  || !String(report.machine.runtimeImage).startsWith('node@sha256:')
  || !/^sha256:[0-9a-f]{64}$/.test(String(report.machine.builderImage))
  || !/^[0-9a-f]{64}$/.test(String(report.machine.nativeGatewaySha256)))
  throw new Error('Linux runtime/native gateway provenance incomplete');
for (const [key, value] of Object.entries(report.refusals) as [string, any][]) {
  const valid = key.startsWith('wrongPeer') ? value?.connected === true
      && typeof value.closedWithinMs === 'number' && value.closedWithinMs < 500
    : key.startsWith('rightPeer') ? value?.connected === true && value.closedWithinMs === null
    : value === 'EACCES';
  if (!valid) throw new Error(`custody refusal invalid: ${key}`);
}
const owners = report.ownership as string;
for (const row of [
  '/run/aether/witness/private/key 10003:10003 600 regular file',
  '/run/aether/witness/store 10003:10003 700 directory',
  '/run/aether/sink/private/sign.pem 10002:10002 600 regular file',
  '/run/aether/sink/store 10002:10002 700 directory',
  '/run/aether/candidate/private/sink-key 10001:10001 600 regular file',
  '/run/aether/candidate/state 10001:10001 700 directory',
  '/run/aether/witness-access/candidate.sock 10003:20000 660 socket',
  '/run/aether/witness-access/sink.sock 10003:20000 660 socket',
  '/run/aether/sink-access/candidate.sock 10002:20000 660 socket',
]) if (!owners.includes(row)) throw new Error(`custody owner/mode missing: ${row}`);
if (Object.keys(report.runtimeIdentities).length !== 7
  || Object.values(report.runtimeIdentities).filter(value => value === '10001:20000').length !== 2
  || Object.values(report.runtimeIdentities).filter(value => value === '10002:20000').length !== 2
  || Object.values(report.runtimeIdentities).filter(value => value === '10003:20000').length !== 3)
  throw new Error('runtime identities incomplete');
for (const [source, expected] of Object.entries(report.sourceSha256) as [string, string][]) {
  if (source.startsWith('/') || source.includes('..') || !/^[0-9a-f]{64}$/.test(expected))
    throw new Error('invalid source hash entry');
  const actual = createHash('sha256').update(readFileSync(join(root, source))).digest('hex');
  if (actual !== expected) throw new Error(`exact source differs: ${source}`);
}
const fixture = externalFixture();
assertLivingEffectAuthorizationV4(registration.authorization, {
  candidateRoot: fixture.manifest.candidateRoot, campaignDigest: fixture.campaignDigest,
  repositoryId: EXTERNAL_REPOSITORY, policyEpoch: '1', signer: 'living-integrated-operator',
  key: registration.operatorPublicKeyPem,
});
if (report.authorizationDigest !== domainDigest('aether.living-effect-authorization/4', registration.authorization)
  || report.candidateRoot !== fixture.manifest.candidateRoot)
  throw new Error('authorization/result subject mismatch');
const result = report.result as ExternalCampaignResult;
if (report.generated !== 15 || report.executed !== 15 || report.filtered !== 0
  || report.attempted !== 17 || report.passed !== 15 || report.failed !== 0
  || report.partitionUnknown !== 1 || report.reconciled !== 1
  || report.sinkDecisions !== 9 || report.sinkWitnessRevision !== '9'
  || result.generated !== report.generated || result.executed !== report.executed
  || result.attempted !== report.attempted || result.sinkDecisions !== report.sinkDecisions
  || JSON.stringify(registration.generated) !== JSON.stringify(result.cases.map(row => row.input)))
  throw new Error('custody campaign count/case mismatch');
if (!(report.measurements.registrationMs > 0) || !(report.measurements.signedExecutionMs > 0)
  || Math.abs(report.measurements.signedExecutedCasesPerSecond
    - report.executed / (report.measurements.signedExecutionMs / 1000)) > 1e-10)
  throw new Error('custody timing arithmetic changed');
auditExternalRaw(evidence, result, registration);

function mustRefuse(label: string, mutate: (copy: string) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), 'aether-uid-tamper-'));
  try {
    cpSync(evidence, scratch, { recursive: true }); mutate(scratch);
    let refused = false;
    try { auditExternalRaw(scratch, result, registration); } catch { refused = true; }
    if (!refused) throw new Error(`${label} tamper was accepted`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
mustRefuse('signed sink decision', copy => {
  const path = join(copy, 'sink-store', 'sink-state-v2.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const signature = state.decisions[0].receipt.signature as string;
  state.decisions[0].receipt.signature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  writeFileSync(path, JSON.stringify(state));
});
mustRefuse('witness revision', copy => {
  const directory = join(copy, 'witness-store');
  const path = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => join(directory, name))
    .find(path => JSON.parse(readFileSync(path, 'utf8')).identity.kind === 'sink');
  if (!path) throw new Error('sink witness raw head absent');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.head.revision = '0'; writeFileSync(path, JSON.stringify(state));
});
process.stdout.write(JSON.stringify({ format: 'aether.living-external-uid-custody-verification/1',
  cleanAudit: 'passed', signedSinkTamper: 'refused', witnessRevisionTamper: 'refused',
  generated: result.generated, executed: result.executed, filtered: result.filtered,
  attempted: result.attempted, sameVmRootController: true }) + '\n');
