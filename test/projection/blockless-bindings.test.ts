import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { executableBundle, parseExecutableBundle, projectTypeScriptV11, projectTypeScriptV12,
  RUST_PROJECTION_CARGO, type ExecutableTarget } from '../../src/projection/executable.ts';

function fixture() {
  const symbols = new SymbolSpace('projection-blockless-bindings-v12');
  const ids = Object.fromEntries(['choice','missing','count','transaction','fault','set','shadow','outerWrite','outerLocal','drop','flag','x','y','i','z']
    .map(name => [name, symbols.define(name)]));
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({symbol:ids.choice,params:[b.param(ids.flag,b.Bool)],returns:b.Int,
      body:b.block(b.if_(b.v(ids.flag),b.let_(ids.x,b.Int,b.int(7)),b.let_(ids.x,b.Int,b.int(9))),b.ret(b.v(ids.x)))}),
    b.fn({symbol:ids.missing,params:[b.param(ids.flag,b.Bool)],returns:b.Int,
      body:b.block(b.if_(b.v(ids.flag),b.let_(ids.y,b.Int,b.int(5))),b.ret(b.v(ids.y)))}),
    b.fn({symbol:ids.count,returns:b.Int,
      body:b.block(b.let_(ids.i,b.Int,b.int(0)),b.while_(b.lt(b.v(ids.i),b.int(3)),b.let_(ids.i,b.Int,b.add(b.v(ids.i),b.int(1)))),b.ret(b.v(ids.i)))}),
    b.fn({symbol:ids.transaction,returns:b.Int,
      body:b.block(b.atomic(b.let_(ids.z,b.Int,b.int(11))),b.ret(b.v(ids.z)))}),
    b.fn({symbol:ids.fault,returns:b.Unit,
      body:b.block(b.atomic(b.let_(ids.z,b.Int,b.div(b.int(1),b.int(0)))),b.ret(b.unit()))}),
    b.fn({symbol:ids.set,returns:b.Int,
      body:b.block(b.if_(b.bool(true),b.let_(ids.x,b.Int,b.int(2))),b.assign(b.place(ids.x),b.int(13)),b.ret(b.v(ids.x)))}),
    b.fn({symbol:ids.shadow,params:[b.param(ids.x,b.Int),b.param(ids.flag,b.Bool)],returns:b.Int,
      body:b.block(b.exprStmt(b.v(ids.x)),b.if_(b.v(ids.flag),b.let_(ids.x,b.Int,b.int(4))),b.ret(b.v(ids.x)))}),
    b.fn({symbol:ids.outerWrite,params:[b.param(ids.x,b.Int)],returns:b.Int,
      body:b.block(b.block(b.assign(b.place(ids.x),b.add(b.v(ids.x),b.int(1))),b.if_(b.bool(true),b.let_(ids.x,b.Int,b.int(4))),b.assert_(b.eq(b.v(ids.x),b.int(4)),'inner')),b.ret(b.v(ids.x)))}),
    b.fn({symbol:ids.outerLocal,returns:b.Int,
      body:b.block(b.let_(ids.x,b.Int,b.int(3)),b.block(b.assign(b.place(ids.x),b.add(b.v(ids.x),b.int(1))),b.if_(b.bool(true),b.let_(ids.x,b.Int,b.int(7))),b.assert_(b.eq(b.v(ids.x),b.int(7)),'nested')),b.ret(b.v(ids.x)))}),
    b.fn({symbol:ids.drop,returns:b.Int,
      body:b.block(b.if_(b.bool(false),b.let_(ids.x,b.Int,b.int(1))),b.block(b.assign(b.place(ids.x),b.int(2))),b.ret(b.v(ids.x)))}),
  ] });
  return {symbols,ids,module};
}

test('V12 parses visible blockless bindings to the exact root and guards slot scaffolding', () => {
  const f=fixture(),root=new GraphStore().intern(f.module);
  assert.throws(()=>projectTypeScriptV11(f.module,f.symbols),/conditional bindings|atomic bindings|distinct binder identities/);
  for(const target of ['typescript','python','rust'] as const){
    const bundle=executableBundle(f.module,f.symbols,target);
    assert.match(bundle.source,/@aether-projection\/12/);
    assert.equal(new GraphStore().intern(parseExecutableBundle(bundle).module),root);
    const altered=bundle.source.replace('ae_int("7")','ae_int("8")');
    assert.notEqual(altered,bundle.source);
    assert.notEqual(new GraphStore().intern(parseExecutableBundle({...bundle,source:altered}).module),root);
    const damaged=bundle.source.replace('@binding-slot','@other-slot');
    assert.throws(()=>parseExecutableBundle({...bundle,source:damaged}),/statement|scaffolding|binding|projection/);
  }
});

