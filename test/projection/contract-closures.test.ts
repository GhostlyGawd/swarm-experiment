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
import { executableBundle, parseExecutableBundle, RUST_PROJECTION_CARGO } from '../../src/projection/executable.ts';

function fixture() {
  const symbols = new SymbolSpace('projection-contract-closure-v14');
  const factory = symbols.define('factory'), entry = symbols.define('entry'), badPost = symbols.define('badPost');
  const inline = symbols.define('inline'), mutating = symbols.define('mutating');
  const captured = symbols.define('captured'), value = symbols.define('value');
  const closure: Ty = { t: 'Fn', params: [], returns: b.Int, capabilities: [] };
  const predicate = b.contract({
    requires: [b.clause(b.gt(b.apply(b.call(factory, b.v(value))), b.int(2)), 'positive closure')],
    ensures: [b.clause(b.eq(b.result(), b.apply(b.call(factory, b.old(b.v(value))))), 'old closure')],
  });
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: factory, params: [b.param(captured, b.Int)], returns: closure,
      body: b.ret(b.lambda({ returns: b.Int, body: b.add(b.v(captured), b.int(2)) })) }),
    b.fn({ symbol: entry, params: [b.param(value, b.Int)], returns: b.Int,
      contract: predicate, body: b.ret(b.add(b.v(value), b.int(2))) }),
    b.fn({ symbol: badPost, params: [b.param(value, b.Int)], returns: b.Int,
      contract: predicate, body: b.ret(b.add(b.v(value), b.int(3))) }),
    b.fn({ symbol: inline, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.apply(b.lambda({ returns: b.Bool, body: b.bool(true) })), 'inline closure')] }),
      body: b.ret(b.int(1)) }),
    b.fn({ symbol: mutating, params: [b.param(value, b.Int)], returns: b.Int,
      contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.apply(b.lambda({ returns: b.Int, body: b.v(value) }))), 'live scalar capture')] }),
      body: b.block(b.assign(b.place(value), b.add(b.v(value), b.int(1))), b.ret(b.v(value))) }),
  ] });
  return { symbols, module, factory, entry, badPost, inline, mutating };
}

test('V14 round-trips exact closure contracts and rejects hidden native capture edits', () => {
  const f = fixture(), store = new GraphStore(), root = store.intern(f.module);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(f.module);
  const good = reference.call(f.entry, [3n]), denied = reference.call(f.entry, [0n]);
  const post = reference.call(f.badPost, [3n]), inline = reference.call(f.inline, []);
  const mutating = reference.call(f.mutating, [3n]);
  assert.equal(good.ok, true); if (good.ok) assert.equal(good.value, 5n);
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.fault.kind, 'precondition');
  assert.equal(post.ok, false); if (!post.ok) assert.equal(post.fault.kind, 'postcondition');
  assert.equal(inline.ok, true); if (inline.ok) assert.equal(inline.value, 1n);
  assert.equal(mutating.ok, true); if (mutating.ok) assert.equal(mutating.value, 4n);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(f.module, f.symbols, target);
    assert.match(bundle.source, /@aether-projection\/14/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module), root);
    const edited = bundle.source.replace('ae_int("2")', 'ae_int("4")');
    assert.notEqual(edited, bundle.source);
    assert.notEqual(store.intern(parseExecutableBundle({ ...bundle, source: edited }).module), root);
    const hidden = bundle.source.replace('ae_capture(ae_captures, "0")', 'ae_capture(ae_captures, "9")');
    assert.notEqual(hidden, bundle.source);
    assert.throws(() => parseExecutableBundle({ ...bundle, source: hidden }), /capture index|scaffolding/);
  }
});

