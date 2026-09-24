import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { executableBundle, parseExecutableBundle, projectTypeScriptV10,
  RUST_PROJECTION_CARGO, type ExecutableTarget } from '../../src/projection/executable.ts';

function fixture() {
  const symbols = new SymbolSpace('projection-contract-calls-v11');
  const nonnegative = symbols.define('nonnegative'), plusOne = symbols.define('plusOne');
  const helper = symbols.define('helper'), main = symbols.define('main');
  const n = symbols.define('n'), x = symbols.define('x');
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: nonnegative, params: [b.param(n, b.Int)], returns: b.Bool,
      body: b.ret(b.ge(b.v(n), b.int(0))) }),
    b.fn({ symbol: plusOne, params: [b.param(n, b.Int)], returns: b.Int,
      body: b.ret(b.add(b.v(n), b.int(1))) }),
    b.fn({ symbol: helper, params: [b.param(n, b.Int)], returns: b.Int,
      body: b.ret(b.call(plusOne, b.v(n))) }),
    b.fn({ symbol: main, params: [b.param(x, b.Int)], returns: b.Int,
      contract: b.contract({
        requires: [b.clause(b.call(nonnegative, b.v(x)), 'nonnegative')],
        ensures: [
          b.clause(b.eq(b.result(), b.call(helper, b.old(b.v(x)))), 'old-plus-one'),
          b.clause(b.eq(b.result(), b.old(b.call(helper, b.v(x)))), 'old-call'),
        ],
      }),
      body: b.block(b.assign(b.place(x), b.int(99)), b.ret(b.int(4))) }),
  ] });
  return { symbols, module, main, helper, plusOne };
}

test('V11 parses visible pure contract calls and preserves exact AST identities', () => {
  const f = fixture(), store = new GraphStore(), root = store.intern(f.module);
  assert.throws(() => projectTypeScriptV10(f.module, f.symbols), /contract profile excludes/);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(f.module);
  const good = reference.call(f.main, [3n]);
  assert.equal(good.ok, true); if (good.ok) assert.equal(good.value, 4n);
  const precondition = reference.call(f.main, [-1n]);
  assert.equal(precondition.ok, false); if (!precondition.ok) assert.equal(precondition.fault.kind, 'precondition');
  const postcondition = reference.call(f.main, [0n]);
  assert.equal(postcondition.ok, false); if (!postcondition.ok) assert.equal(postcondition.fault.kind, 'postcondition');
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(f.module, f.symbols, target);
    assert.match(bundle.source, /@aether-projection\/11/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module), root);
    const changed = bundle.source.replace('ae_int("99")', 'ae_int("98")');
    assert.notEqual(changed, bundle.source);
    assert.notEqual(store.intern(parseExecutableBundle({ ...bundle, source: changed }).module), root);
    const damaged = bundle.source.replace(target === 'rust' ? 'ae_call!' : 'ae_call', 'ae_invoke');
    assert.notEqual(damaged, bundle.source);
    assert.throws(() => parseExecutableBundle({ ...bundle, source: damaged }),
      /scaffolding|capability|expression|arity|metadata|helper/);
  }
});

test('V11 rejects undeclared purity, unsynthesized and indirect paths through contract callees', () => {
  const f = fixture(), module = f.module as Extract<Term, { kind: 'Module' }>;
  const changed = (symbol: string, update: (fn: Extract<Term, { kind: 'FunctionDecl' }>) => Term) =>
    ({ ...module, members: module.members.map(member => member.kind === 'FunctionDecl' && member.symbol === symbol ? update(member) : member) });
  const effectful = changed(f.plusOne, fn => ({ ...fn, purity: 'effectful' as const }));
  const missing = changed(f.plusOne, fn => ({ ...fn, body: null }));
  const indirect = changed(f.plusOne, fn => ({ ...fn, body: b.block(b.exprStmt(b.spawn(b.int(1))), fn.body!) }));
  for (const candidate of [effectful, missing, indirect])
    assert.throws(() => executableBundle(candidate, f.symbols, 'typescript'), /pure callee|closed direct pure call graph/);
});

test('V11 resolves a pure contract callee through an exact-address dependency', () => {
  const symbols = new SymbolSpace('projection-contract-import-v11');
  const plusOne = symbols.define('plusOne'), n = symbols.define('n'), main = symbols.define('main');
  const library = b.module_({ symbol: symbols.define('library'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: plusOne, params: [b.param(n, b.Int)], returns: b.Int,
      body: b.ret(b.add(b.v(n), b.int(1))) }),
  ] });
  const store = new GraphStore(), ref = store.intern(library);
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.import_(ref, [plusOne]),
    b.fn({ symbol: main, params: [b.param(n, b.Int)], returns: b.Int,
      contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.call(plusOne, b.old(b.v(n)))), 'imported')] }),
      body: b.ret(b.add(b.v(n), b.int(1))) }),
  ] });
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target, { modules: new Map([[ref, library]]) });
    assert.match(bundle.source, /@aether-projection\/11/);
    const parsed = parseExecutableBundle(bundle);
    assert.equal(store.intern(parsed.module), store.intern(module));
    assert.equal(store.intern(parsed.modules.get(ref)!), ref);
  }
});

for (const target of ['typescript', 'python', 'rust'] as const)
  test(`V11 actual ${target} contract calls enforce pre and postconditions after mutation`, () => {
    const f = fixture(), bundle = executableBundle(f.module, f.symbols, target);
    const directory = mkdtempSync(join(tmpdir(), 'aether-contract-calls-v11-'));
    const main = bundle.aliases.get(f.main)!;
    try {
      let program: string, args: string[];
      if (target === 'typescript') {
        writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
        writeFileSync(join(directory, 'main.ts'), bundle.source + `\nconst ctx=new Context();const good=${main}(ctx,[3n]);let pre=false,post=false;try{${main}(ctx,[-1n])}catch(e){pre=String(e).includes('nonnegative')}try{${main}(ctx,[0n])}catch(e){post=String(e).includes('old-plus-one')}console.log(JSON.stringify({good:String(good),pre,post}));\n`);
        const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
          '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext',
          '--allowImportingTsExtensions', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        program = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
      } else if (target === 'python') {
        writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
        writeFileSync(join(directory, 'main.py'), bundle.source + `\nctx=Context()\ngood=${main}(ctx,[3])\npre=False\npost=False\ntry: ${main}(ctx,[-1])\nexcept Exception as e: pre='nonnegative' in str(e)\ntry: ${main}(ctx,[0])\nexcept Exception as e: post='old-plus-one' in str(e)\nprint(json.dumps({'good':str(good),'pre':pre,'post':post}))\n`);
        program = 'python3'; args = [join(directory, 'main.py')];
      } else {
        mkdirSync(join(directory, 'src'));
        writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
        writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
        writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
        writeFileSync(join(directory, 'src/main.rs'), bundle.source + `\nfn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn main(){std::panic::set_hook(Box::new(|_|{}));let mut ctx=Context::new(vec![],sink);let good=${main}(&mut ctx,vec![ae_int("3")]);let pre=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${main}(&mut ctx,vec![ae_int("-1")]))).is_err();let post=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${main}(&mut ctx,vec![ae_int("0")]))).is_err();let good=match good{Value::Int(n)=>n.to_string(),_=>panic!("wrong_type")};println!("{}",serde_json::json!({"good":good,"pre":pre,"post":post}));}\n`);
        program = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
      }
      const output = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'target') }, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(output.status, 0, output.stderr);
      assert.deepEqual(JSON.parse(output.stdout), { good: '4', pre: true, post: true });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
