import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { typeName } from '../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { FallbackTreeRuntime, type FallbackTreeOptions } from '../../src/tier3/fallback-tree.ts';
export function fallbackFixture(directory: string, mode: 'fallback' | 'primary' | 'abort' = 'fallback', fault?: FallbackTreeOptions['fault']) {
  mkdirSync(directory, { recursive: true }); const keyPath = join(directory, 'issuer.pem');
  if (!existsSync(keyPath)) writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const symbols = new SymbolSpace('fallback-fixture'), one = symbols.define('primary'), two = symbols.define('conservative'), left = symbols.define('left'), right = symbols.define('right'), temporary = symbols.define('temporary');
  const record = { t: 'Record' as const, name: typeName('type:fallback:record'), fields: [['value', b.Int] as const] };
  const contract = b.contract({ modifies: [b.place(left, 'value')], ensures: [b.clause(b.eq(b.result(), b.add(b.old(b.field(b.v(left), 'value')), b.int(1))), 'increment-once')] });
  const correct = b.block(b.let_(temporary, record, b.record(record, { value: b.int(888) })), b.assign(b.place(left, 'value'), b.add(b.field(b.v(left), 'value'), b.int(1))), b.ret(b.field(b.v(right), 'value')));
  const broken = b.block(b.let_(temporary, record, b.record(record, { value: b.int(777) })), b.assign(b.place(left, 'value'), b.int(99)), b.assert_(b.bool(false), 'deliberate-fault'), b.ret(b.int(99)));
  const members = [b.fn({ symbol: one, params: [b.param(left, record), b.param(right, record)], returns: b.Int, contract, body: mode === 'primary' ? correct : broken }), b.fn({ symbol: two, params: [b.param(left, record), b.param(right, record)], returns: b.Int, contract, body: mode === 'abort' ? broken : correct })];
  const module = b.module_({ symbol: symbols.define('module'), members, symbolTable: symbols.table() }), registry = new CapabilityRegistry(), d = (value: string) => domainDigest('aether.fallback-fixture/1', value);
  const manifest = createEvidenceManifest({ module, registry, specification: 'Increment aliased input once or preserve state.', semanticsVersion: 'reference/1', compilerDigest: d('compiler'), capabilityPolicyDigest: d('policy'), target: { abiVersion: 'local/1', profileDigest: d('profile'), artifactDigest: d('artifact') } });
  let revoked = false;
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(37), repositoryId: 'fallback-test', clock: () => 100, policyEpoch: () => '0', revocationEpoch: () => revoked ? '1' : '0', isRevoked: () => revoked, authorizeIssue: () => true, authorizeDelegate: () => true });
  const options: FallbackTreeOptions = { directory: join(directory, 'runtime'), module, manifest, tier1: one, tier2: two, grants, key: readFileSync(keyPath, 'utf8'), fault };
  return { runtime: new FallbackTreeRuntime(options), options, record, revoke: () => { revoked = true; } };
}
