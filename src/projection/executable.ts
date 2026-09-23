import {hasTypeVariables,moduleFunctions,instantiateReturn} from './executable-generic-plan.ts';
import {GraphStore} from '../tier1/store.ts';
import { linkExecutableModule, nativeModuleName, nativeSymbolName, type ExecutableProjectionOptions } from './executable-link.ts';
import type { NodeRef } from '../tier1/ids.ts';
export type { ExecutableProjectionOptions } from './executable-link.ts';
import { continuationType } from './executable-continuation-plan.ts';
/** Explicit scalar projection profile. The visible host bodies, clauses and
 * control flow are parsed; metadata contains no expression or statement tree. */
import { linkGroups, walk, scalarPayload, type Term, type Ty, type BinOp, type NodeKind } from '../tier1/ast.ts';
import { SymbolSpace } from '../tier1/symbols.ts';
import type { SymbolId } from '../tier1/ids.ts';
import { encodeStored, decodeStored } from '../tier1/persistence.ts';
import { encodeAgentIrBinary } from '../tier1/agent-ir-v2.ts';
import { typecheck, underlying } from '../tier2/typecheck.ts';
import { CapabilityRegistry } from '../tier2/ocap.ts';
import { exactObject, validString } from '../fabric/encoding.ts';
import { executableRuntime, type ExecutableTarget } from './executable-runtime.ts';
export { executableRuntime, RUST_PROJECTION_CARGO, type ExecutableTarget } from './executable-runtime.ts';
const KINDS: readonly NodeKind[] = Object.freeze(['Module','SymbolTable','TypeDecl','FunctionDecl','Contract','Clause','Surface','Lit','Var','Bin','Un','Cond','Call','Invoke','Old','ResultRef','Place','Let','Assign','If','While','Return','Assert','ExprStmt','Block','Yield','IntCast','FixedBin','ForAll']);
export const EXECUTABLE_PROJECTION_PROFILE = Object.freeze({ format:'aether.executable-projection/2', semantics:'aether-reference-scalar/1', kinds:KINDS, types:['Int','Bool','Str','Unit','IntN','Nominal','Owned'], integerSemantics:'arbitrary-precision-truncate-toward-zero', runtimeContracts:'requires-ensures-assert; loop annotations retained', maxSourceBytes:2*1024*1024, maxNodes:4096 });
const COMPOSITE_KINDS:readonly NodeKind[]=Object.freeze([...KINDS,'Field','RecordLit','SeqLit','SeqIndex','SeqLength','SeqMap','SeqFold','ResultValue','MatchResult']);
export const COMPOSITE_PROJECTION_PROFILE=Object.freeze({...EXECUTABLE_PROJECTION_PROFILE,format:'aether.executable-projection/3',semantics:'aether-reference-composites/1',kinds:COMPOSITE_KINDS,types:[...EXECUTABLE_PROJECTION_PROFILE.types,'Record','Seq','Result']});
const CONTINUATION_KINDS:readonly NodeKind[]=Object.freeze([...COMPOSITE_KINDS,'Lambda','Apply','Spawn','Await']);
export const CONTINUATION_PROJECTION_PROFILE=Object.freeze({...COMPOSITE_PROJECTION_PROFILE,format:'aether.executable-projection/4',semantics:'aether-reference-continuations/1',kinds:CONTINUATION_KINDS,types:[...COMPOSITE_PROJECTION_PROFILE.types,'Fn','Task']});
const ATOMIC_KINDS:readonly NodeKind[]=Object.freeze([...CONTINUATION_KINDS,'Atomic']);
export const ATOMIC_PROJECTION_PROFILE=Object.freeze({...CONTINUATION_PROJECTION_PROFILE,format:'aether.executable-projection/5',semantics:'aether-reference-atomic/1',kinds:ATOMIC_KINDS,atomicSemantics:'rollback-fault-preserve-return; external effects and completed task caches persist'});
const LINKED_KINDS:readonly NodeKind[]=Object.freeze([...ATOMIC_KINDS,'Import','StringOp']);
export const LINKED_PROJECTION_PROFILE=Object.freeze({...ATOMIC_PROJECTION_PROFILE,format:'aether.executable-projection/6',semantics:'aether-reference-unicode17-imports/1',kinds:LINKED_KINDS,unicode:'17.0',maxModules:64});
export const GENERIC_PROJECTION_PROFILE=Object.freeze({...LINKED_PROJECTION_PROFILE,format:'aether.executable-projection/7',semantics:'aether-reference-generics-nested/1',types:[...LINKED_PROJECTION_PROFILE.types,'TypeVar'],maxNestedModules:32,maxWitnessBytes:65536});
export const NESTED_IMPORT_PROJECTION_PROFILE=Object.freeze({...GENERIC_PROJECTION_PROFILE,format:'aether.executable-projection/8',semantics:'aether-reference-nested-imports/1'});
interface CaptureBinding{symbol:SymbolId;ty:Ty;expression:string}
interface Header {format:'aether.executable-projection/2'|'aether.executable-projection/3'|'aether.executable-projection/4'|'aether.executable-projection/5'|'aether.executable-projection/6'|'aether.executable-projection/7'|'aether.executable-projection/8';link?:{role:'entry'|'dependency';dependencies:NodeRef[]};target:ExecutableTarget;module:Record<string,unknown>;symbols:Extract<Term,{kind:'SymbolTable'}>;aliases:[SymbolId,string][]}
const genericHeader=(header:Header):boolean=>header.format.endsWith('/7')||header.format.endsWith('/8');
const meta=(v:unknown)=>encodeStored(v).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029'), parseMeta=<T>(v:string)=>decodeStored<T>(v);
function q(value:string,target?:ExecutableTarget,linked=false):string {
  if(target!=='rust')return JSON.stringify(value).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  let out='"';for(const c of value){if(c==='"')out+='\\"';else if(c==='\\')out+='\\\\';else if(c==='\n')out+='\\n';else if(c==='\r')out+='\\r';else if(c==='\t')out+='\\t';else if(c.codePointAt(0)!<32||c.codePointAt(0)===127||c.codePointAt(0)===0x2028||c.codePointAt(0)===0x2029||linked&&((c.codePointAt(0)!>=0x202a&&c.codePointAt(0)!<=0x202e)||(c.codePointAt(0)!>=0x2066&&c.codePointAt(0)!<=0x2069)))out+='\\u{'+c.codePointAt(0)!.toString(16)+'}';else out+=c;}return out+'"';
}
function readQuoted(token:string):string {
  if(token[0]!=='"'||token.at(-1)!=='"')throw new SyntaxError('invalid quoted source');let out='';
  for(let i=1;i<token.length-1;i++){const c=token[i];if(c!=='\\'){if(c==='\n'||c==='\r')throw new SyntaxError('multiline quoted source');out+=c;continue;}const next=token[++i];const simple:Record<string,string>={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f','0':'\0','"':'"','\\':'\\','/':'/'};if(Object.hasOwn(simple,next)){out+=simple[next];continue;}if(next!=='u')throw new SyntaxError('unknown string escape');if(token[i+1]==='{'){const end=token.indexOf('}',i+2),hex=token.slice(i+2,end);if(end<0||! /^[0-9a-fA-F]{1,6}$/.test(hex)||parseInt(hex,16)>0x10ffff)throw new SyntaxError('invalid Unicode escape');out+=String.fromCodePoint(parseInt(hex,16));i=end;}else{const hex=token.slice(i+1,i+5);if(!/^[0-9a-fA-F]{4}$/.test(hex))throw new SyntaxError('invalid Unicode escape');out+=String.fromCharCode(parseInt(hex,16));i+=4;}}
  validString(out);return out;
}

const comment=(target:ExecutableTarget)=>target==='python'?'#':'//';
function scalarType(ty:Ty,composite=false,execution=false,generic=false):void {if(generic&&ty.t==='TypeVar')return;if(execution&&ty.t==='Fn'){ty.params.forEach(t=>scalarType(t,true,true,generic));scalarType(ty.returns,true,true,generic);return;}if(execution&&ty.t==='Task')return scalarType(ty.result,true,true,generic);if(composite&&ty.t==='Record'){ty.fields.forEach(([,t])=>scalarType(t,true,execution,generic));return;}if(composite&&ty.t==='Seq')return scalarType(ty.element,true,execution,generic);if(composite&&ty.t==='Result'){scalarType(ty.ok,true,execution,generic);scalarType(ty.err,true,execution,generic);return;}if(ty.t==='Nominal')return scalarType(ty.repr,composite,execution,generic);if(ty.t==='Owned')return scalarType(ty.inner,composite,execution,generic);if(!['Int','Bool','Str','Unit','IntN'].includes(ty.t))throw new TypeError(`unsupported ${composite?'composite':'scalar'} projection type ${ty.t}`);if(ty.t==='IntN'&&(![8,16,32,64].includes(ty.bits)||!['wrap','trap','saturate'].includes(ty.overflow)))throw new TypeError('invalid fixed integer type');}
function validate(module:Term,composite=false,execution=false,atomic=false,linked=false,options:ExecutableProjectionOptions={},generic=false,nestedImports=false):asserts module is Extract<Term,{kind:'Module'}>{
  encodeAgentIrBinary(module);
  if(module.kind!=='Module'||module.symbolTable.kind!=='SymbolTable'||module.members.some(m=>!(generic?['FunctionDecl','TypeDecl','Import','Module']:linked?['FunctionDecl','TypeDecl','Import']:['FunctionDecl','TypeDecl']).includes(m.kind)))throw new TypeError('scalar projection requires a module of function/type declarations');
  const allowedImports=new Set<Term>();
  const collectImports=(owner:Extract<Term,{kind:'Module'}>,depth:number):void=>{for(const member of owner.members){if(member.kind==='Import'){if(depth===0||nestedImports)allowedImports.add(member);}else if(member.kind==='Module')collectImports(member,depth+1);}};
  collectImports(module,0);
  if(nestedImports&&(!generic||!linked))throw new TypeError('V8 profile requires linked generic module closure');
  const arities=new Map<string,number>();let count=0;
  for(const node of walk(module)){
    if(++count>EXECUTABLE_PROJECTION_PROFILE.maxNodes)throw new RangeError('projection node bound');if(!(linked?LINKED_KINDS:atomic?ATOMIC_KINDS:execution?CONTINUATION_KINDS:composite?COMPOSITE_KINDS:KINDS).includes(node.kind))throw new TypeError(`unsupported ${composite?'composite':'scalar'} projection node ${node.kind}`);
    for(const group of linkGroups(node))for(const child of group.links)if(!composite&&child.kind==='Place'&&!((node.kind==='Assign'&&group.field==='target')||(node.kind==='Contract'&&group.field==='modifies')))throw new TypeError('scalar Place is supported only as assignment target or modifies metadata');
    if(node.kind==='Import'&&!allowedImports.has(node))throw new TypeError('Import is supported only as a module declaration');
    if(node.kind==='Old'&&[...walk(node.expr)].some(n=>n.kind==='ForAll'||n.kind==='MatchResult'))throw new TypeError('old expressions with nested binders require a later projection profile');
    if(node.kind==='Lit'){scalarType(node.ty,composite,execution,generic);let ty=node.ty;while(ty.t==='Nominal'||ty.t==='Owned')ty=ty.t==='Nominal'?ty.repr:ty.inner;const valid=ty.t==='Int'||ty.t==='IntN'?typeof node.value==='bigint':ty.t==='Bool'?typeof node.value==='boolean':ty.t==='Str'?typeof node.value==='string':ty.t==='Unit'&&node.value===null;if(!valid)throw new TypeError('invalid executable literal representation');if(ty.t==='IntN'){const value=node.value as bigint,width=1n<<BigInt(ty.bits),min=ty.signed?-(width/2n):0n,max=ty.signed?width/2n-1n:width-1n;if(value<min||value>max)throw new TypeError('fixed literal outside range');}}
    if('ty'in node)scalarType(node.ty,composite,execution,generic);if('returns'in node)scalarType(node.returns,composite,execution,generic);if('params'in node)node.params.forEach(p=>scalarType(p.ty,composite,execution,generic));
    if(!composite&&(node.kind==='Place'&&node.path.length||node.kind==='Assign'&&(node.target.kind!=='Place'||node.target.path.length)))throw new TypeError('scalar projection supports local assignment only');
    if(!generic&&node.kind==='FunctionDecl'&&node.typeParams.length)throw new TypeError('generic projections require a later profile');
    if(node.kind==='Invoke'){const previous=arities.get(node.capability);if(previous!==undefined&&previous!==node.args.length)throw new TypeError('inconsistent effect arity');arities.set(node.capability,node.args.length);}
  }
  for(const fn of moduleFunctions(module)){if(fn.kind!=='FunctionDecl')continue;if(fn.body===null)throw new TypeError('scalar executable profile requires synthesized bodies');const bound=new Set<string>();const bind=(s:string)=>{if(bound.has(s))throw new TypeError('scalar profile requires distinct binder identities within each function');bound.add(s);};fn.params.forEach(p=>bind(p.symbol));fn.surfaces.forEach(s=>{if(s.kind!=='Surface')throw new TypeError('invalid surface');bind(s.symbol);});if(fn.body)for(const n of walk(fn.body))if(n.kind==='Let')bind(n.symbol);if(fn.contract)for(const n of walk(fn.contract))if(['Invoke','Call','SeqMap','SeqFold','Lambda','Apply','Spawn','Await'].includes(n.kind))throw new TypeError('scalar contract profile excludes effectful or indirect calls');}
  const effective=linked?linkExecutableModule(module,options).linked:module;
  if(generic){
   const depth=(node:Term,n=0):void=>{if(node.kind!=='Module')return;if(n>32)throw new RangeError('nested module depth bound');node.members.forEach(child=>depth(child,n+1));};depth(module);
   const variables=(v:unknown,out=new Set<string>()):Set<string>=>{if(v&&typeof v==='object'){if((v as Ty).t==='TypeVar')out.add((v as Extract<Ty,{t:'TypeVar'}>).name);else Object.values(v).forEach(x=>variables(x,out));}return out;};
   for(const n of walk(module)){if(n.kind==='Module'&&(n.symbolTable.kind!=='SymbolTable'||n.members.some(m=>!['Module','FunctionDecl','TypeDecl','Import'].includes(m.kind))))throw new TypeError('unsupported nested module member');if(!nestedImports&&n.kind==='Module'&&n!==module&&n.members.some(m=>m.kind==='Import'))throw new TypeError('nested Import requires a later profile');if(n.kind==='TypeDecl'&&hasTypeVariables(n.ty))throw new TypeError('free type variable in TypeDecl');}
   for(const fn of moduleFunctions(module)){if(new Set(fn.typeParams).size!==fn.typeParams.length||fn.typeParams.some(t=>!t.length))throw new TypeError('invalid generic parameters');const used=variables(fn);if([...used].some(t=>!fn.typeParams.includes(t)))throw new TypeError('undeclared generic type variable');const argumentsVars=variables(fn.params);if(fn.typeParams.some(t=>!argumentsVars.has(t)))throw new TypeError('generic type parameter must be inferable from arguments');}
   const ids=new Set<string>();for(const fn of moduleFunctions(effective)){if(ids.has(fn.symbol))throw new TypeError('duplicate nested function identity');ids.add(fn.symbol);}
  }
  if(atomic)for(const n of walk(module))if(n.kind==='Atomic'&&n.body.kind==='Let')throw new TypeError('atomic bindings require an explicit Block');

  const declared=new Set(moduleFunctions(effective).map(n=>n.symbol));for(const n of walk(module)){if((n.kind==='Call'||n.kind==='SeqMap'||n.kind==='SeqFold')&&!declared.has(n.callee))throw new TypeError('direct calls require a declared function; use Apply for closure values');if((n.kind==='If'&&(n.then.kind==='Let'||n.otherwise?.kind==='Let'))||(n.kind==='While'&&n.body.kind==='Let'))throw new TypeError('conditional bindings require an explicit Block');}
  for(const n of walk(effective))if(n.kind==='Invoke'){const prior=arities.get(n.capability);if(prior!==undefined&&prior!==n.args.length)throw new TypeError('inconsistent effect arity');arities.set(n.capability,n.args.length);}
  const registry=new CapabilityRegistry();for(const[cap,arity]of arities)registry.declare(cap as never,{arity,description:'explicit projected effect'});
  const checked=typecheck(effective,{registry});if(!checked.ok)throw new TypeError(`projection typecheck failed: ${checked.diagnostics.map(d=>d.code+': '+d.message).join(',')}`);
}
function headerFor(module:Extract<Term,{kind:'Module'}>,symbols:SymbolSpace,target:ExecutableTarget,composite=false,execution=false,atomic=false,linked=false,options:ExecutableProjectionOptions={},role:'entry'|'dependency'='entry',generic=false,nestedImports=false):Header{
  const closure=linked?linkExecutableModule(module,options):null;const ids=new Set<SymbolId>();for(const node of walk(closure?.linked??module)){if('symbol'in node)ids.add(node.symbol);if('callee'in node)ids.add(node.callee);if('params'in node)node.params.forEach(p=>ids.add(p.symbol));if(node.kind==='MatchResult'){ids.add(node.okSymbol);ids.add(node.errSymbol);}}
  const table=module.symbolTable as Extract<Term,{kind:'SymbolTable'}>;table.entries.forEach(([s])=>ids.add(s));
  return{...(linked?{link:{role,dependencies:closure!.dependencies}}:{}),format:nestedImports?'aether.executable-projection/8':generic?'aether.executable-projection/7':linked?'aether.executable-projection/6':atomic?'aether.executable-projection/5':execution?'aether.executable-projection/4':composite?'aether.executable-projection/3':EXECUTABLE_PROJECTION_PROFILE.format,target,module:{...scalarPayload(module)},symbols:table,aliases:[...ids].sort().map((id,i)=>[id,linked?nativeSymbolName(module,id):`v_${symbols.nameOf(id).replace(/[^a-zA-Z0-9_]/g,'_').slice(0,40)}_${i}`])};
}
class Emitter {
  readonly lines:string[]=[];readonly names:Map<string,string>;readonly target:ExecutableTarget;readonly marker:string;readonly composite:boolean;readonly execution:boolean;readonly atomic:boolean;readonly linked:boolean;readonly generic:boolean;typeDeclaration=0;readonly functions:Map<SymbolId,Extract<Term,{kind:'FunctionDecl'}>>;scopes:CaptureBinding[][]=[];resultType:Ty={t:'Unit'};genericFunction=false;
  constructor(readonlyHeader:Header,module:Extract<Term,{kind:'Module'}>,options:ExecutableProjectionOptions={}){this.generic=genericHeader(readonlyHeader);this.linked=this.generic||readonlyHeader.format.endsWith('/6');this.atomic=this.linked||readonlyHeader.format.endsWith('/5');this.execution=this.atomic||readonlyHeader.format.endsWith('/4');this.composite=!readonlyHeader.format.endsWith('/2');this.functions=new Map(moduleFunctions(this.linked?linkExecutableModule(module,options).linked:module).map(n=>[n.symbol,n]));this.names=new Map(readonlyHeader.aliases);this.target=readonlyHeader.target;this.marker=comment(this.target);}
  name(s:string):string{const name=this.names.get(s);if(!name)throw new TypeError('missing native symbol alias');return name;}
  line(text:string,depth=0):void{this.lines.push('    '.repeat(depth)+text);}
  q(value:string):string{return q(value,this.target,this.linked);}
  typeText(value:unknown):string{const text=this.q(meta(value));return this.generic&&hasTypeVariables(value)?(this.target==='rust'?'&':'')+this.call('ae_specialize',[text,this.target==='rust'?'&ae_types':'ae_types']):text;}
  semi(text:string):string{return text+(this.target==='python'?'':';');}
  call(name:string,args:string[],lazy=false):string{return `${name}${this.target==='rust'&&lazy?'!':''}(${args.join(', ')})`;}
  thunk(expr:string):string{return this.target==='python'?`lambda: ${expr}`:this.target==='typescript'?`() => ${expr}`:expr;}
  visible():CaptureBinding[]{return this.scopes.flat();}
  binding(symbol:SymbolId,ty:Ty):CaptureBinding{return{symbol,ty,expression:this.name(symbol)+(this.target==='rust'?'.clone()':'')};}
  infer(term:Term):Ty{return continuationType(term,new Map(this.visible().map(b=>[b.symbol,b.ty])),this.functions,this.resultType);}
  scoped<T>(bindings:CaptureBinding[],run:()=>T):T{this.scopes.push(bindings);try{return run();}finally{this.scopes.pop();}}
  expr(t:Term,old=false):string{
    const e=(n:Term)=>this.expr(n,old),call=(name:string,...args:string[])=>this.call(name,args);
    switch(t.kind){
      case'StringOp':return this.call('ae_string_op',[this.q(t.op),`[${t.args.map(e).join(', ')}]`],true);
      case'Lit':{const raw=typeof t.value==='bigint'?call('ae_int',this.q(String(t.value))):typeof t.value==='boolean'?call('ae_bool',this.target==='python'?(t.value?'True':'False'):String(t.value)):typeof t.value==='string'?call('ae_str',this.q(t.value)):call('ae_unit');const natural=typeof t.value==='bigint'?'Int':typeof t.value==='boolean'?'Bool':typeof t.value==='string'?'Str':'Unit';return t.ty.t===natural?raw:call('ae_lit',this.typeText(t.ty),raw);}
      case'Var':if(this.execution&&!old){const binding=this.visible().findLast(b=>b.symbol===t.symbol);if(!binding)throw new TypeError('unbound native capture');return binding.expression;}return `${old?'old_':''}${this.name(t.symbol)}${this.target==='rust'?'.clone()':''}`;
      case'Place':return this.composite?this.call('ae_read_place',[this.expr({kind:'Var',symbol:t.symbol},old),JSON.stringify(t.path)],true):`${old?'old_':''}${this.name(t.symbol)}${this.target==='rust'?'.clone()':''}`;
      case'Bin':return this.call(`ae_${t.op}`,['and','or'].includes(t.op)?[this.thunk(e(t.left)),this.thunk(e(t.right))]:[e(t.left),e(t.right)],['and','or'].includes(t.op));
      case'Un':return call(`ae_${t.op}`,e(t.operand));
      case'Cond':return this.call('ae_cond',[t.cond,t.then,t.otherwise].map(n=>this.thunk(e(n))),true);
      case'Call':{const fn=this.functions.get(t.callee)!,generic=this.generic&&fn.typeParams.length;return this.call(generic?'ae_generic_call':'ae_call',['ctx',this.name(t.callee),`[${t.args.map(e).join(', ')}]`,...(generic?[this.typeText(t.args.map(n=>this.infer(n)))]:[])],true);}
      case'Invoke':return this.call('ae_invoke',['ctx',this.q(t.capability),`[${t.args.map(e).join(', ')}]`],true);
      case'Old':return call('ae_old',this.expr(t.expr,true));
      case'ResultRef':return `ae_result${this.target==='rust'?'.clone()':''}`;
      case'Lambda':case'Spawn':{const captured=this.visible(),metadata=t.kind==='Lambda'?scalarPayload(t):{t:'Task',result:this.infer(t.body)},params=t.kind==='Lambda'?t.params:[];const saved=this.scopes;let body:string;this.scopes=[captured.map((b,i)=>({...b,expression:call('ae_capture','ae_captures',this.q(String(i)))})),params.map((p,i)=>({symbol:p.symbol,ty:p.ty,expression:call('ae_arg','ae_args',this.q(String(i)))}))];try{body=this.expr(t.body);}finally{this.scopes=saved;}const callback=this.target==='python'?`lambda ctx, ae_captures, ae_args: ${body}`:`(ctx, ae_captures, ae_args) => ${body}`;const macro=t.kind==='Lambda'?'ae_lambda':'ae_spawn',rustGeneric=this.target==='rust'&&this.genericFunction;return this.call(macro+(rustGeneric?'_generic':''),['ctx',this.typeText(metadata),JSON.stringify(captured.map(b=>b.symbol)),`[${captured.map(b=>b.expression).join(', ')}]`,...(this.target==='rust'?['ctx','ae_captures','ae_args',body,...(rustGeneric?['ae_types']:[])]:[callback])],true);}
      case'Apply':return this.call('ae_apply',['ctx',e(t.fn),`[${t.args.map(e).join(', ')}]`],true);
      case'Await':return this.call('ae_await',['ctx',e(t.task)],true);
      case'Field':return call('ae_field',e(t.object),this.q(t.field));
      case'RecordLit':return this.call('ae_record',[this.typeText(t.ty),`[${t.fields.map(([name,value])=>`[${this.q(name)}, ${e(value)}]`).join(', ')}]`],true);
      case'SeqLit':return this.call('ae_seq',[this.typeText(t.ty),`[${t.items.map(e).join(', ')}]`],true);
      case'SeqIndex':return call('ae_index',e(t.sequence),e(t.index));
      case'SeqLength':return call('ae_length',e(t.sequence));
      case'SeqMap':{const fn=this.functions.get(t.callee)!,generic=this.generic&&fn.typeParams.length;if(!generic)return this.call('ae_map',['ctx',e(t.sequence),this.name(t.callee)],true);const ty=underlying(this.infer(t.sequence));if(ty.t!=='Seq')throw new TypeError('map type');return this.call(generic?'ae_generic_map':'ae_map',['ctx',e(t.sequence),this.name(t.callee),...(generic?[this.typeText([ty.element])]:[])],true);}
      case'SeqFold':{const fn=this.functions.get(t.callee)!,generic=this.generic&&fn.typeParams.length;if(!generic)return this.call('ae_fold',['ctx',e(t.sequence),e(t.initial),this.name(t.callee)],true);const ty=underlying(this.infer(t.sequence));if(ty.t!=='Seq')throw new TypeError('fold type');return this.call(generic?'ae_generic_fold':'ae_fold',['ctx',e(t.sequence),e(t.initial),this.name(t.callee),...(generic?[this.typeText([this.infer(t.initial),ty.element])]:[])],true);}
      case'ResultValue':return call('ae_result_value',this.typeText(t.ty),this.q(t.variant),e(t.value));
      case'MatchResult':{const ok=this.name(t.okSymbol),err=this.name(t.errSymbol),ty=this.execution?underlying(this.infer(t.value)):null;const yes=()=>e(t.ok),no=()=>e(t.err),a=this.execution&&ty?.t==='Result'?this.scoped([this.binding(t.okSymbol,ty.ok)],yes):yes(),b=this.execution&&ty?.t==='Result'?this.scoped([this.binding(t.errSymbol,ty.err)],no):no();return this.call('ae_match',[e(t.value),...(this.target==='rust'?[ok,a,err,b]:[this.target==='python'?`lambda ${ok}: ${a}`:`(${ok}: V) => ${a}`,this.target==='python'?`lambda ${err}: ${b}`:`(${err}: V) => ${b}`])],true);}
      case'IntCast':return call('ae_fixed',this.q('cast'),this.typeText(t.ty),e(t.value),...(this.target==='rust'?['None']:[]));
      case'FixedBin':return call('ae_fixed',this.q(t.op),this.typeText(t.ty),e(t.left),this.target==='rust'?`Some(${e(t.right)})`:e(t.right));
      case'ForAll':{const name=this.name(t.symbol),body=this.execution?this.scoped([this.binding(t.symbol,{t:'Int'})],()=>e(t.body)):e(t.body);return this.call('ae_forall',['ctx',e(t.start),e(t.end),...(this.target==='rust'?[name,body]:[this.target==='python'?`lambda ${name}: ${body}`:`(${name}: V) => ${body}`])],true);}
      default:throw new TypeError(`unsupported expression ${t.kind}`);
    }
  }
  stmt(t:Term,d:number):void{
    const line=(s:string)=>this.line(this.semi(s),d),open=(s:string)=>this.line(this.target==='python'?s+':':s+' {',d),close=()=>{if(this.target!=='python')this.line('}',d);};
    switch(t.kind){
      case'Atomic':{
        this.line(`${this.marker} @atomic`,d);
        if(this.target==='python')this.line('with ae_atomic(ctx):',d);
        else{this.line('{',d);this.line(this.target==='rust'?'let _ae_atomic = ae_atomic(ctx);':'const ae_transaction = ae_atomic(ctx);',d+1);if(this.target==='typescript')this.line('try {',d+1);}
        const depth=d+(this.target==='typescript'?2:1);this.line(`${this.marker} @atomic-body`,depth);this.stmt(t.body,depth);this.line(`${this.marker} @atomic-body-end`,depth);
        if(this.target==='typescript'){this.line('} catch (ae_fault) {',d+1);this.line('ae_transaction.rollback();',d+2);this.line('throw ae_fault;',d+2);this.line('} finally {',d+1);this.line('ae_transaction.close();',d+2);this.line('}',d+1);}
        if(this.target!=='python')this.line('}',d);this.line(`${this.marker} @atomic-end`,d);return;
      }
      case'Block':this.line(this.target==='python'?'with ctx.scope():':'{',d);if(!t.stmts.length&&this.target==='python')this.line('pass',d+1);this.scoped([],()=>t.stmts.forEach(s=>this.stmt(s,d+1)));close();return;
      case'Let':line(`${this.target==='typescript'?'let ':this.target==='rust'?'let mut ':''}${this.name(t.symbol)} = ae_bind(${this.typeText(t.ty)}, ${this.expr(t.init)})`);if(this.execution)this.scopes.at(-1)!.push(this.binding(t.symbol,t.ty));return;
      case'Assign':if(t.target.kind==='Place'){if(!t.target.path.length)line(`${this.name(t.target.symbol)} = ${this.expr(t.value)}`);else line(this.call('ae_set_place',[this.expr(t.value),this.expr({kind:'Var',symbol:t.target.symbol}),JSON.stringify(t.target.path)],true));}else if(t.target.kind==='Field')line(`ae_set_field(${this.expr(t.value)}, ${this.expr(t.target.object)}, ${this.q(t.target.field)})`);else throw new TypeError('unsupported assignment target');return;
      case'Return':line(`return ${this.expr(t.value)}`);return;
      case'ExprStmt':line(`ae_discard(${this.expr(t.expr)})`);return;
      case'Assert':line(`ae_assert(${this.expr(t.expr)}, ${this.q(t.label)})`);return;
      case'Yield':line('ctx.tick()');return;
      case'If':open(`if ${this.target==='typescript'?'(':''}ae_truth(${this.expr(t.cond)})${this.target==='typescript'?')':''}`);this.stmt(t.then,d+1);close();if(t.otherwise){open('else');this.stmt(t.otherwise,d+1);close();}return;
      case'While':t.invariants.forEach(n=>this.line(`${this.marker} @invariant ${this.expr(n)}`,d));if(t.variant)this.line(`${this.marker} @variant ${this.expr(t.variant)}`,d);open(`while ${this.target==='typescript'?'(':''}ae_truth(${this.expr(t.cond)})${this.target==='typescript'?')':''}`);this.line(this.semi('ctx.tick()'),d+1);this.stmt(t.body,d+1);close();return;
      default:throw new TypeError(`unsupported statement ${t.kind}`);
    }
  }
  fn(fn:Extract<Term,{kind:'FunctionDecl'}>):void{
    this.resultType=fn.returns;this.genericFunction=this.generic&&fn.typeParams.length>0;this.scopes=[[...fn.params.map(p=>this.binding(p.symbol,p.ty)),...fn.surfaces.map(s=>{if(s.kind!=='Surface')throw new TypeError('surface');return this.binding(s.symbol,{t:s.domain.d==='range'?'Int':'Str'});})]];
    this.line(`${this.marker} @aether-function ${meta(scalarPayload(fn))}`);const name=this.name(fn.symbol),caps=JSON.stringify(fn.capabilities),generic=this.generic&&fn.typeParams.length>0;
    if(this.target==='python'){this.line(`def ${name}(ctx, args${generic?', ae_actual_types':''}):`);this.line(`with ctx.function(${caps}):`,1);}
    else if(this.target==='rust'){this.line(`pub fn ${name}(ctx: &mut Context, args: Vec<Value>${generic?', ae_actual_types: &str':''}) -> Value {`);this.line(`ctx.function(&${caps}, |ctx| {`,1);}
    else{this.line(`export function ${name}(ctx: Context, args: V[]${generic?', ae_actual_types: string':''}): V {`);this.line(`return ctx.function(${caps}, (ctx) => {`,1);}
    const d=2;if(generic)this.line(this.semi(`${this.target==='python'?'':this.target==='rust'?'let ':'const '}ae_types = ae_generic_bindings(${this.q(meta({typeParams:fn.typeParams,params:fn.params}))}, ae_actual_types, ${this.target==='rust'?'&':''}args)`),d);if(this.composite)this.line(this.semi(`ae_arguments(${this.typeText(fn.params.map(p=>p.ty))}, ${this.target==='rust'?'&':''}args)`),d);this.line(this.semi(`ae_arity(${this.target==='rust'?'&':''}args, ${fn.params.length})`),d);
    fn.params.forEach((p,i)=>{const n=this.name(p.symbol);this.line(this.semi(`${this.target==='python'?'':this.target==='rust'?'let mut ':'let '}${n} = ae_bind(${this.typeText(p.ty)}, args[${i}]${this.target==='rust'?'.clone()':''})`),d);this.line(this.semi(`${this.target==='python'?'':this.target==='rust'?'let ':'const '}old_${n} = ${this.composite?`ae_snapshot(${n}${this.target==='rust'?'.clone()':''})`:`${n}${this.target==='rust'?'.clone()':''}`}`),d);});
    this.line(`${this.marker} @aether-surfaces`,d);fn.surfaces.forEach(s=>{if(s.kind!=='Surface')throw new Error('surface');this.line(this.semi(`${this.target==='python'?'':this.target==='rust'?'let mut ':'let '}${this.name(s.symbol)} = ae_surface(${this.q(meta(s))})`),d);this.line(this.semi(`${this.target==='python'?'':this.target==='rust'?'let ':'const '}old_${this.name(s.symbol)} = ${this.name(s.symbol)}${this.target==='rust'?'.clone()':''}`),d);});
    this.line(`${this.marker} @aether-contract ${fn.contract===null?'null':'present'}`,d);
    const contract=fn.contract as Extract<Term,{kind:'Contract'}>|null;
    this.line(`${this.marker} @aether-requires`,d);contract?.requires.forEach(c=>{if(c.kind!=='Clause')throw new Error('clause');this.line(this.semi(`ae_clause(${this.expr(c.expr)}, ${this.q(c.label)}, ${this.q(c.rigor)})`),d);});
    contract?.modifies.forEach(p=>this.line(`${this.marker} @modifies ${meta(p)}`,d));
    if(this.target==='python'){this.line('def ae_body():',d);const names=[...fn.params.map(p=>this.name(p.symbol)),...fn.surfaces.map(s=>this.name((s as Extract<Term,{kind:'Surface'}>).symbol))];if(names.length)this.line(`nonlocal ${names.join(', ')}`,d+1);}
    else this.line(this.target==='rust'?'let ae_result = (|| -> Value {':'const ae_result = (() : V => {',d);
    this.line(`${this.marker} @aether-body ${fn.body===null?'null':'present'}`,d+1);if(fn.body)this.stmt(fn.body,d+1);
    this.line(`${this.marker} @aether-body-end`,d+1);
    this.line(this.target==='rust'?'ae_unit()':this.semi('return ae_unit()'),d+1);
    if(this.target==='python')this.line('ae_result = ae_body()',d);else this.line('})();',d);
    this.line(`${this.marker} @aether-ensures`,d);contract?.ensures.forEach(c=>{if(c.kind!=='Clause')throw new Error('clause');this.line(this.semi(`ae_clause(${this.expr(c.expr)}, ${this.q(c.label)}, ${this.q(c.rigor)})`),d);});
    this.line(`${this.marker} @aether-ensures-end`,d);const result=`ae_bind(${this.typeText(fn.returns)}, ae_result)`;this.line(this.target==='rust'?result:this.semi(`return ${result}`),d);
    if(this.target!=='python'){this.line(this.target==='rust'?'})':'});',1);this.line('}');}
    this.line(`${this.marker} @aether-function-end`);this.line('');
  }
}
const imports=(t:ExecutableTarget,composite=false,execution=false,atomic=false,linked=false,generic=false)=>t==='python'?'from aether_runtime import *':t==='rust'?'include!("aether_runtime.rs");':`import { Context, type V, ae_int, ae_bool, ae_str, ae_unit, ae_bind, ae_lit, ae_old, ae_discard, ae_assert, ae_clause, ae_surface, ae_add, ae_sub, ae_mul, ae_div, ae_mod, ae_lt, ae_le, ae_gt, ae_ge, ae_eq, ae_ne, ae_neg, ae_not, ae_concat, ae_and, ae_or, ae_cond, ae_call, ae_invoke, ae_forall, ae_fixed, ae_truth, ae_arity${composite?', ae_arguments, ae_snapshot, ae_record, ae_field, ae_read_place, ae_set_field, ae_set_place, ae_seq, ae_index, ae_length, ae_map, ae_fold, ae_result_value, ae_match':''}${execution?', ae_lambda, ae_apply, ae_spawn, ae_await, ae_capture, ae_arg':''}${atomic?', ae_atomic':''}${linked?', ae_string_op':''}${generic?', ae_specialize, ae_generic_bindings, ae_generic_call, ae_generic_map, ae_generic_fold':''} } from "./aether_runtime.ts";`;
function emit(module:Extract<Term,{kind:'Module'}>,header:Header,options:ExecutableProjectionOptions={}):string{
 const e=new Emitter(header,module,options);e.line(`${e.marker} @aether-projection/${header.format.slice(-1)} ${meta(header)}`);
 e.line(header.link?.role==='dependency'&&header.target==='rust'?'use crate::*;':imports(header.target,e.composite,e.execution,e.atomic,e.linked,e.generic));
 if(header.link?.role==='entry'&&header.target==='rust')header.link.dependencies.forEach(ref=>e.line(`pub mod ${nativeModuleName(ref)};`));e.line('');
 const closure=e.linked?linkExecutableModule(module,options):null;
 const members=(nodes:readonly Term[])=>nodes.forEach((n,i)=>{
  if(n.kind==='Module'){e.line(`${e.marker} @aether-nested ${meta({...scalarPayload(n),symbolTable:n.symbolTable})}`);members(n.members);e.line(`${e.marker} @aether-nested-end`);}
  else if(n.kind==='Import'){
   e.line(`${e.marker} @aether-import ${meta(n)}`);const dep=options.modules!.get(n.module) as Extract<Term,{kind:'Module'}>,resolved=closure!.resolve(n.module),selected=resolved.members.filter(m=>!n.symbols.length||'symbol'in m&&n.symbols.includes(m.symbol)).flatMap(moduleFunctions),name=nativeModuleName(n.module);
   const names=selected.map(m=>`${nativeSymbolName(dep,m.symbol)} as ${e.name(m.symbol)}`);
   if(header.target==='typescript'){e.line(names.length?`import { ${names.join(', ')} } from "./${name}.ts";`:`import "./${name}.ts";`);if(selected.length)e.line(`export { ${selected.map(m=>e.name(m.symbol)).join(', ')} };`);}
   else if(header.target==='python')e.line(names.length?`from ${name} import ${names.join(', ')}`:`import ${name}`);
   else if(names.length)e.line(`pub use crate::${name}::{${names.join(', ')}};`);
   else e.line(`use crate::${name} as import_d${i};`);
   e.line(`${e.marker} @aether-import-end`);
  }else if(n.kind==='TypeDecl'){const index=e.generic?e.typeDeclaration++:i;e.line(header.target==='rust'?`const type_d${index}: &str = ${q(meta(n),header.target,e.linked)};`:header.target==='typescript'?`const type_d${index} = ${q(meta(n),header.target,e.linked)};`:`type_d${index} = ${q(meta(n),header.target,e.linked)}`);}
  else e.fn(n as Extract<Term,{kind:'FunctionDecl'}>);
 });members(module.members);return e.lines.join('\n')+'\n';
}
function requiresComposites(module:Term):boolean{for(const n of walk(module)){for(const group of linkGroups(n))for(const child of group.links)if(child.kind==='Place'&&!((n.kind==='Assign'&&group.field==='target')||(n.kind==='Contract'&&group.field==='modifies')))return true;if(COMPOSITE_KINDS.includes(n.kind)&&!KINDS.includes(n.kind))return true;const types:Ty[]=[...('ty'in n?[n.ty]:[]),...('returns'in n?[n.returns]:[]),...('params'in n?n.params.map(p=>p.ty):[])];if(types.some(t=>{try{scalarType(t);return false;}catch{return true;}}))return true;}return false;}
function projectProfile(module:Term,symbols:SymbolSpace,target:ExecutableTarget,composite:boolean,execution=false,atomic=false,linked=false,options:ExecutableProjectionOptions={},role:'entry'|'dependency'='entry',generic=false,nestedImports=false):string{if(!['typescript','python','rust'].includes(target))throw new TypeError('unsupported target');validate(module,composite,execution,atomic,linked,options,generic,nestedImports);const source=emit(module,headerFor(module,symbols,target,composite,execution,atomic,linked,options,role,generic,nestedImports),options);if(Buffer.byteLength(source)>EXECUTABLE_PROJECTION_PROFILE.maxSourceBytes)throw new RangeError('projection byte limit');return source;}
function requiresContinuations(module:Term):boolean{return [...walk(module)].some(n=>['Lambda','Apply','Spawn','Await'].includes(n.kind)||[...('ty'in n?[n.ty]:[]),...('returns'in n?[n.returns]:[]),...('params'in n?n.params.map(p=>p.ty):[])].some(t=>JSON.stringify(t).includes('\"Fn\"')||JSON.stringify(t).includes('\"Task\"')));}
export function projectExecutable(module:Term,symbols:SymbolSpace,target:ExecutableTarget,options:ExecutableProjectionOptions={}):string{encodeAgentIrBinary(module);const closure=module.kind==='Module'?[module,...linkExecutableModule(module,options).modules.values()]:[module],generic=closure.some(m=>hasTypeVariables(m)||[...walk(m)].some(n=>n.kind==='Module'&&n!==m||n.kind==='FunctionDecl'&&n.typeParams.length||('ty'in n&&hasTypeVariables(n.ty))));const nestedImports=closure.some(m=>m.kind==='Module'&&[...walk(m)].some(n=>n.kind==='Module'&&n!==m&&n.members.some(member=>member.kind==='Import')));const linked=generic||[...walk(module)].some(n=>n.kind==='Import'||n.kind==='StringOp');const atomic=linked||[...walk(module)].some(n=>n.kind==='Atomic'),execution=atomic||requiresContinuations(module);return projectProfile(module,symbols,target,execution||requiresComposites(module),execution,atomic,linked,options,'entry',generic,nestedImports);}

export interface ExecutableBundle {readonly target:ExecutableTarget;readonly source:string;readonly runtime:string;readonly aliases:ReadonlyMap<SymbolId,string>;readonly dependencies?:ReadonlyMap<string,string>}
const sourceHeader=(source:string,target:ExecutableTarget)=>parseMeta<Header>(source.split('\n')[0].slice((comment(target)+' @aether-projection/2 ').length));
const sourceRuntime=(header:Header)=>executableRuntime(header.target,!header.format.endsWith('/2'),['4','5','6','7','8'].includes(header.format.slice(-1)),['5','6','7','8'].includes(header.format.slice(-1)),['6','7','8'].includes(header.format.slice(-1)),genericHeader(header));
const extension=(target:ExecutableTarget)=>target==='typescript'?'ts':target==='python'?'py':'rs';
export function executableBundle(module:Term,symbols:SymbolSpace,target:ExecutableTarget,options:ExecutableProjectionOptions={}):ExecutableBundle{
 const source=projectExecutable(module,symbols,target,options),header=sourceHeader(source,target),dependencies=new Map<string,string>();
 if(header.link){const closure=linkExecutableModule(module as Extract<Term,{kind:'Module'}>,options);for(const[ref,dependency]of closure.modules)dependencies.set(nativeModuleName(ref)+'.'+extension(target),projectProfile(dependency,symbols,target,true,true,true,true,options,'dependency',genericHeader(header),header.format.endsWith('/8')));}
 return{target,source,runtime:sourceRuntime(header),aliases:new Map(header.aliases),...(header.link?{dependencies}:{})};
}
/** Parse every visible source first, then validate its exact address, complete
 * reference-link closure and regenerated native import/authority scaffolding. */
export function parseExecutableBundle(bundle:Pick<ExecutableBundle,'target'|'source'>&Partial<Pick<ExecutableBundle,'runtime'|'dependencies'>>):{module:Term;modules:ReadonlyMap<NodeRef,Term>;linked:Term}{
 const {target,source}=bundle,modules=new Map<NodeRef,Term>(),store=new GraphStore(),files=bundle.dependencies??new Map<string,string>();if(files.size>63)throw new RangeError('native module closure bound');let bytes=Buffer.byteLength(source);
 for(const[name,text]of files){bytes+=Buffer.byteLength(text);if(bytes>16*1024*1024)throw new RangeError('native source closure byte bound');const match=/^aether_([0-9a-f]{64})\.(ts|py|rs)$/.exec(name);if(!match||match[2]!==extension(target))throw new SyntaxError('native dependency filename');const module=parseNative(text,target,{},true),ref=('ast:b3:'+match[1]) as NodeRef;if(store.intern(module)!==ref)throw new SyntaxError('native dependency content address mismatch');const header=sourceHeader(text,target);if(header.link?.role!=='dependency')throw new SyntaxError('native dependency role');modules.set(ref,module);}
 const header=sourceHeader(source,target);if([...files.values()].some(text=>sourceHeader(text,target).format!==header.format))throw new SyntaxError('mixed native module profiles');if(header.link&&header.link.role!=='entry')throw new SyntaxError('native entry role');const module=parseExecutable(source,target,{modules});for(const text of files.values())parseExecutable(text,target,{modules});
 const closure=linkExecutableModule(module as Extract<Term,{kind:'Module'}>,{modules});if(closure.modules.size!==modules.size||[...modules.keys()].some(ref=>!closure.modules.has(ref)))throw new SyntaxError('extra native dependency');if(bundle.runtime!==undefined&&bundle.runtime!==sourceRuntime(header))throw new SyntaxError('native runtime does not match profile');return{module,modules,linked:closure.linked};
}

type H = {kind:'id';value:string}|{kind:'str';value:string}|{kind:'bool';value:boolean}|{kind:'array';items:H[]}|{kind:'call';name:string;args:H[]}|{kind:'lambda';params:string[];body:H};
function lex(text:string):string[]{const result:string[]=[];for(let i=0;i<text.length;){if(/\s/.test(text[i])){i++;continue;}if(text[i]==='"'){let j=i+1;while(j<text.length){if(text[j]==='\\'){j+=2;continue;}if(text[j++]==='"')break;}const token=text.slice(i,j);readQuoted(token);result.push(token);i=j;continue;}const id=/^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(i));if(id){result.push(id[0]);i+=id[0].length;continue;}if(text.startsWith('=>',i)){result.push('=>');i+=2;continue;}if(text[i]==='&'){i++;continue;}if('()[],:.!'.includes(text[i])){result.push(text[i++]);continue;}throw new SyntaxError(`unsupported projection expression token ${text.slice(i,i+20)}`);}if(result.length>50000)throw new RangeError('projection expression token bound');let depth=0;for(const token of result){if(token==='('||token==='['){if(++depth>64)throw new RangeError('projection expression depth');}else if(token===')'||token===']'){if(--depth<0)throw new SyntaxError('unbalanced expression');}}if(depth)throw new SyntaxError('unbalanced expression');return result;}
function syntax(text:string):H{
  const tokens=lex(text);let p=0;const need=(token:string)=>{if(tokens[p++]!==token)throw new SyntaxError(`expected ${token}`);};
  const read=():H=>{let result:H;const token=tokens[p++];if(token===undefined)throw new SyntaxError('missing expression');
    if(token==='lambda'){const params:string[]=[];while(tokens[p]!==':'){if(params.length)need(',');const name=tokens[p++];if(!name||!/^[A-Za-z_]/.test(name))throw new SyntaxError('lambda binder');params.push(name);}need(':');return{kind:'lambda',params,body:read()};}
    if(token==='('){const params:string[]=[];while(tokens[p]!==')'){if(params.length)need(',');const name=tokens[p++];if(!name||!/^[A-Za-z_]/.test(name))throw new SyntaxError('lambda binder');params.push(name);if(tokens[p]===':'){need(':');need('V');}}need(')');need('=>');return{kind:'lambda',params,body:read()};}
    if(token==='['){const items:H[]=[];while(tokens[p]!==']'){if(items.length)need(',');items.push(read());}need(']');return{kind:'array',items};}
    if(token.startsWith('"'))result={kind:'str',value:readQuoted(token)};
    else if(['true','false','True','False'].includes(token))result={kind:'bool',value:token==='true'||token==='True'};
    else{if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(token))throw new SyntaxError('invalid expression identifier');result={kind:'id',value:token};}
    if(tokens[p]==='!')p++;
    if(tokens[p]==='('){if(result.kind!=='id')throw new SyntaxError('invalid callee');need('(');const args:H[]=[];while(tokens[p]!==')'){if(args.length)need(',');args.push(read());}need(')');result={kind:'call',name:result.value,args};}
    if(tokens[p]==='.'){need('.');need('clone');need('(');need(')');if(result.kind!=='id')throw new SyntaxError('only bound values may be cloned');}
    return result;};const result=read();if(p!==tokens.length)throw new SyntaxError('trailing expression syntax');return result;
}
class Reverse {
  readonly ids:Map<string,SymbolId>; readonly header:Header;executionBindings:{captures:SymbolId[];params:SymbolId[]}[]=[];
  constructor(header:Header){this.header=header;this.ids=new Map(header.aliases.map(([id,name])=>[name,id]));}
  symbol(name:string):SymbolId{const id=this.ids.get(name);if(!id)throw new SyntaxError(`unknown projection binding ${name}`);return id;}
  metadata(h:H):string{if(h?.kind==='str')return h.value;if(genericHeader(this.header)&&h?.kind==='call'&&h.name==='ae_specialize'&&h.args.length===2&&h.args[0].kind==='str'&&h.args[1].kind==='id'&&h.args[1].value==='ae_types')return h.args[0].value;throw new SyntaxError('string metadata expected');}
  expr(h:H,old=false):Term{
    const str=(v:H):string=>this.metadata(v);
    const ex=(v:H)=>this.expr(v,old);
    if(h.kind==='id'){if(h.value==='ae_result')return{kind:'ResultRef'};const name=h.value;if(old){if(!name.startsWith('old_'))throw new SyntaxError('old expression must use captured bindings');return{kind:'Var',symbol:this.symbol(name.slice(4))};}if(name.startsWith('old_'))throw new SyntaxError('entry capture outside old expression');return{kind:'Var',symbol:this.symbol(name)};}
    if(h.kind!=='call')throw new SyntaxError('projected expression helper expected');const a=h.args,name=h.name;
    const arity=(n:number)=>{if(a.length!==n)throw new SyntaxError(`arity of ${name}`);};
    const lazy=(v:H)=>{if(this.header.target==='rust')return ex(v);if(v.kind!=='lambda'||v.params.length)throw new SyntaxError('lazy expression expected');return ex(v.body);};
    if(name==='ae_string_op'){arity(2);const op=str(a[0]);if(!['strlen','contains','slice','lower','upper','trim'].includes(op)||a[1].kind!=='array')throw new SyntaxError('string operation shape');return{kind:'StringOp',op:op as 'strlen',args:a[1].items.map(ex)};}
    if(name==='ae_int'){arity(1);const value=str(a[0]);if(!/^(0|-?[1-9][0-9]*)$/.test(value))throw new SyntaxError('canonical integer expected');return{kind:'Lit',ty:{t:'Int'},value:BigInt(value)};}
    if(name==='ae_bool'){arity(1);if(a[0].kind!=='bool')throw new SyntaxError('boolean literal');return{kind:'Lit',ty:{t:'Bool'},value:a[0].value};}
    if(name==='ae_str'){arity(1);return{kind:'Lit',ty:{t:'Str'},value:str(a[0])};}
    if(name==='ae_unit'){arity(0);return{kind:'Lit',ty:{t:'Unit'},value:null};}
    if(name==='ae_lit'){arity(2);const literal=ex(a[1]);if(literal.kind!=='Lit')throw new SyntaxError('typed literal needs literal');return{...literal,ty:parseMeta<Ty>(str(a[0]))};}
    if(name==='ae_old'){arity(1);return{kind:'Old',expr:this.expr(a[0],true)};}
    if(name==='ae_neg'||name==='ae_not'){arity(1);return{kind:'Un',op:name==='ae_neg'?'neg':'not',operand:ex(a[0])};}
    if(['add','sub','mul','div','mod','eq','ne','lt','le','gt','ge','concat','and','or'].some(op=>name===`ae_${op}`)){arity(2);const op=name.slice(3) as BinOp;return{kind:'Bin',op,left:['and','or'].includes(op)?lazy(a[0]):ex(a[0]),right:['and','or'].includes(op)?lazy(a[1]):ex(a[1])};}
    if(name==='ae_cond'){arity(3);return{kind:'Cond',cond:lazy(a[0]),then:lazy(a[1]),otherwise:lazy(a[2])};}
    if(name==='ae_call'||name==='ae_invoke'||name==='ae_generic_call'){arity(name==='ae_generic_call'?4:3);if(a[0].kind!=='id'||a[0].value!=='ctx'||a[2].kind!=='array')throw new SyntaxError('invalid call envelope');if(name==='ae_call'||name==='ae_generic_call'){if(a[1].kind!=='id')throw new SyntaxError('callee identifier');return{kind:'Call',callee:this.symbol(a[1].value),args:a[2].items.map(ex)};}return{kind:'Invoke',capability:str(a[1]) as never,args:a[2].items.map(ex)};}
    if(name==='ae_capture'||name==='ae_arg'){arity(2);const context=this.executionBindings.at(-1),list=context?.[name==='ae_capture'?'captures':'params'];if(!list||a[0].kind!=='id'||a[0].value!==(name==='ae_capture'?'ae_captures':'ae_args'))throw new SyntaxError('capture outside native continuation');const index=str(a[1]);if(!/^(0|[1-9][0-9]*)$/.test(index)||!Number.isSafeInteger(Number(index))||Number(index)>=list.length)throw new SyntaxError('capture index');return{kind:'Var',symbol:list[Number(index)]};}
    if(['ae_lambda','ae_spawn','ae_lambda_generic','ae_spawn_generic'].includes(name)){const isLambda=name.startsWith('ae_lambda'),rustGeneric=name.endsWith('_generic');if(rustGeneric&&(this.header.target!=='rust'||!genericHeader(this.header)))throw new SyntaxError('generic continuation profile');arity(this.header.target==='rust'?(rustGeneric?9:8):5);if(a[0].kind!=='id'||a[0].value!=='ctx'||a[2].kind!=='array'||a[3].kind!=='array')throw new SyntaxError('continuation layout');const captures=a[2].items.map(s=>str(s) as SymbolId);if(captures.length!==a[3].items.length||captures.some(s=>!this.header.aliases.some(([id])=>id===s)))throw new SyntaxError('continuation captures');let body:H;if(this.header.target==='rust'){for(let i=0;i<3;i++)if(a[i+4].kind!=='id'||(a[i+4] as Extract<H,{kind:'id'}>).value!==['ctx','ae_captures','ae_args'][i])throw new SyntaxError('native continuation arguments');if(rustGeneric&&(a[8].kind!=='id'||a[8].value!=='ae_types'))throw new SyntaxError('generic continuation witness');body=a[7];}else{if(a[4].kind!=='lambda'||a[4].params.join(',')!=='ctx,ae_captures,ae_args')throw new SyntaxError('native continuation lambda');body=a[4].body;}const metadata=parseMeta<any>(str(a[1]));if(isLambda){exactObject(metadata,['kind','params','returns','capabilities']);if(metadata.kind!=='Lambda'||!Array.isArray(metadata.params))throw new SyntaxError('lambda metadata');}else{exactObject(metadata,['t','result']);if(metadata.t!=='Task')throw new SyntaxError('task result metadata');}this.executionBindings.push({captures,params:isLambda?metadata.params.map((p:any)=>p.symbol):[]});let expression:Term;try{expression=this.expr(body);}finally{this.executionBindings.pop();}return isLambda?{...metadata,body:expression}:{kind:'Spawn',body:expression};}
    if(name==='ae_apply'){arity(3);if(a[0].kind!=='id'||a[0].value!=='ctx'||a[2].kind!=='array')throw new SyntaxError('apply layout');return{kind:'Apply',fn:ex(a[1]),args:a[2].items.map(ex)};}
    if(name==='ae_await'){arity(2);if(a[0].kind!=='id'||a[0].value!=='ctx')throw new SyntaxError('await context');return{kind:'Await',task:ex(a[1])};}
    if(name==='ae_read_place'){arity(2);const root=ex(a[0]);if(root.kind!=='Var'||a[1].kind!=='array'||a[1].items.some(x=>x.kind!=='str'))throw new SyntaxError('place expression');return{kind:'Place',symbol:root.symbol,path:a[1].items.map(x=>(x as Extract<H,{kind:'str'}>).value)};}
    if(name==='ae_field'){arity(2);return{kind:'Field',object:ex(a[0]),field:str(a[1])};}
    if(name==='ae_record'){arity(2);if(a[1].kind!=='array')throw new SyntaxError('record fields');return{kind:'RecordLit',ty:parseMeta<Ty>(str(a[0])),fields:a[1].items.map(pair=>{if(pair.kind!=='array'||pair.items.length!==2)throw new SyntaxError('record field pair');return[str(pair.items[0]),ex(pair.items[1])];})};}
    if(name==='ae_seq'){arity(2);const ty=parseMeta<Ty>(str(a[0]));if(ty.t!=='Seq'||a[1].kind!=='array')throw new SyntaxError('sequence shape');return{kind:'SeqLit',ty,items:a[1].items.map(ex)};}
    if(name==='ae_index'){arity(2);return{kind:'SeqIndex',sequence:ex(a[0]),index:ex(a[1])};}
    if(name==='ae_length'){arity(1);return{kind:'SeqLength',sequence:ex(a[0])};}
    if(['ae_map','ae_fold','ae_generic_map','ae_generic_fold'].includes(name)){const map=name.endsWith('map'),generic=name.includes('generic');arity((map?3:4)+(generic?1:0));const f=a.at(generic?-2:-1)!;if(a[0].kind!=='id'||a[0].value!=='ctx'||f.kind!=='id')throw new SyntaxError('sequence callback');return map?{kind:'SeqMap',sequence:ex(a[1]),callee:this.symbol(f.value)}:{kind:'SeqFold',sequence:ex(a[1]),initial:ex(a[2]),callee:this.symbol(f.value)};}
    if(name==='ae_result_value'){arity(3);const ty=parseMeta<Ty>(str(a[0])),variant=str(a[1]);if(ty.t!=='Result'||!['ok','err'].includes(variant))throw new SyntaxError('result shape');return{kind:'ResultValue',ty,variant:variant as 'ok',value:ex(a[2])};}
    if(name==='ae_match'){arity(this.header.target==='rust'?5:3);let ok:string,err:string,yes:H,no:H;if(this.header.target==='rust'){if(a[1].kind!=='id'||a[3].kind!=='id')throw new SyntaxError('result match binders');ok=a[1].value;err=a[3].value;yes=a[2];no=a[4];}else{if(a[1].kind!=='lambda'||a[2].kind!=='lambda'||a[1].params.length!==1||a[2].params.length!==1)throw new SyntaxError('result match branches');ok=a[1].params[0];err=a[2].params[0];yes=a[1].body;no=a[2].body;}return{kind:'MatchResult',value:ex(a[0]),okSymbol:this.symbol(ok),ok:ex(yes),errSymbol:this.symbol(err),err:ex(no)};}
    if(name==='ae_fixed'){const op=str(a[0]),ty=parseMeta<Ty>(str(a[1]));if(ty.t!=='IntN')throw new SyntaxError('fixed operation type');if(op==='cast'){arity(this.header.target==='rust'?4:3);if(this.header.target==='rust'&&(a[3].kind!=='id'||a[3].value!=='None'))throw new SyntaxError('cast option');return{kind:'IntCast',ty,value:ex(a[2])};}arity(4);if(!['add','sub','mul','div','mod'].includes(op))throw new SyntaxError('fixed operator');let right=a[3];if(this.header.target==='rust'){if(right.kind!=='call'||right.name!=='Some'||right.args.length!==1)throw new SyntaxError('fixed option');right=right.args[0];}return{kind:'FixedBin',op:op as 'add',ty,left:ex(a[2]),right:ex(right)};}
    if(name==='ae_forall'){arity(this.header.target==='rust'?5:4);if(a[0].kind!=='id'||a[0].value!=='ctx')throw new SyntaxError('quantifier context');let binder:string,body:H;if(this.header.target==='rust'){if(a[3].kind!=='id')throw new SyntaxError('quantifier binder');binder=a[3].value;body=a[4];}else{if(a[3].kind!=='lambda'||a[3].params.length!==1)throw new SyntaxError('quantifier lambda');binder=a[3].params[0];body=a[3].body;}return{kind:'ForAll',symbol:this.symbol(binder),start:ex(a[1]),end:ex(a[2]),body:ex(body)};}
    throw new SyntaxError(`unsupported projection helper ${name}`);
  }
  expression(text:string):Term{return this.expr(syntax(text));}
  body(lines:string[]):Term{
    const rows=lines.filter(line=>line.trim()).map(line=>{if(line.includes('\t')||/^ */.exec(line)![0].length%4)throw new SyntaxError('projection indentation');return{d:/^ */.exec(line)![0].length/4,text:line.trim()};});let i=0;const target=this.header.target,mark=comment(target),strip=(s:string)=>s.replace(/;$/,'');
    const close=(d:number)=>{if(target!=='python'){if(rows[i]?.d!==d||rows[i]?.text!=='}')throw new SyntaxError('missing block terminator');i++;}};
    const one=(d:number):Term=>{if(d>64)throw new RangeError('projection statement depth');if(rows[i]?.d!==d)throw new SyntaxError('unexpected statement indentation');const invariants:Term[]=[];let variant:Term|null=null;while(rows[i]?.text.startsWith(mark+' @invariant ')||rows[i]?.text.startsWith(mark+' @variant ')){const row=rows[i++];if(row.text.startsWith(mark+' @invariant '))invariants.push(this.expression(row.text.slice((mark+' @invariant ').length)));else{if(variant)throw new SyntaxError('duplicate variant');variant=this.expression(row.text.slice((mark+' @variant ').length));}}
      const row=rows[i++];if(!row||row.d!==d)throw new SyntaxError('missing statement');const s=strip(row.text);
      if(invariants.length||variant){if(!s.startsWith('while '))throw new SyntaxError('loop annotation outside loop');}
      if(s===mark+' @atomic'){
        if(!['5','6','7','8'].includes(this.header.format.slice(-1)))throw new SyntaxError('Atomic requires profile 5');
        const take=(text:string,depth:number)=>{if(rows[i]?.text!==text||rows[i]?.d!==depth)throw new SyntaxError('invalid atomic scaffolding');i++;};
        if(target==='python')take('with ae_atomic(ctx):',d);else{take('{',d);take(target==='rust'?'let _ae_atomic = ae_atomic(ctx);':'const ae_transaction = ae_atomic(ctx);',d+1);if(target==='typescript')take('try {',d+1);}
        const depth=d+(target==='typescript'?2:1);take(mark+' @atomic-body',depth);const body=one(depth);take(mark+' @atomic-body-end',depth);
        if(target==='typescript'){take('} catch (ae_fault) {',d+1);take('ae_transaction.rollback();',d+2);take('throw ae_fault;',d+2);take('} finally {',d+1);take('ae_transaction.close();',d+2);take('}',d+1);}
        if(target!=='python')take('}',d);take(mark+' @atomic-end',d);return{kind:'Atomic',body};
      }
      if(s==='{'||s==='with ctx.scope():'){const stmts:Term[]=[];if(target==='python'&&rows[i]?.d===d+1&&rows[i]?.text==='pass')i++;else while(rows[i]?.d===d+1)stmts.push(one(d+1));close(d);return{kind:'Block',stmts};}
      if(s.startsWith('if ')||s.startsWith('while ')){const loop=s.startsWith('while '),start=loop?'while ':'if ',suffix=target==='python'?':':' {',wrapped=s.slice(start.length,-suffix.length),condition=target==='typescript'?wrapped.slice(1,-1):wrapped;if(!s.endsWith(suffix))throw new SyntaxError('invalid control flow syntax');const h=syntax(condition);if(h.kind!=='call'||h.name!=='ae_truth'||h.args.length!==1)throw new SyntaxError('typed condition expected');if(loop){if(rows[i]?.d!==d+1||strip(rows[i]?.text)!=='ctx.tick()')throw new SyntaxError('missing loop budget check');i++;const body=one(d+1);close(d);return{kind:'While',cond:this.expr(h.args[0]),invariants,variant,body};}const then=one(d+1);close(d);let otherwise:Term|null=null;if(rows[i]?.d===d&&rows[i]?.text===(target==='python'?'else:':'else {')){i++;otherwise=one(d+1);close(d);}return{kind:'If',cond:this.expr(h.args[0]),then,otherwise};}
      if(s.startsWith('return '))return{kind:'Return',value:this.expression(s.slice(7))};
      if(s==='ctx.tick()')return{kind:'Yield'};
      const assigned=/^(?:(let(?: mut)?) )?([A-Za-z_][A-Za-z_0-9]*) = (.+)$/.exec(s);
      if(assigned){const symbol=this.symbol(assigned[2]),h=syntax(assigned[3]);if(h.kind==='call'&&h.name==='ae_bind'){if(h.args.length!==2||target!=='python'&&!assigned[1])throw new SyntaxError('typed local declaration expected');return{kind:'Let',symbol,ty:parseMeta<Ty>(this.metadata(h.args[0])),init:this.expr(h.args[1])};}if(assigned[1])throw new SyntaxError('typed initializer required');return{kind:'Assign',target:{kind:'Place',symbol,path:[]},value:this.expr(h)};}
      const h=syntax(s);if(h.kind==='call'&&h.name==='ae_set_field'&&h.args.length===3&&h.args[2].kind==='str')return{kind:'Assign',target:{kind:'Field',object:this.expr(h.args[1]),field:h.args[2].value},value:this.expr(h.args[0])};if(h.kind==='call'&&h.name==='ae_set_place'&&h.args.length===3&&h.args[2].kind==='array'){const root=this.expr(h.args[1]);if(root.kind!=='Var'||!h.args[2].items.length||h.args[2].items.some(x=>x.kind!=='str'))throw new SyntaxError('place assignment path');return{kind:'Assign',target:{kind:'Place',symbol:root.symbol,path:h.args[2].items.map(x=>(x as Extract<H,{kind:'str'}>).value)},value:this.expr(h.args[0])};}if(h.kind==='call'&&h.name==='ae_discard'&&h.args.length===1)return{kind:'ExprStmt',expr:this.expr(h.args[0])};if(h.kind==='call'&&h.name==='ae_assert'&&h.args.length===2&&h.args[1].kind==='str')return{kind:'Assert',expr:this.expr(h.args[0]),label:h.args[1].value};throw new SyntaxError('unsupported native statement');
    };if(!rows.length)throw new SyntaxError('missing body');const result=one(rows[0].d);if(i!==rows.length)throw new SyntaxError('extra statements outside body');return result;
  }
}
function normalized(source:string,target:ExecutableTarget):string {
  return source.split('\n').filter(line=>line.trim()).map(line=>{
    let result=target==='python'?/^ */.exec(line)![0]:'',quoted=false,escape=false;const text=line.trim();
    for(let i=0;i<text.length;i++){const c=text[i];if(quoted){result+=c;if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;result+=c;continue;}if(/\s/.test(c)){let next=i+1;while(next<text.length&&/\s/.test(text[next]))next++;if(/[A-Za-z_0-9$]/.test(result.at(-1)??'')&&/[A-Za-z_0-9$]/.test(text[next]??''))result+=' ';i=next-1;continue;}result+=c;}
    if(quoted)throw new SyntaxError('unterminated quoted source');return result;
  }).join('\n');
}
function parseNative(source:string,target:ExecutableTarget,options:ExecutableProjectionOptions={},syntaxOnly=false):Term{
  if(!['typescript','python','rust'].includes(target))throw new TypeError('unsupported target');
  validString(source);if(/[\r\u2028\u2029]/.test(source))throw new SyntaxError('projection requires LF source and escaped line separators');if(Buffer.byteLength(source)>EXECUTABLE_PROJECTION_PROFILE.maxSourceBytes)throw new RangeError('projection byte limit');const lines=source.split('\n'),mark=comment(target),prefix=mark+(lines[0]?.startsWith(mark+' @aether-projection/8 ')?' @aether-projection/8 ':lines[0]?.startsWith(mark+' @aether-projection/7 ')?' @aether-projection/7 ':lines[0]?.startsWith(mark+' @aether-projection/6 ')?' @aether-projection/6 ':lines[0]?.startsWith(mark+' @aether-projection/5 ')?' @aether-projection/5 ':lines[0]?.startsWith(mark+' @aether-projection/4 ')?' @aether-projection/4 ':lines[0]?.startsWith(mark+' @aether-projection/3 ')?' @aether-projection/3 ':' @aether-projection/2 ');if(!lines[0]?.startsWith(prefix))throw new SyntaxError('missing executable projection header');const header=parseMeta<Header>(lines[0].slice(prefix.length));exactObject(header,['6','7','8'].includes(header.format.slice(-1))?['format','target','module','symbols','aliases','link']:['format','target','module','symbols','aliases']);if(['6','7','8'].includes(header.format.slice(-1))){exactObject(header.link,['role','dependencies']);if(!['entry','dependency'].includes(header.link!.role)||!Array.isArray(header.link!.dependencies))throw new SyntaxError('native module role');header.link!.dependencies.forEach(nativeModuleName);}if(!['aether.executable-projection/2','aether.executable-projection/3','aether.executable-projection/4','aether.executable-projection/5','aether.executable-projection/6','aether.executable-projection/7','aether.executable-projection/8'].includes(header.format)||!prefix.includes('projection/'+header.format.slice(-1)+' ')||header.target!==target||!Array.isArray(header.aliases))throw new SyntaxError('projection profile mismatch');exactObject(header.module,['kind','symbol','provenance']);if(header.module.kind!=='Module'||header.symbols.kind!=='SymbolTable')throw new SyntaxError('invalid projection module metadata');const ids=new Set<string>(),aliases=new Set<string>();for(const pair of header.aliases){if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||typeof pair[1]!=='string'||!/^v_[A-Za-z_0-9]+$/.test(pair[1])||ids.has(pair[0])||aliases.has(pair[1]))throw new SyntaxError('invalid symbol aliases');ids.add(pair[0]);aliases.add(pair[1]);}
  const reverse=new Reverse(header),members:Term[]=[],nested:{attributes:Record<string,unknown>;members:Term[]}[]=[];const append=(node:Term)=>(nested.at(-1)?.members??members).push(node);let cursor=2;
  const marker=(name:string)=>mark+' @aether-'+name;
  while(cursor<lines.length){const line=lines[cursor].trim();if(target==='rust'&&header.link?.role==='entry'&&/^pub mod aether_[0-9a-f]{64};$/.test(line)){cursor++;continue;}if(!line){cursor++;continue;}
    if(line.startsWith(marker('nested')+' ')){if(!genericHeader(header)||nested.length>=32)throw new SyntaxError('nested module profile/bound');const attributes=parseMeta<Record<string,unknown>>(line.slice((marker('nested')+' ').length));exactObject(attributes,['kind','symbol','provenance','symbolTable']);if(attributes.kind!=='Module')throw new SyntaxError('nested module metadata');nested.push({attributes,members:[]});cursor++;continue;}if(line===marker('nested-end')){const node=nested.pop();if(!node)throw new SyntaxError('unmatched nested module end');append({...node.attributes,members:node.members} as unknown as Term);cursor++;continue;}
    if(line.startsWith(marker('import')+' ')){const imported=parseMeta<Term>(line.slice((marker('import')+' ').length));if(imported.kind!=='Import')throw new SyntaxError('import metadata');const end=lines.findIndex((l,i)=>i>cursor&&l.trim()===marker('import-end'));if(end<0)throw new SyntaxError('missing import end');append(imported);cursor=end+1;continue;}
    const type=/^(?:const )?type_d[0-9]+(?:: &str)? = (".*");?$/.exec(line);if(type){const value=parseMeta<Term>(readQuoted(type[1]));if(value.kind!=='TypeDecl')throw new SyntaxError('invalid declared type metadata');append(value);cursor++;continue;}
    if(!line.startsWith(marker('function')+' '))throw new SyntaxError('unsupported source outside function');const attributes=parseMeta<Record<string,unknown>>(line.slice((marker('function')+' ').length));exactObject(attributes,['kind','symbol','typeParams','params','returns','capabilities','purity','provenance']);if(attributes.kind!=='FunctionDecl')throw new SyntaxError('function metadata');
    const end=lines.findIndex((l,i)=>i>cursor&&l.trim()===marker('function-end'));if(end<0)throw new SyntaxError('missing function end');const chunk=lines.slice(cursor+1,end);
    const locate=(name:string)=>{const matches=chunk.map((l,i)=>l.trim()===marker(name)?i:-1).filter(i=>i>=0);if(matches.length!==1)throw new SyntaxError('missing/duplicate '+name);return matches[0];};
    const surfacesAt=locate('surfaces'),requiresAt=locate('requires'),ensuresAt=locate('ensures'),ensuresEnd=locate('ensures-end'),bodyEnd=locate('body-end');
    const contracts=chunk.filter(l=>l.trim().startsWith(marker('contract')+' '));if(contracts.length!==1||!['null','present'].includes(contracts[0].trim().slice((marker('contract')+' ').length)))throw new SyntaxError('contract presence');const contractPresent=contracts[0].trim().endsWith(' present');const contractAt=chunk.indexOf(contracts[0]);
    const surfaces:Term[]=[];for(const row of chunk.slice(surfacesAt+1,contractAt)){if(!row.trim())continue;const match=/^(?:(?:let(?: mut)?|const) )?[A-Za-z_][A-Za-z_0-9]* = ae_surface\((".*")\);?$/.exec(row.trim());if(match){const s=parseMeta<Term>(readQuoted(match[1]));if(s.kind!=='Surface')throw new SyntaxError('surface metadata');surfaces.push(s);}else if(!/^\s*(?:let |const )?old_v_/.test(row))throw new SyntaxError('invalid surface source');}
    const bodyMarkers=chunk.map((l,i)=>l.trim().startsWith(marker('body')+' ')?i:-1).filter(i=>i>=0);if(bodyMarkers.length!==1)throw new SyntaxError('body presence');const bodyAt=bodyMarkers[0],bodyPresence=chunk[bodyAt].trim().slice((marker('body')+' ').length);if(!['present','null'].includes(bodyPresence))throw new SyntaxError('invalid body marker');const body=bodyPresence==='null'?null:reverse.body(chunk.slice(bodyAt+1,bodyEnd));
    const clauses=(rows:string[]):Term[]=>rows.filter(l=>l.trim().startsWith('ae_clause(')).map(l=>{const h=syntax(l.trim().replace(/;$/,''));if(h.kind!=='call'||h.args.length!==3||h.args[1].kind!=='str'||h.args[2].kind!=='str'||!['formal','property'].includes(h.args[2].value))throw new SyntaxError('clause signature');return{kind:'Clause',expr:reverse.expr(h.args[0]),label:h.args[1].value,rigor:h.args[2].value as 'formal'};});
    const modifies=chunk.slice(requiresAt+1,bodyAt).filter(l=>l.trim().startsWith(mark+' @modifies ')).map(l=>parseMeta<Term>(l.trim().slice((mark+' @modifies ').length)));
    const requires=clauses(chunk.slice(requiresAt+1,bodyAt)),ensures=clauses(chunk.slice(ensuresAt+1,ensuresEnd));if(!contractPresent&&(requires.length||ensures.length||modifies.length))throw new SyntaxError('clauses attached to absent contract');
    append({...attributes,body,surfaces,contract:contractPresent?{kind:'Contract',requires,ensures,modifies}:null} as unknown as Term);cursor=end+1;
  }
  if(nested.length)throw new SyntaxError('missing nested module end');const module={...header.module,members,symbolTable:header.symbols} as unknown as Term;if(syntaxOnly)return module;validate(module,!header.format.endsWith('/2'),['4','5','6','7','8'].includes(header.format.slice(-1)),['5','6','7','8'].includes(header.format.slice(-1)),['6','7','8'].includes(header.format.slice(-1)),options,genericHeader(header),header.format.endsWith('/8'));if(header.link){const closure=linkExecutableModule(module as Extract<Term,{kind:'Module'}>,options);if(meta(header.link.dependencies)!==meta(closure.dependencies)||header.aliases.some(([id,name])=>name!==nativeSymbolName(module as Extract<Term,{kind:'Module'}>,id)))throw new SyntaxError('native link binding');}if(normalized(emit(module as Extract<Term,{kind:'Module'}>,header,options),target)!==normalized(source,target))throw new SyntaxError('unsupported or altered native scaffolding; no visible code is ignored');return module;
}
export const parseExecutable=(source:string,target:ExecutableTarget,options:ExecutableProjectionOptions={}):Term=>parseNative(source,target,options);
export const projectTypeScriptV2=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'typescript',false);
export const projectPythonV2=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'python',false);
export const projectRustV2=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'rust',false);
export const parseTypeScriptV2=(source:string)=>parseExecutable(source,'typescript');
export const parsePythonV2=(source:string)=>parseExecutable(source,'python');
export const parseRustV2=(source:string)=>parseExecutable(source,'rust');

