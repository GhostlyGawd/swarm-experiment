/** Two-stage preregistered local campaign. Never overwrites an attempted run. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { cpus, freemem, loadavg, platform, release, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LivingCampaign, measureR04JsonEvents } from '../../../../src/tier3/living-campaign.ts';
import { livingFixture } from './fixture.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/microworld/profile.json');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const captured = new Set<string>();
function capture(path: string): void {
  if (captured.has(path)) return; captured.add(path);
  if (!path.endsWith('.ts')) return;
  const text = readFileSync(join(root, path), 'utf8');
  for (const match of text.matchAll(/(?:from\s*|import\s*\()['"](\.{1,2}\/[^'"\n]+\.ts)['"]/g)) capture(relative(root, resolve(root, dirname(path), match[1])));
}
for (const path of ['src/tier3/living-campaign.ts', 'roadmap/v4/research/microworld/fixture.ts', 'roadmap/v4/research/microworld/campaign.ts', 'roadmap/v4/research/microworld/profile.json', 'package-lock.json']) capture(path);
const sourcePaths = [...captured].sort();
const sources = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(join(root, path)))]));
const diagnostic = () => ({ at: new Date().toISOString(), platform: platform(), release: release(), architecture: process.arch, node: process.version, cpus: cpus().map(cpu => ({ model: cpu.model, speed: cpu.speed })), memory: { total: totalmem(), free: freemem(), process: process.memoryUsage() }, load: loadavg() });
function write(path: string, value: unknown): void { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); } const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); } }
const [mode, supplied] = process.argv.slice(2); if (!['--register', '--run', '--verify'].includes(mode) || !supplied) throw new Error('usage: campaign.ts --register|--run|--verify OUTPUT_DIRECTORY');
const directory = resolve(supplied), registrationPath = join(directory, 'registration.json');
if (mode === '--register') {
  if (existsSync(directory)) throw new Error('registration requires a new directory'); mkdirSync(directory, { recursive: true });
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')), good = livingFixture(), broken = livingFixture(true);
  write(registrationPath, { format: 'aether.living-research-registration/1', at: new Date().toISOString(), profile, profileSha256: sha(readFileSync(profilePath)),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), gitStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
    sources: sources(), goodManifest: good.manifest, brokenManifest: broken.manifest, diagnostic: diagnostic() });
  console.log(`Registered ${directory}; no timing performed.`);
} else {
  const registration = JSON.parse(readFileSync(registrationPath, 'utf8'));
  if (JSON.stringify(registration.sources) !== JSON.stringify(sources()) || registration.profileSha256 !== sha(readFileSync(profilePath))) throw new Error('source/profile changed after preregistration');
  if (mode === '--run') {
    write(join(directory, 'attempt.json'), { format: 'aether.living-research-attempt/1', registrationSha256: sha(readFileSync(registrationPath)), before: diagnostic() });
    const boundary = measureR04JsonEvents(sample => write(join(directory, sample.warmup ? 'warmup.json' : `trial-${sample.trial}.json`), sample));
    write(join(directory, 'boundary.json'), { ...boundary, after: diagnostic() });
    console.log(`JSON-event timing completed: ${boundary.samples.map(sample => Math.round(sample.inputsPerSecond)).join(', ')} inputs/s; ${boundary.pass ? 'PASS' : 'FAIL'}.`);
    const good = new LivingCampaign({ ...livingFixture(), manifest: registration.goodManifest, directory: join(directory, 'good') }), goodReport = good.run();
    const broken = new LivingCampaign({ ...livingFixture(true), manifest: registration.brokenManifest, directory: join(directory, 'broken') }), brokenReport = broken.run();
    for (const id of brokenReport.counterexamples) broken.replayCounterexample(id);
    write(join(directory, 'results.json'), { format: 'aether.living-research-results/1', registrationSha256: sha(readFileSync(registrationPath)), good: goodReport, admission: good.admit(goodReport), broken: brokenReport,
      boundary, fullCampaignThroughputQualified: false, explanation: 'R04 boundary kernel and complete durable Aether campaign rates are distinct; no distributed scale qualification.', after: diagnostic() });
    console.log(`Campaign completed: good ${goodReport.passed}/${goodReport.declared}; broken ${brokenReport.failed} failures retained and replayed.`);
  } else {
    const result = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
    if (result.registrationSha256 !== sha(readFileSync(registrationPath))) throw new Error('registration digest mismatch');
    const samples = result.boundary.samples;
    if (samples.length !== 5 || result.boundary.minimumPerSecond !== 2_000_000 || result.boundary.warmups !== 1 || result.boundary.inputsPerTrial !== 20_000) throw new Error('R04 profile mismatch');
    for (const [index, sample] of samples.entries()) {
      const raw = JSON.parse(readFileSync(join(directory, `trial-${index}.json`), 'utf8'));
      if (raw.trial !== index || raw.warmup || raw.elapsedNs !== sample.elapsedNs || raw.checksum !== 25534 || sample.checksum !== 25534 || sample.generated !== 20_000 || sample.executed !== 20_000 || sample.filtered !== 0 || sample.inputsPerSecond !== 20_000 / (Number(sample.elapsedNs) / 1e9) || sample.pass !== (sample.inputsPerSecond >= 2_000_000)) throw new Error('raw sample/measurement arithmetic mismatch');
    }
    if (result.boundary.pass !== samples.every((sample: { pass: boolean }) => sample.pass)) throw new Error('false boundary qualification');
    for (const [label, fixture, manifest, report] of [['good', livingFixture(), registration.goodManifest, result.good], ['broken', livingFixture(true), registration.brokenManifest, result.broken]] as const) {
      const campaign = new LivingCampaign({ ...fixture, manifest, directory: join(directory, label) }), generated = campaign.generate();
      if (generated.length !== report.declared || report.cases.length !== generated.length || report.generated !== generated.length || report.executed !== generated.length) throw new Error('hidden case exclusion');
      report.cases.forEach((item: { input: unknown; result: unknown }, index: number) => {
        if (JSON.stringify(item.input) !== JSON.stringify(generated[index]) || JSON.stringify(campaign.execute(generated[index])) !== JSON.stringify(item.result)) throw new Error('candidate case does not replay');
      });
      for (const id of report.counterexamples) campaign.replayCounterexample(id);
    }
    console.log('Verified source pins, all five raw rates, all 30 exact candidate cases and durable counterexamples. No throughput measurement repeated.');
  }
}
