/** Conservative resource envelope before the legacy AE1 reader is entered.
 * The new codec uses independent, disposable dictionaries for each message. */
export const AGENT_IR3_LIMITS=Object.freeze({bytes:1024*1024,roots:64,patches:1024,depth:64,identities:1295,bodyTokens:20000,fieldWork:1000000});
export interface Ir3ReadBudget {pools:Map<string,number>;tokens:number;work:number}
export function checkIr3Payload(text:string,budget:Ir3ReadBudget):void{
 const lines=text.split('\n');if(lines[0]!=='AE1')throw new SyntaxError('AE3 inner version');let cursor=1,width=0;const seen=new Set<string>();
 const type=(src:string):void=>{
  let p=0;const need=(c:string)=>{if(src[p++]!==c)throw new SyntaxError('AE3 type grammar');};
  const index=()=>{const m=/^(0|[1-9][0-9]*)/.exec(src.slice(p));if(!m||Number(m[0])>=AGENT_IR3_LIMITS.identities)throw new SyntaxError('AE3 type index');p+=m[0].length;};
  const read=(depth:number):void=>{if(depth>64||++budget.work>AGENT_IR3_LIMITS.fieldWork)throw new RangeError('AE3 type work/depth');const tag=src[p++];if('IBSU'.includes(tag??'')&&tag)return;if(tag==='D'){if(!/^[0-3][01][0-2]/.test(src.slice(p)))throw new SyntaxError('AE3 fixed type');p+=3;return;}if(tag==='V'){index();return;}if(tag==='N'){index();need('<');read(depth+1);need('>');return;}if(tag==='R'){index();need('<');if(src[p]!=='>'){for(;;){index();need(':');read(depth+1);if(src[p]!==',')break;p++;}}need('>');return;}if(tag==='E'){need('<');read(depth+1);need(',');read(depth+1);need('>');return;}if(tag==='A'||tag==='O'||tag==='K'){need('<');read(depth+1);need('>');return;}if(tag==='F'){need('<');if(src[p]!==';'){for(;;){read(depth+1);if(src[p]!==',')break;p++;}}need(';');read(depth+1);need(';');const end=src.indexOf('>',p);if(end<0||/[<>;]/.test(src.slice(p,end)))throw new SyntaxError('AE3 function type');p=end+1;return;}throw new SyntaxError('AE3 type opcode');};read(0);if(p!==src.length)throw new SyntaxError('AE3 trailing type');
 };
 for(;cursor<lines.length&&lines[cursor].startsWith('§');cursor++){
  const line=lines[cursor],m=/^§([wnysclpv]) ([\s\S]*)$/.exec(line);if(!m||seen.has(m[1]))throw new SyntaxError('AE3 dictionary section');seen.add(m[1]);if(m[1]==='w'){if(!/^[12]$/.test(m[2]))throw new RangeError('AE3 dictionary width');width=Number(m[2]);continue;}
  const entries=m[2].split('|'),count=(budget.pools.get(m[1])??0)+entries.length;if(count>AGENT_IR3_LIMITS.identities)throw new RangeError('AE3 dictionary bound');budget.pools.set(m[1],count);if(m[1]==='y')entries.forEach(type);
 }
 if(!width)throw new SyntaxError('AE3 missing width');const tokens=lines.slice(cursor).join('\n').trim().split(/\s+/).filter(Boolean);budget.tokens+=tokens.length;if(budget.tokens>AGENT_IR3_LIMITS.bodyTokens)throw new RangeError('AE3 token bound');
 for(const token of tokens){if(token.length>16384)throw new RangeError('AE3 token length');if(token[0]==='i'||token[0]==='j'){const start=token[0]==='i'?1:1+width;if(!/^(?:0|[1-9][0-9]*|z[1-9][0-9]*)$/.test(token.slice(start))||token.length-start>4097)throw new SyntaxError('AE3 integer');}
  const end=token[0]==='i'?1:token[0]==='j'?1+width:token.length;
  // Sliding windows include every fixed-width quantity even where enum digits
  // shift alignment. Summing indices too makes this a conservative work bound.
  for(let i=1;i+width<=end;i++){const part=token.slice(i,i+width);if(/^[0-9a-z]+$/.test(part))budget.work+=1+parseInt(part,36);if(budget.work>AGENT_IR3_LIMITS.fieldWork)throw new RangeError('AE3 field work bound');}
 }
}
