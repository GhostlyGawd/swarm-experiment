import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableGrantEpochs } from '../../src/tier2/grant-epochs.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { capability } from '../../src/tier1/ids.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';

const directories: string[] = [];
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));
const cap = capability('cap:db:append');
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-grant-epochs-')); directories.push(directory);
  const options = { directory, repositoryId: 'repository' };
  const epochs = new DurableGrantEpochs(options);
  let time = 100;
  const authority = (ledger = epochs) => new ScopedGrantAuthority({ key: new Uint8Array(32).fill(9), repositoryId: 'repository',
    clock: () => time, policyEpoch: () => ledger.policyEpoch, revocationEpoch: () => ledger.epoch,
    isRevoked: (name, path) => ledger.isRevoked(name, path), authorizeIssue: () => true, authorizeDelegate: () => true });
  const request = { capability: cap, audience: 'worker', path: ['ledger'] } as const;
  return { directory, options, epochs, authority, request, setTime: (value: number) => { time = value; } };
}

test('durable revocation and policy epochs prevent old grants regaining authority after restore/restart', () => {
  const f = setup(), signer = f.authority(), original = signer.issue(f.request, 100);
  assert.equal(signer.verify(original, { ...f.request, path: ['ledger', 'row'] }), true);
  assert.equal(f.epochs.revoke(cap, ['ledger', 'row']), '1');
  assert.equal(f.epochs.revoke(cap, ['ledger', 'row']), '1');
  assert.equal(signer.verify(original, { ...f.request, path: ['ledger', 'row'] }), false);
  assert.throws(() => signer.issue({ ...f.request, path: ['ledger', 'row'] }, 50), /issuance denied/);
  assert.equal(f.epochs.restore(cap, ['ledger', 'row']), '2');
  assert.equal(f.epochs.restore(cap, ['ledger', 'row']), '2');
  assert.equal(signer.verify(original, f.request), false);
  const reopened = new DurableGrantEpochs(f.options), next = f.authority(reopened).issue(f.request, 50);
  assert.equal(reopened.epoch, '2'); assert.equal(f.authority(reopened).verify(next, f.request), true);
  assert.equal(reopened.advancePolicy('0'), '1');
  assert.throws(() => reopened.advancePolicy('0'), /conflict/);
  assert.equal(new DurableGrantEpochs(f.options).policyEpoch, '1');
  assert.equal(f.authority(reopened).verify(next, f.request), false);
});

test('scope revocation covers descendants and preserves siblings', () => {
  const f = setup();
  f.epochs.revoke(cap, ['ledger', 'private']);
  assert.equal(f.epochs.isRevoked(cap, ['ledger', 'private', 'row']), true);
  assert.equal(f.epochs.isRevoked(cap, ['ledger', 'public']), false);
  assert.equal(f.epochs.isRevoked(capability('cap:db:read'), ['ledger', 'private']), false);
});

test('missing or corrupted established epoch state fails closed; interrupted empty initialization recovers', () => {
  const f = setup(), state = join(f.directory, 'state.json'), seal = join(f.directory, 'initialized.json');
  const saved = readFileSync(state);
  writeFileSync(state, 'corrupt');
  assert.throws(() => new DurableGrantEpochs(f.options), /JSON|corrupt|invalid|expected|grant/i);
  writeFileSync(state, saved);
  unlinkSync(state);
  assert.throws(() => new DurableGrantEpochs(f.options), /profile mismatch/);
  writeFileSync(state, saved);
  unlinkSync(seal);
  assert.throws(() => new DurableGrantEpochs(f.options), /missing grant epoch completion receipt/);
  writeFileSync(join(f.directory, 'initializing.json'), encodeCanonical({ format: 'aether.grant-epochs-initializing/1', repositoryId: 'repository' }));
  const recovered = new DurableGrantEpochs(f.options);
  assert.equal(recovered.epoch, '0');
  assert.equal(readFileSync(seal).length > 0, true);
});
