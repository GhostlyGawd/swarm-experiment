import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeAgentIrBinary,decodeAgentIrBinary,encodeAgentIrModel,decodeAgentIrModel,AGENT_IR_V2_LIMITS} from '../../src/tier1/agent-ir-v2.ts';
import {encode,decode,IrContext} from '../../src/tier1/agent-ir.ts';
import {GraphStore} from '../../src/tier1/store.ts';
import * as b from '../../src/tier1/build.ts';

test('binary DAG preserves grouped child identity, aliases, canonical scalar types and AE1 compatibility',()=>{
 const shared=b.int(-17),terms=[b.add(shared,shared),b.while_(b.bool(false),b.block(),{invariants:[b.bool(true)]}),b.while_(b.bool(false),b.block(),{variant:b.int(1)}),b.str('Unicode 😀\u0000\n'),b.int(-(10n**100n))];const store=new GraphStore();
 for(const term of terms){const bytes=encodeAgentIrBinary(term);assert.deepEqual(encodeAgentIrBinary(term),bytes);assert.equal(store.intern(decodeAgentIrBinary(bytes)),store.intern(term));assert.equal(store.intern(decodeAgentIrModel(encodeAgentIrModel(term))),store.intern(term));if(term.kind!=='Lit'||typeof term.value!=='string')assert.equal(store.intern(decode(encode(term).text)),store.intern(term));}
 assert.notDeepEqual(encodeAgentIrBinary(terms[1]),encodeAgentIrBinary(terms[2]));const back=decodeAgentIrBinary(encodeAgentIrBinary(terms[0]));assert.ok(back.kind==='Bin'&&back.left===back.right,'shared DAG children are reconstructed once');
 const send=new IrContext(),receive=new IrContext();for(const term of terms.filter(t=>t.kind!=='Lit'||typeof t.value!=='string'))assert.equal(store.intern(decode(encode(term,send).text,receive)),store.intern(term));
});
test('truncated, corrupted, trailing and noncanonical binary frames reject without any context mutation',()=>{
 const bytes=encodeAgentIrBinary(b.int(7));for(let i=0;i<bytes.length;i++)assert.throws(()=>decodeAgentIrBinary(bytes.slice(0,i)));
 const trailing=Buffer.concat([bytes,Buffer.from([0])]);assert.throws(()=>decodeAgentIrBinary(trailing),/trailing/);
 const version=Buffer.from(bytes);version[3]=51;assert.throws(()=>decodeAgentIrBinary(version),/version/);
 const varint=Buffer.concat([bytes.slice(0,6),Buffer.from([bytes[6]|128,0]),bytes.slice(7)]);assert.throws(()=>decodeAgentIrBinary(varint),/varint/);
 for(const offset of [8,16,32,bytes.length-1]){const changed=Buffer.from(bytes);changed[offset]^=1;assert.throws(()=>decodeAgentIrBinary(changed));}
 assert.throws(()=>decodeAgentIrBinary(new Uint8Array(AGENT_IR_V2_LIMITS.bytes+1)),/byte limit/);
});
test('model framing rejects stale hashes, extra data, invalid versions and malformed AST scalar inputs',()=>{
 const value=encodeAgentIrModel(b.int(7));assert.throws(()=>decodeAgentIrModel(value+'\n'),/noncanonical/);assert.throws(()=>decodeAgentIrModel(value.replace('AE2','AE3')),/version/);assert.throws(()=>decodeAgentIrModel(value.replace(/\ni7$/,'\ni8')));
 let reads=0;const node={...b.int(1)};Object.defineProperty(node,'value',{get(){reads++;return 1n},enumerable:true});assert.throws(()=>encodeAgentIrBinary(node),/accessor/);assert.equal(reads,0);
 assert.throws(()=>encodeAgentIrBinary(new Proxy(b.int(1),{})),/opaque/);assert.throws(()=>encodeAgentIrBinary({...b.int(1),unrecognized:'hidden'} as never),/unsupported/);
 assert.throws(()=>encodeAgentIrBinary(b.int(10n**4096n)),/integer limit/);
});

test('AE2 escapes dictionary delimiters and controls without reinterpreting AE1 data',()=>{
 const store=new GraphStore();for(const value of ['a|b','%41 %00 %FF','commas, semicolons; <types>','§header\r\n\t\u0000 😀']){const term=b.str(value),message=encodeAgentIrModel(term);assert.equal(message.includes('\u0000'),false);assert.equal(store.intern(decodeAgentIrModel(message)),store.intern(term));assert.equal(store.intern(decodeAgentIrBinary(encodeAgentIrBinary(term))),store.intern(term));}
 const archived='AE1\n§w 1\n§y S\n§s a%7Cb\nm0';assert.equal(store.intern(decode(archived)),store.intern(b.str('a%7Cb')),'AE1 percent text is not reinterpreted as AE2 escaping');
});
