import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {GraphStore} from '../../src/tier1/store.ts';
import {executableBundle,parseExecutableBundle,RUST_PROJECTION_CARGO,type ExecutableTarget} from '../../src/projection/executable.ts';
import {genericContinuationFixture} from '../../roadmap/v4/research/projections/corpus-generic-continuations.ts';

for(const target of ['typescript','python','rust'] as const satisfies readonly ExecutableTarget[])test(`generic captured closures and tasks round trip and execute in ${target}`,()=>{
 const f=genericContinuationFixture(),bundle=executableBundle(f.module,f.symbols,target),parsed=parseExecutableBundle(bundle),store=new GraphStore();
 assert.equal(store.intern(parsed.module),store.intern(f.module));
 const altered=bundle.source.replace('ae_capture(ae_captures, "0")','ae_capture(ae_captures, "1")');
 assert.notEqual(altered,bundle.source);assert.throws(()=>parseExecutableBundle({...bundle,source:altered}),/capture index/);
 assert.throws(()=>parseExecutableBundle({...bundle,source:bundle.source+'\nfunction hidden() {}\n'}),/unsupported source outside function/);
 if(target==='rust'){
  assert.match(bundle.source,/ae_lambda_generic!/);assert.match(bundle.source,/ae_spawn_generic!/);
  assert.throws(()=>parseExecutableBundle({...bundle,source:bundle.source.replace(/ae_lambda_generic!/, 'ae_lambda!')}),/arity|scaffolding/);
  const wrongWitness=bundle.source.replace(/(ae_lambda_generic!\([^\n]*), ae_types\)/,'$1, ae_args)');
  assert.notEqual(wrongWitness,bundle.source);assert.throws(()=>parseExecutableBundle({...bundle,source:wrongWitness}),/generic continuation witness|scaffolding/);
 }
 const entry=bundle.aliases.get(f.main)!;let source=bundle.source,command:string,args:string[];const directory=mkdtempSync(join(tmpdir(),'aether-generic-continuations-'));
 try{
  if(target==='typescript'){
   writeFileSync(join(directory,'aether_runtime.ts'),bundle.runtime);
   source+=`\nconst context=new Context([]);const row=${entry}(context,[]);console.log(JSON.stringify({integer:String(ae_field(row,"integer")),string:ae_field(row,"string"),task:ae_field(row,"task")}));`;
   writeFileSync(join(directory,'main.ts'),source);command=process.execPath;args=['--experimental-strip-types',join(directory,'main.ts')];
  }else if(target==='python'){
   writeFileSync(join(directory,'aether_runtime.py'),bundle.runtime);
   source+=`\nrow=${entry}(Context([]),[])\nprint(json.dumps({"integer":str(ae_field(row,"integer")),"string":ae_field(row,"string"),"task":ae_field(row,"task")}))`;
   writeFileSync(join(directory,'main.py'),source);command='python3';args=[join(directory,'main.py')];
  }else{
   mkdirSync(join(directory,'src'));writeFileSync(join(directory,'Cargo.toml'),RUST_PROJECTION_CARGO);writeFileSync(join(directory,'Cargo.lock'),readFileSync(new URL('../../roadmap/v4/research/projections/Cargo.lock',import.meta.url)));
   writeFileSync(join(directory,'src/aether_runtime.rs'),bundle.runtime);
   source+=`\nfn main(){let mut context=Context::new(vec![],|_,_|Value::Unit);let row=${entry}(&mut context,vec![]);println!("{}",serde_json::json!({"integer":ae_num(ae_field(row.clone(),"integer")).to_string(),"string":ae_text(&ae_field(row.clone(),"string")),"task":ae_text(&ae_field(row,"task"))}));}`;
   writeFileSync(join(directory,'src/main.rs'),source);command='cargo';args=['run','--quiet','--locked','--offline','--manifest-path',join(directory,'Cargo.toml')];
  }
  const run=spawnSync(command,args,{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,env:{...process.env,CARGO_TARGET_DIR:join(tmpdir(),'aether-projection-target-v7')}});
  assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),{integer:'7',string:'saved',task:'later'});
 }finally{rmSync(directory,{recursive:true,force:true});}
});
