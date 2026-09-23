/** Agent-IR v2: canonical binary DAG transport and a separately measured model
 * message. Neither representation changes the existing grouped v1 AST hash. */
import { types as nodeTypes } from 'node:util';
import { LINK_SCHEMA, children, linkGroups, scalarPayload, type NodeKind, type Term } from './ast.ts';
import { GraphStore } from './store.ts';
import type { NodeRef } from './ids.ts';
import { encode, decode } from './agent-ir.ts';
import { validString } from '../fabric/encoding.ts';
import { validateDigest } from '../fabric/identity.ts';

// This list is a wire assignment, never derived from object enumeration order.
const KINDS: readonly NodeKind[] = Object.freeze([
  'Lit','Var','Bin','Un','Cond','Call','Field','RecordLit','ResultValue','MatchResult',
  'SeqLit','SeqIndex','SeqLength','SeqMap','SeqFold','Lambda','Apply','StringOp','IntCast',
  'FixedBin','ForAll','Spawn','Await','Old','ResultRef','Invoke','Place','Let','Assign',
  'If','While','Return','Assert','ExprStmt','Block','Yield','Atomic','Clause','Contract',
  'FunctionDecl','TypeDecl','Surface','Import','Module','SymbolTable',
]);
export const AGENT_IR_V2_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, nodes: 20000, values: 400000, depth: 64, integerDigits: 4096, expandedNodes: 200000 });
const MAGIC = Buffer.from([0x41,0x45,0x42,0x32,0x0d,0x0a]);
const order = (a: string,b: string) => Buffer.compare(Buffer.from(a),Buffer.from(b));

