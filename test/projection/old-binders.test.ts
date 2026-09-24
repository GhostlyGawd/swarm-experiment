import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { executableBundle, parseExecutableBundle, projectTypeScriptV9,
  RUST_PROJECTION_CARGO } from '../../src/projection/executable.ts';

function fixture() {
  const symbols = new SymbolSpace('projection-old-binders-v10');
  const range = symbols.define('range'), choose = symbols.define('choose'), make = symbols.define('make');
  const x = symbols.define('x'), i = symbols.define('i'), j = symbols.define('j'), row = symbols.define('row');
  const yes = symbols.define('yes'), no = symbols.define('no');
  const sum = { t: 'Result' as const, ok: b.Int, err: b.Int };
  const rangeContract = b.contract({ ensures: [b.clause(b.old(b.forall(i, b.int(0), b.int(2),
    b.forall(j, b.int(0), b.int(2), b.and(b.lt(b.v(i), b.v(x)), b.lt(b.v(j), b.v(x)))))), 'old-range')] });
  const choiceContract = b.contract({ ensures: [b.clause(b.old(b.matchResult(b.v(row), yes,
    b.eq(b.v(yes), b.int(7)), no, b.bool(false))), 'old-result')] });
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: range, params: [b.param(x, b.Int)], returns: b.Int, contract: rangeContract,
      body: b.block(b.assign(b.place(x), b.int(1)), b.ret(b.v(x))) }),
    b.fn({ symbol: choose, params: [b.param(row, sum)], returns: b.Int, contract: choiceContract,
      body: b.block(b.assign(b.place(row), b.err(sum, b.int(4))), b.ret(b.int(7))) }),
    b.fn({ symbol: make, returns: sum, body: b.ret(b.ok(sum, b.int(7))) }),
  ] });
  return { symbols, module, range, choose, make };
}

test('V10 keeps quantifier and Result binders local inside old snapshots', () => {
  const f = fixture(), root = new GraphStore().intern(f.module);
  assert.throws(() => projectTypeScriptV9(f.module, f.symbols), /nested binders/);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(f.module);
  const range = reference.call(f.range, [3n]);
  assert.equal(range.ok, true); if (range.ok) assert.equal(range.value, 1n);
  const made = reference.call(f.make, []);
  assert.equal(made.ok, true); if (!made.ok) return;
  const choice = reference.call(f.choose, [made.value]);
  assert.equal(choice.ok, true); if (choice.ok) assert.equal(choice.value, 7n);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(f.module, f.symbols, target);
    assert.match(bundle.source, /@aether-projection\/10/);
    assert.match(bundle.source, /ae_old\(ae_forall/);
    assert.match(bundle.source, /ae_old\(ae_match/);
    assert.equal(new GraphStore().intern(parseExecutableBundle(bundle).module), root);
    assert.throws(() => parseExecutableBundle({ ...bundle,
      source: bundle.source.replace('ae_old(ae_forall', 'ae_old(ae_bool') }), /scaffolding|expression|arity/);
  }
});

for (const target of ['typescript', 'python', 'rust'] as const)test(`V10 actual ${target} old-binder execution sees pre-state`, () => {
  const f = fixture(), bundle = executableBundle(f.module, f.symbols, target);
  const directory = mkdtempSync(join(tmpdir(), 'aether-old-binders-v10-'));
  const range = bundle.aliases.get(f.range)!, choose = bundle.aliases.get(f.choose)!, make = bundle.aliases.get(f.make)!;
  try {
    let program: string, args: string[];
    if (target === 'typescript') {
      writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
      writeFileSync(join(directory, 'main.ts'), bundle.source + `\nconst ctx=new Context();const a=${range}(ctx,[3n]);const row=${make}(ctx,[]);const c=${choose}(ctx,[row]);console.log(JSON.stringify({range:String(a),choice:String(c)}));\n`);
      const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext',
        '--allowImportingTsExtensions', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      program = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
    } else if (target === 'python') {
      writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
      writeFileSync(join(directory, 'main.py'), bundle.source + `\nctx=Context()\na=${range}(ctx,[3])\nrow=${make}(ctx,[])\nc=${choose}(ctx,[row])\nprint(json.dumps({'range':str(a),'choice':str(c)}))\n`);
      program = 'python3'; args = [join(directory, 'main.py')];
    } else {
      mkdirSync(join(directory, 'src'));
      writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
      writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
      writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
      writeFileSync(join(directory, 'src/main.rs'), bundle.source + `\nfn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn value(v:Value)->String{match v{Value::Int(n)=>n.to_string(),_=>panic!("wrong_type")}}fn main(){let mut ctx=Context::new(vec![],sink);let a=${range}(&mut ctx,vec![ae_int("3")]);let row=${make}(&mut ctx,vec![]);let c=${choose}(&mut ctx,vec![row]);println!("{}",serde_json::json!({"range":value(a),"choice":value(c)}));}\n`);
      program = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
    }
    const output = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'target') }, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout), { range: '1', choice: '7' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
