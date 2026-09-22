import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blake3, blake3Hex, bytesToHex } from '../../src/tier1/blake3.ts';

/** Official BLAKE3 test-vector input: byte i is (i % 251). */
function vectorInput(len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = i % 251;
  return b;
}

const TEST_KEY = new TextEncoder().encode('whats the Elvish word for friend');
const TEST_CONTEXT = 'BLAKE3 2019-12-27 16:29:52 test vectors context';

// From https://github.com/BLAKE3-team/BLAKE3/blob/master/test_vectors/test_vectors.json
// Lengths chosen to exercise sub-block, exact-block, exact-chunk and multi-chunk
// inputs — the cases where block flags and the chunk stack actually matter.
const UNKEYED: Array<[len: number, hash: string]> = [
  [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
  [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
  [64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'],
  [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
  [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
];

const KEYED: Array<[len: number, hash: string]> = [
  [0, '92b2b75604ed3c761f9d6f62392c8a9227ad0ea3f09573e783f1498a4ed60d26'],
  [1024, '75c46f6f3d9eb4f55ecaaee480db732e6c2105546f1e675003687c31719c7ba4'],
  [2048, '879cf1fa2ea0e79126cb1063617a05b6ad9d0b696d0d757cf053439f60a99dd1'],
];

const DERIVE_KEY: Array<[len: number, hash: string]> = [
  [0, '2cc39783c223154fea8dfb7c1b1660f2ac2dcbd1c1de8277b0b0dd39b7e50d7d'],
];

test('BLAKE3 matches official unkeyed vectors', () => {
  for (const [len, hash] of UNKEYED) {
    assert.equal(blake3Hex(vectorInput(len)), hash, `unkeyed len=${len}`);
  }
});

test('BLAKE3 matches official keyed vectors', () => {
  for (const [len, hash] of KEYED) {
    assert.equal(
      bytesToHex(Blake3.keyed(TEST_KEY).update(vectorInput(len)).digest()),
      hash,
      `keyed len=${len}`,
    );
  }
});

test('BLAKE3 matches official derive_key vectors', () => {
  for (const [len, hash] of DERIVE_KEY) {
    assert.equal(
      bytesToHex(Blake3.deriveKey(TEST_CONTEXT).update(vectorInput(len)).digest()),
      hash,
      `derive_key len=${len}`,
    );
  }
});

test('keyed and derive_key are domain-separated from plain hashing', () => {
  const input = vectorInput(100);
  const plain = blake3Hex(input);
  const keyed = Blake3.keyed(TEST_KEY).update(input).hex();
  const derived = Blake3.deriveKey(TEST_CONTEXT).update(input).hex();
  assert.notEqual(plain, keyed);
  assert.notEqual(plain, derived);
  assert.notEqual(keyed, derived);
});

test('extended output (XOF) is a prefix-consistent stream', () => {
  const short = blake3Hex('abc', 32);
  const long = bytesToHex(Blake3.create().update(new TextEncoder().encode('abc')).digest(131));
  assert.equal(long.slice(0, 64), short);
  assert.equal(long.length, 262, '131 bytes squeezed => 262 hex chars');
});

test('incremental updates equal one-shot hashing across chunk boundaries', () => {
  // 5000 bytes spans 5 chunks, so finalization walks an unbalanced CV stack.
  const input = vectorInput(5000);
  const oneShot = blake3Hex(input);
  for (const chunk of [1, 7, 63, 64, 65, 1023, 1024, 1025]) {
    const h = Blake3.create();
    for (let i = 0; i < input.length; i += chunk) h.update(input.subarray(i, i + chunk));
    assert.equal(h.hex(), oneShot, `chunked by ${chunk}`);
  }
});

test('rejects keys that are not 32 bytes', () => {
  assert.throws(() => Blake3.keyed(new Uint8Array(31)), RangeError);
});
