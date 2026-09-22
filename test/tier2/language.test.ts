import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { typecheck } from '../../src/tier2/typecheck.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';
import { TypeScriptProjector } from '../../src/projection/typescript.ts';
import { parseTypeScript } from '../../src/projection/parse.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import type { Term } from '../../src/tier1/ast.ts';

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

test('B2: immutable sequences support index, length, map, and fold', () => {
  const syms = new SymbolSpace('sequence-language');
  const x = syms.define('x');
  const accumulator = syms.define('accumulator');
  const item = syms.define('item');
  const doubleSymbol = syms.define('double');
  const addSymbol = syms.define('add');
  const mainSymbol = syms.define('sequenceTotal');
  const double = b.fn({
    symbol: doubleSymbol, params: [b.param(x, b.Int)], returns: b.Int,
    body: b.block(b.ret(b.mul(b.v(x), b.int(2)))),
  });
  const add = b.fn({
    symbol: addSymbol,
    params: [b.param(accumulator, b.Int), b.param(item, b.Int)],
    returns: b.Int,
    body: b.block(b.ret(b.add(b.v(accumulator), b.v(item)))),
  });
  const main = b.fn({
    symbol: mainSymbol, returns: b.Int,
    body: b.block(b.ret(
      b.add(
        b.fold(b.map(b.seq(b.Int, b.int(1), b.int(2), b.int(3)), doubleSymbol), b.int(0), addSymbol),
        b.add(b.index(b.seq(b.Int, b.int(4)), b.int(0)), b.length(b.seq(b.Int, b.int(9)))),
      ),
    )),
  });
  const module = b.module_({
    symbol: syms.define('sequences'), members: [double, add, main], symbolTable: syms.table(),
  });
  const registry = new CapabilityRegistry();
  assert.equal(typecheck(module, { registry, symbols: syms }).ok, true);
  const development = new Runtime({ registry, symbols: syms }).load(module).call(mainSymbol, []);
  assert.equal(development.ok && development.value, 17n);
  const production = ProductionRuntime.compile(module, { registry, symbols: syms }).call(mainSymbol, []);
  assert.equal(production.ok && production.value, 17n);

  const projector = new TypeScriptProjector(syms);
  const projected = projector.decl(module);
  const moduleNode = module as Extract<Term, { kind: 'Module' }>;
  const bindings = new Map(
    (moduleNode.symbolTable as Extract<Term, { kind: 'SymbolTable' }>).entries.map(([symbol, name]) => [name, symbol]),
  );
  const parsed = parseTypeScript(projected, { symbols: syms, bindings, typeNames: projector.typeNames });
  const store = new GraphStore();
  assert.equal(store.intern(parsed), store.intern(module));
});

test('B3: closures capture lexical values and carry an explicit capability type', () => {
  const syms = new SymbolSpace('closure-language');
  const offset = syms.define('offset');
  const value = syms.define('value');
  const mainSymbol = syms.define('applyOffset');
  const declaration = b.fn({
    symbol: mainSymbol,
    params: [b.param(offset, b.Int)],
    returns: b.Int,
    body: b.block(b.ret(b.apply(
      b.lambda({
        params: [b.param(value, b.Int)], returns: b.Int,
        body: b.add(b.v(value), b.v(offset)),
      }),
      b.int(5),
    ))),
  });
  const registry = new CapabilityRegistry();
  assert.equal(typecheck(declaration, { registry, symbols: syms }).ok, true);
  const development = new Runtime({ registry, symbols: syms }).load(declaration).call(mainSymbol, [7n]);
  assert.equal(development.ok && development.value, 12n);
  const production = ProductionRuntime.compile(declaration, { registry, symbols: syms }).call(mainSymbol, [7n]);
  assert.equal(production.ok && production.value, 12n);
  const projector = new TypeScriptProjector(syms);
  const bindings = new Map(
    (syms.table() as Extract<Term, { kind: 'SymbolTable' }>).entries.map(([symbol, name]) => [name, symbol]),
  );
  const parsed = parseTypeScript(projector.decl(declaration), {
    symbols: syms, bindings, typeNames: projector.typeNames,
  });
  const store = new GraphStore();
  assert.equal(store.intern((parsed as Extract<Term, { kind: 'Module' }>).members[0]), store.intern(declaration));
});

