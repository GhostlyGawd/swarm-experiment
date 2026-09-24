import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { typecheck } from '../../src/tier2/typecheck.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { executableBundle, parseExecutableBundle } from '../../src/projection/executable.ts';
import { CONTRACT_BODY_FORMS_V17, CONTRACT_CARRIERS, validContractContexts } from
  '../../roadmap/v4/research/projections/corpus-valid-contract-contexts.ts';

test('V17 generated 13×5 corpus exposes the next valid task-state gaps', () => {
  const rows = validContractContexts(17), misses: string[] = [];
  assert.equal(rows.length, CONTRACT_BODY_FORMS_V17.length * CONTRACT_CARRIERS.length);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  for (const row of rows) {
    const checked = typecheck(row.module, { registry: new CapabilityRegistry() });
    assert.equal(checked.ok, true, `${row.id}: ${checked.diagnostics.map(d => d.message).join('; ')}`);
    const reference = new Runtime({ registry: new CapabilityRegistry() }).load(row.module).call(row.entry, []);
    assert.equal(reference.ok, true, row.id);
    if (reference.ok) assert.equal(reference.value, 1n, row.id);
    const store = new GraphStore(), root = store.intern(row.module);
    for (const target of ['typescript', 'python', 'rust'] as const) {
      try {
        const bundle = executableBundle(row.module, row.symbols, target);
        assert.equal(store.intern(parseExecutableBundle(bundle).module), root, `${row.id}:${target}`);
        if (row.carrier === 'passed_parameter') {
          const first = bundle.source.split('\n')[0];
          const header = JSON.parse(first.slice(first.indexOf('{')));
          if (header.closureCertificates?.length === 0)
            misses.push(`${row.id}/${target}: native contract closure has no certificate`);
        }
      } catch (error) {
        misses.push(`${row.id}/${target}: ${String(error)}`);
      }
    }
  }
  assert.equal(misses.length, 2 * 5 * 3, JSON.stringify(misses));
  assert.ok(misses.some(miss => miss.startsWith('task_record_field/')), JSON.stringify(misses));
  assert.ok(misses.some(miss => miss.startsWith('task_identity/')), JSON.stringify(misses));
});
