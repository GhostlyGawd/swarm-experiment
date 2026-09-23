import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import {SymbolSpace} from '../../src/tier1/symbols.ts';
import {GraphStore} from '../../src/tier1/store.ts';
import {executableBundle,parseExecutable,projectExecutable,RUST_PROJECTION_CARGO,type ExecutableTarget} from '../../src/projection/executable.ts';
import type {Term} from '../../src/tier1/ast.ts';
const targets:ExecutableTarget[]=['typescript','python','rust'];
function fixture(){
 const syms=new SymbolSpace('projection-v2'),cap='cap:test:emit' as never,x=syms.define('x'),i=syms.define('i'),n=syms.define('n'),j=syms.define('j');
 const symbols=Object.fromEntries(['bool','division','remainder','huge','wrap','saturate','trap','effect','loop','quantified','lazy','callee','caller','unicode','massive'].map(name=>[name,syms.define(name)]));
 const byte=(overflow:'wrap'|'trap'|'saturate')=>({t:'IntN' as const,bits:8 as const,signed:false,overflow});
 const f=(name:string,returns:Parameters<typeof b.fn>[0]['returns'],body:Term,extra:Partial<Parameters<typeof b.fn>[0]>={})=>b.fn({symbol:symbols[name],returns,body,...extra});
 const members=[f('bool',b.Bool,b.ret(b.and(b.bool(true),b.not(b.bool(false))))),f('division',b.Int,b.ret(b.div(b.int(-7),b.int(3)))),f('remainder',b.Int,b.ret(b.mod(b.int(-7),b.int(3)))),f('huge',b.Int,b.ret(b.add(b.int(10n**80n),b.int(1)))),...(['wrap','saturate','trap'] as const).map(op=>f(op,byte(op),b.ret(b.fixed('add',byte(op),b.typed(byte(op),250n),b.typed(byte(op),10n))))),f('effect',b.Unit,b.block(b.exprStmt(b.invoke(cap,b.str('payload'))),b.ret(b.typed(b.Unit,null))),{purity:'effectful',capabilities:[cap]}),f('loop',b.Int,b.block(b.let_(i,b.Int,b.int(0)),b.while_(b.lt(b.v(i),b.v(n)),b.block(b.assign(b.place(i),b.add(b.v(i),b.int(1)))),{invariants:[b.ge(b.v(i),b.int(0))],variant:b.sub(b.v(n),b.v(i))}),b.assign(b.place(n),b.int(0)),b.ret(b.v(i))),{params:[b.param(n,b.Int)],contract:b.contract({requires:[b.clause(b.ge(b.v(n),b.int(0)),'nonnegative')],ensures:[b.clause(b.eq(b.result(),b.old(b.v(n))),'entry count')]})}),f('quantified',b.Bool,b.ret(b.forall(j,b.int(0),b.int(5),b.ge(b.v(j),b.int(0))))),f('lazy',b.Int,b.ret(b.cond(b.bool(true),b.int(9),b.div(b.int(1),b.int(0))))),f('callee',b.Int,b.ret(b.add(b.v(x),b.int(1))),{params:[b.param(x,b.Int)]}),f('caller',b.Int,b.ret(b.call(symbols.callee,b.int(7)))),f('massive',b.Int,b.ret(b.mul(b.int(10n**2200n),b.int(10n**2200n)))),f('unicode',b.Str,b.ret(b.str('quotes \" \\\ \n\u0000😀\u0001\u2028\u2029')))];
 syms.rename(symbols.unicode,'unicode\u2028label');
 const module=b.module_({symbol:syms.define('module'),members,symbolTable:syms.table()});return{module,syms,symbols};
}
test('scalar native profiles round-trip all emitted control flow and parse actual visible edits',()=>{
 const f=fixture(),store=new GraphStore();
 for(const target of targets){const source=projectExecutable(f.module,f.syms,target);assert.equal(store.intern(parseExecutable(source,target)),store.intern(f.module));const changed=source.replace('ae_int("-7")','ae_int("-8")');assert.notEqual(changed,source);const parsed=parseExecutable(changed,target);assert.notEqual(store.intern(parsed),store.intern(f.module));assert.ok([...store.reachable(store.intern(parsed))].some(ref=>{const node=store.get(ref);return node.kind==='Lit'&&node.value===-8n;}));assert.throws(()=>parseExecutable(source+'\nmalicious_host_call();\n',target));assert.throws(()=>parseExecutable(source.replace('ae_arity','disabled_arity'),target),/scaffolding/);const broken=target==='typescript'?source.replace('return ctx.function','return\nctx.function'):target==='python'?source.replace('with ctx.function','withctx.function'):source.replace('pub fn','pubfn');assert.throws(()=>parseExecutable(broken,target),/scaffolding/);assert.throws(()=>parseExecutable(source.replace('ae_arity','\u2028ae_arity'),target),/line separators/);}
});
test('unsupported projected AST and host syntax reject rather than use placeholders or hidden IR',()=>{
 const f=fixture(),module=f.module as Extract<Term,{kind:'Module'}>;const bad={...module,members:[b.fn({symbol:f.symbols.bool,returns:b.Unit,body:b.atomic(b.block(b.ret(b.unit())))})]};for(const target of targets){assert.throws(()=>projectExecutable(bad,f.syms,target),/unsupported (scalar|composite) projection/);const source=projectExecutable(f.module,f.syms,target);assert.throws(()=>parseExecutable(source.replace('ae_int("-7")','eval("code")'),target),/unsupported projection helper/);}
});
for(const target of targets)test(`actual ${target} execution preserves booleans, arbitrary integers, negative division, overflow, contracts and effects`,()=>{
 const f=fixture(),bundle=executableBundle(f.module,f.syms,target),directory=mkdtempSync(join(tmpdir(),`aether-projection-${target}-`));
 try{
  const names=['bool','division','remainder','huge','wrap','saturate','trap','effect','loop','quantified','lazy','caller','unicode','massive'];
  let command:string,args:string[],source=bundle.source.replace('ae_int("-7")','ae_int("-10")');
  assert.notEqual(new GraphStore().intern(parseExecutable(source,target)),new GraphStore().intern(f.module),'the executed edit changed the graph');
  if(target==='typescript'){
   writeFileSync(join(directory,'aether_runtime.ts'),bundle.runtime);
   source+='\nimport {ae_json} from "./aether_runtime.ts";\nlet effects=0;const context=new Context(["cap:test:emit"],(cap,args)=>{if(cap!=="cap:test:emit"||args[0]!=="payload")throw Error("bad payload");effects++;return null;});\nconst results:string[]=[];\n';
   names.forEach(name=>{source+=`try{results.push(ae_json(${bundle.aliases.get(f.symbols[name])}(context,${name==='loop'?'[3n]':'[]'})));}catch{results.push('{"fault":"expected"}');}\n`;});source+='console.log(JSON.stringify({results:results.map(x=>JSON.parse(x)),effects}));\n';writeFileSync(join(directory,'main.ts'),source);command=process.execPath;args=['--experimental-strip-types',join(directory,'main.ts')];
  }else if(target==='python'){
   writeFileSync(join(directory,'aether_runtime.py'),bundle.runtime);source+='\neffects=[]\ncontext=Context(["cap:test:emit"],lambda cap,args: effects.append([cap,args]))\nresults=[]\n';names.forEach(name=>{source+=`try: results.append(json.loads(ae_json(${bundle.aliases.get(f.symbols[name])}(context,${name==='loop'?'[3]':'[]'}))))\nexcept Exception: results.append({"fault":"expected"})\n`;});source+='assert effects==[["cap:test:emit",["payload"]]]\nprint(json.dumps({"results":results,"effects":len(effects)}))\n';writeFileSync(join(directory,'main.py'),source);command='python3';args=[join(directory,'main.py')];
  }else{
   mkdirSync(join(directory,'src'));writeFileSync(join(directory,'Cargo.toml'),RUST_PROJECTION_CARGO);writeFileSync(join(directory,'Cargo.lock'),readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock',import.meta.url)));writeFileSync(join(directory,'src/aether_runtime.rs'),bundle.runtime);source+='\nuse std::sync::atomic::{AtomicUsize,Ordering};static EFFECTS:AtomicUsize=AtomicUsize::new(0);fn sink(cap:&str,args:Vec<Value>)->Value{assert_eq!(cap,"cap:test:emit");assert_eq!(args,vec![ae_str("payload")]);EFFECTS.fetch_add(1,Ordering::SeqCst);Value::Unit}\nfn main(){std::panic::set_hook(Box::new(|_|{}));let mut context=Context::new(vec!["cap:test:emit".to_string()],sink);let mut results:Vec<String>=vec![];\n';names.forEach(name=>{source+=`match std::panic::catch_unwind(std::panic::AssertUnwindSafe(||${bundle.aliases.get(f.symbols[name])}(&mut context,${name==='loop'?'vec![ae_int("3")]':'vec![]'}))){Ok(v)=>results.push(ae_json(&v)),Err(_)=>results.push("{\\\"fault\\\":\\\"expected\\\"}".to_string())};\n`;});source+='println!("{}",serde_json::json!({"results":results.iter().map(|s|serde_json::from_str::<J>(s).unwrap()).collect::<Vec<_>>(),"effects":EFFECTS.load(Ordering::SeqCst)}));}\n';writeFileSync(join(directory,'src/main.rs'),source);command='cargo';args=['run','--quiet','--locked','--offline','--manifest-path',join(directory,'Cargo.toml')];
  }
  const result=spawnSync(command,args,{encoding:'utf8',timeout:120000,env:{...process.env,CARGO_TARGET_DIR:join(tmpdir(),'aether-projection-target-v2')}});assert.equal(result.status,0,result.stderr);const parsed=JSON.parse(result.stdout.trim());assert.deepEqual(parsed,{results:[{tag:'bool',value:true},{tag:'int',value:'-3'},{tag:'int',value:'-1'},{tag:'int',value:String(10n**80n+1n)},{tag:'int',value:'4'},{tag:'int',value:'255'},{fault:'expected'},{tag:'null'},{tag:'int',value:'3'},{tag:'bool',value:true},{tag:'int',value:'9'},{tag:'int',value:'8'},{tag:'string',value:'quotes \" \\\ \n\u0000😀\u0001\u2028\u2029'},{tag:'int',value:String(10n**4400n)}],effects:1});
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('declared scalar kinds retain type declarations, surfaces, branch shape and contract metadata',()=>{
 const syms=new SymbolSpace('projection-coverage'),fn=syms.define('function'),surface=syms.define('tuning'),choice=syms.define('choice'),local=syms.define('local');
 const ty={t:'Nominal' as const,name:'type:projection:amount' as never,repr:b.Int},byte={t:'IntN' as const,bits:8 as const,signed:false,overflow:'wrap' as const};
 const module=b.module_({symbol:syms.define('module'),symbolTable:syms.table(),members:[b.typeDecl(ty.name,ty),b.fn({symbol:fn,returns:b.Int,surfaces:[b.surface({symbol:surface,domain:{d:'range',min:0n,max:10n,step:1n},current:8n,objective:'minimize_cost'}),b.surface({symbol:choice,domain:{d:'choice',options:['x|y','z']},current:'x|y',objective:'minimize_memory'})],contract:b.contract({ensures:[b.clause(b.eq(b.result(),b.old(b.v(surface))),'same|value','property')],modifies:[]}),body:b.block(b.let_(local,ty,b.typed(ty,1n)),b.if_(b.bool(false),b.yield_(),b.block(b.assert_(b.ne(b.neg(b.int(1)),b.int(0)),'negative'))),b.exprStmt(b.intCast(byte,b.int(258))),b.ret(b.v(surface)))})]});
 const store=new GraphStore();for(const target of targets)assert.equal(store.intern(parseExecutable(projectExecutable(module,syms,target),target)),store.intern(module));
});