test('V14 rejects captured records, effectful closure bodies and opaque targets', () => {
  const symbols = new SymbolSpace('projection-contract-closure-refusal-v14');
  const box: Ty = { t: 'Record', name: 'type:projection:captured-box' as never, fields: [['value', b.Int]] };
  const recordFactory = symbols.define('recordFactory'), recordEntry = symbols.define('recordEntry');
  const recordValue = symbols.define('recordValue'), recordWrapper = symbols.define('recordWrapper');
  const closure: Ty = { t: 'Fn', params: [], returns: b.Int, capabilities: [] };
  const recordModule = b.module_({ symbol: symbols.define('recordModule'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: recordFactory, params: [b.param(recordValue, box)], returns: closure,
      body: b.ret(b.lambda({ returns: b.Int, body: b.field(b.v(recordValue), 'value') })) }),
    b.fn({ symbol: recordEntry, params: [b.param(recordValue, box)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.call(recordFactory, b.v(recordValue))), b.int(0)), 'record capture')] }),
      body: b.ret(b.int(1)) }),
    b.fn({ symbol: recordWrapper, returns: b.Int,
      body: b.ret(b.call(recordEntry, b.record(box as Extract<Ty,{t:'Record'}>, { value: b.int(2) }))) }),
  ] });
  assert.equal(typecheck(recordModule, { registry: new CapabilityRegistry() }).ok, true);
  const recordResult = new Runtime({ registry: new CapabilityRegistry() }).load(recordModule).call(recordWrapper, []);
  assert.equal(recordResult.ok, true);

  const opaqueSymbols = new SymbolSpace('projection-contract-opaque-v14');
  const fn = opaqueSymbols.define('fn'), entry = opaqueSymbols.define('entry'), wrapper = opaqueSymbols.define('wrapper');
  const opaqueModule = b.module_({ symbol: opaqueSymbols.define('module'), symbolTable: opaqueSymbols.table(), members: [
    b.fn({ symbol: entry, params: [b.param(fn, closure)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.v(fn)), b.int(0)), 'opaque target')] }),
      body: b.ret(b.int(1)) }),
    b.fn({ symbol: wrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int, body: b.int(2) }))) }),
  ] });
  assert.equal(typecheck(opaqueModule, { registry: new CapabilityRegistry() }).ok, true);
  const opaqueResult = new Runtime({ registry: new CapabilityRegistry() }).load(opaqueModule).call(wrapper, []);
  assert.equal(opaqueResult.ok, true);

  const localSymbols = new SymbolSpace('projection-contract-local-capture-v14');
  const localFactory = localSymbols.define('factory'), localEntry = localSymbols.define('entry');
  const input = localSymbols.define('input'), local = localSymbols.define('local');
  const localModule = b.module_({ symbol: localSymbols.define('module'), symbolTable: localSymbols.table(), members: [
    b.fn({ symbol: localFactory, params: [b.param(input, b.Int)], returns: closure,
      body: b.block(b.let_(local, b.Int, b.v(input)), b.ret(b.lambda({ returns: b.Int, body: b.v(local) }))) }),
    b.fn({ symbol: localEntry, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.call(localFactory, b.int(2))), b.int(0)), 'local capture')] }),
      body: b.ret(b.int(1)) }),
  ] });
  assert.equal(typecheck(localModule, { registry: new CapabilityRegistry() }).ok, true);
  const localResult = new Runtime({ registry: new CapabilityRegistry() }).load(localModule).call(localEntry, []);
  assert.equal(localResult.ok, true);

  const f = fixture(), effectful = { ...f.module, members: (f.module as Extract<Term,{kind:'Module'}>).members.map(member => member.kind === 'FunctionDecl' && member.symbol === f.factory
    ? { ...member, body: b.ret(b.lambda({ returns: b.Int, capabilities: ['cap:test:emit' as never], body: b.int(1) })) } : member) };
  const recursive = { ...f.module, members: (f.module as Extract<Term,{kind:'Module'}>).members.map(member => member.kind === 'FunctionDecl' && member.symbol === f.factory
    ? { ...member, body: b.ret(b.lambda({ returns: b.Int, body: b.apply(b.call(f.factory, b.int(1))) })) } : member) };
  for (const target of ['typescript', 'python', 'rust'] as const) {
    assert.throws(() => executableBundle(recordModule, symbols, target), /captures mutable or opaque state/);
    assert.throws(() => executableBundle(opaqueModule, opaqueSymbols, target), /exact direct factory/);
    assert.throws(() => executableBundle(localModule, localSymbols, target), /visible direct lambda/);
    assert.throws(() => executableBundle(effectful, f.symbols, target), /requires no capabilities/);
    assert.throws(() => executableBundle(recursive, f.symbols, target), /factory cycle/);
  }
});

