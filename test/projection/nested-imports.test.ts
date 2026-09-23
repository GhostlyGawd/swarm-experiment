import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import type { SymbolId } from '../../src/tier1/ids.ts';
import { ModuleResolver } from '../../src/tier1/modules.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { executableBundle, parseExecutable, parseExecutableBundle, projectTypeScriptV7, projectTypeScriptV8, RUST_PROJECTION_CARGO, type ExecutableTarget } from '../../src/projection/executable.ts';

function fixture() {
  const symbols = new SymbolSpace('projection-nested-import-v8'), helper = symbols.define('helper'), x = symbols.define('x');
  const library = b.module_({ symbol: symbols.define('library'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: helper, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.add(b.v(x), b.int(1))) }),
  ] });
  const store = new GraphStore(), address = store.intern(library), entry = symbols.define('entry');
  const inner = b.module_({ symbol: symbols.define('inner'), symbolTable: symbols.table(), members: [
    b.import_(address, [helper]), b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.call(helper, b.int(41))) }),
  ] });
  const module = b.module_({ symbol: symbols.define('outer'), symbolTable: symbols.table(), members: [inner] });
  return { module, library, address, entry, symbols, options: { modules: new Map([[address, library]]) } };
}

function executeBundle(target: ExecutableTarget, bundle: ReturnType<typeof executableBundle>, entry: SymbolId, expected: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'aether-transitive-nested-v8-')), name = bundle.aliases.get(entry)!;
  try {
    let source = bundle.source, command: string, args: string[];
    if (target === 'typescript') {
      writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
      for (const [file, text] of bundle.dependencies!) writeFileSync(join(directory, file), text);
      source += `\nconst context=new Context([],()=>null);console.log(String(${name}(context,[])));\n`;
      writeFileSync(join(directory, 'main.ts'), source);
      const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--allowImportingTsExtensions', join(directory, 'main.ts')],
        { encoding: 'utf8', timeout: 60_000 });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      command = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
    } else if (target === 'python') {
      writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
      for (const [file, text] of bundle.dependencies!) writeFileSync(join(directory, file), text);
      source += `\ncontext=Context([],lambda cap,args: None)\nprint(str(${name}(context,[])))\n`;
      writeFileSync(join(directory, 'main.py'), source); command = 'python3'; args = [join(directory, 'main.py')];
    } else {
      mkdirSync(join(directory, 'src')); writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
      writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
      writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
      for (const [file, text] of bundle.dependencies!) writeFileSync(join(directory, 'src', file), text);
      source += `\nfn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn main(){let mut context=Context::new(vec![],sink);println!("{}",ae_num(${name}(&mut context,vec![])));}\n`;
      writeFileSync(join(directory, 'src/main.rs'), source);
      command = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
    }
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), 'aether-projection-target-v8') } });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('V8 nested imports retain exact module/address identity and reject altered or missing dependencies', () => {
  const f = fixture(), store = new GraphStore();
  assert.throws(() => projectTypeScriptV7(f.module, f.symbols, f.options), /nested Import requires a later profile|Import is supported only as a module declaration/);
  assert.throws(() => executableBundle(f.module, f.symbols, 'typescript'), /missing native module dependency/);
  assert.equal(projectTypeScriptV8(f.module, f.symbols, f.options), executableBundle(f.module, f.symbols, 'typescript', f.options).source);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(f.module, f.symbols, target, f.options), parsed = parseExecutableBundle(bundle);
    assert.match(bundle.source, /@aether-projection\/8/);
    assert.equal(store.intern(parsed.module), store.intern(f.module));
    assert.equal(store.intern(parsed.modules.get(f.address)!), f.address);
    assert.equal(parsed.modules.size, 1);
    const dependencies = new Map(bundle.dependencies);
    dependencies.clear();
    assert.throws(() => parseExecutableBundle({ ...bundle, dependencies }), /missing native module dependency/);
    const [filename, text] = [...bundle.dependencies!][0], changed = new Map(bundle.dependencies);
    const changedText = text.replace('ae_int("1")', 'ae_int("2")');
    assert.notEqual(changedText, text, 'native dependency edit must be visible');
    changed.set(filename, changedText);
    assert.throws(() => parseExecutableBundle({ ...bundle, dependencies: changed }), /content address mismatch/);
    const editedLibrary = parseExecutable(changedText, target, f.options), editedAddress = store.intern(editedLibrary);
    if (f.module.kind !== 'Module' || f.module.members[0]?.kind !== 'Module') throw new Error('fixture module');
    const inner = f.module.members[0];
    const editedInner = { ...inner, members: inner.members.map(member => member.kind === 'Import' ? { ...member, module: editedAddress } : member) };
    const editedModule = { ...f.module, members: [editedInner] };
    const rebound = executableBundle(editedModule, f.symbols, target, { modules: new Map([[editedAddress, editedLibrary]]) });
    assert.equal(store.intern(parseExecutableBundle(rebound).module), store.intern(editedModule));
    assert.notEqual(editedAddress, f.address);
  }
  if (f.module.kind !== 'Module' || f.module.members[0]?.kind !== 'Module') throw new Error('fixture module');
  const inner = f.module.members[0];
  const imported = inner.members[0]; if (imported?.kind !== 'Import') throw new Error('fixture import');
  const duplicate = { ...f.module, members: [{ ...inner, members: [...inner.members, b.import_(f.address, [imported.symbols[0]])] }] };
  assert.throws(() => executableBundle(duplicate, f.symbols, 'typescript', f.options), /duplicate imported symbol/);
});