test('each blockless If, While and Atomic shape independently selects V12',()=>{
  for(const kind of ['If','While','Atomic'] as const){
    const symbols=new SymbolSpace(`projection-v12-${kind}`),x=symbols.define('x'),fn=symbols.define('fn');
    const binding=b.let_(x,b.Int,b.int(1));
    const statement=kind==='If'?b.if_(b.bool(true),binding):kind==='While'?b.while_(b.bool(false),binding):b.atomic(binding);
    const module=b.module_({symbol:symbols.define('module'),symbolTable:symbols.table(),members:[
      b.fn({symbol:fn,returns:b.Unit,body:b.block(statement,b.ret(b.unit()))}),
    ]});
    const root=new GraphStore().intern(module);
    for(const target of ['typescript','python','rust'] as const){
      const bundle=executableBundle(module,symbols,target);
      assert.match(bundle.source,/@aether-projection\/12/);
      assert.equal(new GraphStore().intern(parseExecutableBundle(bundle).module),root);
    }
  }
});

test('V12 reference run covers selected branches, skipped bindings, loop rebinding, Atomic, assignment and shadow fallback',()=>{
  const f=fixture(),rt=new Runtime({registry:new CapabilityRegistry()}).load(f.module),call=(name:string,args:(bigint|boolean)[]=[])=>rt.call(f.ids[name],args);
  for(const [name,args,want] of [['choice',[true],7n],['choice',[false],9n],['missing',[true],5n],['count',[],3n],['transaction',[],11n],['set',[],13n],['shadow',[20n,true],4n],['shadow',[20n,false],20n],['outerWrite',[20n],21n],['outerLocal',[],4n]] as const){const result=call(name,[...args]);assert.equal(result.ok,true,name);if(result.ok)assert.equal(result.value,want,name);}
  const missing=call('missing',[false]);assert.equal(missing.ok,false);if(!missing.ok)assert.equal(missing.fault.kind,'unbound');
  const dropped=call('drop');assert.equal(dropped.ok,false);if(!dropped.ok)assert.equal(dropped.fault.kind,'unbound');
  const fault=call('fault');assert.equal(fault.ok,false);if(!fault.ok)assert.equal(fault.fault.kind,'division_by_zero');
});

test('V12 explicitly rejects invalid blockless binding types',()=>{
  const symbols=new SymbolSpace('projection-v12-invalid-binding'),x=symbols.define('x'),fn=symbols.define('fn');
  const module=b.module_({symbol:symbols.define('module'),symbolTable:symbols.table(),members:[
    b.fn({symbol:fn,returns:b.Unit,body:b.block(b.if_(b.bool(true),b.let_(x,b.Int,b.bool(true))),b.ret(b.unit()))}),
  ]});
  assert.throws(()=>projectTypeScriptV12(module,symbols),/projection typecheck failed/);
});

test('V12 profile propagates through an exact-address import closure',()=>{
  const symbols=new SymbolSpace('projection-v12-import'),libraryFn=symbols.define('libraryFn'),entry=symbols.define('entry'),x=symbols.define('x');
  const library=b.module_({symbol:symbols.define('library'),symbolTable:symbols.table(),members:[
    b.fn({symbol:libraryFn,returns:b.Int,body:b.block(b.if_(b.bool(true),b.let_(x,b.Int,b.int(6))),b.ret(b.v(x)))}),
  ]});
  const store=new GraphStore(),ref=store.intern(library);
  const module=b.module_({symbol:symbols.define('module'),symbolTable:symbols.table(),members:[
    b.import_(ref,[libraryFn]),b.fn({symbol:entry,returns:b.Int,body:b.ret(b.call(libraryFn))}),
  ]});
  for(const target of ['typescript','python','rust'] as const){
    const bundle=executableBundle(module,symbols,target,{modules:new Map([[ref,library]])});
    assert.match(bundle.source,/@aether-projection\/12/);
    assert.equal(bundle.dependencies?.size,1);
    const parsed=parseExecutableBundle(bundle);
    assert.equal(store.intern(parsed.module),store.intern(module));
    assert.equal(store.intern(parsed.modules.get(ref)!),ref);
  }
});

