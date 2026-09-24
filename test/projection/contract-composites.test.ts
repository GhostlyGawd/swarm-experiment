import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import type { Term, Ty } from '../../src/tier1/ast.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { typecheck } from '../../src/tier2/typecheck.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { executableBundle, parseExecutableBundle, projectTypeScriptV13, projectPythonV13, projectRustV13, RUST_PROJECTION_CARGO } from '../../src/projection/executable.ts';

function fixture() {
  const symbols = new SymbolSpace('projection-contract-composites');
  const box: Ty = { t: 'Record', name: 'type:projection:contract-box' as never, fields: [['value', b.Int]] };
  const read = symbols.define('read'), sum = symbols.define('sum'), entry = symbols.define('entry');
  const mutator = symbols.define('mutator');
  const good = symbols.define('good'), bad = symbols.define('bad');
  const identity = symbols.define('identity'), genericValue = symbols.define('genericValue');
  const increment = symbols.define('increment'), incrementValue = symbols.define('incrementValue');
  const value = symbols.define('value'), accumulator = symbols.define('accumulator');
  const item = symbols.define('item'), argument = symbols.define('argument');
  const readFn = b.fn({ symbol: read, params: [b.param(value, box)], returns: b.Int,
    body: b.ret(b.field(b.v(value), 'value')) });
  const sumFn = b.fn({ symbol: sum, params: [b.param(accumulator, b.Int), b.param(item, b.Int)],
    returns: b.Int, body: b.ret(b.add(b.v(accumulator), b.v(item))) });
  const variable: Ty = { t: 'TypeVar', name: 'T' };
  const identityFn = b.fn({ symbol: identity, typeParams: ['T'], params: [b.param(genericValue, variable)],
    returns: variable, body: b.ret(b.v(genericValue)) });
  const incrementFn = b.fn({ symbol: increment, params: [b.param(incrementValue, b.Int)], returns: b.Int,
    body: b.ret(b.add(b.v(incrementValue), b.int(1))) });
  const source = b.seq(b.Int, b.int(1), b.int(2));
  const entryFn = b.fn({ symbol: entry, params: [b.param(argument, box)], returns: b.Int,
    contract: b.contract({ requires: [
      b.clause(b.gt(b.call(read, b.v(argument)), b.int(0)), 'positive record'),
      b.clause(b.eq(b.fold(source, b.int(0), sum), b.int(3)), 'pure fold'),
      b.clause(b.eq(b.length(b.map(source, increment)), b.int(2)), 'pure map'),
      b.clause(b.eq(b.field(b.call(identity, b.v(argument)), 'value'), b.call(read, b.v(argument))), 'generic record'),
    ], ensures: [b.clause(b.eq(b.result(), b.add(b.call(read, b.old(b.v(argument))), b.int(2))), 'old record')] }),
    body: b.ret(b.add(b.field(b.v(argument), 'value'), b.int(2))) });
  const callWith = (symbol: typeof good, integer: number) => b.fn({ symbol, returns: b.Int,
    body: b.ret(b.call(entry, b.record(box as Extract<Ty, { t: 'Record' }>, { value: b.int(integer) }))) });
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(),
    members: [readFn, sumFn, identityFn, incrementFn, entryFn, callWith(good, 3), callWith(bad, -1)] });
  return { symbols, box, module, entry, read, readFn, value, mutator, good, bad };
}

test('V13 contract calls accept read-only composite inputs and pure sequence folds', () => {
  const f = fixture(), store = new GraphStore(), root = store.intern(f.module);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(f.module);
  const good = reference.call(f.good, []), bad = reference.call(f.bad, []);
  assert.equal(good.ok, true); if (good.ok) assert.equal(good.value, 5n);
  assert.equal(bad.ok, false); if (!bad.ok) assert.equal(bad.fault.kind, 'precondition');
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(f.module, f.symbols, target);
    assert.match(bundle.source, /@aether-projection\/13/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module), root);
    const changed = bundle.source.replace('ae_int("2")', 'ae_int("4")');
    assert.notEqual(changed, bundle.source);
    assert.notEqual(store.intern(parseExecutableBundle({ ...bundle, source: changed }).module), root);
    const altered = bundle.source.replace('ae_generic_call', 'ae_call');
    assert.notEqual(altered, bundle.source);
    assert.throws(() => parseExecutableBundle({ ...bundle, source: altered }),
      /scaffolding|helper|arity|expression/);
  }
});

test('V13 rejects mutable and effectful contract callees, including transitive paths', () => {
  const f = fixture(), module = f.module as Extract<Term, { kind: 'Module' }>;
  const mutating = { ...f.readFn, body: b.block(
    b.assign(b.place(f.value, 'value'), b.int(99)), b.ret(b.field(b.v(f.value), 'value')),
  ) };
  const direct = { ...module, members: module.members.map(member => member.kind === 'FunctionDecl' && member.symbol === f.read ? mutating : member) };
  const mutator = { ...mutating, symbol: f.mutator };
  const indirect = { ...module, members: [...module.members.map(member => member.kind === 'FunctionDecl' && member.symbol === f.read
    ? { ...member, body: b.ret(b.call(f.mutator, b.v(f.value))) } : member), mutator] };
  const effectfulFold = { ...module, members: module.members.map(member => member.kind === 'FunctionDecl' && member.symbol !== f.read && member.symbol !== f.entry && member.symbol !== f.good && member.symbol !== f.bad
    ? { ...member, purity: 'effectful' as const } : member) };
  for (const target of ['typescript', 'python', 'rust'] as const)
    assert.throws(() => executableBundle(direct, f.symbols, target), /read-only callee/);
  for (const target of ['typescript', 'python', 'rust'] as const)
    assert.throws(() => executableBundle(indirect, f.symbols, target), /read-only callee/);
  for (const target of ['typescript', 'python', 'rust'] as const)
    assert.throws(() => executableBundle(effectfulFold, f.symbols, target), /synthesized pure callee/);
});

