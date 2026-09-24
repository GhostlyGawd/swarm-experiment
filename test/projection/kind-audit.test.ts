import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LINK_SCHEMA, walk } from '../../src/tier1/ast.ts';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { executableBundle, parseExecutableBundle, RUST_PROJECTION_CARGO,
  type ExecutableProjectionOptions } from '../../src/projection/executable.ts';
import { projectionCorpus } from '../../roadmap/v4/research/projections/corpus.ts';
import { compositeProjectionCorpus } from '../../roadmap/v4/research/projections/corpus-composites.ts';
import { continuationProjectionCorpus } from '../../roadmap/v4/research/projections/corpus-continuations.ts';
import { atomicProjectionCorpus } from '../../roadmap/v4/research/projections/corpus-atomic.ts';
import { stringImportProjectionCorpus } from '../../roadmap/v4/research/projections/corpus-strings-imports.ts';
import { genericNestedCorpus } from '../../roadmap/v4/research/projections/corpus-generics-nested.ts';
import { genericContinuationCorpus } from '../../roadmap/v4/research/projections/corpus-generic-continuations.ts';
import { nestedImportCorpus } from '../../roadmap/v4/research/projections/corpus-nested-imports.ts';
import { completionProjectionCorpus, completionProjectionFixture } from '../../roadmap/v4/research/projections/corpus-completion.ts';

function corpus() {
  return [...projectionCorpus(), ...compositeProjectionCorpus(), ...continuationProjectionCorpus(),
    ...atomicProjectionCorpus(), ...stringImportProjectionCorpus(), ...genericNestedCorpus(),
    ...genericContinuationCorpus(), ...nestedImportCorpus(), ...completionProjectionCorpus()];
}

test('every declared AST kind has a representative exact-root TS/Python/Rust round trip', () => {
  const rows = corpus(), seen = new Set<string>(), store = new GraphStore();
  for (const row of rows) {
    const modules: ExecutableProjectionOptions['modules'] = 'modules' in row
      ? row.modules as ExecutableProjectionOptions['modules'] : undefined;
    for (const node of walk(row.module)) seen.add(node.kind);
    for (const dependency of modules?.values() ?? [])
      for (const node of walk(dependency)) seen.add(node.kind);
    for (const target of ['typescript', 'python', 'rust'] as const) {
      const bundle = executableBundle(row.module, row.symbols, target, { modules });
      const parsed = parseExecutableBundle(bundle);
      assert.equal(store.intern(parsed.module), store.intern(row.module), `${row.id}:${target}`);
    }
  }
  assert.deepEqual(Object.keys(LINK_SCHEMA).filter(kind => !seen.has(kind)), []);
});

test('new Cond/ForAll/Surface/Un/Yield fixture matches the reference runtime', () => {
  const f = completionProjectionFixture();
  const rt = new Runtime({ registry: new CapabilityRegistry() }).load(f.module);
  for (const [arg, expected] of [[2n, 7n], [-2n, 2n]] as const) {
    const result = rt.call(f.entry, [arg]);
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.value, expected);
  }
});

test('free type variables without a binding are explicitly rejected in all targets', () => {
  const symbols = new SymbolSpace('projection-unbound-type-audit');
  const identity = symbols.define('identity'), value = symbols.define('value');
  const open = { t: 'TypeVar' as const, name: 'T' };
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: identity, params: [b.param(value, open)], returns: open, body: b.ret(b.v(value)) }),
  ] });
  for (const target of ['typescript', 'python', 'rust'] as const)
    assert.throws(() => executableBundle(module, symbols, target), /type variable|generic|inferable/);
});

for (const target of ['typescript', 'python', 'rust'] as const)test(`actual ${target} completes five missing AST kinds`, () => {
  const f = completionProjectionFixture(), bundle = executableBundle(f.module, f.symbols, target);
  const directory = mkdtempSync(join(tmpdir(), 'aether-kind-audit-'));
  const entry = bundle.aliases.get(f.entry)!;
  try {
    let program: string, args: string[];
    if (target === 'typescript') {
      writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
      writeFileSync(join(directory, 'main.ts'), bundle.source + `\nconst ctx=new Context();console.log(JSON.stringify([String(${entry}(ctx,[2n])),String(${entry}(ctx,[-2n]))]));\n`);
      const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext',
        '--allowImportingTsExtensions', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      program = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
    } else if (target === 'python') {
      writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
      writeFileSync(join(directory, 'main.py'), bundle.source + `\nctx=Context()\nprint(json.dumps([str(${entry}(ctx,[2])),str(${entry}(ctx,[-2]))]))\n`);
      program = 'python3'; args = [join(directory, 'main.py')];
    } else {
      mkdirSync(join(directory, 'src'));
      writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
      writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
      writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
      writeFileSync(join(directory, 'src/main.rs'), bundle.source + `\nfn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn value(v:Value)->String{match v{Value::Int(n)=>n.to_string(),_=>panic!("wrong_type")}}fn main(){let mut ctx=Context::new(vec![],sink);let a=${entry}(&mut ctx,vec![ae_int("2")]);let b=${entry}(&mut ctx,vec![ae_int("-2")]);println!("{}",serde_json::json!([value(a),value(b)]));}\n`);
      program = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
    }
    const output = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'target') }, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout), ['7', '2']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
