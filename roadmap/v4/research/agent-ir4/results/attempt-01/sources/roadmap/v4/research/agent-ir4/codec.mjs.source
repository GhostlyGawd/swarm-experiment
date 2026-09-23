/** Research-only closed-bundle AE4 candidate. Every imported AST address must be
 * an included root. The address is reconstructed from that root's exact term,
 * while the original complete-snapshot digest stays in the paid header. */
import {GraphStore} from '../../../../src/tier1/store.ts';
import {decode,IrContext} from '../../../../src/tier1/agent-ir.ts';
import {expandIr3} from '../../../../src/tier1/agent-ir-v3-compact.ts';
import {agentIr3Snapshot,encodeAgentIr3,AGENT_IR3_LIMITS} from '../../../../src/tier1/agent-ir-v3.ts';
import {checkIr3Payload} from '../../../../src/tier1/agent-ir-v3-bounds.ts';
import {validString} from '../../../../src/fabric/encoding.ts';

const AST=/^ast:b3:[0-9a-f]{64}$/;
const ENUM=new Set(['kind','t','op','variant','rigor','purity','objective','d','overflow']);
const ALPHABET='abcdefghijklmnopqrstuvwxyz234567';
const synthetic=index=>'ast:b3:'+(index+1).toString(16).padStart(64,'0');
const digestDecimal=hex=>BigInt('0x'+hex).toString();
const validCount=(s,max)=>{if(!/^(0|[1-9][0-9]*)$/.test(s)||s.length>9||Number(s)>max)throw new SyntaxError('AE4 count');return Number(s);};
const validDigest=s=>{if(!/^(0|[1-9][0-9]*)$/.test(s)||s.length>78||BigInt(s)>>256n)throw new SyntaxError('AE4 digest');return BigInt(s).toString(16).padStart(64,'0');};
const mapStrings=(value,fn,key='')=>{
 if(typeof value==='string'&&!ENUM.has(key))return fn(value);
 if(Array.isArray(value))return value.map(v=>mapStrings(v,fn));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,mapStrings(v,fn,k)]));
 return value;
};
function candidateRoots(snapshot){
 const byRef=new Map(snapshot.rootRefs.map((ref,index)=>[ref,index]));let refs=0;
 const roots=snapshot.roots.map(root=>mapStrings(root,value=>{
  if(!AST.test(value))return value;
  const index=byRef.get(value);if(index===undefined)throw new SyntaxError('AE4 requires all AST dependencies in its paid root list');
  refs++;return synthetic(index);
 }));
 return refs?roots:null;
}
export function encodeAe4(snapshot,format='AE3C'){
 if(!['AE3','AE3C'].includes(format))throw new TypeError('AE4 format');
 // Also enforces the existing private AE3 snapshot brand before reading it.
 encodeAgentIr3(snapshot,undefined,format);
 const roots=candidateRoots(snapshot);if(!roots)return null;
 const shifted=agentIr3Snapshot(roots),base=encodeAgentIr3(shifted,undefined,format);
 return `${format==='AE3C'?'AE4C':'AE4'} F ${digestDecimal(snapshot.digest)}\n${base.slice(base.indexOf('\n')+1)}`;
}
class Reader{
 constructor(wire){validString(wire);this.bytes=Buffer.from(wire);if(this.bytes.length>AGENT_IR3_LIMITS.bytes)throw new RangeError('AE4 byte limit');this.offset=0;}
 line(){const end=this.bytes.indexOf(10,this.offset);if(end<0)throw new SyntaxError('AE4 truncated line');const str=this.bytes.subarray(this.offset,end).toString();this.offset=end+1;return str;}
 frame(){const end=this.bytes.indexOf(58,this.offset);if(end<0)throw new SyntaxError('AE4 frame length');const length=validCount(this.bytes.subarray(this.offset,end).toString(),AGENT_IR3_LIMITS.bytes);this.offset=end+1;if(length>this.bytes.length-this.offset)throw new SyntaxError('AE4 truncated frame');const bytes=this.bytes.subarray(this.offset,this.offset+length);this.offset+=length;const str=bytes.toString('utf8');if(!Buffer.from(str).equals(bytes))throw new SyntaxError('AE4 frame UTF-8');return str;}
}
function unpack(count,text,bits){
 if(!count){if(text!=='-')throw new SyntaxError('AE4 empty identity table');return [];}
 if(!/^(0|[1-9][0-9]*)$/.test(text)||text.length>Math.ceil(count*bits*0.302)+1)throw new SyntaxError('AE4 identity integer');
 let n=BigInt(text);if(n>>BigInt(count*bits))throw new SyntaxError('AE4 identity overflow');
 const mask=(1n<<BigInt(bits))-1n,rows=[];
 for(let i=0;i<count;i++){
  let value=n&mask;n>>=BigInt(bits);
  if(bits===256)rows.unshift('ast:b3:'+value.toString(16).padStart(64,'0'));
  else{let sym='';for(let j=0;j<22;j++){sym=ALPHABET[Number(value&31n)]+sym;value>>=5n;}rows.unshift('sym:'+sym);}
 }
 if(new Set(rows).size!==rows.length||rows.some((row,i)=>i>0&&rows[i-1]>=row))throw new SyntaxError('AE4 identity order');
 return rows;
}
function restore(value,table,key=''){
 if(typeof value==='string'&&!ENUM.has(key)){
  const alias=/^([sa])(0|[1-9][0-9]*)$/.exec(value);
  if(alias){const row=(alias[1]==='s'?table.symbols:table.asts)[Number(alias[2])];if(row===undefined)throw new SyntaxError('AE4 identity index');return row;}
  return value.replace(/%([0-9A-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
 }
 if(Array.isArray(value))return value.map(x=>restore(x,table));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,restore(v,table,k)]));
 return value;
}
export function decodeAe4(wire){
 const reader=new Reader(wire),header=reader.line().split(' ');
 if(header.length!==3||!['AE4','AE4C'].includes(header[0])||header[1]!=='F')throw new SyntaxError('AE4 header');
 const target=validDigest(header[2]),identity=reader.line().split(' ');
 if(identity.length!==4)throw new SyntaxError('AE4 identity header');
 const table={symbols:unpack(validCount(identity[0],AGENT_IR3_LIMITS.identities),identity[1],110),asts:unpack(validCount(identity[2],AGENT_IR3_LIMITS.identities),identity[3],256)};
 const count=validCount(reader.line(),AGENT_IR3_LIMITS.roots),ctx=new IrContext(),budget={pools:new Map(),tokens:0,work:0},shifted=[];
 for(let i=0;i<count;i++){
  const frame=reader.frame(),body=header[0]==='AE4C'?expandIr3(frame):frame;
  checkIr3Payload(body,budget);shifted.push(restore(decode(body,ctx),table));
 }
 if(reader.offset!==reader.bytes.length)throw new SyntaxError('AE4 trailing data');
 // The dictionary permits only small surrogate addresses. Derive each original
 // root in dependency order; cyclic or absent roots fail closed.
 const actual=new Array(count),refs=new Array(count),pending=new Set(),store=new GraphStore();
 function materialize(i){
  if(actual[i])return actual[i];if(pending.has(i))throw new SyntaxError('AE4 cyclic dependency');pending.add(i);
  const root=mapStrings(shifted[i],value=>{
   if(!AST.test(value))return value;
   const n=BigInt('0x'+value.slice(7));if(n<1n||n>BigInt(count))throw new SyntaxError('AE4 unbound dependency');
   const index=Number(n)-1;materialize(index);return refs[index];
  });
  refs[i]=store.intern(root);actual[i]=root;pending.delete(i);return root;
 }
 for(let i=0;i<count;i++)materialize(i);
 const snapshot=agentIr3Snapshot(actual);
 if(snapshot.digest!==target)throw new SyntaxError('AE4 target mismatch');
 const canonical=encodeAe4(snapshot,header[0]==='AE4C'?'AE3C':'AE3');
 if(canonical!==wire)throw new SyntaxError('AE4 noncanonical');
 return snapshot;
}