/** Snapshot plain data before inspecting it. Accessors/proxies are never run. */
function snapshot<T>(input:T):T {
  let count=0,textBytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):unknown=>{
    if(++count>AGENT_IR_V2_LIMITS.values||depth>AGENT_IR_V2_LIMITS.depth)throw new RangeError('Agent-IR value/depth limit');
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='string'){validString(value);textBytes+=Buffer.byteLength(value);if(textBytes>AGENT_IR_V2_LIMITS.bytes)throw new RangeError('Agent-IR text byte limit');return value;}
    if(typeof value==='bigint'){if(String(value).replace('-','').length>AGENT_IR_V2_LIMITS.integerDigits)throw new RangeError('Agent-IR integer limit');return value;}
    if(typeof value==='number'){if(!Number.isSafeInteger(value)||Object.is(value,-0))throw new TypeError('Agent-IR requires canonical integer scalars');return value;}
    if(!value||typeof value!=='object'||nodeTypes.isProxy(value)||active.has(value))throw new TypeError('Agent-IR rejects opaque/cyclic data');
    const proto=Object.getPrototypeOf(value);if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)throw new TypeError('Agent-IR requires plain data');
    active.add(value);
    try{
      if(Array.isArray(value)){
        if(Reflect.ownKeys(value).length!==value.length+1)throw new TypeError('Agent-IR rejects sparse/extended arrays');
        return Array.from({length:value.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable)throw new TypeError('Agent-IR rejects array accessors');return visit(d.value,depth+1);});
      }
      const result=Object.create(null) as Record<string,unknown>;
      for(const key of Reflect.ownKeys(value)){if(typeof key!=='string'||key==='__proto__')throw new TypeError('Agent-IR rejects reserved keys');validString(key);const d=Object.getOwnPropertyDescriptor(value,key)!;if(!('value'in d)||!d.enumerable)throw new TypeError('Agent-IR rejects accessors');Object.defineProperty(result,key,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});}
      return result;
    }finally{active.delete(value);}
  };return visit(input,0) as T;
}
function supported(term:Term):{term:Term;store:GraphStore;root:NodeRef}{
  term=snapshot(term);let count=0;
  const walk=(node:Term,depth:number):void=>{if(++count>AGENT_IR_V2_LIMITS.expandedNodes||depth>AGENT_IR_V2_LIMITS.depth)throw new RangeError('Agent-IR AST expansion limit');if(!KINDS.includes(node.kind))throw new TypeError('unsupported Agent-IR AST opcode');children(node).forEach(child=>walk(child,depth+1));};walk(term,0);
  const store=new GraphStore(),root=store.intern(term);
  // AE1 remains the declared AST schema. Unknown/dropped scalar fields are not
  // silently admitted into the new transport; all existing supported terms fit.
  if(store.intern(decode(encode(term).text))!==root)throw new TypeError('noncanonical or unsupported Agent-IR AST fields');
  return{term,store,root};
}
class Writer{
  private chunks:Buffer[]=[];private size=0;
  bytes(value:Uint8Array):void{this.size+=value.length;if(this.size>AGENT_IR_V2_LIMITS.bytes)throw new RangeError('Agent-IR byte limit');this.chunks.push(Buffer.from(value));}
  uint(value:number):void{if(!Number.isSafeInteger(value)||value<0)throw new TypeError('invalid Agent-IR unsigned integer');let n=BigInt(value);const out:number[]=[];do{const part=Number(n&127n);n>>=7n;out.push(part|(n?128:0));}while(n);this.bytes(Uint8Array.from(out));}
  text(value:string):void{const bytes=Buffer.from(value);this.uint(bytes.length);this.bytes(bytes);}
  finish():Uint8Array{return Buffer.concat(this.chunks);}
}
class Reader{
  offset=0;values=0;
  readonly bytes:Buffer;
  constructor(bytes:Buffer){this.bytes=bytes;if(bytes.length>AGENT_IR_V2_LIMITS.bytes)throw new RangeError('Agent-IR byte limit');}
  take(length:number):Buffer{if(!Number.isSafeInteger(length)||length<0||length>this.bytes.length-this.offset)throw new SyntaxError('truncated Agent-IR binary');const result=this.bytes.subarray(this.offset,this.offset+length);this.offset+=length;return result;}
  uint(max=Number.MAX_SAFE_INTEGER):number{let value=0n,shift=0n,last=0;for(let i=0;i<8;i++){last=this.take(1)[0];value|=BigInt(last&127)<<shift;if(!(last&128)){if(i&&last===0)throw new SyntaxError('noncanonical Agent-IR varint');if(value>BigInt(max))throw new RangeError('Agent-IR count limit');return Number(value);}shift+=7n;}throw new RangeError('Agent-IR varint overflow');}
  text():string{const bytes=this.take(this.uint(AGENT_IR_V2_LIMITS.bytes)),value=bytes.toString('utf8');if(!Buffer.from(value).equals(bytes))throw new SyntaxError('invalid Agent-IR UTF-8');return value;}
}
function stringsIn(value:unknown,strings:Set<string>):void{if(typeof value==='string')strings.add(value);else if(Array.isArray(value))value.forEach(v=>stringsIn(v,strings));else if(value&&typeof value==='object')for(const[key,v]of Object.entries(value)){strings.add(key);stringsIn(v,strings);}}
function scalarWrite(writer:Writer,value:unknown,strings:ReadonlyMap<string,number>):void{
  if(value===null){writer.uint(0);return;}if(value===false){writer.uint(1);return;}if(value===true){writer.uint(2);return;}
  if(typeof value==='bigint'||typeof value==='number'){writer.uint(typeof value==='bigint'?3:4);writer.text(String(value));return;}
  if(typeof value==='string'){writer.uint(5);writer.uint(strings.get(value)!);return;}
  if(Array.isArray(value)){writer.uint(6);writer.uint(value.length);value.forEach(v=>scalarWrite(writer,v,strings));return;}
  if(value&&typeof value==='object'){writer.uint(7);const entries=Object.entries(value).sort(([a],[b])=>order(a,b));writer.uint(entries.length);for(const[key,v]of entries){writer.uint(strings.get(key)!);scalarWrite(writer,v,strings);}return;}
  throw new TypeError('unsupported Agent-IR scalar');
}
function scalarRead(reader:Reader,strings:readonly string[],depth=0):unknown{
  if(++reader.values>AGENT_IR_V2_LIMITS.values||depth>AGENT_IR_V2_LIMITS.depth)throw new RangeError('Agent-IR scalar limit');
  const string=()=>{const index=reader.uint(strings.length);if(index>=strings.length)throw new SyntaxError('Agent-IR dictionary index');return strings[index];};
  switch(reader.uint(7)){
    case 0:return null;case 1:return false;case 2:return true;
    case 3:case 4:{const tag=reader.bytes[reader.offset-1],value=reader.text();if(!/^(0|-?[1-9][0-9]*)$/.test(value)||value.replace('-','').length>AGENT_IR_V2_LIMITS.integerDigits)throw new SyntaxError('invalid Agent-IR integer');if(tag===3)return BigInt(value);const number=Number(value);if(!Number.isSafeInteger(number))throw new RangeError('unsafe Agent-IR number');return number;}
    case 5:return string();
    case 6:{const count=reader.uint(AGENT_IR_V2_LIMITS.values);return Array.from({length:count},()=>scalarRead(reader,strings,depth+1));}
    case 7:{const count=reader.uint(AGENT_IR_V2_LIMITS.values),value=Object.create(null);let previous:string|null=null;for(let i=0;i<count;i++){const key=string();if(previous!==null&&order(previous,key)>=0)throw new SyntaxError('noncanonical Agent-IR object keys');previous=key;Object.defineProperty(value,key,{value:scalarRead(reader,strings,depth+1),enumerable:true,writable:true,configurable:true});}return value;}
  }throw new SyntaxError('invalid Agent-IR scalar tag');
}
export function encodeAgentIrBinary(input:Term):Uint8Array{
  const{store,root}=supported(input),refs:NodeRef[]=[],indices=new Map<NodeRef,number>(),costs=new Map<NodeRef,number>();let totalExpansion=0;
  const visit=(ref:NodeRef):void=>{if(indices.has(ref))return;const kids=children(store.get(ref));kids.forEach(visit);const cost=1+kids.reduce((sum,child)=>sum+costs.get(child)!,0);totalExpansion+=cost;if(totalExpansion>AGENT_IR_V2_LIMITS.values)throw new RangeError('Agent-IR aggregate expansion limit');costs.set(ref,cost);if(refs.length>=AGENT_IR_V2_LIMITS.nodes)throw new RangeError('Agent-IR node limit');indices.set(ref,refs.length);refs.push(ref);};visit(root);
  const payloads=refs.map(ref=>{const{kind:_,...payload}=scalarPayload(store.get(ref));return payload;}),strings=new Set<string>();payloads.forEach(payload=>stringsIn(payload,strings));
  const dictionary=[...strings].sort(order),lookup=new Map(dictionary.map((s,i)=>[s,i])),writer=new Writer();writer.bytes(MAGIC);writer.text(root);writer.uint(dictionary.length);dictionary.forEach(s=>writer.text(s));writer.uint(refs.length);
  refs.forEach((ref,index)=>{const node=store.get(ref);writer.uint(KINDS.indexOf(node.kind));scalarWrite(writer,payloads[index],lookup);for(const group of linkGroups(node)){writer.uint(group.links.length);group.links.forEach(child=>writer.uint(indices.get(child)!));}});
  return writer.finish();
}
export function decodeAgentIrBinary(bytes:Uint8Array):Term{
  if(!(bytes instanceof Uint8Array)||nodeTypes.isProxy(bytes))throw new TypeError('Agent-IR binary bytes required');const reader=new Reader(Buffer.from(bytes));if(!reader.take(MAGIC.length).equals(MAGIC))throw new SyntaxError('unsupported Agent-IR binary version');
  const root=reader.text();validateDigest(root,'ast');const strings:string[]=[],count=reader.uint(AGENT_IR_V2_LIMITS.values);for(let i=0;i<count;i++){const value=reader.text();if(i&&order(strings[i-1],value)>=0)throw new SyntaxError('noncanonical Agent-IR dictionary');strings.push(value);}
  const nodes=reader.uint(AGENT_IR_V2_LIMITS.nodes);if(!nodes)throw new SyntaxError('empty Agent-IR graph');const terms:Term[]=[],costs:number[]=[],depths:number[]=[],store=new GraphStore(),refs=new Set<string>();let totalExpansion=0;
  for(let index=0;index<nodes;index++){
    const opcode=reader.uint(KINDS.length-1),kind=KINDS[opcode],payload=scalarRead(reader,strings);if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.hasOwn(payload,'kind'))throw new SyntaxError('invalid Agent-IR scalar payload');const node={...payload,kind} as Record<string,unknown>;let cost=1,depth=0;
    for(const field of LINK_SCHEMA[kind]){const length=reader.uint(AGENT_IR_V2_LIMITS.expandedNodes);if(field.arity==='one'&&length!==1||field.arity==='opt'&&length>1)throw new SyntaxError('invalid Agent-IR grouped arity');const children:Term[]=[];for(let i=0;i<length;i++){const child=reader.uint(index);if(child>=index)throw new SyntaxError('non-topological Agent-IR child');cost+=costs[child];depth=Math.max(depth,depths[child]+1);if(cost>AGENT_IR_V2_LIMITS.expandedNodes||depth>AGENT_IR_V2_LIMITS.depth)throw new RangeError('Agent-IR expansion/depth limit');children.push(terms[child]);}
      if(field.arity==='pairs'){const names=node[field.field];if(!Array.isArray(names)||names.length!==length||names.some(n=>typeof n!=='string'))throw new SyntaxError('invalid Agent-IR paired labels');node[field.field]=names.map((name,i)=>[name,children[i]]);}else{if(Object.hasOwn(node,field.field))throw new SyntaxError('Agent-IR link duplicated as scalar');node[field.field]=field.arity==='one'?children[0]:field.arity==='opt'?children[0]??null:children;}}
    totalExpansion+=cost;if(totalExpansion>AGENT_IR_V2_LIMITS.values)throw new RangeError('Agent-IR aggregate expansion limit');const term=node as unknown as Term,ref=store.intern(term);if(refs.has(ref))throw new SyntaxError('duplicate Agent-IR DAG record');refs.add(ref);terms.push(term);costs.push(cost);depths.push(depth);
  }
  if(reader.offset!==reader.bytes.length)throw new SyntaxError('trailing Agent-IR bytes');const term=terms.at(-1)!;if(store.intern(term)!==root)throw new SyntaxError('Agent-IR root mismatch');if(!Buffer.from(encodeAgentIrBinary(term)).equals(reader.bytes))throw new SyntaxError('noncanonical or unreachable Agent-IR records');return term;
}
function modelBounds(message:string):void{validString(message);if(Buffer.byteLength(message)>AGENT_IR_V2_LIMITS.bytes)throw new RangeError('Agent-IR model message limit');let separators=0;for(const ch of message)if((ch==='|'||/\s/.test(ch))&&++separators>AGENT_IR_V2_LIMITS.values)throw new RangeError('Agent-IR model field limit');}
export function encodeAgentIrModel(term:Term):string{const value=supported(term),message=`AE2\n${value.root}\n${encode(value.term).text}`;modelBounds(message);return message;}
export function decodeAgentIrModel(message:string):Term{
  modelBounds(message);const first=message.indexOf('\n'),second=message.indexOf('\n',first+1);if(message.slice(0,first)!=='AE2'||second<0)throw new SyntaxError('unsupported Agent-IR model version');const root=message.slice(first+1,second);validateDigest(root,'ast');const term=decode(message.slice(second+1)),checked=supported(term);if(root!==checked.root||encodeAgentIrModel(term)!==message)throw new SyntaxError('noncanonical Agent-IR model message/root');return term;
}
