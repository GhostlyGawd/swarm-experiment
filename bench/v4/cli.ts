import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, enforcementFailures, profile, type Profile } from './manifest.ts';
import { ledgerCorpus, ledgerV6Corpus } from './tokens.ts';

const args = process.argv.slice(2);
let mode: '--measure' | '--enforce' = '--measure';
let selected: Profile['id'] = 'v4-release/2';
let output = '.aether-store/benchmarks/v4/latest';
let modeSeen = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--measure' || arg === '--enforce') {
    if (modeSeen) throw new Error('Select exactly one mode');
    modeSeen = true; mode = arg;
  } else if (arg === '--profile') {
    const name = args[++i];
    if (name !== 'ledger-baseline/1' && name !== 'ledger-warm-v6/1'
      && name !== 'v4-release/1' && name !== 'v4-release/2') throw new Error(`Unknown profile: ${name}`);
    selected = name;
  } else if (arg === '--output') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--output requires a directory');
    output = args[++i];
  } else throw new Error(`Unknown option ${arg}`);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = selected === 'ledger-baseline/1' || selected === 'v4-release/1' ? ledgerCorpus() : ledgerV6Corpus();
const selectedProfile = profile(selected, corpus.map(workload => workload.id));
const { run, samples } = createRun(corpus, selectedProfile, 'samples.json', root);
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'samples.json'), JSON.stringify(samples, null, 2) + '\n');
writeFileSync(join(directory, 'manifest.json'), JSON.stringify(run, null, 2) + '\n');
for (const row of run.measurements) {
  console.log(`${row.verdict.padEnd(12)} ${row.requirement} ${row.metric}: ${row.value ?? 'unmeasured'} ${row.unit}${row.required ? ' [required]' : ' [diagnostic]'}`);
}
const failures = enforcementFailures(selectedProfile, run.measurements);
console.log(`Evidence: ${join(directory, 'manifest.json')}`);
console.log(`${failures.length} required targets remain unsatisfied; mode=${mode.slice(2)}.`);
if (mode === '--enforce' && failures.length > 0) process.exitCode = 1;