export const projectTypeScriptV3=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'typescript',true);
export const projectPythonV3=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'python',true);
export const projectRustV3=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'rust',true);

export const projectTypeScriptV4=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'typescript',true,true);
export const projectPythonV4=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'python',true,true);
export const projectRustV4=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'rust',true,true);

export const projectTypeScriptV5=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'typescript',true,true,true);
export const projectPythonV5=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'python',true,true,true);
export const projectRustV5=(module:Term,symbols:SymbolSpace)=>projectProfile(module,symbols,'rust',true,true,true);

export const projectTypeScriptV6=(module:Term,symbols:SymbolSpace,options:ExecutableProjectionOptions={})=>projectProfile(module,symbols,'typescript',true,true,true,true,options);
export const projectPythonV6=(module:Term,symbols:SymbolSpace,options:ExecutableProjectionOptions={})=>projectProfile(module,symbols,'python',true,true,true,true,options);
export const projectRustV6=(module:Term,symbols:SymbolSpace,options:ExecutableProjectionOptions={})=>projectProfile(module,symbols,'rust',true,true,true,true,options);

export const projectTypeScriptV7=(module:Term,symbols:SymbolSpace,options:ExecutableProjectionOptions={})=>projectProfile(module,symbols,'typescript',true,true,true,true,options,'entry',true);
export const projectPythonV7=(module:Term,symbols:SymbolSpace,options:ExecutableProjectionOptions={})=>projectProfile(module,symbols,'python',true,true,true,true,options,'entry',true);
export const projectRustV7=(module:Term,symbols:SymbolSpace,options:ExecutableProjectionOptions={})=>projectProfile(module,symbols,'rust',true,true,true,true,options,'entry',true);
export const projectTypeScriptV8=(module:Term,symbols:SymbolSpace,options:ExecutableProjectionOptions={})=>projectProfile(module,symbols,'typescript',true,true,true,true,options,'entry',true,true);
export const projectPythonV8=(module:Term,symbols:SymbolSpace,options:ExecutableProjectionOptions={})=>projectProfile(module,symbols,'python',true,true,true,true,options,'entry',true,true);
export const projectRustV8=(module:Term,symbols:SymbolSpace,options:ExecutableProjectionOptions={})=>projectProfile(module,symbols,'rust',true,true,true,true,options,'entry',true,true);
