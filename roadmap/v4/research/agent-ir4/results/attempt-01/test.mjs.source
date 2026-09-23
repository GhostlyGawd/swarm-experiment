import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {decodeAgentIrBinary} from '../../../../src/tier1/agent-ir-v2.ts';
import {agentIr3Snapshot} from '../../../../src/tier1/agent-ir-v3.ts';
import {encodeAe4,decodeAe4} from './codec.mjs';

const artifacts=JSON.parse(readFileSync('roadmap/v4/research/projections/results/campaign-11-generics/artifacts.json'));
const snapshot=file=>agentIr3Snapshot([file,...file.dependencyModules??[]].map(f=>decodeAgentIrBinary(Buffer.from(f.binary,'base64'))));

test('both AE4 grammars restore every imported V7 root, identity and byte-exact term',()=>{
 let messages=0;
 for(const artifact of artifacts){
  for(const file of artifact.files){
   if(!file.dependencyModules?.length)continue;
   const expected=snapshot(file);
   for(const format of ['AE3','AE3C']){
    const wire=encodeAe4(expected,format),actual=decodeAe4(wire);
    assert.deepEqual(actual.roots,expected.roots);
    assert.deepEqual(actual.rootRefs,expected.rootRefs);
    assert.equal(actual.digest,expected.digest);
    messages++;
   }
  }
 }
 assert.equal(messages,12);
});

test('unshipped dependencies and unvalidated snapshot objects are rejected',()=>{
 const file=artifacts.at(-1).files[0];
 assert.throws(()=>encodeAe4(agentIr3Snapshot([decodeAgentIrBinary(Buffer.from(file.binary,'base64'))])),/paid root list/);
 assert.throws(()=>encodeAe4({roots:[],rootRefs:[],digest:'0'}),/validated snapshot/);
});

test('complete message rejects target substitution, truncation and extra bytes',()=>{
 const expected=snapshot(artifacts.at(-1).files[0]),wire=encodeAe4(expected),first=wire.indexOf('\n');
 assert.throws(()=>decodeAe4('AE4C F 0'+wire.slice(first)),/target mismatch/);
 assert.throws(()=>decodeAe4(wire.slice(0,-1)),/truncated frame/);
 assert.throws(()=>decodeAe4(wire+'0'),/trailing data/);
});