test('V8 closes a transitive nested import inside an addressed dependency', () => {
  const symbols = new SymbolSpace('transitive-nested-import-v8'), store = new GraphStore();
  const helper = symbols.define('leafHelper'), value = symbols.define('leafValue');
  const leaf = b.module_({ symbol: symbols.define('leaf'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: helper, params: [b.param(value, b.Int)], returns: b.Int, body: b.ret(b.add(b.v(value), b.int(1))) }),
  ] });
  const leafRef = store.intern(leaf), middle = symbols.define('middle'), middleEntry = symbols.define('middleEntry');
  const nested = b.module_({ symbol: middle, symbolTable: symbols.table(), members: [
    b.import_(leafRef, [helper]), b.fn({ symbol: middleEntry, returns: b.Int, body: b.ret(b.call(helper, b.int(41))) }),
  ] });
  const mid = b.module_({ symbol: symbols.define('mid'), symbolTable: symbols.table(), members: [nested] });
  const midRef = store.intern(mid), entry = symbols.define('rootEntry');
  const root = b.module_({ symbol: symbols.define('root'), symbolTable: symbols.table(), members: [
    b.import_(midRef, [middle]), b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.call(middleEntry)) }),
  ] });
  const linked = new ModuleResolver(store).resolve(store.intern(root));
  assert.deepEqual(linked.dependencies, [leafRef, midRef]);
  const result = new Runtime({ registry: new CapabilityRegistry() }).load(linked.module).call(entry, []);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value, 42n);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(root, symbols, target, { modules: new Map([[leafRef, leaf], [midRef, mid]]) });
    assert.match(bundle.source, /@aether-projection\/8/);
    assert.equal(bundle.dependencies?.size, 2);
    const parsed = parseExecutableBundle(bundle);
    assert.equal(new GraphStore().intern(parsed.module), new GraphStore().intern(root));
    executeBundle(target, bundle, entry, '42');
  }
});

for (const target of ['typescript', 'python', 'rust'] as ExecutableTarget[])
  test(`actual ${target} nested exact-address import executes the same result`, () => {
    const f = fixture(), bundle = executableBundle(f.module, f.symbols, target, f.options);
    const directory = mkdtempSync(join(tmpdir(), 'aether-nested-import-v8-'));
    const name = bundle.aliases.get(f.entry)!;
    try {
      let command: string, args: string[], source = bundle.source;
      if (target === 'typescript') {
        writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
        for (const [file, text] of bundle.dependencies!) writeFileSync(join(directory, file), text);
        source += `\nconst context=new Context([],()=>null);console.log(String(${name}(context,[])));\n`;
        writeFileSync(join(directory, 'main.ts'), source);
        const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
          '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--allowImportingTsExtensions', join(directory, 'main.ts')],
          { encoding: 'utf8', timeout: 60_000 });
        assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        command = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
      } else if (target === 'python') {
        writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
        for (const [file, text] of bundle.dependencies!) writeFileSync(join(directory, file), text);
        source += `\ncontext=Context([],lambda cap,args: None)\nprint(str(${name}(context,[])))\n`;
        writeFileSync(join(directory, 'main.py'), source);
        command = 'python3'; args = [join(directory, 'main.py')];
      } else {
        mkdirSync(join(directory, 'src'));
        writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
        writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
        writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
        for (const [file, text] of bundle.dependencies!) writeFileSync(join(directory, 'src', file), text);
        source += `\nfn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn main(){let mut context=Context::new(vec![],sink);println!("{}",ae_num(${name}(&mut context,vec![])));}\n`;
        writeFileSync(join(directory, 'src/main.rs'), source);
        command = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
      }
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), 'aether-projection-target-v8') } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '42');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

test('edited nested TypeScript dependency rebinds its address and runs the changed program', () => {
  const f = fixture(), original = executableBundle(f.module, f.symbols, 'typescript', f.options);
  const sourceText = [...original.dependencies!.values()][0].replace('ae_int("1")', 'ae_int("2")');
  const library = parseExecutable(sourceText, 'typescript', f.options), address = new GraphStore().intern(library);
  if (f.module.kind !== 'Module' || f.module.members[0]?.kind !== 'Module') throw new Error('fixture module');
  const inner = f.module.members[0];
  const changed = { ...f.module, members: [{ ...inner, members: inner.members.map(member => member.kind === 'Import'
    ? { ...member, module: address } : member) }] };
  const bundle = executableBundle(changed, f.symbols, 'typescript', { modules: new Map([[address, library]]) });
  assert.equal(new GraphStore().intern(parseExecutableBundle(bundle).module), new GraphStore().intern(changed));
  const directory = mkdtempSync(join(tmpdir(), 'aether-nested-import-edit-'));
  try {
    writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
    for (const [file, text] of bundle.dependencies!) writeFileSync(join(directory, file), text);
    const name = bundle.aliases.get(f.entry)!;
    writeFileSync(join(directory, 'main.ts'), bundle.source + `\nconst context=new Context([],()=>null);console.log(String(${name}(context,[])));\n`);
    const run = spawnSync(process.execPath, ['--experimental-strip-types', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.trim(), '43');
    assert.throws(() => parseExecutableBundle({ ...bundle, source: bundle.source.replace('import {', 'const fake =') }), /scaffolding|unsupported|native|syntax/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
