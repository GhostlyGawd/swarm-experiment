import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainDigest } from '../../src/fabric/identity.ts';
import { allocateFractionalPosition, compareFractionalPositions, parseFractionalPosition } from '../../src/tier1/fractional-position.ts';
import { allocateFractionalPosition as modelAllocate } from '../../roadmap/v4/research/replication-model.ts';
const id = (n: number) => domainDigest('aether.operation-id/1', n);

test('Tree-CRDT fractional allocator matches D04 exact rational model and distinguishes concurrent interval edits', () => {
  for (const [left, right] of [[null, null], [null, 'fi1:1/1'], ['fi1:2/1', null], ['fi1:1/1', 'fi1:1/1;1/2'], ['fi1:1/1;1/2', 'fi1:1/1;2/3']] as const) {
    const keys = Array.from({ length: 20 }, (_, index) => allocateFractionalPosition(left, right, id(index)));
    assert.equal(new Set(keys).size, keys.length);
    keys.forEach((key, index) => {
      assert.equal(key, modelAllocate(left, right, id(index)));
      if (left) assert.ok(compareFractionalPositions(left, key) < 0);
      if (right) assert.ok(compareFractionalPositions(key, right) < 0);
    });
  }
  assert.equal(compareFractionalPositions('fi1:9007199254740993/1', 'fi1:9007199254740992/1'), 1);
});

test('Tree-CRDT fraction bounds reject noncanonical input and exhaustion before publishing', () => {
  for (const key of ['fi1:', 'fi1:0/1', 'fi1:01/2', 'fi1:2/4', 'fi1:1/0', 'fi1:-1/2', 'position-1', `fi1:${'1/1;'.repeat(8)}1/1`, `fi1:${'9'.repeat(129)}/1`]) assert.throws(() => parseFractionalPosition(key));
  assert.throws(() => allocateFractionalPosition('fi1:1/1', 'fi1:1/1', id(1)), /equal_fractional_bounds/);
  assert.throws(() => allocateFractionalPosition('fi1:2/1', 'fi1:1/1', id(1)), /reversed/);
  const left = `fi1:${Array(7).fill('1/1').join(';')}`, right = `${left};1/1`;
  assert.throws(() => allocateFractionalPosition(left, right, id(1)), /depth/);
});
