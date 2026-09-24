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
import { executableBundle, parseExecutableBundle, projectTypeScriptV14, projectPythonV14,
  projectRustV14, RUST_PROJECTION_CARGO } from '../../src/projection/executable.ts';

function fixture() {
  const symbols = new SymbolSpace('projection-contract-closure-values-v15');
  const factory = symbols.define('factory'), entry = symbols.define('entry');
  const direct = symbols.define('direct'), wrapper = symbols.define('wrapper');
  const factoryWrapper = symbols.define('factoryWrapper'), unsafeWrapper = symbols.define('unsafeWrapper');
  const localWrapper = symbols.define('localWrapper');
  const helper = symbols.define('helper'), callWrapper = symbols.define('callWrapper');
  const sum = symbols.define('sum'), foldWrapper = symbols.define('foldWrapper');
  const increment = symbols.define('increment'), mapWrapper = symbols.define('mapWrapper');
  const freshRecordWrapper = symbols.define('freshRecordWrapper');
  const branchFactory = symbols.define('branchFactory'), branchDirect = symbols.define('branchDirect');
  const branchLocalFactory = symbols.define('branchLocalFactory'), branchLocalDirect = symbols.define('branchLocalDirect');
  const quantified = symbols.define('quantified'), iterator = symbols.define('iterator');
  const matched = symbols.define('matched'), matchOk = symbols.define('matchOk'), matchErr = symbols.define('matchErr');
  const nested = symbols.define('nested');
  const input = symbols.define('input'), local = symbols.define('local'), fn = symbols.define('fn');
  const closureLocal = symbols.define('closureLocal');
  const flag = symbols.define('flag');
  const localA = symbols.define('localA'), localB = symbols.define('localB');
  const accumulator = symbols.define('accumulator'), item = symbols.define('item');
  const mappedItem = symbols.define('mappedItem');
  const box = symbols.define('box');
  const closure: Ty = { t: 'Fn', params: [], returns: b.Int, capabilities: [] };
  const matchType: Ty = { t: 'Result', ok: b.Int, err: b.Int };
  const boxType: Ty = { t: 'Record', name: 'type:projection:v15-box' as never, fields: [['value', b.Int]] };
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: factory, params: [b.param(input, b.Int)], returns: closure,
      body: b.block(b.let_(local, b.Int, b.v(input)),
        b.ret(b.lambda({ returns: b.Int, body: b.add(b.v(local), b.int(1)) }))) }),
    b.fn({ symbol: branchFactory, params: [b.param(flag, b.Bool)], returns: closure,
      body: b.if_(b.v(flag),
        b.ret(b.lambda({ returns: b.Int, body: b.int(11) })),
        b.ret(b.lambda({ returns: b.Int, body: b.int(12) }))) }),
    b.fn({ symbol: branchLocalFactory, params: [b.param(flag, b.Bool)], returns: closure,
      body: b.if_(b.v(flag),
        b.block(b.let_(localA, b.Int, b.int(7)), b.ret(b.lambda({ returns: b.Int, body: b.v(localA) }))),
        b.block(b.let_(localB, b.Int, b.int(8)), b.ret(b.lambda({ returns: b.Int, body: b.v(localB) })))) }),
    b.fn({ symbol: entry, params: [b.param(fn, closure)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.v(fn)), b.int(0)), 'checked function value')],
        ensures: [b.clause(b.eq(b.result(), b.apply(b.v(fn))), 'checked result')] }),
      body: b.ret(b.apply(b.v(fn))) }),
    b.fn({ symbol: direct, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.eq(b.apply(b.call(factory, b.int(3))), b.int(4)), 'block factory')] }),
      body: b.ret(b.int(4)) }),
    b.fn({ symbol: branchDirect, returns: b.Int,
      contract: b.contract({ requires: [
        b.clause(b.eq(b.apply(b.call(branchFactory, b.bool(true))), b.int(11)), 'true branch'),
        b.clause(b.eq(b.apply(b.call(branchFactory, b.bool(false))), b.int(12)), 'false branch'),
      ] }), body: b.ret(b.int(1)) }),
    b.fn({ symbol: branchLocalDirect, returns: b.Int,
      contract: b.contract({ requires: [
        b.clause(b.eq(b.apply(b.call(branchLocalFactory, b.bool(true))), b.int(7)), 'true local branch'),
        b.clause(b.eq(b.apply(b.call(branchLocalFactory, b.bool(false))), b.int(8)), 'false local branch'),
      ] }), body: b.ret(b.int(1)) }),
    b.fn({ symbol: quantified, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.apply(b.lambda({ returns: b.Bool,
        body: b.forall(iterator, b.int(0), b.int(3), b.ge(b.v(iterator), b.int(0))) })), 'quantifier closure')] }),
      body: b.ret(b.int(1)) }),
    b.fn({ symbol: matched, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.lambda({ returns: b.Int,
        body: b.matchResult(b.ok(matchType as Extract<Ty,{t:'Result'}>, b.int(3)),
          matchOk, b.v(matchOk), matchErr, b.int(0)) })), b.int(0)), 'result binder closure')] }),
      body: b.ret(b.int(1)) }),
    b.fn({ symbol: nested, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.lambda({ returns: b.Int,
        body: b.apply(b.lambda({ returns: b.Int, body: b.int(5) })) })), b.int(0)), 'nested closure')] }),
      body: b.ret(b.int(1)) }),
    b.fn({ symbol: wrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int, body: b.int(7) }))) }),
    b.fn({ symbol: factoryWrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.call(factory, b.int(3)))) }),
    b.fn({ symbol: localWrapper, returns: b.Int,
      body: b.block(b.let_(closureLocal, closure, b.lambda({ returns: b.Int, body: b.int(6) })),
        b.ret(b.call(entry, b.v(closureLocal)))) }),
    b.fn({ symbol: helper, returns: b.Int, body: b.ret(b.int(8)) }),
    b.fn({ symbol: callWrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int, body: b.call(helper) }))) }),
    b.fn({ symbol: sum, params: [b.param(accumulator, b.Int), b.param(item, b.Int)], returns: b.Int,
      body: b.ret(b.add(b.v(accumulator), b.v(item))) }),
    b.fn({ symbol: foldWrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int,
        body: b.fold(b.seq(b.Int, b.int(1), b.int(2)), b.int(0), sum) }))) }),
    b.fn({ symbol: increment, params: [b.param(mappedItem, b.Int)], returns: b.Int,
      body: b.ret(b.add(b.v(mappedItem), b.int(1))) }),
    b.fn({ symbol: mapWrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int,
        body: b.length(b.map(b.seq(b.Int, b.int(1), b.int(2)), increment)) }))) }),
    b.fn({ symbol: freshRecordWrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int,
        body: b.field(b.record(boxType as Extract<Ty,{t:'Record'}>, { value: b.int(5) }), 'value') }))) }),
    b.fn({ symbol: unsafeWrapper, returns: b.Int,
      body: b.block(b.let_(box, boxType, b.record(boxType as Extract<Ty,{t:'Record'}>, { value: b.int(9) })),
        b.ret(b.call(entry, b.lambda({ returns: b.Int, body: b.field(b.v(box), 'value') })))) }),
  ] });
  return { symbols, module, factory, entry, direct, branchDirect, branchLocalDirect, quantified, matched, nested, wrapper, factoryWrapper, localWrapper, helper, callWrapper, sum, foldWrapper, increment, mapWrapper, freshRecordWrapper, unsafeWrapper };
}