test('V14 binds a read-only closure factory through an exact-address import', () => {
  const symbols = new SymbolSpace('projection-contract-closure-import-v14');
  const factory = symbols.define('factory'), entry = symbols.define('entry');
  const input = symbols.define('input');
  const closure: Ty = { t: 'Fn', params: [], returns: b.Bool, capabilities: [] };
  const library = b.module_({ symbol: symbols.define('library'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: factory, params: [b.param(input, b.Int)], returns: closure,
      body: b.ret(b.lambda({ returns: b.Bool, body: b.gt(b.v(input), b.int(0)) })) }),
  ] });
  const store = new GraphStore(), libraryRoot = store.intern(library);
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.import_(libraryRoot, [factory]),
    b.fn({ symbol: entry, params: [b.param(input, b.Int)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.apply(b.call(factory, b.v(input))), 'imported closure')] }),
      body: b.ret(b.v(input)) }),
  ] });
  const root = store.intern(module);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target, { modules: new Map([[libraryRoot, library]]) });
    assert.match(bundle.source, /@aether-projection\/14/);
    assert.equal(bundle.dependencies?.size, 1);
    const parsed = parseExecutableBundle(bundle);
    assert.equal(store.intern(parsed.module), root);
    assert.equal(store.intern(parsed.modules.get(libraryRoot)!), libraryRoot);
  }
});

for (const target of ['typescript', 'python', 'rust'] as const)
  test(`V14 actual ${target} scalar-capture closure contracts match reference outcomes`, () => {
    const f = fixture(), bundle = executableBundle(f.module, f.symbols, target);
    const directory = mkdtempSync(join(tmpdir(), 'aether-contract-closure-v14-'));
    const entry = bundle.aliases.get(f.entry)!, badPost = bundle.aliases.get(f.badPost)!, inline = bundle.aliases.get(f.inline)!;
    const mutating = bundle.aliases.get(f.mutating)!;
    try {
      let program: string, args: string[];
      if (target === 'typescript') {
        writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
        writeFileSync(join(directory, 'main.ts'), bundle.source + `\nconst ctx=new Context();const good=${entry}(ctx,[3n]);let pre=false,post=false;try{${entry}(ctx,[0n])}catch(e){pre=String(e).includes('positive closure')}try{${badPost}(ctx,[3n])}catch(e){post=String(e).includes('old closure')}const inline=${inline}(ctx,[]),live=${mutating}(ctx,[3n]);console.log(JSON.stringify({good:String(good),pre,post,inline:String(inline),live:String(live)}));\n`);
        const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
          '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext',
          '--allowImportingTsExtensions', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        program = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
      } else if (target === 'python') {
        writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
        writeFileSync(join(directory, 'main.py'), bundle.source + `\nctx=Context()\ngood=${entry}(ctx,[3])\npre=False\npost=False\ntry: ${entry}(ctx,[0])\nexcept Exception as e: pre='positive closure' in str(e)\ntry: ${badPost}(ctx,[3])\nexcept Exception as e: post='old closure' in str(e)\ninline=${inline}(ctx,[])\nlive=${mutating}(ctx,[3])\nprint(json.dumps({'good':str(good),'pre':pre,'post':post,'inline':str(inline),'live':str(live)}))\n`);
        program = 'python3'; args = [join(directory, 'main.py')];
      } else {
        mkdirSync(join(directory, 'src'));
        writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
        writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
        writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
        writeFileSync(join(directory, 'src/main.rs'), bundle.source + `\nfn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn as_int(v:Value)->String{match v{Value::Int(n)=>n.to_string(),_=>panic!("wrong_type")}}fn main(){std::panic::set_hook(Box::new(|_|{}));let mut ctx=Context::new(vec![],sink);let good=${entry}(&mut ctx,vec![ae_int("3")]);let pre=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${entry}(&mut ctx,vec![ae_int("0")]))).is_err();let post=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${badPost}(&mut ctx,vec![ae_int("3")]))).is_err();let inline=${inline}(&mut ctx,vec![]);let live=${mutating}(&mut ctx,vec![ae_int("3")]);println!("{}",serde_json::json!({"good":as_int(good),"pre":pre,"post":post,"inline":as_int(inline),"live":as_int(live)}));}\n`);
        program = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
      }
      const output = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'target') }, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(output.status, 0, output.stderr);
      assert.deepEqual(JSON.parse(output.stdout), { good: '5', pre: true, post: true, inline: '1', live: '4' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