for(const target of ['typescript','python','rust'] as const)
  test(`V12 actual ${target} execution matches reference binding outcomes`,()=>{
    const f=fixture(),bundle=executableBundle(f.module,f.symbols,target),dir=mkdtempSync(join(tmpdir(),'aether-binding-v12-'));
    const n=(name:string)=>bundle.aliases.get(f.ids[name])!;
    let command:string,args:string[];
    try{
      if(target==='typescript'){
        writeFileSync(join(dir,'aether_runtime.ts'),bundle.runtime);
        writeFileSync(join(dir,'main.ts'),bundle.source+`\nconst ctx=new Context();const fail=(f:()=>V)=>{try{f();return false}catch(e){return String(e).includes('unbound')}};const fault=(f:()=>V)=>{try{f();return false}catch(e){return String(e).includes('division_by_zero')}};console.log(JSON.stringify({yes:String(${n('choice')}(ctx,[true])),no:String(${n('choice')}(ctx,[false])),bound:String(${n('missing')}(ctx,[true])),missing:fail(()=>${n('missing')}(ctx,[false])),dropped:fail(()=>${n('drop')}(ctx,[])),count:String(${n('count')}(ctx,[])),transaction:String(${n('transaction')}(ctx,[])),set:String(${n('set')}(ctx,[])),shadowYes:String(${n('shadow')}(ctx,[20n,true])),shadowNo:String(${n('shadow')}(ctx,[20n,false])),outerWrite:String(${n('outerWrite')}(ctx,[20n])),outerLocal:String(${n('outerLocal')}(ctx,[])),fault:fault(()=>${n('fault')}(ctx,[]))}));\n`);
        const checked=spawnSync(process.execPath,[new URL('../../node_modules/typescript/bin/tsc',import.meta.url).pathname,'--noEmit','--strict','--skipLibCheck','--target','ES2023','--module','NodeNext','--allowImportingTsExtensions',join(dir,'main.ts')],{encoding:'utf8',timeout:60_000});
        assert.equal(checked.status,0,checked.stdout+checked.stderr);
        command=process.execPath;args=['--experimental-strip-types',join(dir,'main.ts')];
      }else if(target==='python'){
        writeFileSync(join(dir,'aether_runtime.py'),bundle.runtime);
        writeFileSync(join(dir,'main.py'),bundle.source+`\nctx=Context()\ndef fail(f):\n    try: f(); return False\n    except Exception as e: return 'unbound' in str(e)\ndef fault(f):\n    try: f(); return False\n    except Exception as e: return 'division_by_zero' in str(e)\nprint(json.dumps({'yes':str(${n('choice')}(ctx,[True])),'no':str(${n('choice')}(ctx,[False])),'bound':str(${n('missing')}(ctx,[True])),'missing':fail(lambda:${n('missing')}(ctx,[False])),'dropped':fail(lambda:${n('drop')}(ctx,[])),'count':str(${n('count')}(ctx,[])),'transaction':str(${n('transaction')}(ctx,[])),'set':str(${n('set')}(ctx,[])),'shadowYes':str(${n('shadow')}(ctx,[20,True])),'shadowNo':str(${n('shadow')}(ctx,[20,False])),'outerWrite':str(${n('outerWrite')}(ctx,[20])),'outerLocal':str(${n('outerLocal')}(ctx,[])),'fault':fault(lambda:${n('fault')}(ctx,[]))}))\n`);
        command='python3';args=[join(dir,'main.py')];
      }else{
        mkdirSync(join(dir,'src'));writeFileSync(join(dir,'Cargo.toml'),RUST_PROJECTION_CARGO);
        writeFileSync(join(dir,'Cargo.lock'),readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock',import.meta.url)));
        writeFileSync(join(dir,'src/aether_runtime.rs'),bundle.runtime);
        writeFileSync(join(dir,'src/main.rs'),bundle.source+`\nfn sink(_cap:&str,_args:Vec<Value>)->Value{Value::Unit}fn failed(f:impl FnOnce()->Value)->bool{std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()}fn main(){std::panic::set_hook(Box::new(|_|{}));let mut ctx=Context::new(vec![],sink);let yes=${n('choice')}(&mut ctx,vec![ae_bool(true)]);let no=${n('choice')}(&mut ctx,vec![ae_bool(false)]);let bound=${n('missing')}(&mut ctx,vec![ae_bool(true)]);let missing=failed(||${n('missing')}(&mut ctx,vec![ae_bool(false)]));let dropped=failed(||${n('drop')}(&mut ctx,vec![]));let count=${n('count')}(&mut ctx,vec![]);let transaction=${n('transaction')}(&mut ctx,vec![]);let set=${n('set')}(&mut ctx,vec![]);let shadow_yes=${n('shadow')}(&mut ctx,vec![ae_int("20"),ae_bool(true)]);let shadow_no=${n('shadow')}(&mut ctx,vec![ae_int("20"),ae_bool(false)]);let outer_write=${n('outerWrite')}(&mut ctx,vec![ae_int("20")]);let outer_local=${n('outerLocal')}(&mut ctx,vec![]);let fault=failed(||${n('fault')}(&mut ctx,vec![]));println!("{}",serde_json::json!({"yes":ae_num(yes).to_string(),"no":ae_num(no).to_string(),"bound":ae_num(bound).to_string(),"missing":missing,"dropped":dropped,"count":ae_num(count).to_string(),"transaction":ae_num(transaction).to_string(),"set":ae_num(set).to_string(),"shadowYes":ae_num(shadow_yes).to_string(),"shadowNo":ae_num(shadow_no).to_string(),"outerWrite":ae_num(outer_write).to_string(),"outerLocal":ae_num(outer_local).to_string(),"fault":fault}));}\n`);
        command='cargo';args=['run','--quiet','--locked','--offline','--manifest-path',join(dir,'Cargo.toml')];
      }
      const output=spawnSync(command,args,{encoding:'utf8',timeout:120_000,maxBuffer:16*1024*1024,env:{...process.env,CARGO_TARGET_DIR:join(dir,'target')}});
      assert.equal(output.status,0,output.stderr);
      assert.deepEqual(JSON.parse(output.stdout),{yes:'7',no:'9',bound:'5',missing:true,dropped:true,count:'3',transaction:'11',set:'13',shadowYes:'4',shadowNo:'20',outerWrite:'21',outerLocal:'4',fault:true});
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