test('V13 still rejects a valid pure closure predicate while V14 admits its exact root', () => {
  const symbols = new SymbolSpace('projection-contract-indirect-gap');
  const factory = symbols.define('factory'), entry = symbols.define('entry');
  const closure: Ty = { t: 'Fn', params: [], returns: b.Bool, capabilities: [] };
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: factory, returns: closure,
      body: b.ret(b.lambda({ returns: b.Bool, body: b.bool(true) })) }),
    b.fn({ symbol: entry, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.apply(b.call(factory)), 'closure predicate')] }),
      body: b.ret(b.int(1)) }),
  ] });
  assert.equal(typecheck(module, { registry: new CapabilityRegistry() }).ok, true);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(module).call(entry, []);
  assert.equal(reference.ok, true); if (reference.ok) assert.equal(reference.value, 1n);
  const legacy = { typescript: projectTypeScriptV13, python: projectPythonV13, rust: projectRustV13 };
  const root = new GraphStore().intern(module);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    assert.throws(() => legacy[target](module, symbols), /contract profile/);
    const bundle = executableBundle(module, symbols, target);
    assert.match(bundle.source, /@aether-projection\/14/);
    assert.equal(new GraphStore().intern(parseExecutableBundle(bundle).module), root);
  }
});

test('V13 carries typed contract helpers through an exact-address import closure', () => {
  const symbols = new SymbolSpace('projection-contract-composite-import');
  const box: Ty = { t: 'Record', name: 'type:projection:imported-box' as never, fields: [['value', b.Int]] };
  const read = symbols.define('read'), entry = symbols.define('entry');
  const input = symbols.define('input');
  const library = b.module_({ symbol: symbols.define('library'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: read, params: [b.param(input, box)], returns: b.Int,
      body: b.ret(b.field(b.v(input), 'value')) }),
  ] });
  const store = new GraphStore(), libraryRoot = store.intern(library);
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.import_(libraryRoot, [read]),
    b.fn({ symbol: entry, params: [b.param(input, box)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.call(read, b.v(input)), b.int(0)), 'imported record')] }),
      body: b.ret(b.call(read, b.v(input))) }),
  ] });
  const root = store.intern(module);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target, { modules: new Map([[libraryRoot, library]]) });
    assert.match(bundle.source, /@aether-projection\/13/);
    assert.equal(bundle.dependencies?.size, 1);
    const parsed = parseExecutableBundle(bundle);
    assert.equal(store.intern(parsed.module), root);
    assert.equal(store.intern(parsed.modules.get(libraryRoot)!), libraryRoot);
  }
});

for (const target of ['typescript', 'python', 'rust'] as const)
  test(`V13 actual ${target} composite contract checks pass and fail before body execution`, () => {
    const f = fixture(), bundle = executableBundle(f.module, f.symbols, target);
    const directory = mkdtempSync(join(tmpdir(), 'aether-contract-composite-'));
    const name = bundle.aliases.get(f.entry)!;
    const type = JSON.stringify(JSON.stringify(f.box));
    try {
      let program: string, args: string[];
      if (target === 'typescript') {
        writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
        writeFileSync(join(directory, 'main.ts'), bundle.source + `\nconst ctx=new Context();const make=(n:string)=>ae_record(${type},[['value',ae_int(n)]]);const good=${name}(ctx,[make('3')]);let bad=false;try{${name}(ctx,[make('-1')])}catch(e){bad=String(e).includes('positive record')}console.log(JSON.stringify({good:String(good),bad}));\n`);
        const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
          '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext',
          '--allowImportingTsExtensions', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        program = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
      } else if (target === 'python') {
        writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
        writeFileSync(join(directory, 'main.py'), bundle.source + `\nctx=Context()\ndef make(n): return ae_record(${type},[['value',ae_int(n)]])\ngood=${name}(ctx,[make('3')])\nbad=False\ntry: ${name}(ctx,[make('-1')])\nexcept Exception as e: bad='positive record' in str(e)\nprint(json.dumps({'good':str(good),'bad':bad}))\n`);
        program = 'python3'; args = [join(directory, 'main.py')];
      } else {
        mkdirSync(join(directory, 'src'));
        writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
        writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
        writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
        writeFileSync(join(directory, 'src/main.rs'), bundle.source + `\nfn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn make(n:&str)->Value{ae_record(${type},vec![("value",ae_int(n))])}fn main(){std::panic::set_hook(Box::new(|_|{}));let mut ctx=Context::new(vec![],sink);let good=${name}(&mut ctx,vec![make("3")]);let bad=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${name}(&mut ctx,vec![make("-1")]))).is_err();let good=match good{Value::Int(n)=>n.to_string(),_=>panic!("wrong_type")};println!("{}",serde_json::json!({"good":good,"bad":bad}));}\n`);
        program = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
      }
      const output = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'target') }, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(output.status, 0, output.stderr);
      assert.deepEqual(JSON.parse(output.stdout), { good: '5', bad: true });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