test('V16 checked function values and dataflow factories parse to exact roots', () => {
  const f = fixture(), store = new GraphStore(), root = store.intern(f.module);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(f.module);
  for (const [symbol, expected] of [[f.direct, 4n], [f.branchDirect, 1n], [f.branchLocalDirect, 1n], [f.quantified, 1n], [f.matched, 1n], [f.nested, 1n], [f.wrapper, 7n], [f.factoryWrapper, 4n], [f.localWrapper, 6n], [f.callWrapper, 8n], [f.foldWrapper, 3n], [f.mapWrapper, 2n], [f.freshRecordWrapper, 5n], [f.unsafeWrapper, 9n]] as const) {
    const result = reference.call(symbol, []);
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.value, expected);
  }
  const old = { typescript: projectTypeScriptV14, python: projectPythonV14, rust: projectRustV14 };
  for (const target of ['typescript', 'python', 'rust'] as const) {
    assert.throws(() => old[target](f.module, f.symbols), /exact direct factory/);
    const bundle = executableBundle(f.module, f.symbols, target);
    assert.match(bundle.source, /@aether-projection\/16/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module), root);
    const edited = bundle.source.replace('ae_int("7")', 'ae_int("8")');
    assert.notEqual(edited, bundle.source);
    assert.throws(() => parseExecutableBundle({ ...bundle, source: edited }), /certificate closure mismatch/);
    const path = store.findPath(root, node => node.kind === 'Lit' && node.value === 7n);
    assert.ok(path);
    const literal = store.get(store.resolvePath(root, path).at(-1)!);
    assert.equal(literal.kind, 'Lit');
    const nextRoot = store.replaceAt(root, path, store.intern({ ...literal, value: 8n }));
    const regenerated = executableBundle(store.hydrate(nextRoot), f.symbols, target);
    assert.equal(store.intern(parseExecutableBundle(regenerated).module), nextRoot);
    const ownerChanged = { ...(f.module as Extract<Term,{kind:'Module'}>), members:
      (f.module as Extract<Term,{kind:'Module'}>).members.map(member => member.kind === 'FunctionDecl' && member.symbol === f.wrapper
        ? { ...member, body: b.block(b.exprStmt(b.int(0)), member.body!) } : member) };
    const rebound = executableBundle(ownerChanged, f.symbols, target);
    const headerOf = (source: string) => JSON.parse(source.split('\n')[0].slice(source.indexOf('{')));
    assert.notDeepEqual(headerOf(rebound.source).closureCertificates, headerOf(bundle.source).closureCertificates);
    assert.equal(store.intern(parseExecutableBundle(rebound).module), store.intern(ownerChanged));
    const changedCertificate = bundle.source.replace(/cc16:[0-9a-f]{64}/, `cc16:${'0'.repeat(64)}`);
    assert.notEqual(changedCertificate, bundle.source);
    assert.throws(() => parseExecutableBundle({ ...bundle, source: changedCertificate }), /certificate|scaffolding/);
    const [first, ...tail] = bundle.source.split('\n');
    const alteredSite = first + '\n' + tail.join('\n').replace(/cc16:[0-9a-f]{64}/, `cc16:${'0'.repeat(64)}`);
    assert.notEqual(alteredSite, bundle.source);
    assert.throws(() => parseExecutableBundle({ ...bundle, source: alteredSite }), /scaffolding|certificate/);
    assert.throws(() => parseExecutableBundle({ ...bundle, runtime: bundle.runtime.replace(/cc16:[0-9a-f]{64}/, 'cc16:'+'0'.repeat(64)) }), /runtime/);
  }
});

