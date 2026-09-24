import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { executableBundle, projectTypeScriptV16, projectPythonV16, projectRustV16 } from '../../src/projection/executable.ts';

test('V17 keeps pinned V16 source and runtime bytes in all three targets', () => {
  const symbols = new SymbolSpace('v16-compat-pinned');
  const helper = symbols.define('helper'), entry = symbols.define('entry');
  const wrapper = symbols.define('wrapper'), f = symbols.define('f');
  const closure = { t: 'Fn' as const, params: [], returns: b.Int, capabilities: [] };
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: helper, returns: b.Int, body: b.ret(b.int(7)) }),
    b.fn({ symbol: entry, params: [b.param(f, closure)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.v(f)), b.int(0)), 'p')] }),
      body: b.ret(b.apply(b.v(f))) }),
    b.fn({ symbol: wrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int, body: b.call(helper) }))) }),
  ] });
  const expected = {
    typescript: { source: '606cb69672fb027b30c965f1a1af5fe9a9d2d1ff07b38290d7f2b1e852324127', runtime: '056b1750ca602a2947bafacee90acb4ae4c27aa67ea2e235d4448bb617c68d10' },
    python: { source: '717cde707dd4eed34cb3993bee09f401653937aaa44d5b480a3129009f406f11', runtime: '1a3f8f7be79f3bc7bcd062162a6b69d83bc00ad851c6e8331588938009ca39be' },
    rust: { source: '5670b536b9c320140c25edb529b86d9198befeb8c24c5a7ce1380e6fcd4566d9', runtime: 'ea3501f0649b7f16f2d25ed2f7dbdf9286953de0e26ed9006df5aa9071ff2c4c' },
  };
  const named = { typescript: projectTypeScriptV16, python: projectPythonV16, rust: projectRustV16 };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target);
    assert.match(bundle.source, /@aether-projection\/16/);
    assert.equal(hash(named[target](module, symbols)), expected[target].source);
    assert.equal(hash(bundle.source), expected[target].source);
    assert.equal(hash(bundle.runtime), expected[target].runtime);
  }
});
