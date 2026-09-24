/** Signed Aether candidate in a separate process using external sink/witness. */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createAttestedSinkClient } from '../../../../src/fabric/attested-sink-service.ts';
import { createProcessWitnessClient } from '../../../../src/fabric/witness-service.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { LivingCampaign, type LivingCase } from '../../../../src/tier3/living-campaign.ts';
import { externalFixture, EXTERNAL_ARTIFACT, EXTERNAL_CLOCK, EXTERNAL_DEPLOYMENT,
  EXTERNAL_REPOSITORY, EXTERNAL_WITNESS_AUTHORITY } from './fixture.ts';

const [registrationPath, configPath] = process.argv.slice(2);
if (!registrationPath || !configPath) throw new Error('external worker arguments');
const registration = JSON.parse(readFileSync(registrationPath, 'utf8')) as {
  authorization: NonNullable<ConstructorParameters<typeof LivingCampaign>[0]['effectAuthorization']>;
  operatorPublicKeyPem: string;
};
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  directory: string; witnessSocket: string; witnessKeyFile: string;
  gatewaySocket: string; sinkKeyFile: string; listenSocket: string;
};
const authorization = registration.authorization;
if (authorization.format !== 'aether.living-effect-authorization/4') throw new TypeError('external V4 authority required');
const witnessKey = readFileSync(config.witnessKeyFile), sinkKey = readFileSync(config.sinkKeyFile);
const witness = createProcessWitnessClient({ socketPath: config.witnessSocket, key: witnessKey, timeoutMs: 3000 });
const effectCatalog = witness.effectCatalog({ authorityId: EXTERNAL_WITNESS_AUTHORITY,
  repositoryId: EXTERNAL_REPOSITORY, deploymentId: EXTERNAL_DEPLOYMENT, clockDomain: EXTERNAL_CLOCK });
const sinkStateWitness = witness.sinkStateWitness({ authorityId: EXTERNAL_WITNESS_AUTHORITY,
  anchor: authorization.externalSink.anchor, adapterArtifactDigest: EXTERNAL_ARTIFACT });
const client = createAttestedSinkClient({ socketPath: config.gatewaySocket, authKey: sinkKey,
  anchor: authorization.externalSink.anchor, adapterArtifactDigest: EXTERNAL_ARTIFACT,
  repositoryId: EXTERNAL_REPOSITORY, deploymentId: EXTERNAL_DEPLOYMENT, timeoutMs: 3000 });
const fixture = externalFixture();
const campaign = new LivingCampaign({ manifest: fixture.manifest, module: fixture.module, registry: fixture.registry,
  directory: config.directory, effectAuthorization: authorization,
  effectTrust: { repositoryId: EXTERNAL_REPOSITORY, policyEpoch: '1',
    signer: 'living-integrated-operator', key: registration.operatorPublicKeyPem },
  externalEffectServices: { client, sinkStateWitness, effectCatalog } });
const generated = new Map(campaign.generate().map(item => [domainDigest('aether.living-case/1', item), item]));
function exactCase(value: unknown): LivingCase {
  const id = domainDigest('aether.living-case/1', value), found = generated.get(id);
  if (!found) throw new TypeError('case outside signed generated campaign');
  return found;
}
function handle(value: unknown): unknown {
  if (!value || typeof value !== 'object') throw new TypeError('TCP command object required');
  const command = value as { op?: string; input?: LivingCase };
  if (!['run-case', 'recover-case'].includes(command.op ?? '')) throw new TypeError('unknown command');
  const input = exactCase(command.input);
  return command.op === 'recover-case' ? campaign.recoverEffectCase(input) : campaign.execute(input);
}
const server = createServer(socket => {
  socket.setEncoding('utf8'); let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 32 * 1024) { socket.destroy(); return; }
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const frame = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { socket.write(JSON.stringify({ result: handle(JSON.parse(frame)) }) + '\n'); }
      catch (error) { socket.write(JSON.stringify({ error: String(error) }) + '\n'); }
    }
  });
});
server.listen(config.listenSocket, () => process.stdout.write('external worker ready\n'));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
