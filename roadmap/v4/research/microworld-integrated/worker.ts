/** Independent TCP worker executing the registered signed Aether candidate. */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { LivingCampaign, type LivingCase } from '../../../../src/tier3/living-campaign.ts';
import { integratedFixture, integratedTrust } from './fixture.ts';

const [registrationPath, directory] = process.argv.slice(2);
if (!registrationPath || !directory) throw new Error('worker arguments');
const registration = JSON.parse(readFileSync(registrationPath, 'utf8')) as {
  authorization: ConstructorParameters<typeof LivingCampaign>[0]['effectAuthorization']; publicKeyPem: string;
};
const fixture = integratedFixture();
const campaign = new LivingCampaign({ manifest: fixture.manifest, module: fixture.module, registry: fixture.registry,
  directory, effectAuthorization: registration.authorization, effectTrust: integratedTrust(registration.publicKeyPem) });
const generated = new Map(campaign.generate().map(item => [domainDigest('aether.living-case/1', item), item]));
function exactCase(value: unknown): LivingCase {
  const id = domainDigest('aether.living-case/1', value);
  const found = generated.get(id);
  if (!found) throw new TypeError('case is outside registered generated set');
  return found;
}
function handle(value: unknown): unknown {
  if (!value || typeof value !== 'object') throw new TypeError('TCP command object required');
  const request = value as { op?: string; input?: LivingCase };
  if (!['run-case', 'recover-case'].includes(request.op ?? '')) throw new TypeError('unknown TCP command');
  const input = exactCase(request.input);
  return request.op === 'recover-case' ? campaign.recoverEffectCase(input) : campaign.execute(input);
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
server.listen(0, '127.0.0.1', () => {
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('socket address');
  process.stdout.write(JSON.stringify({ ready: address.port, pid: process.pid }) + '\n');
});