test('V15 certificates close over an exact-address imported scalar factory', () => {
  const symbols = new SymbolSpace('projection-v15-imported-factory');
  const factory = symbols.define('factory'), entry = symbols.define('entry');
  const input = symbols.define('input'), local = symbols.define('local');
  const closure: Ty = { t: 'Fn', params: [], returns: b.Int, capabilities: [] };
  const library = b.module_({ symbol: symbols.define('library'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: factory, params: [b.param(input, b.Int)], returns: closure,
      body: b.block(b.let_(local, b.Int, b.v(input)), b.ret(b.lambda({ returns: b.Int, body: b.add(b.v(local), b.int(1)) }))) }),
  ] });
  const store = new GraphStore(), libraryRoot = store.intern(library);
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.import_(libraryRoot, [factory]),
    b.fn({ symbol: entry, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.eq(b.apply(b.call(factory, b.int(3))), b.int(4)), 'imported factory')] }),
      body: b.ret(b.int(4)) }),
  ] });
  const root = store.intern(module);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target, { modules: new Map([[libraryRoot, library]]) });
    assert.match(bundle.source, /@aether-projection\/15/);
    assert.equal(bundle.dependencies?.size, 1);
    const parsed = parseExecutableBundle(bundle);
    assert.equal(store.intern(parsed.module), root);
    assert.equal(store.intern(parsed.modules.get(libraryRoot)!), libraryRoot);
    const first = bundle.source.split('\n')[0];
    const header = JSON.parse(first.slice(first.indexOf('{')));
    assert.equal(header.closureCertificates.length, 1);
    assert.match(bundle.runtime, new RegExp(header.closureCertificates[0]));
  }
});

