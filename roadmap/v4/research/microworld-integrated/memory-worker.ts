/** One signed Aether case executed while real process pages remain resident. */
import { readFileSync } from 'node:fs';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { LivingCampaign, type LivingCase } from '../../../../src/tier3/living-campaign.ts';
import { integratedFixture, integratedTrust } from './fixture.ts';

const [registrationPath, directory, scenario] = process.argv.slice(2);
if (!registrationPath || !directory || scenario !== 'bounded-allocation')
  throw new Error('physical pressure worker arguments');
const registration = JSON.parse(readFileSync(registrationPath, 'utf8')) as {
  memoryAuthorization: ConstructorParameters<typeof LivingCampaign>[0]['effectAuthorization'];
  publicKeyPem: string;
};
const fixture = integratedFixture();
const campaign = new LivingCampaign({ manifest: fixture.manifest, module: fixture.module,
  registry: fixture.registry, directory, effectAuthorization: registration.memoryAuthorization,
  effectTrust: integratedTrust(registration.publicKeyPem) });
const input = campaign.generate().find(item => item.scenario === scenario && item.ordinal === 0);
if (!input) throw new Error('registered physical pressure case missing');
const caseDigest = domainDigest('aether.living-case/1', input);
let pressure: Buffer | null = null, stride = 0, touchedPages = 0, checksum = 0;
let phase: 'ready' | 'pressurized' | 'done' = 'ready', pending = '';
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
emit({ phase, pid: process.pid, caseDigest, rssBytes: process.memoryUsage().rss });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  if (pending.length > 4096) throw new Error('physical pressure command bound exceeded');
  for (;;) {
    const newline = pending.indexOf('\n'); if (newline < 0) return;
    const command = JSON.parse(pending.slice(0, newline)) as { op: string; bytes?: number; stride?: number };
    pending = pending.slice(newline + 1);
    if (phase === 'ready' && command.op === 'pressure') {
      const bytes = command.bytes, touchStride = command.stride;
      if (!Number.isSafeInteger(bytes) || bytes! < 1 || bytes! > 128 * 1024 * 1024
        || !Number.isSafeInteger(touchStride) || touchStride! < 1 || touchStride! > 4096)
        throw new Error('invalid physical pressure profile');
      pressure = Buffer.allocUnsafe(bytes!); stride = touchStride!;
      for (let index = 0; index < pressure.length; index += stride) {
        pressure[index] = (index / stride * 17 + 3) & 255;
        touchedPages++;
      }
      for (let index = 0; index < pressure.length; index += stride)
        checksum = (checksum + pressure[index]) >>> 0;
      phase = 'pressurized';
      emit({ phase, pid: process.pid, caseDigest, rssBytes: process.memoryUsage().rss,
        touchedPages, checksum });
    } else if (phase === 'pressurized' && command.op === 'run') {
      const result = campaign.execute(input as LivingCase);
      let retainedChecksum = 0;
      for (let index = 0; index < pressure!.length; index += stride)
        retainedChecksum = (retainedChecksum + pressure![index]) >>> 0;
      if (retainedChecksum !== checksum) throw new Error('resident pressure pages changed');
      phase = 'done';
      emit({ phase, pid: process.pid, caseDigest, rssBytes: process.memoryUsage().rss,
        touchedPages, checksum, retainedChecksum, result });
    } else throw new Error('out-of-order physical pressure command');
  }
});
