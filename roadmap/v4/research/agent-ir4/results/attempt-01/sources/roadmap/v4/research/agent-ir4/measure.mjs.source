import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {decodeAgentIrBinary} from '../../../../src/tier1/agent-ir-v2.ts';
import {agentIr3Snapshot,encodeAgentIr3,decodeAgentIr3} from '../../../../src/tier1/agent-ir-v3.ts';
import {countTokens} from '../../../../src/util/tokens.ts';
import {encodeAe4,decodeAe4} from './codec.mjs';

const output=resolve(process.argv[2]??'roadmap/v4/research/agent-ir4/results/attempt-01');
if(existsSync(output))throw Error('Refusing to overwrite retained density evidence');
const baseline='roadmap/v4/research/projections/results/campaign-11-generics';
const input=readFileSync(join(baseline,'artifacts.json'));
const baselineBytes=readFileSync(join(baseline,'report.json'));
const artifacts=JSON.parse(input),baselineReport=JSON.parse(baselineBytes);
const sha=x=>createHash('sha256').update(x).digest('hex');
const sources=['roadmap/v4/research/agent-ir4/codec.mjs','roadmap/v4/research/agent-ir4/measure.mjs','roadmap/v4/research/agent-ir4/verify.mjs','src/tier1/agent-ir-v3.ts','src/tier1/agent-ir-v3-compact.ts','src/tier1/agent-ir-v3-bounds.ts','src/tier1/agent-ir.ts','src/tier1/agent-ir-v2.ts','src/tier1/ast.ts','src/tier1/store.ts','src/util/tokens.ts'];
const registration={format:'aether.agent-ir4.campaign/1',started:new Date().toISOString(),baseline,baselineArtifactsSha256:sha(input),baselineReportSha256:sha(baselineBytes),workloads:artifacts.map(a=>a.id),rootMessages:artifacts.reduce((n,a)=>n+a.files.length,0),tokenizers:['cl100k_base','o200k_base'],selection:'Every original V7 workload and version, unchanged. Full cold payload includes the entry plus all dependencies. For a closed bundle, derive AST import references from included dependency roots and retain the original complete snapshot digest. Choose AE4 only when shorter in UTF-8 bytes than AE3, before tokenizer measurement. Otherwise use AE3. Edits use AE3 and pay initial complete message.',hypothesis:'Content-addressed imported root references are redundant when the exact referenced roots are already in a paid complete message. Reconstruct them without dropping identities, imports or digest. Fourfold remains a required independent gate.',sources:sources.map(path=>({path,sha256:sha(readFileSync(path))}))};
mkdirSync(output,{recursive:true});
writeFileSync(join(output,'preregistration.json'),JSON.stringify(registration,null,2)+'\n');
writeFileSync(join(output,'baseline-artifacts.json'),input);
writeFileSync(join(output,'baseline-report.json'),baselineBytes);

const messages=[],rows=[];
for(const artifact of artifacts){
 let base;const versions=[];
 for(const file of artifact.files){
  const inputFiles=[file,...file.dependencyModules??[]];
  const snapshot=agentIr3Snapshot(inputFiles.map(f=>decodeAgentIrBinary(Buffer.from(f.binary,'base64'))));
  assert.deepEqual(snapshot.rootRefs,inputFiles.map(f=>f.root));
  const ae3=encodeAgentIr3(snapshot),research=encodeAe4(snapshot);
  const full=research&&Buffer.byteLength(research)<Buffer.byteLength(ae3)?research:ae3;
  const decoded=full.startsWith('AE4')?decodeAe4(full):decodeAgentIr3(full);
  assert.deepEqual(decoded.rootRefs,snapshot.rootRefs);
  const session=base?encodeAgentIr3(snapshot,base):full;
  assert.deepEqual((base?decodeAgentIr3(session,base):decoded).rootRefs,snapshot.rootRefs);
  versions.push({rootRefs:snapshot.rootRefs,digest:snapshot.digest,format:full.startsWith('AE4')?'AE4':'AE3',full,session,ae3});
  base=snapshot;
 }
 messages.push({workload:artifact.id,versions});
 for(const tokenizer of registration.tokenizers){
  const old=baselineReport.rows.find(r=>r.workload===artifact.id&&r.tokenizer===tokenizer);
  assert(old);
  const count=s=>countTokens(s,tokenizer),fullMessages=versions.map(v=>count(v.full)),sessionMessages=versions.map(v=>count(v.session));
  rows.push({workload:artifact.id,tokenizer,baselineLegacyCold:old.cold.legacyTsReviewTokens,baselineAe2Cold:old.cold.ae2Tokens,baselineLegacySession:old.session.legacyTsReviewTokens,baselineAe2Session:old.session.ae2CompleteMessages,ae3Cold:count(versions[0].ae3),cold:fullMessages[0],fullMessages,sessionMessages,session:sessionMessages.reduce((n,v)=>n+v,0)});
 }
}
const aggregate=registration.tokenizers.map(tokenizer=>{
 const selected=rows.filter(r=>r.tokenizer===tokenizer),sum=key=>selected.reduce((n,row)=>n+row[key],0);
 const cold=sum('cold'),session=sum('session'),legacyCold=sum('baselineLegacyCold'),legacySession=sum('baselineLegacySession'),ae2Cold=sum('baselineAe2Cold'),ae2Session=sum('baselineAe2Session'),ae3Cold=sum('ae3Cold');
 return{tokenizer,cold,session,legacyCold,legacySession,ae2Cold,ae2Session,ae3Cold,legacyToCandidateCold:legacyCold/cold,legacyToCandidateSession:legacySession/session,coldReductionFromAe3:1-cold/ae3Cold,meetsFourfoldCold:legacyCold/cold>=4,meetsFourfoldSession:legacySession/session>=4};
});
for(const source of registration.sources){
 const content=readFileSync(source.path);assert.equal(sha(content),source.sha256,'Source changed during campaign');
 const dest=join(output,'sources',source.path+'.source');mkdirSync(dest.slice(0,dest.lastIndexOf('/')),{recursive:true});writeFileSync(dest,content);
}
writeFileSync(join(output,'messages.json'),JSON.stringify(messages,null,2)+'\n');
const report={...registration,completed:new Date().toISOString(),node:process.version,git:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tokenizerPackage:JSON.parse(readFileSync('node_modules/js-tiktoken/package.json')).version,rows,aggregate,qualifiedReleaseDensity:false};
writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,aggregate},null,2));
