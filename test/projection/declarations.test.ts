import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { executableBundle, parseExecutableBundle, projectTypeScriptV8,
  RUST_PROJECTION_CARGO, type ExecutableTarget } from '../../src/projection/executable.ts';

function fixture() {
  const symbols = new SymbolSpace('projection-declarations-v9');
  const declared = symbols.define('declared'), main = symbols.define('main');
  const contract = b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(7)), 'declared-result')] });
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: declared, returns: b.Int, contract, body: null }),
    b.fn({ symbol: main, returns: b.Int, body: b.ret(b.int(7)) }),
  ] });
  return { symbols, module, declared, main };
}

test('V9 round-trips null bodies exactly and rejects changed executable scaffolding', () => {
  const f = fixture(), store = new GraphStore(), root = store.intern(f.module);
  assert.throws(() => projectTypeScriptV8(f.module, f.symbols), /synthesized bodies/);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(f.module, f.symbols, target);
    assert.match(bundle.source, /@aether-projection\/9/);
    assert.match(bundle.source, /@aether-body null/);
    assert.match(bundle.source, /ae_unsynthesized/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module), root);
    assert.throws(() => parseExecutableBundle({ ...bundle,
      source: bundle.source.replace('return ae_unsynthesized(', 'return ae_unit(') }), /scaffolding|unsupported|expression/);
    assert.throws(() => parseExecutableBundle({ ...bundle, runtime: bundle.runtime.replace('unsynthesized_body', 'fabricated_result') }),
      /runtime does not match/);
  }
});

test('V9 propagates unsynthesized dependency identity through exact-address imports', () => {
  const f = fixture(), store = new GraphStore();
  const dependency = b.module_({ symbol: f.symbols.define('library'), symbolTable: f.symbols.table(),
    members: [b.fn({ symbol: f.declared, returns: b.Int, body: null })] });
  const ref = store.intern(dependency);
  const entry = b.module_({ symbol: f.symbols.define('entry'), symbolTable: f.symbols.table(), members: [
    b.import_(ref, [f.declared]),
    b.fn({ symbol: f.main, returns: b.Int, body: b.ret(b.call(f.declared)) }),
  ] });
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(entry, f.symbols, target, { modules: new Map([[ref, dependency]]) });
    assert.match(bundle.source, /@aether-projection\/9/);
    const dependencySource = [...bundle.dependencies!.values()][0];
    assert.match(dependencySource, /@aether-projection\/9/);
    assert.match(dependencySource, /ae_unsynthesized/);
    const parsed = parseExecutableBundle(bundle);
    assert.equal(store.intern(parsed.module), store.intern(entry));
    assert.equal(store.intern(parsed.modules.get(ref)!), ref);
    const files = new Map(bundle.dependencies);
    const [name] = [...files.keys()];
    files.set(name, dependencySource.replace('return ae_unsynthesized(', 'return ae_unit('));
    assert.throws(() => parseExecutableBundle({ ...bundle, dependencies: files }), /scaffolding|content address|unsupported/);
  }
});

for (const target of ['typescript', 'python', 'rust'] as const)test(`V9 actual ${target} declaration traps while synthesized code executes`, () => {
  const f = fixture(), bundle = executableBundle(f.module, f.symbols, target);
  const directory = mkdtempSync(join(tmpdir(), 'aether-declarations-v9-'));
  const declared = bundle.aliases.get(f.declared)!, main = bundle.aliases.get(f.main)!;
  try {
    let program: string, args: string[];
    if (target === 'typescript') {
      writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
      writeFileSync(join(directory, 'main.ts'), bundle.source + `\nconst ctx=new Context();let refused=false;try{${declared}(ctx,[])}catch(e){refused=String(e).includes('unsynthesized_body')}const value=${main}(ctx,[]);console.log(JSON.stringify({refused,value:String(value)}));\n`);
      const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext',
        '--allowImportingTsExtensions', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      program = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
    } else if (target === 'python') {
      writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
      writeFileSync(join(directory, 'main.py'), bundle.source + `\nctx=Context()\nrefused=False\ntry: ${declared}(ctx,[])\nexcept Exception as e: refused='unsynthesized_body' in str(e)\nvalue=${main}(ctx,[])\nprint(json.dumps({'refused':refused,'value':str(value)}))\n`);
      program = 'python3'; args = [join(directory, 'main.py')];
    } else {
      mkdirSync(join(directory, 'src'));
      writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
      writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
      writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
      writeFileSync(join(directory, 'src/main.rs'), bundle.source + `\nfn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn main(){std::panic::set_hook(Box::new(|_|{}));let mut ctx=Context::new(vec![],sink);let refused=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${declared}(&mut ctx,vec![]))).is_err();let value=${main}(&mut ctx,vec![]);let value=match value{Value::Int(n)=>n.to_string(),_=>panic!("wrong_type")};println!("{}",serde_json::json!({"refused":refused,"value":value}));}\n`);
      program = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
    }
    const output = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'target') }, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout), { refused: true, value: '7' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
