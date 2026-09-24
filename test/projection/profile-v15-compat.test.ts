import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { executableBundle, projectTypeScriptV15, projectPythonV15, projectRustV15 } from '../../src/projection/executable.ts';

test('V16 keeps the pinned V15 source and runtime bytes in all three targets', () => {
  const symbols = new SymbolSpace('v15-compat-pinned');
  const factory = symbols.define('factory'), entry = symbols.define('entry');
  const value = symbols.define('value'), local = symbols.define('local');
  const closure = { t: 'Fn' as const, params: [], returns: b.Int, capabilities: [] };
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: factory, params: [b.param(value, b.Int)], returns: closure,
      body: b.block(b.let_(local, b.Int, b.v(value)),
        b.ret(b.lambda({ returns: b.Int, body: b.add(b.v(local), b.int(1)) }))) }),
    b.fn({ symbol: entry, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.call(factory, b.int(3))), b.int(0)), 'p')] }),
      body: b.ret(b.int(1)) }),
  ] });
  const expected = {
    typescript: { source: '65c291afb15930690928121db7c167f7c10472be7ac8b1fe332c6e37eda8ab65', runtime: 'e436440ca6d18efbca97bde0e195130bcc96d5910746d2bfc5f5ca6af9a4a211' },
    python: { source: 'eed90dda619add79e2fb8e4264241f0156d60a85d10352072db89fc76bff1d6e', runtime: 'dbcf35b4e9428603f3e7817ab018360acd62d3a9fc88f11c97bb546354f8775b' },
    rust: { source: '978b7a1956acd6f0d3cc4e04a80146fc84bb92fac5da4de787da5a886c929c5b', runtime: 'fa785bd4faf364efde5c3ba92e0c3985bbed21fe43721c2a378ed447b9dfc165' },
  };
  const named = { typescript: projectTypeScriptV15, python: projectPythonV15, rust: projectRustV15 };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target);
    assert.match(bundle.source, /@aether-projection\/15/);
    assert.equal(hash(named[target](module, symbols)), expected[target].source);
    assert.equal(hash(bundle.source), expected[target].source);
    assert.equal(hash(bundle.runtime), expected[target].runtime);
  }
});
