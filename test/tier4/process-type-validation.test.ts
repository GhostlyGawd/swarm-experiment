import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import type {Ty,Term} from '../../src/tier1/ast.ts';
import {typeName} from '../../src/tier1/ids.ts';
import {SymbolSpace} from '../../src/tier1/symbols.ts';
import {domainDigest} from '../../src/fabric/identity.ts';
import type {TaggedValueV1} from '../../src/fabric/encoding.ts';
import type {RuntimeSnapshotV1} from '../../src/fabric/snapshot.ts';
import {validateProcessArguments,validateProcessResult,validateProcessAllocation,validateProcessTypedValue} from '../../src/tier4/process-type-validation.ts';

const int=(value:number|bigint):TaggedValueV1=>({tag:'int',value:String(value)});
const str=(value:string):TaggedValueV1=>({tag:'string',value});
const seq=(...items:TaggedValueV1[]):TaggedValueV1=>({tag:'sequence',items});
const ref=(objectId:string):TaggedValueV1=>({tag:'ref',value:{heapId:'heap:typed',objectId,ownerEpoch:'1'}});
const box:Ty={t:'Record',name:typeName('type:test:box'),fields:[['count',b.Int]]};
const snapshot=():RuntimeSnapshotV1=>({format:'aether.state/1',executionManifest:domainDigest('aether.execution/1','types'),heapId:'heap:typed',nextObjectId:'4',eventCursor:'0',records:[
  {objectId:'1',fields:[['count',int(1)]]},{objectId:'2',fields:[['count',int(2)]]},
  {objectId:'3',fields:[['count',int(3)],['hiddenAlias',ref('1')],['self',ref('3')]]},
],ownership:['1','2','3'].map(objectId=>({objectId,unit:'worker',epoch:'1'}))});
function declaration(params:Ty[],returns:Ty,typeParams:string[]=[]):Extract<Term,{kind:'FunctionDecl'}>{
  const symbols=new SymbolSpace('typed-process');return b.fn({symbol:symbols.define('identity'),params:params.map((ty,i)=>b.param(symbols.define(`x${i}`),ty)),returns,typeParams,contract:b.contract({}),body:b.block(b.ret(b.unit()))}) as Extract<Term,{kind:'FunctionDecl'}>;
}

test('typed process boundary enforces primitive values, exact arity and return type',()=>{
  const s=snapshot(),decl=declaration([b.Int],b.Int),bound=validateProcessArguments(decl,[int(4)],s);
  validateProcessResult(decl,int(4),s,bound);
  assert.throws(()=>validateProcessArguments(decl,[str('bad')],s),/expected Int/);
  assert.throws(()=>validateProcessArguments(decl,[],s),/arity/);
  assert.throws(()=>validateProcessArguments(decl,[int(4),int(5)],s),/arity/);
  assert.throws(()=>validateProcessResult(decl,str('bad'),s,bound),/expected Int/);
  for(const [ty,value]of [[b.Bool,{tag:'bool',value:true}],[b.Str,str('text')],[b.Unit,{tag:'null'}]] as [Ty,TaggedValueV1][])validateProcessTypedValue(ty,value,s);
});

test('typed process boundary checks all IntN ranges and nominal representations without coercion',()=>{
  const s=snapshot();
  for(const bits of [8,16,32,64]as const)for(const signed of [false,true]){
    const ty:Ty={t:'IntN',bits,signed,overflow:'wrap'},lo=signed?-(1n<<BigInt(bits-1)):0n,hi=signed?(1n<<BigInt(bits-1))-1n:(1n<<BigInt(bits))-1n;
    validateProcessTypedValue(ty,int(lo),s);validateProcessTypedValue(ty,int(hi),s);
    assert.throws(()=>validateProcessTypedValue(ty,int(lo-1n),s),/range/);assert.throws(()=>validateProcessTypedValue(ty,int(hi+1n),s),/range/);
  }
  const money:Ty={t:'Nominal',name:typeName('type:money:cents'),repr:b.Int};validateProcessTypedValue(money,int(10),s);assert.throws(()=>validateProcessTypedValue(money,str('10'),s),/expected Int/);
});

test('typed process records validate required fields and preserve bounded cyclic/extra data',()=>{
  const s=snapshot(),before=JSON.stringify(s);validateProcessTypedValue(box,ref('3'),s);assert.equal(JSON.stringify(s),before);
  const missing={...s,records:s.records.map(r=>r.objectId==='1'?{...r,fields:[]}:r)};
  assert.throws(()=>validateProcessTypedValue(box,ref('1'),missing),/missing process record field/);
  const wrong={...s,records:s.records.map(r=>r.objectId==='1'?{...r,fields:[['count',str('wrong')]] as const}:r)};
  assert.throws(()=>validateProcessTypedValue(box,ref('1'),wrong),/expected Int/);
  assert.throws(()=>validateProcessTypedValue(box,{tag:'ref',value:{heapId:'another',objectId:'1',ownerEpoch:'1'}},s),/heap/);
  assert.throws(()=>validateProcessTypedValue(box,{tag:'ref',value:{heapId:s.heapId,objectId:'1',ownerEpoch:'2'}},s),/stale/);
});

