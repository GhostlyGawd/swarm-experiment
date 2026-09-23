import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {decodeAgentIrBinary} from '../../../../src/tier1/agent-ir-v2.ts';
import {agentIr3Snapshot,decodeAgentIr3} from '../../../../src/tier1/agent-ir-v3.ts';
import {countTokens} from '../../../../src/util/tokens.ts';
import {decodeAe4} from './codec.mjs';

const directory=process.argv[2]??'roadmap/v4/research/agent-ir4/results/attempt-01';
const read=name=>readFileSync(join(directory,name));
const sha=x=>createHash('sha256').update(x).digest('hex');
const report=JSON.parse(read('report.json')),artifacts=JSON.parse(read('baseline-artifacts.json')),messages=JSON.parse(read('messages.json'));
assert.equal(sha(read('baseline-artifacts.json')),report.baselineArtifactsSha256);
assert.equal(sha(read('baseline-report.json')),report.baselineReportSha256);
assert.deepEqual(report.workloads,artifacts.map(a=>a.id));
assert.deepEqual(report.tokenizers,['cl100k_base','o200k_base']);
assert.equal(JSON.parse(readFileSync('node_modules/js-tiktoken/package.json')).version,report.tokenizerPackage);
for(const source of report.sources)assert.equal(sha(read(join('sources',source.path+'.source'))),source.sha256);
let rootMessages=0,dependencyMessages=0,ae4FullMessages=0;
const measured=[];
for(let i=0;i<artifacts.length;i++){
 const artifact=artifacts[i],entry=messages[i];
 assert.equal(entry.workload,artifact.id);assert.equal(entry.versions.length,artifact.files.length);
 let base;
 for(let j=0;j<artifact.files.length;j++){
  const file=artifact.files[j],version=entry.versions[j],input=[file,...file.dependencyModules??[]];
  const expected=agentIr3Snapshot(input.map(f=>decodeAgentIrBinary(Buffer.from(f.binary,'base64'))));
  assert.deepEqual(expected.rootRefs,input.map(f=>f.root));assert.deepEqual(version.rootRefs,expected.rootRefs);assert.equal(version.digest,expected.digest);
  const full=version.format==='AE4'?decodeAe4(version.full):decodeAgentIr3(version.full);
  assert.deepEqual(full.rootRefs,expected.rootRefs);assert.equal(full.digest,expected.digest);
  const next=base?decodeAgentIr3(version.session,base):full;
  assert.deepEqual(next.rootRefs,expected.rootRefs);assert.equal(next.digest,expected.digest);
  base=next;rootMessages++;dependencyMessages+=input.length-1;if(version.format==='AE4')ae4FullMessages++;
 }
 for(const tokenizer of report.tokenizers){
  const row=report.rows.find(r=>r.workload===artifact.id&&r.tokenizer===tokenizer);assert(row);
  const count=s=>countTokens(s,tokenizer),version=entry.versions[0],message=(file,key)=>file.dependencyModules?JSON.stringify({entry:file[key],dependencies:file.dependencyModules.map(d=>d[key])}):file[key];
  const legacyCold=count(message(artifact.files[0],'legacyTypeScript'));
  const ae2Cold=count(message(artifact.files[0],'ae2'));
  const legacySession=artifact.files.reduce((n,f)=>n+count(message(f,'legacyTypeScript')),0);
  const ae2Session=artifact.files.reduce((n,f)=>n+count(message(f,'ae2')),0);
  const cold=count(version.full),sessionMessages=entry.versions.map(v=>count(v.session)),session=sessionMessages.reduce((n,v)=>n+v,0),ae3Cold=count(version.ae3);
  assert.equal(row.baselineLegacyCold,legacyCold);assert.equal(row.baselineAe2Cold,ae2Cold);assert.equal(row.baselineLegacySession,legacySession);assert.equal(row.baselineAe2Session,ae2Session);
  assert.equal(row.cold,cold);assert.equal(row.ae3Cold,ae3Cold);assert.deepEqual(row.fullMessages,entry.versions.map(v=>count(v.full)));assert.deepEqual(row.sessionMessages,sessionMessages);assert.equal(row.session,session);
  measured.push({tokenizer,cold,session,legacyCold,legacySession,ae2Cold,ae2Session,ae3Cold});
 }
}
for(const total of report.aggregate){
 const rows=measured.filter(r=>r.tokenizer===total.tokenizer),sum=key=>rows.reduce((n,r)=>n+r[key],0);
 for(const key of ['cold','session','legacyCold','legacySession','ae2Cold','ae2Session','ae3Cold'])assert.equal(total[key],sum(key));
 assert.equal(total.legacyToCandidateCold,total.legacyCold/total.cold);
 assert.equal(total.legacyToCandidateSession,total.legacySession/total.session);
 assert.equal(total.coldReductionFromAe3,1-total.cold/total.ae3Cold);
 assert.equal(total.meetsFourfoldCold,total.legacyToCandidateCold>=4);
 assert.equal(total.meetsFourfoldSession,total.legacyToCandidateSession>=4);
}
assert.equal(rootMessages,report.rootMessages);
assert.equal(report.qualifiedReleaseDensity,false);
console.log(JSON.stringify({format:'aether.agent-ir4.audit/1',passed:true,rootMessages,dependencyMessages,ae4FullMessages,aggregate:report.aggregate},null,2));
