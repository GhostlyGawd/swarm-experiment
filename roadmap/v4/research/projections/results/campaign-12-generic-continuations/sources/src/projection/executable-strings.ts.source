import {STRING_UNICODE_DATA} from './executable-string-data.ts';
const ts=`
const ae_unicode=JSON.parse(AE_UNICODE_DATA),ae_lower=new Map<number,string>(ae_unicode.lower),ae_upper=new Map<number,string>(ae_unicode.upper);
const ae_in_ranges=(cp:number,ranges:number[][]):boolean=>ranges.some(([a,b])=>cp>=a&&cp<=b);
function ae_text(v:V):string{if(typeof v!=='string'||[...v].some(c=>c.codePointAt(0)!>=0xd800&&c.codePointAt(0)!<=0xdfff))throw Error('string_scalar');return v;}
function ae_case(text:string,upper:boolean):string{const chars=[...text],cased=(index:number,step:number)=>{while(index>=0&&index<chars.length){const cp=chars[index].codePointAt(0)!;if(!ae_in_ranges(cp,ae_unicode.ignorable))return ae_in_ranges(cp,ae_unicode.cased);index+=step;}return false;};return chars.map((c,i)=>{const cp=c.codePointAt(0)!;return !upper&&cp===931&&cased(i-1,-1)&&!cased(i+1,1)?'ς':(upper?ae_upper:ae_lower).get(cp)??c;}).join('');}
export function ae_string_op(op:string,args:V[]):V{const arity:Record<string,number>={strlen:1,contains:2,slice:3,lower:1,upper:1,trim:1};if(!Object.hasOwn(arity,op)||args.length!==arity[op])throw Error('string_arity');const text=ae_text(args[0]),chars=[...text];if(op==='strlen')return BigInt(chars.length);if(op==='contains')return text.includes(ae_text(args[1]));if(op==='slice'){const clamp=(v:V)=>{const n=ae_num(v),len=BigInt(chars.length);return Number(n< -len?-len:n>len?len:n);};return chars.slice(clamp(args[1]),clamp(args[2])).join('');}if(op==='lower'||op==='upper')return ae_case(text,op==='upper');let start=0,end=chars.length;while(start<end&&ae_in_ranges(chars[start].codePointAt(0)!,ae_unicode.trim))start++;while(end>start&&ae_in_ranges(chars[end-1].codePointAt(0)!,ae_unicode.trim))end--;return chars.slice(start,end).join('');}
`;
const py=`
_ae_unicode=json.loads(AE_UNICODE_DATA)
_ae_lower=dict(_ae_unicode['lower']); _ae_upper=dict(_ae_unicode['upper'])
def _ae_in_ranges(cp,ranges): return any(a<=cp<=b for a,b in ranges)
def _ae_text(v):
    if type(v) is not str or any(0xd800<=ord(c)<=0xdfff for c in v): raise RuntimeError('string_scalar')
    return v
def _ae_case(text,upper):
    def cased(index,step):
        while 0<=index<len(text):
            cp=ord(text[index])
            if not _ae_in_ranges(cp,_ae_unicode['ignorable']): return _ae_in_ranges(cp,_ae_unicode['cased'])
            index+=step
        return False
    mapping=_ae_upper if upper else _ae_lower
    return ''.join('ς' if not upper and ord(c)==931 and cased(i-1,-1) and not cased(i+1,1) else mapping.get(ord(c),c) for i,c in enumerate(text))
def ae_string_op(op,args):
    arity={'strlen':1,'contains':2,'slice':3,'lower':1,'upper':1,'trim':1}
    if op not in arity or len(args)!=arity[op]: raise RuntimeError('string_arity')
    text=_ae_text(args[0])
    if op=='strlen': return len(text)
    if op=='contains': return _ae_text(args[1]) in text
    if op=='slice':
        start=ae_num(args[1]); end=ae_num(args[2]); length=len(text)
        return text[max(-length,min(length,start)):max(-length,min(length,end))]
    if op in ('lower','upper'): return _ae_case(text,op=='upper')
    start=0; end=len(text)
    while start<end and _ae_in_ranges(ord(text[start]),_ae_unicode['trim']): start+=1
    while end>start and _ae_in_ranges(ord(text[end-1]),_ae_unicode['trim']): end-=1
    return text[start:end]
`;
const rs=`
struct AeUnicode {lower:HashMap<u32,String>,upper:HashMap<u32,String>,cased:Vec<(u32,u32)>,ignorable:Vec<(u32,u32)>,trim:Vec<(u32,u32)>}
fn ae_unicode()->&'static AeUnicode {static DATA:std::sync::OnceLock<AeUnicode>=std::sync::OnceLock::new();DATA.get_or_init(||{let data:J=serde_json::from_str(AE_UNICODE_DATA).unwrap();let map=|key:&str|data[key].as_array().unwrap().iter().map(|r|(r[0].as_u64().unwrap() as u32,r[1].as_str().unwrap().to_string())).collect();let ranges=|key:&str|data[key].as_array().unwrap().iter().map(|r|(r[0].as_u64().unwrap() as u32,r[1].as_u64().unwrap() as u32)).collect();AeUnicode{lower:map("lower"),upper:map("upper"),cased:ranges("cased"),ignorable:ranges("ignorable"),trim:ranges("trim")}})}
fn ae_in_ranges(cp:u32,ranges:&[(u32,u32)])->bool{ranges.iter().any(|(a,b)|cp>=*a&&cp<=*b)}
fn ae_text(v:&Value)->&str{if let Value::Str(s)=v{s}else{panic!("string_scalar")}}
pub fn ae_string_op(op:&str,args:Vec<Value>)->Value{let arity=match op{"strlen"|"lower"|"upper"|"trim"=>1,"contains"=>2,"slice"=>3,_=>panic!("string_arity")};if args.len()!=arity{panic!("string_arity")}let text=ae_text(&args[0]);let chars:Vec<char>=text.chars().collect();let data=ae_unicode();match op{"strlen"=>Value::Int(BigInt::from(chars.len())),"contains"=>ae_bool(text.contains(ae_text(&args[1]))),"slice"=>{let bound=|v:Value|{let n=ae_num(v);let len=BigInt::from(chars.len());if n< -&len{0}else if n< BigInt::zero(){(n+&len).to_string().parse::<usize>().unwrap()}else if n>=len{chars.len()}else{n.to_string().parse::<usize>().unwrap()}};let start=bound(args[1].clone());let end=bound(args[2].clone()).max(start);Value::Str(chars[start..end].iter().collect())},"trim"=>{let mut start=0;let mut end=chars.len();while start<end&&ae_in_ranges(chars[start] as u32,&data.trim){start+=1}while end>start&&ae_in_ranges(chars[end-1] as u32,&data.trim){end-=1}Value::Str(chars[start..end].iter().collect())},_=>{let cased=|mut index:isize,step:isize|{while index>=0&&(index as usize)<chars.len(){let cp=chars[index as usize] as u32;if !ae_in_ranges(cp,&data.ignorable){return ae_in_ranges(cp,&data.cased)}index+=step;}false};let upper=op=="upper";let map=if upper{&data.upper}else{&data.lower};let mut out=String::new();for(i,c)in chars.iter().enumerate(){let cp=*c as u32;if !upper&&cp==931&&cased(i as isize-1,-1)&&!cased(i as isize+1,1){out.push('ς')}else if let Some(s)=map.get(&cp){out.push_str(s)}else{out.push(*c)}}Value::Str(out)}}}
macro_rules! ae_string_op {($op:expr,[$($value:expr),*])=>{{let args=vec![$($value),*];ae_string_op($op,args)}}}
`;
export function extendStringRuntime(base:string,target:'typescript'|'python'|'rust'):string{
 // JSON contains only well-formed scalars. Rust raw literals avoid target-specific escapes.
 const data=target==='typescript'?`const AE_UNICODE_DATA=${JSON.stringify(STRING_UNICODE_DATA)};\n`:target==='python'?`AE_UNICODE_DATA=${JSON.stringify(STRING_UNICODE_DATA)}\n`:`const AE_UNICODE_DATA:&str=r###"${STRING_UNICODE_DATA}"###;\n`;
 return base+'\n'+data+(target==='typescript'?ts:target==='python'?py:rs);
}
