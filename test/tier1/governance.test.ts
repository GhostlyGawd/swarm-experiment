import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { ProvenanceLedger } from '../../src/tier1/provenance.ts';
import type { InvariantId } from '../../src/tier1/ids.ts';

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-governance-'));
  directories.push(directory);
  return directory;
};
after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

test('F1/F2: durable lineage queries export a verifiable signed audit', () => {
  const directory = temporary();
  const ledger = new ProvenanceLedger({ directory, clock: () => 10 });
  const clause = 'inv:b3:audit' as InvariantId;
  const id = ledger.record({
    intent: 'audited decision', origin: { kind: 'issue', ref: 'ISSUE-1', actor: 'architect' },
    specClauses: [clause],
  });
  const store = new GraphStore({ directory });
  const node = store.intern(b.int(1));
  ledger.bind(node, id);
  assert.deepEqual(ledger.queryLineage({ actor: 'architect', clause }).map((record) => record.id), [id]);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const audit = ledger.exportSignedAudit(privateKey);
  assert.equal(ProvenanceLedger.verifySignedAudit(audit, publicKey), true);
  assert.equal(ProvenanceLedger.verifySignedAudit({ ...audit, payload: `${audit.payload}x` }, publicKey), false);
});

test('F4: property-checked fence evidence requires a durable human approval', () => {
  const directory = temporary();
  const ledger = new ProvenanceLedger({ directory, clock: () => 20 });
  const invariant = 'inv:b3:approval' as InvariantId;
  const provenance = ledger.record({
    intent: 'required guard', origin: { kind: 'spec_clause', ref: 'SPEC-1' },
    guard: { invariant, priority: 'required', rationale: 'requires review' },
  });
  const store = new GraphStore({ directory });
  const node = store.intern(b.int(1));
  const replacement = store.intern(b.int(2));
  ledger.bind(node, provenance);
  const proof = { invariant, verdict: 'property_checked' as const, evidence: 'fuzzed', subject: replacement };
  assert.equal(ledger.guardMutation(node, replacement, [proof]).allowed, false);
  ledger.approveDischarge(node, replacement, proof, 'reviewer@example.com');
  assert.equal(new ProvenanceLedger({ directory }).guardMutation(node, replacement, [proof]).allowed, true);
});

test('F5: structural keys are indexed incrementally and survive reopening', () => {
  const directory = temporary();
  const store = new GraphStore({ directory, incrementalStructuralIndex: true });
  const ref = store.intern(b.add(b.int(1), b.int(2)));
  const key = store.structuralKey(ref);
  const reopened = new GraphStore({ directory, incrementalStructuralIndex: true });
  assert.equal(reopened.incrementalStructural(ref), key);
  assert.equal(reopened.stats().structuralKeysComputed > 0, true);
});
