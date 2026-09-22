import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { typecheck } from '../../src/tier2/typecheck.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';

test('B1: Result constructors and exhaustive matching execute in both runtimes', () => {
  const syms = new SymbolSpace('result-language');
  const f = syms.define('unwrap');
  const input = syms.define('input');
  const okValue = syms.define('okValue');
  const errValue = syms.define('errValue');
  const resultType = { t: 'Result' as const, ok: b.Int, err: b.Str };
  const declaration = b.fn({
    symbol: f,
    params: [b.param(input, resultType)],
    returns: b.Int,
    body: b.block(
      b.ret(b.matchResult(b.v(input), okValue, b.v(okValue), errValue, b.int(-1))),
    ),
  });
  const registry = new CapabilityRegistry();
  assert.equal(typecheck(declaration, { registry, symbols: syms }).ok, true);

  const development = new Runtime({ registry, symbols: syms }).load(declaration);
  const developed = development.call(f, [{ variant: 'ok', value: 7n }]);
  assert.equal(developed.ok && developed.value, 7n);
  assert.equal(development.call(f, [{ variant: 'err', value: 'bad' }]).ok, true);

  const production = ProductionRuntime.compile(declaration, { registry, symbols: syms });
  assert.deepEqual(production.call(f, [{ variant: 'ok', value: 7n }]), { ok: true, value: 7n, steps: 0 });
  const failed = production.call(f, [{ variant: 'err', value: 'bad' }]);
  assert.equal(failed.ok && failed.value, -1n);
});
