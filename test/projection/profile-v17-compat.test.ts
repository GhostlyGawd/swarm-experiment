import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { executableBundle, projectTypeScriptV17, projectPythonV17, projectRustV17 } from '../../src/projection/executable.ts';

test('V18 keeps pinned V17 source and runtime bytes in all three targets', () => {
  const symbols = new SymbolSpace('v17-compat-pinned'), entry = symbols.define('entry');
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: entry, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.eq(b.apply(b.lambda({ returns: b.Int,
        body: b.await_(b.spawn(b.int(5))) })), b.int(5)), 'p')] }), body: b.ret(b.int(1)) }),
  ] });
  const expected = {
    typescript: { source: '907aad1fc1f0151b2d8ff310bf1a717c290bf3d11574e6290d3b038f6365be54', runtime: '51e455f07d39013ca1699cdceceb5ee0d2ae1c7078f286581ea0f1380c1174b6' },
    python: { source: '1fdc4a5f2ea56174824cba7b6335874db78151f79fb1ecc4b28600225d688176', runtime: 'e0c6ad6d9b629d72cb3576b125d74c1f3f1661e768c243b2beea312175bc71dc' },
    rust: { source: 'c2f65080f6f62374d6fe84b7d34892afb6ca07d34e7556c905a65d5fefc0dcf1', runtime: '31a65edb6b1c6706150e7782aaf769642ba88b199f143ca3478b82ce49e3c9d5' },
  };
  const named = { typescript: projectTypeScriptV17, python: projectPythonV17, rust: projectRustV17 };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target);
    assert.match(bundle.source, /@aether-projection\/17/);
    assert.equal(hash(named[target](module, symbols)), expected[target].source);
    assert.equal(hash(bundle.source), expected[target].source);
    assert.equal(hash(bundle.runtime), expected[target].runtime);
  }
});
