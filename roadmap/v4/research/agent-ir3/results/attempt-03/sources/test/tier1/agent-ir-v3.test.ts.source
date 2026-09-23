import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';
import{agentIr3Snapshot,encodeAgentIr3,decodeAgentIr3,AGENT_IR3_LIMITS,type AgentIr3Format}from'../../src/tier1/agent-ir-v3.ts';
import{decodeAgentIrBinary,encodeAgentIrBinary,encodeAgentIrModel,decodeAgentIrModel}from'../../src/tier1/agent-ir-v2.ts';import{encode,decode}from'../../src/tier1/agent-ir.ts';import{LINK_SCHEMA,walk,type Term}from'../../src/tier1/ast.ts';import{SymbolSpace}from'../../src/tier1/symbols.ts';import*as b from'../../src/tier1/build.ts';
const artifacts=JSON.parse(readFileSync(new URL('../../roadmap/v4/research/projections/results/campaign-11-generics/artifacts.json',import.meta.url),'utf8'));
const states=(row:typeof artifacts[number])=>row.files.map((file:{binary:string;dependencyModules?:{binary:string}[]})=>agentIr3Snapshot([file,...file.dependencyModules??[]].map(f=>decodeAgentIrBinary(Buffer.from(f.binary,'base64')))));
const decimal=(hex:string)=>BigInt('0x'+hex).toString();
test('AE3 preserves the exact full V7 corpus and every AST kind in both opcode profiles',()=>{
 const kinds=new Set<string>();let roots=0;
 for(const row of artifacts){const snapshots=states(row);for(const format of ['AE3','AE3C','auto'] as const){let previous;for(const state of snapshots){state.roots.forEach((r:Term)=>{for(const n of walk(r))kinds.add(n.kind);});const message=encodeAgentIr3(state,previous,format),decoded=decodeAgentIr3(message,previous);assert.deepEqual(decoded.rootRefs,state.rootRefs);assert.equal(decoded.digest,state.digest);previous=decoded;roots+=state.roots.length;}}}
 const symbols=new SymbolSpace('ir3-kinds'),i=symbols.define('i');const extra=[b.cond(b.bool(true),b.int(1),b.int(2)),b.forall(i,b.int(0),b.int(3),b.ge(b.v(i),b.int(0))),b.yield_(),b.surface({symbol:i,domain:{d:'choice',options:[]},current:'',objective:'minimize_cost'})];
 for(const root of extra){for(const n of walk(root))kinds.add(n.kind);const state=agentIr3Snapshot([root]);for(const format of ['AE3','AE3C'] as AgentIr3Format[])assert.deepEqual(decodeAgentIr3(encodeAgentIr3(state,undefined,format)).rootRefs,state.rootRefs);}
 assert.equal(kinds.size,Object.keys(LINK_SCHEMA).length);assert.equal(roots,117);
});
test('reserved atoms, Unicode, leading-zero opaque IDs and AE1/AE2 archives retain identity',()=>{
 const roots=[...['s0','a0','s00','a1294','%73 %25 s1','x|y,;<>\u0000\n\u2028\u2029😀','sym:'+'a'.repeat(22),'ast:b3:'+'0'.repeat(64)].map(b.str),b.int(-(10n**4095n)),b.import_(('ast:b3:'+'0'.repeat(64)) as never,[('sym:'+'a'.repeat(22)) as never])],snapshot=agentIr3Snapshot(roots);
 for(const format of ['AE3','AE3C'] as AgentIr3Format[]){const message=encodeAgentIr3(snapshot,undefined,format);assert.deepEqual(decodeAgentIr3(message).rootRefs,snapshot.rootRefs);}
 for(const root of roots){assert.deepEqual(encodeAgentIrBinary(decodeAgentIrModel(encodeAgentIrModel(root))),encodeAgentIrBinary(root));}assert.deepEqual(decode(encode(b.str('a%7Cb')).text),b.str('a%7Cb'));
});
test('edits preserve grouped links, paired labels, optional slots and the immutable base',()=>{
 const base=states(artifacts.find((r:{id:string})=>r.id==='full-ledger'))[0],next=states(artifacts.find((r:{id:string})=>r.id==='full-ledger'))[1],original=encodeAgentIr3(base),delta=encodeAgentIr3(next,base);assert.match(delta,/^AE3C? D /);assert.equal(Object.isFrozen(base),true);assert.equal(Object.isFrozen(base.roots[0]),true);assert.equal(Reflect.set(base.roots[0],'kind','Lit'),false);assert.deepEqual(decodeAgentIr3(delta,base).rootRefs,next.rootRefs);assert.equal(encodeAgentIr3(base),original);
 const a=agentIr3Snapshot([b.while_(b.bool(false),b.block(),{invariants:[b.bool(true)]}),b.record({t:'Record',name:'type:ir3:record' as never,fields:[['left',b.Int]]},{left:b.int(1)})]);
 const z=agentIr3Snapshot([b.while_(b.bool(false),b.block(),{variant:b.int(0)}),b.record({t:'Record',name:'type:ir3:record' as never,fields:[['right',b.Int]]},{right:b.int(2)})]);assert.deepEqual(decodeAgentIr3(encodeAgentIr3(z,a),a).rootRefs,z.rootRefs);assert.deepEqual(decodeAgentIr3(encodeAgentIr3(base)).rootRefs,base.rootRefs);
});
test('truncation, stale bases, redundant edits, false roots and hostile field counts fail without changing state',()=>{
 const[base,next,third]=states(artifacts[0]),delta=encodeAgentIr3(next,base),saved=encodeAgentIr3(base);
 for(let i=0;i<delta.length;i++)assert.throws(()=>decodeAgentIr3(delta.slice(0,i),base));assert.throws(()=>decodeAgentIr3(delta,third),/stale base/);assert.throws(()=>decodeAgentIr3(delta),/validated snapshot/);assert.throws(()=>encodeAgentIr3({...base}),/validated snapshot/);assert.throws(()=>decodeAgentIr3(delta+'x',base),/trailing/);
 const lines=delta.split('\n');lines[2]='0 200000';assert.throws(()=>decodeAgentIr3(lines.join('\n'),base),/patch path/);
 const doubled=encodeAgentIr3(agentIr3Snapshot([base.roots[0],base.roots[0]]),undefined,'AE3'),redundant=`AE3 D ${decimal(base.digest)} ${decimal(base.digest)}\n2\n0 -\n0 -\n`+doubled.slice(doubled.indexOf('\n')+1);assert.throws(()=>decodeAgentIr3(redundant,base),/noncanonical/);
 const raw=(payload:string)=>`AE3 F ${decimal(base.digest)}\n0 - 0 -\n1\n${Buffer.byteLength(payload)}:${payload}`;
 assert.throws(()=>decodeAgentIr3(raw('AE1\n§w 9\nu')),/width/);assert.throws(()=>decodeAgentIr3(raw('AE1\n§w 2\nG'+'zz'.repeat(1000))),/field work/);assert.throws(()=>decodeAgentIr3(raw('AE1\n§w 1\n§y '+'A<'.repeat(66)+'I'+'>'.repeat(66)+'\nu')),/depth/);assert.throws(()=>decodeAgentIr3(raw('AE1\n§w 1\n§n x\n§y R0<\nu')),/type/);assert.throws(()=>decodeAgentIr3(raw('AE1\n§w 1\nu')),/target mismatch/);assert.equal(encodeAgentIr3(base),saved);
});
test('large edit sets fall back to a complete message without dropping changes',()=>{const grid=(n:number)=>b.block(...Array.from({length:35},()=>b.block(...Array.from({length:35},()=>b.int(n))))),base=agentIr3Snapshot([grid(0)]),next=agentIr3Snapshot([grid(1)]),wire=encodeAgentIr3(next,base);assert.match(wire,/^AE3C? F /);assert.deepEqual(decodeAgentIr3(wire,base).rootRefs,next.rootRefs);});

test('snapshot input rejects getters, proxies, dropped fields and oversized inputs before using them',()=>{
 let touched=0;const roots=[b.int(1)];Object.defineProperty(roots,'0',{get(){touched++;return b.int(1);}});assert.throws(()=>agentIr3Snapshot(roots),/accessor/);assert.equal(touched,0);assert.throws(()=>agentIr3Snapshot(new Proxy([b.int(1)],{get(){touched++;return null;}})),/plain dense/);assert.equal(touched,0);assert.throws(()=>agentIr3Snapshot(Object.assign([b.int(1)],{extra:true})),/plain dense/);assert.throws(()=>agentIr3Snapshot([{...b.int(1),hidden:'code'} as unknown as Term]),/unsupported/);assert.throws(()=>agentIr3Snapshot(Array.from({length:65},()=>b.unit())),/root count/);assert.throws(()=>decodeAgentIr3('x'.repeat(AGENT_IR3_LIMITS.bytes+1)),/message bound/);
});