for (const target of ['typescript', 'python', 'rust'] as const)
  test(`V16 actual ${target} contract admits checked values and refuses raw/record captures`, () => {
    const f = fixture(), bundle = executableBundle(f.module, f.symbols, target);
    const directory = mkdtempSync(join(tmpdir(), 'aether-contract-values-v15-'));
    const name = (key: keyof typeof f) => bundle.aliases.get(f[key] as never)!;
    try {
      let program: string, args: string[];
      if (target === 'typescript') {
        writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
        writeFileSync(join(directory, 'main.ts'), bundle.source + `\nlet rawCalls=0;const ctx=new Context();const direct=${name('direct')}(ctx,[]),branch=${name('branchDirect')}(ctx,[]),branchLocal=${name('branchLocalDirect')}(ctx,[]),quantified=${name('quantified')}(ctx,[]),matched=${name('matched')}(ctx,[]),nested=${name('nested')}(ctx,[]),wrapped=${name('wrapper')}(ctx,[]),factory=${name('factoryWrapper')}(ctx,[]),local=${name('localWrapper')}(ctx,[]);let recordDenied=false;try{${name('unsafeWrapper')}(ctx,[])}catch(e){recordDenied=String(e).includes('unverified_contract_closure')}const helper=${name('callWrapper')}(ctx,[]),fold=${name('foldWrapper')}(ctx,[]),mapped=${name('mapWrapper')}(ctx,[]),fresh=${name('freshRecordWrapper')}(ctx,[]);const meta=JSON.stringify({kind:'Lambda',params:[],returns:{t:'Int'},capabilities:[]});const raw=ae_lambda(ctx,meta,[],[],()=>{rawCalls++;return 9n});let rawDenied=false;try{${name('entry')}(ctx,[raw])}catch(e){rawDenied=String(e).includes('unverified_contract_closure')}console.log(JSON.stringify({direct:String(direct),branch:String(branch),branchLocal:String(branchLocal),quantified:String(quantified),matched:String(matched),nested:String(nested),wrapped:String(wrapped),factory:String(factory),local:String(local),recordDenied,helper:String(helper),fold:String(fold),mapped:String(mapped),fresh:String(fresh),rawDenied,rawCalls}));\n`);
        const checked = spawnSync(process.execPath, [new URL('../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
          '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext',
          '--allowImportingTsExtensions', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        program = process.execPath; args = ['--experimental-strip-types', join(directory, 'main.ts')];
      } else if (target === 'python') {
        writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
        writeFileSync(join(directory, 'main.py'), bundle.source + `\nctx=Context()\ndirect=${name('direct')}(ctx,[])\nbranch=${name('branchDirect')}(ctx,[])\nbranchLocal=${name('branchLocalDirect')}(ctx,[])\nquantified=${name('quantified')}(ctx,[])\nmatched=${name('matched')}(ctx,[])\nnested=${name('nested')}(ctx,[])\nwrapped=${name('wrapper')}(ctx,[])\nfactory=${name('factoryWrapper')}(ctx,[])\nlocal=${name('localWrapper')}(ctx,[])\nrecordDenied=False\ntry: ${name('unsafeWrapper')}(ctx,[])\nexcept Exception as e: recordDenied='unverified_contract_closure' in str(e)\nhelper=${name('callWrapper')}(ctx,[])\nfold=${name('foldWrapper')}(ctx,[])\nmapped=${name('mapWrapper')}(ctx,[])\nfresh=${name('freshRecordWrapper')}(ctx,[])\nrawCalls=[0]\ndef raw_body(ctx,captures,args):\n    rawCalls[0]+=1\n    return 9\nraw=ae_lambda(ctx,json.dumps({'kind':'Lambda','params':[],'returns':{'t':'Int'},'capabilities':[]}),[],[],raw_body)\nrawDenied=False\ntry: ${name('entry')}(ctx,[raw])\nexcept Exception as e: rawDenied='unverified_contract_closure' in str(e)\nprint(json.dumps({'direct':str(direct),'branch':str(branch),'branchLocal':str(branchLocal),'quantified':str(quantified),'matched':str(matched),'nested':str(nested),'wrapped':str(wrapped),'factory':str(factory),'local':str(local),'recordDenied':recordDenied,'helper':str(helper),'fold':str(fold),'mapped':str(mapped),'fresh':str(fresh),'rawDenied':rawDenied,'rawCalls':rawCalls[0]}))\n`);
        program = 'python3'; args = [join(directory, 'main.py')];
      } else {
        mkdirSync(join(directory, 'src'));
        writeFileSync(join(directory, 'Cargo.toml'), RUST_PROJECTION_CARGO);
        writeFileSync(join(directory, 'Cargo.lock'), readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock', import.meta.url)));
        writeFileSync(join(directory, 'src/aether_runtime.rs'), bundle.runtime);
        writeFileSync(join(directory, 'src/main.rs'), bundle.source + `\nstatic RAW_CALLS:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);fn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn as_int(v:Value)->String{match v{Value::Int(n)=>n.to_string(),_=>panic!("wrong_type")}}fn main(){std::panic::set_hook(Box::new(|_|{}));let mut ctx=Context::new(vec![],sink);let direct=${name('direct')}(&mut ctx,vec![]);let branch=${name('branchDirect')}(&mut ctx,vec![]);let branch_local=${name('branchLocalDirect')}(&mut ctx,vec![]);let quantified=${name('quantified')}(&mut ctx,vec![]);let matched=${name('matched')}(&mut ctx,vec![]);let nested=${name('nested')}(&mut ctx,vec![]);let wrapped=${name('wrapper')}(&mut ctx,vec![]);let factory=${name('factoryWrapper')}(&mut ctx,vec![]);let local=${name('localWrapper')}(&mut ctx,vec![]);let record_denied=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${name('unsafeWrapper')}(&mut ctx,vec![]))).is_err();let helper=${name('callWrapper')}(&mut ctx,vec![]);let fold=${name('foldWrapper')}(&mut ctx,vec![]);let mapped=${name('mapWrapper')}(&mut ctx,vec![]);let fresh=${name('freshRecordWrapper')}(&mut ctx,vec![]);let raw=ae_lambda(&mut ctx,r#"{"kind":"Lambda","params":[],"returns":{"t":"Int"},"capabilities":[]}"#,&[],vec![],|_,_,_|{RAW_CALLS.fetch_add(1,std::sync::atomic::Ordering::SeqCst);ae_int("9")});let raw_denied=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${name('entry')}(&mut ctx,vec![raw]))).is_err();println!("{}",serde_json::json!({"direct":as_int(direct),"branch":as_int(branch),"branchLocal":as_int(branch_local),"quantified":as_int(quantified),"matched":as_int(matched),"nested":as_int(nested),"wrapped":as_int(wrapped),"factory":as_int(factory),"local":as_int(local),"recordDenied":record_denied,"helper":as_int(helper),"fold":as_int(fold),"mapped":as_int(mapped),"fresh":as_int(fresh),"rawDenied":raw_denied,"rawCalls":RAW_CALLS.load(std::sync::atomic::Ordering::SeqCst)}));}\n`);
        program = 'cargo'; args = ['run', '--quiet', '--locked', '--offline', '--manifest-path', join(directory, 'Cargo.toml')];
      }
      const output = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'target') }, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(output.status, 0, output.stderr);
      assert.deepEqual(JSON.parse(output.stdout), { direct: '4', branch: '1', branchLocal: '1', quantified: '1', matched: '1', nested: '1', wrapped: '7', factory: '4', local: '6', recordDenied: true, helper: '8', fold: '3', mapped: '2', fresh: '5', rawDenied: true, rawCalls: 0 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

for (const target of ['typescript', 'python'] as const)
  test(`V16 actual ${target} refuses a certified closure after host capture mutation`, () => {
    const f = fixture(), bundle = executableBundle(f.module, f.symbols, target);
    const directory = mkdtempSync(join(tmpdir(), 'aether-contract-tamper-v15-'));
    const factory = bundle.aliases.get(f.factory)!;
    const entry = bundle.aliases.get(f.entry)!;
    try {
      if (target === 'typescript') {
        writeFileSync(join(directory, 'aether_runtime.ts'), bundle.runtime);
        writeFileSync(join(directory, 'main.ts'), bundle.source + `\nconst ctx=new Context();const value=${factory}(ctx,[3n]) as any;value.captures[0]=9n;let denied=false;try{${entry}(ctx,[value])}catch(e){denied=String(e).includes('contract_closure_tamper')}console.log(JSON.stringify({denied}));\n`);
        const output = spawnSync(process.execPath, ['--experimental-strip-types', join(directory, 'main.ts')], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(output.status, 0, output.stderr);
        assert.deepEqual(JSON.parse(output.stdout), { denied: true });
      } else {
        writeFileSync(join(directory, 'aether_runtime.py'), bundle.runtime);
        writeFileSync(join(directory, 'main.py'), bundle.source + `\nctx=Context()\nvalue=${factory}(ctx,[3])\nvalue.captures[0]=9\ndenied=False\ntry: ${entry}(ctx,[value])\nexcept Exception as e: denied='contract_closure_tamper' in str(e)\nprint(json.dumps({'denied':denied}))\n`);
        const output = spawnSync('python3', [join(directory, 'main.py')], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(output.status, 0, output.stderr);
        assert.deepEqual(JSON.parse(output.stdout), { denied: true });
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
