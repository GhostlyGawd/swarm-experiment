import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateCounts, countPair, ledgerCorpus, ledgerV6Corpus, measureWorkload, sessionWire } from '../../bench/v4/tokens.ts';
import { digest, enforcementFailures, evaluate, measureCorpus, profile, type BenchmarkRunV1 } from '../../bench/v4/manifest.ts';
import { countTokens } from '../../src/util/tokens.ts';

test('V4-F02: corpus aggregation divides summed actual counts, not averaged ratios', () => {
  assert.deepEqual(aggregateCounts([{ baseline: 100, candidate: 10 }, { baseline: 100, candidate: 100 }]), {
    baseline: 200, candidate: 110, ratio: 200 / 110,
  });
  assert.deepEqual(aggregateCounts([]), { baseline: 0, candidate: 0, ratio: null });
  assert.throws(() => aggregateCounts([{ baseline: -1, candidate: 2 }]));
  assert.throws(() => aggregateCounts([{ baseline: Infinity, candidate: 2 }]));
});

test('V4-F02: real-tokenizer corpus includes cold dictionaries and complete warm message framing', () => {
  const corpus = ledgerCorpus();
  const samples = measureCorpus(corpus);
  assert.deepEqual(samples.aggregates.warmBody, { baseline: 698, candidate: 343, ratio: 698 / 343 });
  assert.deepEqual(samples.aggregates.warmMessage, { baseline: 698, candidate: 375, ratio: 698 / 375 });
  assert.deepEqual(samples.aggregates.cold, { baseline: 878, candidate: 933, ratio: 878 / 933 });
  assert.equal(corpus[0].session.length, 7);
  assert.deepEqual(corpus[0].session.filter(message => message.role === 'tool').map(message => JSON.parse(message.candidate)), [
    { input: '1000', expected: '5', actual: '10', accepted: false },
    { input: '1000', expected: '5', actual: '5', accepted: true },
  ]);
  assert.equal(samples.aggregates.fullSession.baseline, corpus[0].session.reduce((sum, message) => sum + countTokens(sessionWire(message, 'baseline')), 0));
  assert.equal(samples.aggregates.fullSession.candidate, corpus[0].session.reduce((sum, message) => sum + countTokens(sessionWire(message, 'candidate')), 0));
  assert.ok(samples.aggregates.fullSession.candidate > 933, 'full session includes requests, failed output, repair, responses and wire framing');
  assert.throws(() => measureCorpus([]));
  assert.throws(() => measureCorpus([corpus[0], corpus[0]]));
});

test('V4-F02: full-session arithmetic includes failed attempts, repairs, responses and dictionary deltas', () => {
  const workload = ledgerCorpus()[0];
  const before = measureWorkload(workload).fullSession;
  const added = [
    { role: 'assistant' as const, purpose: 'failed_attempt' as const, baseline: 'broken TypeScript output', candidate: 'broken IR output' },
    { role: 'tool' as const, purpose: 'response' as const, baseline: 'validation failed', candidate: 'validation failed' },
    { role: 'assistant' as const, purpose: 'repair' as const, baseline: 'repaired TypeScript output', candidate: 'AE1\n§w 1\n§n newlyIntroducedSymbol\nrepaired output' },
  ];
  workload.session.push(...added);
  const after = measureWorkload(workload).fullSession;
  assert.equal(after.candidate - before.candidate, added.reduce((sum, message) => sum + countTokens(sessionWire(message, 'candidate')), 0));
  assert.equal(after.baseline - before.baseline, added.reduce((sum, message) => sum + countTokens(sessionWire(message, 'baseline')), 0));
  assert.ok(countPair({ baseline: 'hello world', candidate: 'hello' }).ratio !== null);
});

