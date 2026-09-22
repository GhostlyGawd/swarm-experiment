/** Representational checks at typed process boundaries. Nominal labels are erased
 * by C1 transport; this module does not claim nominal provenance or linear lifetime enforcement. */
import type { Term,Ty } from '../tier1/ast.ts';
import { encodeCanonical,exactObject,identifier,validateTaggedValue,type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest } from '../fabric/identity.ts';
import { validateRuntimeSnapshot,type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';

type Declaration=Extract<Term,{kind:'FunctionDecl'}>;
type Shape={kind:'Int'|'Bool'|'Str'|'Unit'}|{kind:'Seq';element:Shape|null}|{kind:'Result';ok:Shape|null;err:Shape|null};
export interface ProcessTypeBindings {readonly format:'aether.process-type-bindings/1'}
interface BindingState {signature:string;heapId:string;manifest:string;types:Map<string,Shape>}
const bindings=new WeakMap<object,BindingState>();
const MAX_DEPTH=64,MAX_VISITS=100_000;
function signature(decl:Declaration):string{return domainDigest('aether.process-type-signature/1',{symbol:decl.symbol,typeParams:decl.typeParams,params:decl.params.map(p=>p.ty),returns:decl.returns});}
function typeSchema(ty:Ty,names:ReadonlySet<string>):void {
  encodeCanonical(ty,{maxDepth:128,maxObjects:MAX_VISITS});
  const scan=(t:Ty,depth:number):void=>{
    if(depth>MAX_DEPTH)throw new RangeError('process type depth limit');
    if(!t||typeof t!=='object')throw new TypeError('invalid process type');
    switch(t.t){
      case 'Int':case 'Bool':case 'Str':case 'Unit':exactObject(t,['t']);return;
      case 'TypeVar':exactObject(t,['t','name']);identifier(t.name);if(!names.has(t.name))throw new TypeError('undeclared process type variable');return;
      case 'IntN':exactObject(t,['t','bits','signed','overflow']);if(![8,16,32,64].includes(t.bits)||typeof t.signed!=='boolean'||!['wrap','trap','saturate'].includes(t.overflow))throw new TypeError('invalid fixed integer type');return;
      case 'Nominal':exactObject(t,['t','name','repr']);identifier(t.name);scan(t.repr,depth+1);return;
      case 'Owned':exactObject(t,['t','inner']);scan(t.inner,depth+1);return;
      case 'Seq':exactObject(t,['t','element']);scan(t.element,depth+1);return;
      case 'Result':exactObject(t,['t','ok','err']);scan(t.ok,depth+1);scan(t.err,depth+1);return;
      case 'Task':exactObject(t,['t','result']);scan(t.result,depth+1);return;
      case 'Fn':exactObject(t,['t','params','returns','capabilities']);if(!Array.isArray(t.params)||!Array.isArray(t.capabilities))throw new TypeError('invalid function type');t.params.forEach(p=>scan(p,depth+1));t.capabilities.forEach(identifier);scan(t.returns,depth+1);return;
      case 'Record':{
        exactObject(t,['t','name','fields']);identifier(t.name);if(!Array.isArray(t.fields))throw new TypeError('invalid record type');const fields=new Set<string>();
        for(const pair of t.fields){if(!Array.isArray(pair)||pair.length!==2)throw new TypeError('invalid record type field');identifier(pair[0]);if(fields.has(pair[0]))throw new TypeError('duplicate record type field');fields.add(pair[0]);scan(pair[1],depth+1);}return;
      }
      default:throw new TypeError('unsupported process type');
    }
  };
  scan(ty,0);
}
function unify(left:Shape|null,right:Shape|null,mayInfer:boolean):Shape|null {
  if(right===null)return left;
  if(left===null){if(!mayInfer)throw new TypeError('unresolved generic type cannot be inferred from a return value');return right;}
  if(left.kind!==right.kind)throw new TypeError('inconsistent generic process type');
  if(left.kind==='Seq'&&right.kind==='Seq')return {kind:'Seq',element:unify(left.element,right.element,mayInfer)};
  if(left.kind==='Result'&&right.kind==='Result')return {kind:'Result',ok:unify(left.ok,right.ok,mayInfer),err:unify(left.err,right.err,mayInfer)};
  return left;
}

class Validator {
  private readonly records:Map<string,RuntimeSnapshotV1['records'][number]>;
  private readonly epochs:Map<string,string>;
  private visits=0;
  private readonly seen=new Set<string>();
  private readonly typeIds=new Map<Ty,number>();
  private readonly borrowed=new Set<string>();
  private readonly owned=new Map<number,Set<string>>();
  private nextOwner=0;
  readonly types:Map<string,Shape>;
  readonly mayInfer:boolean;
  constructor(privateSnapshot:RuntimeSnapshotV1,types:Map<string,Shape>,mayInfer:boolean){
    this.types=types;this.mayInfer=mayInfer;
    validateRuntimeSnapshot(privateSnapshot);
    this.snapshot=privateSnapshot;this.records=new Map(privateSnapshot.records.map(r=>[r.objectId,r]));this.epochs=new Map(privateSnapshot.ownership.map(o=>[o.objectId,o.epoch]));
  }
  private readonly snapshot:RuntimeSnapshotV1;
  private budget(depth:number):void{if(depth>MAX_DEPTH||++this.visits>MAX_VISITS)throw new RangeError('process value type validation resource limit');}
  private record(value:TaggedValueV1):RuntimeSnapshotV1['records'][number]{
    if(value.tag!=='ref')throw new TypeError('process type mismatch: expected record reference');
    if(value.value.heapId!==this.snapshot.heapId||this.epochs.get(value.value.objectId)!==value.value.ownerEpoch)throw new TypeError('wrong heap or stale typed reference');
    const record=this.records.get(value.value.objectId);if(!record)throw new TypeError('missing typed record');return record;
  }
  private mark(value:TaggedValueV1,owner:number|null,depth:number,seen=new Set<string>()):void{
    this.budget(depth);
    if(value.tag==='ref'){
      const record=this.record(value);const set=owner===null?this.borrowed:this.owned.get(owner)!;set.add(record.objectId);
      if(seen.has(record.objectId))return;seen.add(record.objectId);
      for(const [,child]of record.fields)this.mark(child,owner,depth+1,seen);
    }else if(value.tag==='sequence')for(const child of value.items)this.mark(child,owner,depth+1,seen);
    else if(value.tag==='result')this.mark(value.value,owner,depth+1,seen);
    else if(value.tag==='authority')throw new TypeError('authority cannot cross a typed value boundary');
  }
  private infer(value:TaggedValueV1,depth:number):Shape {
    this.budget(depth);
    switch(value.tag){
      case 'null':return {kind:'Unit'};case 'int':return {kind:'Int'};case 'bool':return {kind:'Bool'};case 'string':return {kind:'Str'};
      case 'sequence':{let element:Shape|null=null;for(const item of value.items)element=unify(element,this.infer(item,depth+1),true);return {kind:'Seq',element};}
      case 'result':return {kind:'Result',ok:value.variant==='ok'?this.infer(value.value,depth+1):null,err:value.variant==='err'?this.infer(value.value,depth+1):null};
      case 'ref':throw new TypeError('generic record inference requires nominal type metadata not present in C1');
      case 'authority':throw new TypeError('authority cannot instantiate a generic process type');
    }
  }
  check(ty:Ty,value:TaggedValueV1,depth=0,owner:number|null=null):void{
    this.budget(depth);
    if(ty.t==='Nominal'){this.check(ty.repr,value,depth+1,owner);return;}
    if(ty.t==='Owned'){
      if(owner!==null){this.check(ty.inner,value,depth+1,owner);return;}
      const id=this.nextOwner++;this.owned.set(id,new Set());this.mark(value,id,depth+1);this.check(ty.inner,value,depth+1,id);return;
    }
    if(ty.t==='TypeVar'){
      const actual=this.infer(value,depth+1),prior=this.types.get(ty.name)??null;
      const next=unify(prior,actual,this.mayInfer)!;
      if(this.mayInfer)this.types.set(ty.name,next);
      this.mark(value,owner,depth+1);return;
    }
    switch(ty.t){
      case 'Int':if(value.tag!=='int')throw new TypeError('process type mismatch: expected Int');return;
      case 'IntN':{
        if(value.tag!=='int')throw new TypeError('process type mismatch: expected IntN');const n=BigInt(value.value),bits=BigInt(ty.bits),min=ty.signed?-(1n<<(bits-1n)):0n,max=ty.signed?(1n<<(bits-1n))-1n:(1n<<bits)-1n;
        if(n<min||n>max)throw new RangeError('process IntN argument/result outside declared range');return;
      }
      case 'Bool':if(value.tag!=='bool')throw new TypeError('process type mismatch: expected Bool');return;
      case 'Str':if(value.tag!=='string')throw new TypeError('process type mismatch: expected Str');return;
      case 'Unit':if(value.tag!=='null')throw new TypeError('process type mismatch: expected Unit');return;
      case 'Seq':if(value.tag!=='sequence')throw new TypeError('process type mismatch: expected Seq');for(const item of value.items)this.check(ty.element,item,depth+1,owner);return;
      case 'Result':if(value.tag!=='result')throw new TypeError('process type mismatch: expected Result');this.check(value.variant==='ok'?ty.ok:ty.err,value.value,depth+1,owner);return;
      case 'Fn':case 'Task':throw new TypeError('opaque function/task values cannot cross process transport');
      case 'Record':{
        const record=this.record(value);(owner===null?this.borrowed:this.owned.get(owner)!).add(record.objectId);
        let typeId=this.typeIds.get(ty);if(typeId===undefined){typeId=this.typeIds.size;this.typeIds.set(ty,typeId);}
        const key=`${record.objectId}/${typeId}/${owner??'borrowed'}`;if(this.seen.has(key))return;this.seen.add(key);
        const values=new Map(record.fields),declared=new Map(ty.fields);
        for(const [name,fieldType]of ty.fields){const field=values.get(name);if(field===undefined)throw new TypeError(`missing process record field ${name}`);this.check(fieldType,field,depth+1,owner);}
        // Extra stored fields are preserved, including cyclic bookkeeping data;
        // they must still participate in reachable ownership separation.
        for(const [name,field]of record.fields)if(!declared.has(name))this.mark(field,owner,depth+1);
        return;
      }
    }
  }
  finish():void{
    const claimed=new Set<string>();
    for(const set of this.owned.values())for(const id of set){if(this.borrowed.has(id)||claimed.has(id))throw new TypeError('Owned reachable reference regions overlap');claimed.add(id);}
  }
}

export function validateProcessArguments(decl:Declaration,args:readonly TaggedValueV1[],snapshot:RuntimeSnapshotV1):ProcessTypeBindings {
  if(!Array.isArray(args)||args.length!==decl.params.length)throw new TypeError('process argument arity mismatch');
  const names=new Set(decl.typeParams);if(names.size!==decl.typeParams.length)throw new TypeError('duplicate generic process type parameter');names.forEach(identifier);
  decl.params.forEach(p=>typeSchema(p.ty,names));typeSchema(decl.returns,names);args.forEach(v=>validateTaggedValue(v));
  const types=new Map<string,Shape>(),validator=new Validator(snapshot,types,true);
  decl.params.forEach((p,i)=>validator.check(p.ty,args[i]));validator.finish();
  const token:ProcessTypeBindings=Object.freeze({format:'aether.process-type-bindings/1'});
  bindings.set(token,{signature:signature(decl),heapId:snapshot.heapId,manifest:snapshot.executionManifest,types});return token;
}
export function validateProcessResult(decl:Declaration,value:TaggedValueV1,snapshot:RuntimeSnapshotV1,token?:ProcessTypeBindings):void {
  validateTaggedValue(value);typeSchema(decl.returns,new Set(decl.typeParams));
  const state=token?bindings.get(token):undefined;
  if(token&&!state)throw new TypeError('unknown process type bindings');
  if(state&&(state.signature!==signature(decl)||state.heapId!==snapshot.heapId||state.manifest!==snapshot.executionManifest))throw new TypeError('process result bindings subject mismatch');
  const validator=new Validator(snapshot,new Map(state?.types??[]),false);validator.check(decl.returns,value);validator.finish();
}
export function validateProcessTypedValue(ty:Ty,value:TaggedValueV1,snapshot:RuntimeSnapshotV1):void {
  typeSchema(ty,new Set());validateTaggedValue(value);const validator=new Validator(snapshot,new Map(),false);validator.check(ty,value);validator.finish();
}
export function validateProcessAllocation(ty:Ty,fields:Readonly<Record<string,TaggedValueV1>>,snapshot:RuntimeSnapshotV1):void {
  typeSchema(ty,new Set());let record=ty;while(record.t==='Owned'||record.t==='Nominal')record=record.t==='Owned'?record.inner:record.repr;
  if(record.t!=='Record')throw new TypeError('process allocation requires a record type');
  exactObject(fields,record.fields.map(([name])=>name));Object.values(fields).forEach(v=>validateTaggedValue(v));
  const validator=new Validator(snapshot,new Map(),false);
  for(const [name,fieldType]of record.fields)validator.check(fieldType,fields[name]);validator.finish();
}
