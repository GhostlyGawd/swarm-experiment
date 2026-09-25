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
import { Runtime } from '../../src/tier3/runtime.ts';
import { executableBundle, parseExecutableBundle, projectTypeScriptV17,
  projectPythonV17, projectRustV17, RUST_PROJECTION_CARGO } from '../../src/projection/executable.ts';

function fixture() {
  const symbols = new SymbolSpace('projection-record-task-v18');
  const direct = symbols.define('direct'), entry = symbols.define('entry');
  const wrapper = symbols.define('wrapper'), badWrapper = symbols.define('badWrapper');
  const fn = symbols.define('fn');
  const box: Ty = { t: 'Record', name: 'type:projection:task-box' as never, fields: [['value', b.Int]] };
  const closure: Ty = { t: 'Fn', params: [], returns: b.Int, capabilities: [] };
  const readTask = (value: number): Term => b.field(b.await_(b.spawn(
    b.record(box as Extract<Ty,{t:'Record'}>, { value: b.int(value) }))), 'value');
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: direct, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.eq(b.apply(b.lambda({ returns: b.Int,
        body: readTask(5) })), b.int(5)), 'fresh task record')] }), body: b.ret(b.int(1)) }),
    b.fn({ symbol: entry, params: [b.param(fn, closure)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.eq(b.apply(b.v(fn)), b.int(5)), 'passed task record')] }),
      body: b.ret(b.apply(b.v(fn))) }),
    b.fn({ symbol: wrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int, body: readTask(5) }))) }),
    b.fn({ symbol: badWrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int, body: readTask(6) }))) }),
  ] });
  return { symbols, module, direct, entry, wrapper, badWrapper };
}

test('V18 record-task field reads retain exact AST identity and V17 refuses the new profile', () => {
  const f = fixture(), store = new GraphStore(), root = store.intern(f.module);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(f.module);
  for (const [symbol, expected] of [[f.direct, 1n], [f.wrapper, 5n]] as const) {
    const result = reference.call(symbol, []);
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.value, expected);
  }
  const refused = reference.call(f.badWrapper, []);
  assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.fault.kind, 'precondition');
  const old = { typescript: projectTypeScriptV17, python: projectPythonV17, rust: projectRustV17 };
  for (const target of ['typescript', 'python', 'rust'] as const) {
    assert.throws(() => old[target](f.module, f.symbols), /scalar callback-free body/);
    const bundle = executableBundle(f.module, f.symbols, target);
    assert.match(bundle.source, /@aether-projection\/18/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module), root);
    const changed = bundle.source.replace('ae_int("5")', 'ae_int("7")');
    assert.notEqual(changed, bundle.source);
    assert.throws(() => parseExecutableBundle({ ...bundle, source: changed }), /certificate closure mismatch/);
    const path = store.findPath(root, node => node.kind === 'Lit' && node.value === 5n);
    assert.ok(path);
    const literal = store.get(store.resolvePath(root, path).at(-1)!);
    assert.equal(literal.kind, 'Lit');
    const nextRoot = store.replaceAt(root, path, store.intern({ ...literal, value: 7n }));
    const regenerated = executableBundle(store.hydrate(nextRoot), f.symbols, target);
    assert.equal(store.intern(parseExecutableBundle(regenerated).module), nextRoot);
    const [first, ...tail] = bundle.source.split('\n');
    const alteredSite = first + '\n' + tail.join('\n').replace(/cc18:[0-9a-f]{64}/, `cc18:${'0'.repeat(64)}`);
    assert.notEqual(alteredSite, bundle.source);
    assert.throws(() => parseExecutableBundle({ ...bundle, source: alteredSite }), /certificate|scaffolding/);
    assert.throws(() => parseExecutableBundle({ ...bundle,
      runtime: bundle.runtime.replace(/cc18:[0-9a-f]{64}/, `cc18:${'0'.repeat(64)}`) }), /runtime/);
  }
});

for (const target of ['typescript', 'python', 'rust'] as const)
  test(`V18 actual ${target} awaits fresh record tasks with zero ambient effects`, () => {
    const f = fixture(), bundle = executableBundle(f.module, f.symbols, target);
    const directory = mkdtempSync(join(tmpdir(), 'aether-record-task-v18-'));
    const direct = bundle.aliases.get(f.direct)!, wrapper = bundle.aliases.get(f.wrapper)!;
    const bad = bundle.aliases.get(f.badWrapper)!;
    try {
      let program: string, args: string[];
      if (target === 'typescript') {
        writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
        writeFileSync(join(directory, 'main.ts'), bundle.source + `\nlet effects=0;const ctx=new Context(['cap:test:emit'],()=>{effects++;return null});const direct=${direct}(ctx,[]),passed=${wrapper}(ctx,[]);let denied=false;try{${bad}(ctx,[])}catch(e){denied=String(e).includes('passed task record')}console.log(JSON.stringify({direct:String(direct),passed:String(passed),denied,effects}));\n`);
        const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
          '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext',
          '--allowImportingTsExtensions', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        program = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
      } else if (target === 'python') {
        writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
        writeFileSync(join(directory, 'main.py'), bundle.source + `\neffects=[]\ndef effect(cap,args): effects.append([cap,args])\nctx=Context(['cap:test:emit'],effect)\ndirect=${direct}(ctx,[])\npassed=${wrapper}(ctx,[])\ndenied=False\ntry: ${bad}(ctx,[])\nexcept Exception as e: denied='passed task record' in str(e)\nprint(json.dumps({'direct':str(direct),'passed':str(passed),'denied':denied,'effects':len(effects)}))\n`);
        program = 'python3'; args = [join(directory, 'main.py')];
      } else {
        mkdirSync(join(directory, 'src'));
        writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
        writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
        writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
        writeFileSync(join(directory, 'src/main.rs'), bundle.source + `\nstatic EFFECTS:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);fn sink(_cap:&str,_args:Vec<Value>)->Value{EFFECTS.fetch_add(1,std::sync::atomic::Ordering::SeqCst);Value::Unit}fn as_int(v:Value)->String{match v{Value::Int(n)=>n.to_string(),_=>panic!("wrong_type")}}fn main(){std::panic::set_hook(Box::new(|_|{}));let mut ctx=Context::new(vec!["cap:test:emit".to_string()],sink);let direct=${direct}(&mut ctx,vec![]);let passed=${wrapper}(&mut ctx,vec![]);let denied=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${bad}(&mut ctx,vec![]))).is_err();println!("{}",serde_json::json!({"direct":as_int(direct),"passed":as_int(passed),"denied":denied,"effects":EFFECTS.load(std::sync::atomic::Ordering::SeqCst)}));}\n`);
        program = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
      }
      const output = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'target') }, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(output.status, 0, output.stderr);
      assert.deepEqual(JSON.parse(output.stdout), { direct: '1', passed: '5', denied: true, effects: 0 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
