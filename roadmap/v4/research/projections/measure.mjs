#!/usr/bin/env node
/** Actual tokenizer accounting over complete files/messages. Never token-count
 * binary bytes as though they were model vocabulary symbols. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {projectionCorpus} from './corpus.ts';
import {compositeProjectionCorpus} from './corpus-composites.ts';
import {continuationProjectionCorpus} from './corpus-continuations.ts';
import {genericNestedCorpus} from './corpus-generics-nested.ts';
import {genericContinuationCorpus} from './corpus-generic-continuations.ts';
import {nestedImportCorpus} from './corpus-nested-imports.ts';
import {stringImportProjectionCorpus} from './corpus-strings-imports.ts';
import {atomicProjectionCorpus} from './corpus-atomic.ts';
import {projectExecutable,parseExecutable,executableRuntime,executableBundle,parseExecutableBundle} from '../../../../src/projection/executable.ts';
import {projectTypeScript} from '../../../../src/projection/typescript.ts';
import {encode,IrContext} from '../../../../src/tier1/agent-ir.ts';
import {encodeAgentIrBinary,encodeAgentIrModel} from '../../../../src/tier1/agent-ir-v2.ts';
import {GraphStore} from '../../../../src/tier1/store.ts';
import {countTokens} from '../../../../src/util/tokens.ts';
import {buildLedgerExample} from '../../../../src/examples/ledger.ts';
const directory=resolve(process.argv[2]??'roadmap/v4/research/projections/results/campaign-01');
if(existsSync(directory))throw Error('refusing to overwrite retained measurement');
const sha=x=>createHash('sha256').update(x).digest('hex');
const paths=['src/projection/executable-generics.ts','src/projection/executable-generic-plan.ts','roadmap/v4/research/projections/corpus-generics-nested.ts','roadmap/v4/research/projections/corpus-generic-continuations.ts','roadmap/v4/research/projections/corpus-nested-imports.ts','src/tier1/modules.ts','src/projection/executable-strings.ts','src/projection/executable-string-data.ts','src/projection/executable-link.ts','roadmap/v4/research/projections/corpus-strings-imports.ts','roadmap/v4/research/projections/generate-string-data.mjs','roadmap/v4/research/projections/string-data-provenance.json','src/projection/executable-atomic.ts','roadmap/v4/research/projections/corpus-atomic.ts','roadmap/v4/research/projections/verify.mjs','src/projection/executable-continuations.ts','src/projection/executable-continuation-plan.ts','roadmap/v4/research/projections/corpus-continuations.ts','src/projection/executable-composites.ts','roadmap/v4/research/projections/corpus-composites.ts','src/tier1/agent-ir-v2.ts','src/tier1/agent-ir.ts','src/projection/executable.ts','src/projection/executable-runtime.ts','src/projection/typescript.ts','src/util/tokens.ts','roadmap/v4/research/projections/corpus.ts','roadmap/v4/research/projections/measure.mjs','roadmap/v4/research/projections/Cargo.lock'];
const sources=paths.map(path=>({path,sha256:sha(readFileSync(path))}));
const ledger=buildLedgerExample();
const workloads=[...projectionCorpus(),...(['extended','continuations','atomics','linked','generics','nested-imports'].includes(process.argv[3])?[...compositeProjectionCorpus(),{id:'full-ledger',module:ledger.module,symbols:ledger.syms}]:[]),...(['continuations','atomics','linked','generics','nested-imports'].includes(process.argv[3])?continuationProjectionCorpus():[]),...(['atomics','linked','generics','nested-imports'].includes(process.argv[3])?atomicProjectionCorpus():[]),...(['linked','generics','nested-imports'].includes(process.argv[3])?stringImportProjectionCorpus():[]),...(['generics','nested-imports'].includes(process.argv[3])?[...genericNestedCorpus(),...genericContinuationCorpus()]:[]),...(process.argv[3]==='nested-imports'?nestedImportCorpus():[])];
const registration={format:'aether.projection-token-campaign/1',createdAt:new Date().toISOString(),tokenizers:['cl100k_base','o200k_base'],workloads:workloads.map(w=>w.id),dependencyFraming:'Imported workloads count JSON {entry,dependencies} messages containing the complete content-addressed closure; static dependencies repeat in each message; binaryBytes reports summed binary payload bytes',session:'one original complete module and two complete-module replacements; every message includes framing/dictionary overhead',densityGoal:4,scope:'Small authored scalar corpus, no representative-production or release density qualification. Legacy TS review syntax is a diagnostic baseline; native v2 metadata/runtime overhead is reported separately.',sources};
mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'preregistration.json'),JSON.stringify(registration,null,2)+'\n');
const packageVersion=JSON.parse(readFileSync('node_modules/js-tiktoken/package.json','utf8')).version;
const rows=[],artifacts=[];
for(const workload of workloads){
 const store=new GraphStore(),root=store.intern(workload.module),path=store.findPath(root,node=>node.kind==='Lit'&&typeof node.value==='bigint');if(!path)throw Error('corpus needs integer edit');
 const changed=[workload.module];for(let i=1;i<=2;i++){const selected=store.resolvePath(root,path).at(-1),before=store.get(selected);changed.push(store.hydrate(store.replaceAt(root,path,store.intern({...before,value:before.value+BigInt(i)}))));}
 const files=changed.map(module=>{
  const options={modules:workload.modules},bundles=Object.fromEntries(['typescript','python','rust'].map(target=>{const bundle=executableBundle(module,workload.symbols,target,options);if(store.intern(parseExecutableBundle(bundle).module)!==store.intern(module))throw Error('native roundtrip');return[target,bundle];}));
  const dependencyModules=[...(parseExecutableBundle(bundles.typescript).modules)].sort(([a],[b])=>a.localeCompare(b)).map(([root,module])=>({root,legacyTypeScript:projectTypeScript(module,workload.symbols),ae1:encode(module).text,ae2:encodeAgentIrModel(module),binary:Buffer.from(encodeAgentIrBinary(module)).toString('base64')}));
  const file={root:store.intern(module),legacyTypeScript:projectTypeScript(module,workload.symbols),ae1:encode(module).text,ae2:encodeAgentIrModel(module),binary:Buffer.from(encodeAgentIrBinary(module)).toString('base64'),native:Object.fromEntries(Object.entries(bundles).map(([t,b])=>[t,b.source]))};
  if(dependencyModules.length){file.dependencyModules=dependencyModules;file.nativeDependencies=Object.fromEntries(Object.entries(bundles).map(([t,b])=>[t,Object.fromEntries(b.dependencies)]));}
  return file;
 });
 const send=new IrContext(),warmDependencies=[],warm=changed.map(module=>{const main=encode(module,send).text;warmDependencies.push([...(workload.modules??[])].sort(([a],[b])=>a.localeCompare(b)).map(([,dep])=>encode(dep,send).text));return main;});
 artifacts.push({id:workload.id,files,warmAe1Messages:warm,...(warmDependencies.some(d=>d.length)?{warmAe1DependencyMessages:warmDependencies}:{})});
 const message=(file,key)=>file.dependencyModules?JSON.stringify({entry:file[key],dependencies:file.dependencyModules.map(d=>d[key])}):file[key];
 const nativeMessage=(file,target)=>file.nativeDependencies?JSON.stringify({entry:file.native[target],dependencies:file.nativeDependencies[target]}):file.native[target];
 const binarySize=file=>[file,...(file.dependencyModules??[])].reduce((n,f)=>n+Buffer.from(f.binary,'base64').length,0);
 const warmMessages=warm.map((entry,i)=>warmDependencies[i].length?JSON.stringify({entry,dependencies:warmDependencies[i]}):entry);
 for(const tokenizer of registration.tokenizers){const count=s=>countTokens(s,tokenizer),sum=values=>values.reduce((a,b)=>a+b,0),first=files[0];
  const legacy=count(message(first,'legacyTypeScript')),cold=count(message(first,'ae2')),legacySession=sum(files.map(f=>count(message(f,'legacyTypeScript')))),ae2Session=sum(files.map(f=>count(message(f,'ae2'))));
  rows.push({workload:workload.id,tokenizer,cold:{legacyTsReviewTokens:legacy,ae1Tokens:count(message(first,'ae1')),ae2Tokens:cold,binaryBytes:binarySize(first),nativeTokens:Object.fromEntries(Object.entries(first.native).map(([t])=>[t,count(nativeMessage(first,t))])),legacyReviewToAe2Ratio:legacy/cold,meetsFourfoldDiagnostic:legacy/cold>=4},session:{messages:3,legacyTsReviewTokens:legacySession,ae1SharedDictionaryTokens:sum(warmMessages.map(count)),ae2CompleteMessages:ae2Session,legacyReviewToAe2Ratio:legacySession/ae2Session,meetsFourfoldDiagnostic:legacySession/ae2Session>=4}});
 }
}
const misses=[],coverage=[];for(const target of ['typescript','python','rust']){try{const source=projectExecutable(ledger.module,ledger.syms,target),store=new GraphStore();if(store.intern(parseExecutable(source,target))!==store.intern(ledger.module))throw Error('ledger roundtrip');coverage.push({workload:'full-ledger',target,status:'supported'});}catch(error){if(!/unsupported (scalar|composite) projection/.test(String(error)))throw error;const row={workload:'full-ledger',target,reason:String(error)};misses.push(row);coverage.push({...row,status:'unsupported'});}}
const aggregate=registration.tokenizers.map(tokenizer=>{const selected=rows.filter(r=>r.tokenizer===tokenizer),sum=(f)=>selected.reduce((n,row)=>n+f(row),0),baseline=sum(r=>r.cold.legacyTsReviewTokens),candidate=sum(r=>r.cold.ae2Tokens);return{tokenizer,legacyTsReviewTokens:baseline,ae2Tokens:candidate,ratioOfSums:baseline/candidate,meetsFourfoldDiagnostic:baseline/candidate>=4};});
const genericRuntime=Object.fromEntries(['typescript','python','rust'].map(target=>{const source=executableRuntime(target,true,true,true,true,true);return[target,{bytes:Buffer.byteLength(source),sha256:sha(source),tokens:Object.fromEntries(registration.tokenizers.map(t=>[t,countTokens(source,t)]))}];}));
const linkedRuntime=Object.fromEntries(['typescript','python','rust'].map(target=>{const source=executableRuntime(target,true,true,true,true);return[target,{bytes:Buffer.byteLength(source),sha256:sha(source),tokens:Object.fromEntries(registration.tokenizers.map(t=>[t,countTokens(source,t)]))}];}));
const atomicRuntime=Object.fromEntries(['typescript','python','rust'].map(target=>{const source=executableRuntime(target,true,true,true);return[target,{bytes:Buffer.byteLength(source),sha256:sha(source),tokens:Object.fromEntries(registration.tokenizers.map(t=>[t,countTokens(source,t)]))}];}));
const continuationRuntime=Object.fromEntries(['typescript','python','rust'].map(target=>{const source=executableRuntime(target,true,true);return[target,{bytes:Buffer.byteLength(source),sha256:sha(source),tokens:Object.fromEntries(registration.tokenizers.map(t=>[t,countTokens(source,t)]))}];}));
const compositeRuntime=Object.fromEntries(['typescript','python','rust'].map(target=>{const source=executableRuntime(target,true);return[target,{bytes:Buffer.byteLength(source),sha256:sha(source),tokens:Object.fromEntries(registration.tokenizers.map(t=>[t,countTokens(source,t)]))}];}));
const runtime=Object.fromEntries(['typescript','python','rust'].map(target=>{const source=executableRuntime(target);return[target,{bytes:Buffer.byteLength(source),sha256:sha(source),tokens:Object.fromEntries(registration.tokenizers.map(t=>[t,countTokens(source,t)]))}];}));
for(const source of sources){const text=readFileSync(source.path);if(sha(text)!==source.sha256)throw Error('source changed during measurement');const path=join(directory,'sources',source.path+'.source');mkdirSync(path.slice(0,path.lastIndexOf('/')),{recursive:true});writeFileSync(path,text);}
writeFileSync(join(directory,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
const runtimeArtifacts=Object.fromEntries([['runtime',false,false,false],['compositeRuntime',true,false,false],['continuationRuntime',true,true,false],['atomicRuntime',true,true,true],['linkedRuntime',true,true,true,true],['genericRuntime',true,true,true,true,true]].map(([key,composite,continuation,atomic,linked,generic])=>[key,Object.fromEntries(['typescript','python','rust'].map(target=>[target,executableRuntime(target,composite,continuation,atomic,linked,generic)]))]));
writeFileSync(join(directory,'runtime-artifacts.json'),JSON.stringify(runtimeArtifacts,null,2)+'\n');
const report={...registration,completedAt:new Date().toISOString(),gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),gitStatus:execFileSync('git',['status','--short'],{encoding:'utf8'}),node:process.version,tokenizerPackage:{name:'js-tiktoken',version:packageVersion},rows,aggregate,runtime,compositeRuntime,continuationRuntime,atomicRuntime,linkedRuntime,genericRuntime,unsupportedWorkloads:misses,coverage,qualifiedReleaseDensity:false};
writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({directory,aggregate,unsupportedWorkloads:misses},null,2));