test('AE6 ledger profile charges the cold base and full changed session while complete warm wires exceed 4× in both tokenizers', () => {
  const legacy = ledgerCorpus()[0], modern = ledgerV6Corpus()[0];
  assert.deepEqual(modern.cold, legacy.cold);
  assert.deepEqual(modern.changes.map(({ id, baseline }) => ({ id, baseline })),
    legacy.changes.map(({ id, baseline }) => ({ id, baseline })));
  assert.deepEqual(modern.session.map(({ role, purpose, baseline }) => ({ role, purpose, baseline })),
    legacy.session.map(({ role, purpose, baseline }) => ({ role, purpose, baseline })));
  assert.ok(modern.changes.every(change => change.candidate.startsWith('R6:')));
  assert.match(modern.session.find(message => message.purpose === 'repair')!.candidate, /^E6:/);
  const measured = measureWorkload(modern);
  assert.deepEqual(measured.warmMessage, { baseline: 698, candidate: 124, ratio: 698 / 124 });
  assert.deepEqual(measured.cold, { baseline: 878, candidate: 933, ratio: 878 / 933 });
  assert.deepEqual(measured.fullSession, { baseline: 1361, candidate: 1193, ratio: 1361 / 1193 });
  for (const [encoding, expected] of [
    ['cl100k_base', { warm: [698, 124], framed: [791, 172], cold: [878, 933], session: [1361, 1193] }],
    ['o200k_base', { warm: [706, 124], framed: [803, 172], cold: [886, 931], session: [1377, 1191] }],
  ] as const) {
    const pair = (rows: ReadonlyArray<{ baseline: string; candidate: string }>, wire: (row: { baseline: string; candidate: string }, side: 'baseline' | 'candidate') => string) =>
      (['baseline', 'candidate'] as const).map(side => rows.reduce((sum, row) => sum + countTokens(wire(row, side), encoding), 0));
    assert.deepEqual(pair(modern.changes, (row, side) => row[side]), expected.warm);
    assert.deepEqual(pair(modern.changes, (row, side) => JSON.stringify({ role: 'assistant', purpose: 'change', content: row[side] }) + '\n'), expected.framed);
    assert.deepEqual(pair([modern.cold], (row, side) => row[side]), expected.cold);
    assert.deepEqual(pair(modern.session, (row, side) => sessionWire(row as typeof modern.session[number], side)), expected.session);
    assert.ok(expected.warm[0] / expected.warm[1] >= 4);
    assert.ok(expected.framed[0] / expected.framed[1] >= 4);
    assert.ok(expected.cold[0] / expected.cold[1] < 4);
    assert.ok(expected.session[0] / expected.session[1] < 4);
  }
  const selected = profile('v4-release/2', [modern.id]);
  const required = selected.targets.filter(target => target.required);
  assert.equal(required.find(target => target.metric === `${modern.id}:warmMessage`)?.minimum, 4);
  assert.throws(() => profile('v4-release/2', [legacy.id]), /declared workload/);
});

test('V4-F02: enforcement rejects misses, unmeasured, inconclusive, deleted, duplicated and fabricated pass rows', () => {
  const selected = profile('ledger-baseline/1', []);
  const target = selected.targets.find(target => target.required)!;
  const check = (value: number | null) => enforcementFailures(selected, [evaluate(target, value)]);
  assert.equal(check(4).length, 0);
  assert.equal(check(698 / 375).length, 1);
  assert.equal(check(null).length, 1);
  assert.equal(check(NaN).length, 1);
  assert.equal(enforcementFailures(selected, []).length, 1);
  const pass = evaluate(target, 4);
  assert.equal(enforcementFailures(selected, [pass, pass]).length, 1);
  assert.equal(enforcementFailures(selected, [{ ...evaluate(target, 1), verdict: 'pass' }]).length, 1);
  for (const altered of [{ bound: '≥0×' }, { unit: 'made-up units' }, { required: false }, { minimum: 0 }, { reason: 'claimed pass' }]) {
    assert.equal(enforcementFailures(selected, [{ ...pass, ...altered }]).length, 1, 'target metadata and explanation are part of admission');
  }
  const full = profile('v4-release/1', []);
  assert.equal(new Set(full.targets.map(target => target.requirement)).size, 16);
  assert.equal(enforcementFailures(full, [pass]).length, 15);
});

test('V4-F02: measurement CLI succeeds while enforcement fails and emits reproducible bound evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-bench-f02-'));
  try {
    const args = ['--experimental-strip-types', 'bench/v4/cli.ts', '--output', directory];
    const measured = spawnSync(process.execPath, [...args, '--measure'], { encoding: 'utf8' });
    assert.equal(measured.status, 0, measured.stderr);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as BenchmarkRunV1;
    const samples = JSON.parse(readFileSync(join(directory, 'samples.json'), 'utf8'));
    assert.equal(manifest.format, 'aether.benchmark/1');
    assert.match(manifest.subjectCommit, /^[a-f0-9]{40}$/);
    assert.equal(manifest.samplesDigest, digest(samples));
    assert.equal(manifest.workloadDigest, digest(samples.corpus));
    assert.equal(manifest.targetProfileDigest, digest(manifest.profile));
    assert.equal(manifest.sourceTreeDigest, digest(samples.sourceFiles));
    assert.equal(manifest.environment.tokenizerVersion, '1.0.21');
    assert.ok(manifest.measurements.some(row => row.verdict === 'fail'));
    assert.ok(manifest.measurements.some(row => row.required && row.verdict === 'not_measured'));
    const enforced = spawnSync(process.execPath, [...args, '--enforce'], { encoding: 'utf8' });
    assert.equal(enforced.status, 1, enforced.stderr);
    const invalid = spawnSync(process.execPath, [...args, '--profile', 'fake-pass'], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
