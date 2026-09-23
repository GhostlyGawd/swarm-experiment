/** Fixed opcode spelling, not an external dictionary: small symbol uses are
 * unused one-letter tokens; integer literals use their ordinary decimal text.
 * Every symbol-to-identity mapping remains in the paid AE1 dictionary/table. */
const VARIABLES=[...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter(c=>!'cfoqtuwyEHNT'.includes(c));
function convert(text:string,restore:boolean):string{
 const lines=text.split('\n');if(lines[0]!== (restore?'AE1C':'AE1'))throw new SyntaxError('AE3 opcode profile');let p=1,width=0;for(;p<lines.length&&lines[p].startsWith('§');p++){const m=/^§w ([12])$/.exec(lines[p]);if(m)width=Number(m[1]);}if(!width)throw new SyntaxError('AE3 compact width');
 const words=lines.slice(p).join('\n').trim().split(/\s+/).filter(Boolean).map(token=>{
  if(restore){if(/^(0|-?[1-9][0-9]*)$/.test(token))return'i'+(token[0]==='-'?'z'+token.slice(1):token);const index=VARIABLES.indexOf(token);if(index>=0)return'v'+index.toString(36).padStart(width,'0');return token;}
  if(/^i(?:0|[1-9][0-9]*|z[1-9][0-9]*)$/.test(token))return token[1]==='z'?'-'+token.slice(2):token.slice(1);if(token[0]==='v'&&token.length===width+1){const index=parseInt(token.slice(1),36);if(index<VARIABLES.length)return VARIABLES[index];}return token;
 });lines[0]=restore?'AE1':'AE1C';return lines.slice(0,p).join('\n')+'\n'+words.join(' ');
}
export const compactIr3=(text:string)=>convert(text,false);
export const expandIr3=(text:string)=>convert(text,true);