test('typed allocation rejects missing/extra fields, inherited keys and wrong field values',()=>{
  const s=snapshot();validateProcessAllocation(box,{count:int(1)},s);
  assert.throws(()=>validateProcessAllocation(box,{count:str('wrong')},s),/expected Int/);
  assert.throws(()=>validateProcessAllocation(box,{},s),/fields/);
  assert.throws(()=>validateProcessAllocation(box,{count:int(1),extra:int(2)},s),/fields/);
  assert.throws(()=>validateProcessAllocation(box,Object.create({count:int(1)}),s),/plain object/);
  const special:Ty={t:'Record',name:typeName('type:test:special'),fields:[['__proto__',b.Int]]};
  validateProcessAllocation(special,Object.fromEntries([['__proto__',int(4)]]),s);
});

test('scalar and sequence type variables infer consistently and constrain returned values',()=>{
  const s=snapshot(),T:Ty={t:'TypeVar',name:'T'},identity=declaration([T],T,['T']);
  const integers=validateProcessArguments(identity,[int(7)],s);validateProcessResult(identity,int(8),s,integers);assert.throws(()=>validateProcessResult(identity,str('bad'),s,integers),/inconsistent generic/);
  const pair=declaration([T,T],T,['T']);assert.throws(()=>validateProcessArguments(pair,[int(1),str('mixed')],s),/inconsistent generic/);
  const sequences=declaration([{t:'Seq',element:T}],{t:'Seq',element:T},['T']);
  const bound=validateProcessArguments(sequences,[seq(int(1),int(2))],s);validateProcessResult(sequences,seq(int(4)),s,bound);
  assert.throws(()=>validateProcessResult(sequences,seq(str('bad')),s,bound),/inconsistent generic/);
  assert.throws(()=>validateProcessArguments(identity,[seq(int(1),str('mixed'))],s),/inconsistent generic/);
  const arrays=validateProcessArguments(identity,[seq()],s);validateProcessResult(identity,seq(),s,arrays);
  assert.throws(()=>validateProcessResult(identity,seq(int(1)),s,arrays),/unresolved generic/);
  const refined=validateProcessArguments(pair,[seq(),seq(int(2))],s);validateProcessResult(pair,seq(int(3)),s,refined);
  assert.throws(()=>validateProcessResult(identity,int(1),s,{...integers}),/unknown process type bindings/);
  assert.throws(()=>validateProcessArguments(identity,[ref('1')],s),/generic record inference/);
});

test('Result active variants and nested generic fields preserve independent bindings',()=>{
  const s=snapshot(),T:Ty={t:'TypeVar',name:'T'},resultTy:Ty={t:'Result',ok:T,err:b.Str};
  const decl=declaration([resultTy],resultTy,['T']);const bound=validateProcessArguments(decl,[{tag:'result',variant:'ok',value:int(1)}],s);
  validateProcessResult(decl,{tag:'result',variant:'err',value:str('error')},s,bound);
  assert.throws(()=>validateProcessResult(decl,{tag:'result',variant:'ok',value:str('bad')},s,bound),/generic/);
  const genericBox:Ty={...box,fields:[['count',T]]};const boxDecl=declaration([genericBox],T,['T']);
  const fields=validateProcessArguments(boxDecl,[ref('1')],s);validateProcessResult(boxDecl,int(3),s,fields);assert.throws(()=>validateProcessResult(boxDecl,str('wrong'),s,fields),/generic/);
});

test('Owned requires separation of reachable graphs, including hidden aliases and sequences',()=>{
  const s=snapshot(),owned:Ty={t:'Owned',inner:box};
  const decl=declaration([owned,box],b.Unit);validateProcessArguments(decl,[ref('1'),ref('2')],s);
  assert.throws(()=>validateProcessArguments(decl,[ref('1'),ref('1')],s),/Owned.*overlap/);
  assert.throws(()=>validateProcessArguments(decl,[ref('1'),ref('3')],s),/Owned.*overlap/);
  const both=declaration([owned,owned],b.Unit);assert.throws(()=>validateProcessArguments(both,[ref('1'),ref('3')],s),/Owned.*overlap/);
  const many=declaration([{t:'Seq',element:owned}],b.Unit);validateProcessArguments(many,[seq(ref('1'),ref('2'))],s);
  assert.throws(()=>validateProcessArguments(many,[seq(ref('1'),ref('1'))],s),/Owned.*overlap/);
  const resultDecl=declaration([],{t:'Seq',element:owned});const token=validateProcessArguments(resultDecl,[],s);
  assert.throws(()=>validateProcessResult(resultDecl,seq(ref('1'),ref('1')),s,token),/Owned.*overlap/);
});

test('unsupported opaque values and excessive type nesting fail explicitly',()=>{
  const s=snapshot();
  for(const ty of [{t:'Task',result:b.Int},{t:'Fn',params:[],returns:b.Int,capabilities:[]}]as Ty[])assert.throws(()=>validateProcessTypedValue(ty,{tag:'null'},s),/opaque/);
  let nested:Ty=b.Int;for(let i=0;i<70;i++)nested={t:'Owned',inner:nested};
  assert.throws(()=>validateProcessTypedValue(nested,int(1),s),/depth/);
});
