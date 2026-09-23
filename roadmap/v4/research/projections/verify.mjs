#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {countTokens} from '../../../../src/util/tokens.ts';
import {decode,IrContext} from '../../../../src/tier1/agent-ir.ts';
import {decodeAgentIrBinary,decodeAgentIrModel} from '../../../../src/tier1/agent-ir-v2.ts';
import {parseExecutable} from '../../../../src/projection/executable.ts';
import {GraphStore} from '../../../../src/tier1/store.ts';
const directory=process.argv[2]??'roadmap/v4/research/projections/results/campaign-03';
const report=JSON.parse(readFileSync(join(directory,'report.json'))),artifacts=JSON.parse(readFileSync(join(directory,'artifacts.json')));
const sha=x=>createHash('sha256').update(x).digest('hex');
assert.equal(JSON.parse(readFileSync('node_modules/js-tiktoken/package.json')).version,report.tokenizerPackage.version);
for(const source of report.sources)assert.equal(sha(readFileSync(join(directory,'sources',source.path+'.source'))),source.sha256);
let messages=0;
for(const artifact of artifacts){const ctx=new IrContext(),store=new GraphStore();for(let i=0;i<artifact.files.length;i++){const file=artifact.files[i];assert.equal(store.intern(decode(artifact.warmAe1Messages[i],ctx)),file.root);assert.equal(store.intern(decode(file.ae1)),file.root);assert.equal(store.intern(decodeAgentIrModel(file.ae2)),file.root);assert.equal(store.intern(decodeAgentIrBinary(Buffer.from(file.binary,'base64'))),file.root);for(const[target,source]of Object.entries(file.native))assert.equal(store.intern(parseExecutable(source,target)),file.root);messages++;}
 for(const tokenizer of report.tokenizers){const row=report.rows.find(r=>r.workload===artifact.id&&r.tokenizer===tokenizer),count=s=>countTokens(s,tokenizer),first=artifact.files[0];assert.equal(row.cold.legacyTsReviewTokens,count(first.legacyTypeScript));assert.equal(row.cold.ae2Tokens,count(first.ae2));assert.equal(row.cold.ae1Tokens,count(first.ae1));assert.equal(row.cold.binaryBytes,Buffer.from(first.binary,'base64').length);for(const[target,source]of Object.entries(first.native))assert.equal(row.cold.nativeTokens[target],count(source));assert.equal(row.session.ae2CompleteMessages,artifact.files.reduce((n,f)=>n+count(f.ae2),0));assert.equal(row.session.ae1SharedDictionaryTokens,artifact.warmAe1Messages.reduce((n,s)=>n+count(s),0));}
}
for(const row of report.aggregate){const rows=report.rows.filter(r=>r.tokenizer===row.tokenizer),baseline=rows.reduce((n,r)=>n+r.cold.legacyTsReviewTokens,0),candidate=rows.reduce((n,r)=>n+r.cold.ae2Tokens,0);assert.equal(row.ratioOfSums,baseline/candidate);assert.equal(row.meetsFourfoldDiagnostic,baseline/candidate>=4);}
assert.equal(report.qualifiedReleaseDensity,false);assert.equal(report.unsupportedWorkloads.length,3);
console.log(JSON.stringify({format:'aether.projection-token-audit/1',passed:true,messages,tokenizers:report.tokenizers,sourceSnapshots:report.sources.length,aggregate:report.aggregate},null,2));