test('B4: generic functions infer and consistently substitute type variables', () => {
  const syms = new SymbolSpace('generic-language');
  const identitySymbol = syms.define('identity');
  const value = syms.define('value');
  const intUse = syms.define('intUse');
  const stringUse = syms.define('stringUse');
  const variable = { t: 'TypeVar' as const, name: 'T' };
  const identity = b.fn({
    symbol: identitySymbol, typeParams: ['T'], params: [b.param(value, variable)], returns: variable,
    body: b.block(b.ret(b.v(value))),
  });
  const asInt = b.fn({
    symbol: intUse, returns: b.Int, body: b.block(b.ret(b.call(identitySymbol, b.int(9)))),
  });
  const asString = b.fn({
    symbol: stringUse, returns: b.Str, body: b.block(b.ret(b.call(identitySymbol, b.str('nine')))),
  });
  const module = b.module_({
    symbol: syms.define('generics'), members: [identity, asInt, asString], symbolTable: syms.table(),
  });
  const registry = new CapabilityRegistry();
  assert.equal(typecheck(module, { registry, symbols: syms }).ok, true);
  const runtime = new Runtime({ registry, symbols: syms }).load(module);
  const intResult = runtime.call(intUse, []);
  const stringResult = runtime.call(stringUse, []);
  assert.equal(intResult.ok && intResult.value, 9n);
  assert.equal(stringResult.ok && stringResult.value, 'nine');

  const projector = new TypeScriptProjector(syms);
  const moduleNode = module as Extract<Term, { kind: 'Module' }>;
  const bindings = new Map(
    (moduleNode.symbolTable as Extract<Term, { kind: 'SymbolTable' }>).entries.map(([symbol, name]) => [name, symbol]),
  );
  const parsed = parseTypeScript(projector.decl(module), { symbols: syms, bindings, typeNames: projector.typeNames });
  const store = new GraphStore();
  assert.equal(store.intern(parsed), store.intern(module));
});

test('B5: string operations are Unicode-aware and available in both runtimes', () => {
  const syms = new SymbolSpace('string-language');
  const textSymbol = syms.define('transform');
  const measureSymbol = syms.define('measure');
  const transformed = b.fn({
    symbol: textSymbol, returns: b.Str,
    body: b.block(b.ret(b.concat(
      b.upper(b.trim(b.str(' hi '))),
      b.slice(b.str('world'), b.int(1), b.int(4)),
    ))),
  });
  const measured = b.fn({
    symbol: measureSymbol, returns: b.Int,
    body: b.block(b.ret(b.cond(
      b.contains(b.lower(b.str('HÉLLO')), b.str('é')),
      b.strlen(b.str('👩‍👩‍👧‍👦')),
      b.int(0),
    ))),
  });
  const module = b.module_({
    symbol: syms.define('strings'), members: [transformed, measured], symbolTable: syms.table(),
  });
  const registry = new CapabilityRegistry();
  assert.equal(typecheck(module, { registry, symbols: syms }).ok, true);
  const development = new Runtime({ registry, symbols: syms }).load(module);
  const transformedResult = development.call(textSymbol, []);
  assert.equal(transformedResult.ok && transformedResult.value, 'HIorl');
  const measuredResult = development.call(measureSymbol, []);
  assert.equal(measuredResult.ok && measuredResult.value, 7n);
  const production = ProductionRuntime.compile(module, { registry, symbols: syms });
  const productionText = production.call(textSymbol, []);
  assert.equal(productionText.ok && productionText.value, 'HIorl');
});

test('B7: fixed-width integers enforce wrap, saturate, and trap policies', () => {
  const syms = new SymbolSpace('fixed-integers');
  const wrap = { t: 'IntN' as const, bits: 8 as const, signed: false, overflow: 'wrap' as const };
  const saturate = { ...wrap, overflow: 'saturate' as const };
  const trap = { ...wrap, overflow: 'trap' as const };
  const make = (name: string, ty: typeof wrap | typeof saturate | typeof trap) => {
    const symbol = syms.define(name);
    return {
      symbol,
      declaration: b.fn({
        symbol, returns: ty,
        body: b.block(b.ret(b.fixed('add', ty, b.intCast(ty, b.int(250)), b.intCast(ty, b.int(10))))),
      }),
    };
  };
  const wrapped = make('wrapped', wrap);
  const saturated = make('saturated', saturate);
  const trapped = make('trapped', trap);
  const module = b.module_({
    symbol: syms.define('fixed'),
    members: [wrapped.declaration, saturated.declaration, trapped.declaration],
    symbolTable: syms.table(),
  });
  const registry = new CapabilityRegistry();
  assert.equal(typecheck(module, { registry, symbols: syms }).ok, true);
  const development = new Runtime({ registry, symbols: syms }).load(module);
  const wrappedResult = development.call(wrapped.symbol, []);
  const saturatedResult = development.call(saturated.symbol, []);
  assert.equal(wrappedResult.ok && wrappedResult.value, 4n);
  assert.equal(saturatedResult.ok && saturatedResult.value, 255n);
  assert.equal(development.call(trapped.symbol, []).ok, false);
  const production = ProductionRuntime.compile(module, { registry, symbols: syms });
  const productionWrapped = production.call(wrapped.symbol, []);
  assert.equal(productionWrapped.ok && productionWrapped.value, 4n);
  assert.equal(production.call(trapped.symbol, []).ok, false);
});
