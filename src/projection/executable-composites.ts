/** Native composite support. Values have identities; this is not an AST interpreter. */
const ts = `
let ae_next_id=1;
const ae_id=()=>{if(!Number.isSafeInteger(ae_next_id+1))throw Error('identity_limit');return ae_next_id++;};
export class AeRecord {readonly kind='record';ty:any;fields:Map<string,V>;id:number;frozen:boolean;constructor(ty:any,fields:Map<string,V>,id=ae_id(),frozen=false){this.ty=ty;this.fields=fields;this.id=id;this.frozen=frozen;}}
export class AeSeq {readonly kind='sequence';items:V[];id:number;constructor(items:V[],id=ae_id()){this.items=items;this.id=id;}}
export class AeResult {readonly kind='result';variant:'ok'|'err';value:V;id:number;constructor(variant:'ok'|'err',value:V,id=ae_id()){this.variant=variant;this.value=value;this.id=id;}}
function ae_base(t:any):any{return t.t==='Nominal'?ae_base(t.repr):t.t==='Owned'?ae_base(t.inner):t;}
function ae_check(t:any,v:V,seen=new Set<string>(),depth=0):void{
 if(depth>64)throw Error('type_depth');if(t.t==='Nominal')return ae_check(t.repr,v,seen,depth+1);if(t.t==='Owned')return ae_check(t.inner,v,seen,depth+1);
 if(t.t==='Record'){if(!(v instanceof AeRecord)||ae_base(v.ty).name!==t.name)throw Error('record_type');const key=v.id+':'+JSON.stringify(t);if(seen.has(key))return;seen.add(key);if(v.fields.size!==t.fields.length)throw Error('record_fields');for(const [name,ty]of t.fields){if(!v.fields.has(name))throw Error('record_fields');ae_check(ty,v.fields.get(name)!,seen,depth+1);}return;}
 if(t.t==='Seq'){if(!(v instanceof AeSeq))throw Error('sequence_type');for(const item of v.items)ae_check(t.element,item,seen,depth+1);return;}
 if(t.t==='Result'){if(!(v instanceof AeResult))throw Error('result_type');return ae_check(v.variant==='ok'?t.ok:t.err,v.value,seen,depth+1);}
 ae_scalar_bind(JSON.stringify(t),v);
}
export function ae_bind(text:string,v:V):V{ae_check(JSON.parse(text),v);return v;}
function ae_regions(v:V,out:Set<number>,seen=new Set<number>()):void{if(!(v instanceof AeRecord||v instanceof AeSeq||v instanceof AeResult)||seen.has(v.id))return;seen.add(v.id);if(v instanceof AeRecord){out.add(v.id);v.fields.forEach(x=>ae_regions(x,out,seen));}else if(v instanceof AeSeq)v.items.forEach(x=>ae_regions(x,out,seen));else ae_regions(v.value,out,seen);}
export function ae_arguments(text:string,args:V[]):void{const types=JSON.parse(text),owned:Set<number>[]=[],borrowed=new Set<number>();ae_arity(args,types.length);const visit=(t:any,v:V,region:Set<number>|null,seen=new Set<string>()):void=>{if(t.t==='Nominal')return visit(t.repr,v,region,seen);if(t.t==='Owned'){if(region===null){region=new Set();owned.push(region);}ae_regions(v,region);return visit(t.inner,v,region,seen);}if(v instanceof AeRecord&&t.t==='Record'){const key=v.id+':'+JSON.stringify(t)+':'+owned.indexOf(region!);if(seen.has(key))return;seen.add(key);(region??borrowed).add(v.id);for(const[name,ty]of t.fields)visit(ty,v.fields.get(name)!,region,seen);}else if(v instanceof AeSeq&&t.t==='Seq')v.items.forEach(x=>visit(t.element,x,region,seen));else if(v instanceof AeResult&&t.t==='Result')visit(v.variant==='ok'?t.ok:t.err,v.value,region,seen);};types.forEach((t:any,i:number)=>{ae_check(t,args[i]);visit(t,args[i],null);});const ids=new Set<number>();for(const region of owned)for(const id of region){if(ids.has(id)||borrowed.has(id))throw Error('owned_overlap');ids.add(id);}}
export function ae_snapshot(v:V,memo=new Map<number,V>()):V{if(!(v instanceof AeRecord||v instanceof AeSeq||v instanceof AeResult))return v;const prior=memo.get(v.id);if(prior)return prior;if(v instanceof AeRecord){const copy=new AeRecord(v.ty,new Map(),v.id,true);memo.set(v.id,copy);v.fields.forEach((x,k)=>copy.fields.set(k,ae_snapshot(x,memo)));return copy;}if(v instanceof AeSeq){const copy=new AeSeq([],v.id);memo.set(v.id,copy);copy.items=v.items.map(x=>ae_snapshot(x,memo));return copy;}const copy=new AeResult(v.variant,null,v.id);memo.set(v.id,copy);copy.value=ae_snapshot(v.value,memo);return copy;}
export function ae_record(text:string,fields:[string,V][]):V{const ty=JSON.parse(text),base=ae_base(ty);if(base.t!=='Record'||new Set(fields.map(x=>x[0])).size!==fields.length||fields.length!==base.fields.length)throw Error('record_fields');for(const[name,t]of base.fields){const value=fields.find(x=>x[0]===name);if(!value)throw Error('record_fields');ae_check(t,value[1]);}return new AeRecord(ty,new Map(fields));}
export function ae_field(v:V,name:string):V{if(!(v instanceof AeRecord)||!v.fields.has(name))throw Error('record_field');return v.fields.get(name)!;}
export function ae_set_field(value:V,v:V,name:string):void{if(!(v instanceof AeRecord)||v.frozen)throw Error('record_write');const field=ae_base(v.ty).fields.find((f:any)=>f[0]===name);if(!field)throw Error('record_field');ae_check(field[1],value);v.fields.set(name,value);}
export function ae_seq(text:string,items:V[]):V{const ty=JSON.parse(text);if(ty.t!=='Seq')throw Error('sequence_type');items.forEach(v=>ae_check(ty.element,v));return new AeSeq(items);}
export function ae_items(v:V):V[]{if(!(v instanceof AeSeq))throw Error('sequence_type');return v.items;}
export function ae_index(v:V,index:V):V{const items=ae_items(v),i=ae_num(index);if(i<0n||i>=BigInt(items.length))throw Error('sequence_bounds');return items[Number(i)];}
export const ae_length=(v:V):V=>BigInt(ae_items(v).length);
export function ae_map(ctx:Context,v:V,f:(ctx:Context,args:V[])=>V):V{return new AeSeq([...ae_items(v)].map(item=>{ctx.tick();return f(ctx,[item]);}));}
export function ae_fold(ctx:Context,v:V,initial:V,f:(ctx:Context,args:V[])=>V):V{let result=initial;for(const item of [...ae_items(v)]){ctx.tick();result=f(ctx,[result,item]);}return result;}
export function ae_result_value(text:string,variant:string,value:V):V{const ty=JSON.parse(text);if(ty.t!=='Result'||!['ok','err'].includes(variant))throw Error('result_type');ae_check(ty[variant],value);return new AeResult(variant as 'ok'|'err',value);}
export function ae_match(v:V,ok:(v:V)=>V,err:(v:V)=>V):V{if(!(v instanceof AeResult))throw Error('result_type');return v.variant==='ok'?ok(v.value):err(v.value);}
export function ae_read_place(root:V,path:string[]):V{for(const field of path)root=ae_field(root,field);return root;}
export function ae_set_place(value:V,root:V,path:string[]):void{if(!path.length)throw Error('place_path');let object=root;for(const field of path.slice(0,-1))object=ae_field(object,field);ae_set_field(value,object,path.at(-1)!);}
function ae_equal(a:V,b:V):boolean{if(a instanceof AeRecord||a instanceof AeSeq||a instanceof AeResult)return (b instanceof AeRecord||b instanceof AeSeq||b instanceof AeResult)&&a.kind===b.kind&&a.id===b.id;return a===b;}
export function ae_json(v:V):string{const seen=new Set<number>();const encode=(v:V):any=>{if(v instanceof AeRecord||v instanceof AeSeq||v instanceof AeResult){if(seen.has(v.id))return{tag:'ref',id:String(v.id)};seen.add(v.id);if(v instanceof AeRecord)return{tag:'record',id:String(v.id),fields:[...v.fields].map(([k,x])=>[k,encode(x)])};if(v instanceof AeSeq)return{tag:'sequence',id:String(v.id),items:v.items.map(encode)};return{tag:'result',id:String(v.id),variant:v.variant,value:encode(v.value)};}return v===null?{tag:'null'}:typeof v==='bigint'?{tag:'int',value:String(v)}:typeof v==='boolean'?{tag:'bool',value:v}:{tag:'string',value:v};};return JSON.stringify(encode(v));}
`;
const py = `
_ae_next_id=1
def _ae_id():
    global _ae_next_id
    result=_ae_next_id; _ae_next_id+=1; return result
class AeRecord:
    def __init__(self,ty,fields,id=None,frozen=False): self.ty=ty; self.fields=fields; self.id=_ae_id() if id is None else id; self.frozen=frozen
    def __eq__(self,other): return type(other) is AeRecord and self.id==other.id
class AeSeq:
    def __init__(self,items,id=None): self.items=items; self.id=_ae_id() if id is None else id
    def __eq__(self,other): return type(other) is AeSeq and self.id==other.id
class AeResult:
    def __init__(self,variant,value,id=None): self.variant=variant; self.value=value; self.id=_ae_id() if id is None else id
    def __eq__(self,other): return type(other) is AeResult and self.id==other.id
def _ae_base(t): return _ae_base(t['repr']) if t['t']=='Nominal' else _ae_base(t['inner']) if t['t']=='Owned' else t
def _ae_check(t,v,seen=None,depth=0):
    if depth>64: raise RuntimeError('type_depth')
    if seen is None: seen=set()
    if t['t']=='Nominal': return _ae_check(t['repr'],v,seen,depth+1)
    if t['t']=='Owned': return _ae_check(t['inner'],v,seen,depth+1)
    if t['t']=='Record':
        if type(v) is not AeRecord or _ae_base(v.ty)['name']!=t['name']: raise RuntimeError('record_type')
        key=(v.id,json.dumps(t,sort_keys=True))
        if key in seen: return
        seen.add(key)
        if len(v.fields)!=len(t['fields']): raise RuntimeError('record_fields')
        for name,ty in t['fields']:
            if name not in v.fields: raise RuntimeError('record_fields')
            _ae_check(ty,v.fields[name],seen,depth+1)
        return
    if t['t']=='Seq':
        if type(v) is not AeSeq: raise RuntimeError('sequence_type')
        for x in v.items: _ae_check(t['element'],x,seen,depth+1)
        return
    if t['t']=='Result':
        if type(v) is not AeResult: raise RuntimeError('result_type')
        return _ae_check(t[v.variant],v.value,seen,depth+1)
    _ae_scalar_bind(json.dumps(t),v)
def ae_bind(text,v): _ae_check(json.loads(text),v); return v
def _ae_regions(v,out,seen=None):
    if seen is None: seen=set()
    if type(v) not in (AeRecord,AeSeq,AeResult) or v.id in seen: return
    seen.add(v.id)
    if type(v) is AeRecord:
        out.add(v.id)
        for x in v.fields.values(): _ae_regions(x,out,seen)
    elif type(v) is AeSeq:
        for x in v.items: _ae_regions(x,out,seen)
    else: _ae_regions(v.value,out,seen)
def ae_arguments(text,args):
    types=json.loads(text); ae_arity(args,len(types)); owned=[]; borrowed=set()
    def visit(t,v,region=None,seen=None):
        if seen is None: seen=set()
        if t['t']=='Nominal': return visit(t['repr'],v,region,seen)
        if t['t']=='Owned':
            if region is None: region=set(); owned.append(region)
            _ae_regions(v,region); return visit(t['inner'],v,region,seen)
        if t['t']=='Record':
            key=(v.id,json.dumps(t,sort_keys=True),id(region))
            if key in seen: return
            seen.add(key); (borrowed if region is None else region).add(v.id)
            for name,ty in t['fields']: visit(ty,v.fields[name],region,seen)
        elif t['t']=='Seq':
            for x in v.items: visit(t['element'],x,region,seen)
        elif t['t']=='Result': visit(t[v.variant],v.value,region,seen)
    for t,v in zip(types,args): _ae_check(t,v); visit(t,v)
    seen=set()
    for region in owned:
        if region & (seen|borrowed): raise RuntimeError('owned_overlap')
        seen.update(region)
def ae_snapshot(v,memo=None):
    if memo is None: memo={}
    if type(v) not in (AeRecord,AeSeq,AeResult): return v
    if v.id in memo: return memo[v.id]
    if type(v) is AeRecord:
        copy=AeRecord(v.ty,{},v.id,True); memo[v.id]=copy; copy.fields={k:ae_snapshot(x,memo) for k,x in v.fields.items()}; return copy
    if type(v) is AeSeq:
        copy=AeSeq([],v.id); memo[v.id]=copy; copy.items=[ae_snapshot(x,memo) for x in v.items]; return copy
    copy=AeResult(v.variant,None,v.id); memo[v.id]=copy; copy.value=ae_snapshot(v.value,memo); return copy
def ae_record(text,fields):
    ty=json.loads(text); base=_ae_base(ty); values=dict(fields)
    if base['t']!='Record' or len(values)!=len(fields) or len(fields)!=len(base['fields']): raise RuntimeError('record_fields')
    for name,t in base['fields']:
        if name not in values: raise RuntimeError('record_fields')
        _ae_check(t,values[name])
    return AeRecord(ty,values)
def ae_field(v,name):
    if type(v) is not AeRecord or name not in v.fields: raise RuntimeError('record_field')
    return v.fields[name]
def ae_set_field(value,v,name):
    if type(v) is not AeRecord or v.frozen: raise RuntimeError('record_write')
    field=next((f for f in _ae_base(v.ty)['fields'] if f[0]==name),None)
    if field is None: raise RuntimeError('record_field')
    _ae_check(field[1],value); v.fields[name]=value
def ae_read_place(root,path):
    for field in path: root=ae_field(root,field)
    return root
def ae_set_place(value,root,path):
    if not path: raise RuntimeError('place_path')
    for field in path[:-1]: root=ae_field(root,field)
    ae_set_field(value,root,path[-1])
def ae_seq(text,items):
    ty=json.loads(text)
    if ty['t']!='Seq': raise RuntimeError('sequence_type')
    for x in items: _ae_check(ty['element'],x)
    return AeSeq(items)
def ae_items(v):
    if type(v) is not AeSeq: raise RuntimeError('sequence_type')
    return v.items
def ae_index(v,index):
    items=ae_items(v); i=ae_num(index)
    if i<0 or i>=len(items): raise RuntimeError('sequence_bounds')
    return items[i]
def ae_length(v): return len(ae_items(v))
def ae_map(ctx,v,f):
    out=[]
    for x in list(ae_items(v)): ctx.tick(); out.append(f(ctx,[x]))
    return AeSeq(out)
def ae_fold(ctx,v,initial,f):
    out=initial
    for x in list(ae_items(v)): ctx.tick(); out=f(ctx,[out,x])
    return out
def ae_result_value(text,variant,value):
    ty=json.loads(text)
    if ty['t']!='Result' or variant not in ('ok','err'): raise RuntimeError('result_type')
    _ae_check(ty[variant],value); return AeResult(variant,value)
def ae_match(v,ok,err):
    if type(v) is not AeResult: raise RuntimeError('result_type')
    return ok(v.value) if v.variant=='ok' else err(v.value)
def ae_json(v):
    seen=set()
    def encode(v):
        if type(v) in (AeRecord,AeSeq,AeResult):
            if v.id in seen: return {'tag':'ref','id':str(v.id)}
            seen.add(v.id)
            if type(v) is AeRecord: return {'tag':'record','id':str(v.id),'fields':[[k,encode(x)] for k,x in v.fields.items()]}
            if type(v) is AeSeq: return {'tag':'sequence','id':str(v.id),'items':[encode(x) for x in v.items]}
            return {'tag':'result','id':str(v.id),'variant':v.variant,'value':encode(v.value)}
        return {'tag':'null'} if v is None else {'tag':'int','value':str(v)} if type(v) is int else {'tag':'bool','value':v} if type(v) is bool else {'tag':'string','value':v}
    return json.dumps(encode(v))
`;
const rs = `
use std::rc::Rc;
use std::cell::RefCell;
use std::collections::{HashMap,HashSet};
use std::sync::atomic::{AtomicU64,Ordering as AeOrdering};
static AE_NEXT_ID:AtomicU64=AtomicU64::new(1);
fn ae_id()->u64{AE_NEXT_ID.fetch_update(AeOrdering::SeqCst,AeOrdering::SeqCst,|n|n.checked_add(1)).expect("identity_limit")}
#[derive(Debug)] pub struct AeRecord{pub ty:J,pub fields:Vec<(String,Value)>,pub id:u64,pub frozen:bool}
#[derive(Debug)] pub struct AeSeq{pub items:Vec<Value>,pub id:u64}
#[derive(Debug)] pub struct AeResult{pub variant:String,pub value:Value,pub id:u64}
fn ae_identity(v:&Value)->Option<(u8,u64)>{match v{Value::Record(r)=>Some((0,r.borrow().id)),Value::Seq(r)=>Some((1,r.borrow().id)),Value::Result(r)=>Some((2,r.borrow().id)),_=>None}}
impl PartialEq for Value{fn eq(&self,other:&Self)->bool{match(self,other){(Value::Int(a),Value::Int(b))=>a==b,(Value::Bool(a),Value::Bool(b))=>a==b,(Value::Str(a),Value::Str(b))=>a==b,(Value::Unit,Value::Unit)=>true,_=>ae_identity(self).is_some()&&ae_identity(self)==ae_identity(other)}}}
fn ae_type_base(t:&J)->&J{match t["t"].as_str().unwrap(){"Nominal"=>ae_type_base(&t["repr"]),"Owned"=>ae_type_base(&t["inner"]),_=>t}}
fn ae_check(t:&J,v:&Value,seen:&mut HashSet<String>,depth:usize){if depth>64{panic!("type_depth")}match t["t"].as_str().unwrap(){
 "Nominal"=>ae_check(&t["repr"],v,seen,depth+1),"Owned"=>ae_check(&t["inner"],v,seen,depth+1),
 "Record"=>{let r=if let Value::Record(r)=v{r}else{panic!("record_type")};let (id,ty,fields)={let row=r.borrow();(row.id,row.ty.clone(),row.fields.clone())};if ae_type_base(&ty)["name"]!=t["name"]{panic!("record_type")}if !seen.insert(format!("{}:{}",id,t)){return}let expected=t["fields"].as_array().unwrap();if fields.len()!=expected.len(){panic!("record_fields")}for f in expected{let name=f[0].as_str().unwrap();let value=&fields.iter().find(|(key,_)|key==name).expect("record_fields").1;ae_check(&f[1],value,seen,depth+1);}},
 "Seq"=>{for item in ae_items(v.clone()){ae_check(&t["element"],&item,seen,depth+1);}},
 "Result"=>{let r=if let Value::Result(r)=v{r}else{panic!("result_type")};let (variant,value)={let row=r.borrow();(row.variant.clone(),row.value.clone())};ae_check(&t[&variant],&value,seen,depth+1);},
 _=>{ae_scalar_bind(&t.to_string(),v.clone());}
}}
pub fn ae_bind(text:&str,v:Value)->Value{ae_check(&serde_json::from_str::<J>(text).unwrap(),&v,&mut HashSet::new(),0);v}
fn ae_regions(v:&Value,out:&mut HashSet<u64>,seen:&mut HashSet<u64>){if let Some((_,id))=ae_identity(v){if !seen.insert(id){return}match v{Value::Record(r)=>{out.insert(id);for(_,x)in r.borrow().fields.clone(){ae_regions(&x,out,seen);}},Value::Seq(r)=>{for x in r.borrow().items.clone(){ae_regions(&x,out,seen);}},Value::Result(r)=>ae_regions(&r.borrow().value.clone(),out,seen),_=>{}}}}
pub fn ae_arguments(text:&str,args:&[Value]){let types:J=serde_json::from_str(text).unwrap();let types=types.as_array().unwrap();ae_arity(args,types.len());let mut owned:Vec<HashSet<u64>>=vec![];let mut borrowed=HashSet::new();
 fn visit(t:&J,v:&Value,region:Option<usize>,owned:&mut Vec<HashSet<u64>>,borrowed:&mut HashSet<u64>,seen:&mut HashSet<String>){match t["t"].as_str().unwrap(){"Nominal"=>visit(&t["repr"],v,region,owned,borrowed,seen),"Owned"=>{let index=region.unwrap_or_else(||{owned.push(HashSet::new());owned.len()-1});ae_regions(v,&mut owned[index],&mut HashSet::new());visit(&t["inner"],v,Some(index),owned,borrowed,seen)},"Record"=>{let r=if let Value::Record(r)=v{r}else{panic!("record_type")};let(id,fields)={let row=r.borrow();(row.id,row.fields.clone())};if !seen.insert(format!("{}:{}:{:?}",id,t,region)){return}if let Some(i)=region{owned[i].insert(id);}else{borrowed.insert(id);}for f in t["fields"].as_array().unwrap(){let x=&fields.iter().find(|(name,_)|name==f[0].as_str().unwrap()).unwrap().1;visit(&f[1],x,region,owned,borrowed,seen);}},"Seq"=>{for x in ae_items(v.clone()){visit(&t["element"],&x,region,owned,borrowed,seen);}},"Result"=>{let r=if let Value::Result(r)=v{r}else{panic!("result_type")};let(variant,x)={let row=r.borrow();(row.variant.clone(),row.value.clone())};visit(&t[&variant],&x,region,owned,borrowed,seen)},_=>{}}}
 for(t,v)in types.iter().zip(args){ae_check(t,v,&mut HashSet::new(),0);visit(t,v,None,&mut owned,&mut borrowed,&mut HashSet::new());}let mut all=HashSet::new();for region in owned{for id in region{if borrowed.contains(&id)||!all.insert(id){panic!("owned_overlap")}}}}
pub fn ae_snapshot(v:Value)->Value{fn copy(v:Value,memo:&mut HashMap<u64,Value>)->Value{let id=match ae_identity(&v){Some((_,id))=>id,None=>return v};if let Some(value)=memo.get(&id){return value.clone()}match v{Value::Record(r)=>{let(ty,fields)={let row=r.borrow();(row.ty.clone(),row.fields.clone())};let copy=Rc::new(RefCell::new(AeRecord{ty,fields:vec![],id,frozen:true}));let value=Value::Record(copy.clone());memo.insert(id,value.clone());copy.borrow_mut().fields=fields.into_iter().map(|(k,v)|(k,copy_value(v,memo))).collect();value},Value::Seq(r)=>{let items=r.borrow().items.clone();let copy=Rc::new(RefCell::new(AeSeq{items:vec![],id}));let value=Value::Seq(copy.clone());memo.insert(id,value.clone());copy.borrow_mut().items=items.into_iter().map(|v|copy_value(v,memo)).collect();value},Value::Result(r)=>{let(variant,item)={let row=r.borrow();(row.variant.clone(),row.value.clone())};let copy=Rc::new(RefCell::new(AeResult{variant,value:Value::Unit,id}));let value=Value::Result(copy.clone());memo.insert(id,value.clone());copy.borrow_mut().value=copy_value(item,memo);value},_=>unreachable!()}}fn copy_value(v:Value,memo:&mut HashMap<u64,Value>)->Value{copy(v,memo)}copy(v,&mut HashMap::new())}
pub fn ae_record(text:&str,fields:Vec<(&str,Value)>)->Value{let ty:J=serde_json::from_str(text).unwrap();let base=ae_type_base(&ty);let expected=base["fields"].as_array().expect("record_type");let names:HashSet<&str>=fields.iter().map(|(k,_)|*k).collect();if base["t"]!="Record"||names.len()!=fields.len()||expected.len()!=fields.len(){panic!("record_fields")}for f in expected{let value=&fields.iter().find(|(name,_)|*name==f[0].as_str().unwrap()).expect("record_fields").1;ae_check(&f[1],value,&mut HashSet::new(),0);}Value::Record(Rc::new(RefCell::new(AeRecord{ty,fields:fields.into_iter().map(|(k,v)|(k.to_string(),v)).collect(),id:ae_id(),frozen:false})))}
pub fn ae_field(v:Value,name:&str)->Value{if let Value::Record(r)=v{let out=r.borrow().fields.iter().find(|(k,_)|k==name).expect("record_field").1.clone();out}else{panic!("record_field")}}
pub fn ae_set_field(value:Value,v:Value,name:&str){let r=if let Value::Record(r)=v{r}else{panic!("record_write")};let ty={let row=r.borrow();if row.frozen{panic!("record_write")}let base=ae_type_base(&row.ty);base["fields"].as_array().unwrap().iter().find(|f|f[0].as_str()==Some(name)).expect("record_field")[1].clone()};ae_check(&ty,&value,&mut HashSet::new(),0);r.borrow_mut().fields.iter_mut().find(|(k,_)|k==name).expect("record_field").1=value;}
pub fn ae_read_place(mut root:Value,path:&[&str])->Value{for field in path{root=ae_field(root,field);}root}
macro_rules! ae_read_place {($root:expr,[$($field:expr),*])=>{ae_read_place($root,&[$($field),*])}}
pub fn ae_set_place(value:Value,mut root:Value,path:&[&str]){if path.is_empty(){panic!("place_path")}for field in &path[..path.len()-1]{root=ae_field(root,field);}ae_set_field(value,root,path[path.len()-1]);}
macro_rules! ae_set_place {($value:expr,$root:expr,[$($field:expr),*])=>{{let value=$value;let root=$root;ae_set_place(value,root,&[$($field),*]);}}}
pub fn ae_seq(text:&str,items:Vec<Value>)->Value{let ty:J=serde_json::from_str(text).unwrap();if ty["t"]!="Seq"{panic!("sequence_type")}for x in &items{ae_check(&ty["element"],x,&mut HashSet::new(),0);}ae_sequence(items)}
fn ae_sequence(items:Vec<Value>)->Value{Value::Seq(Rc::new(RefCell::new(AeSeq{items,id:ae_id()})))}
pub fn ae_items(v:Value)->Vec<Value>{if let Value::Seq(r)=v{r.borrow().items.clone()}else{panic!("sequence_type")}}
pub fn ae_index(v:Value,index:Value)->Value{use num_traits::ToPrimitive;let items=ae_items(v);let i=ae_num(index);if i<BigInt::zero()||i>=BigInt::from(items.len()){panic!("sequence_bounds")}items[i.to_usize().unwrap()].clone()}
pub fn ae_length(v:Value)->Value{Value::Int(BigInt::from(ae_items(v).len()))}
pub fn ae_result_value(text:&str,variant:&str,value:Value)->Value{let ty:J=serde_json::from_str(text).unwrap();if ty["t"]!="Result"||!(variant=="ok"||variant=="err"){panic!("result_type")}ae_check(&ty[variant],&value,&mut HashSet::new(),0);Value::Result(Rc::new(RefCell::new(AeResult{variant:variant.to_string(),value,id:ae_id()})))}
macro_rules! ae_record {($ty:expr,[$([$key:expr,$value:expr]),*])=>{{let fields=vec![$(($key,$value)),*];ae_record($ty,fields)}}}
macro_rules! ae_seq {($ty:expr,[$($value:expr),*])=>{ae_seq($ty,vec![$($value),*])}}
macro_rules! ae_map {($ctx:expr,$seq:expr,$f:ident)=>{{let items=ae_items($seq);let mut out=vec![];for x in items{$ctx.tick();out.push($f($ctx,vec![x]));}ae_sequence(out)}}}
macro_rules! ae_fold {($ctx:expr,$seq:expr,$initial:expr,$f:ident)=>{{let items=ae_items($seq);let mut out=$initial;for x in items{$ctx.tick();out=$f($ctx,vec![out,x]);}out}}}
macro_rules! ae_match {($value:expr,$ok:ident,$ok_body:expr,$err:ident,$err_body:expr)=>{{let result=$value;let (variant,value)=if let Value::Result(r)=result{let row=r.borrow();(row.variant.clone(),row.value.clone())}else{panic!("result_type")};if variant=="ok"{let $ok=value;$ok_body}else{let $err=value;$err_body}}}}
pub fn ae_json(v:&Value)->String{fn encode(v:&Value,seen:&mut HashSet<u64>)->J{if let Some((_,id))=ae_identity(v){if !seen.insert(id){return serde_json::json!({"tag":"ref","id":id.to_string()})}return match v{Value::Record(r)=>serde_json::json!({"tag":"record","id":id.to_string(),"fields":r.borrow().fields.iter().map(|(k,x)|serde_json::json!([k,encode(x,seen)])).collect::<Vec<_>>()}),Value::Seq(r)=>serde_json::json!({"tag":"sequence","id":id.to_string(),"items":r.borrow().items.iter().map(|x|encode(x,seen)).collect::<Vec<_>>()}),Value::Result(r)=>serde_json::json!({"tag":"result","id":id.to_string(),"variant":r.borrow().variant,"value":encode(&r.borrow().value,seen)}),_=>unreachable!()};}match v{Value::Unit=>serde_json::json!({"tag":"null"}),Value::Int(n)=>serde_json::json!({"tag":"int","value":n.to_string()}),Value::Bool(b)=>serde_json::json!({"tag":"bool","value":b}),Value::Str(s)=>serde_json::json!({"tag":"string","value":s}),_=>unreachable!()}}encode(v,&mut HashSet::new()).to_string()}
`;
export function extendCompositeRuntime(base:string,target:'typescript'|'python'|'rust'):string {
 if(target==='typescript')return base.replace('bigint | boolean | string | null;','bigint | boolean | string | null | AeRecord | AeSeq | AeResult;').replace('function ae_bind(', 'function ae_scalar_bind(').replace('=>a===b;','=>ae_equal(a,b);').replace('=>a!==b;','=>!ae_equal(a,b);').replace(/^export const ae_json=.*\n/m,'')+ts;
 if(target==='python')return base.replace('def ae_bind(', 'def _ae_scalar_bind(').replace('ae_lit=ae_bind','def ae_lit(t,v): return ae_bind(t,v)').replace(/^def ae_json\(v\):.*\n/m,'')+py;
 return base.replace('#[derive(Clone,Debug,PartialEq)]','#[derive(Clone,Debug)]').replace('Str(String), Unit }','Str(String), Unit, Record(Rc<RefCell<AeRecord>>), Seq(Rc<RefCell<AeSeq>>), Result(Rc<RefCell<AeResult>>) }').replace('pub fn ae_bind(', 'pub fn ae_scalar_bind(').replace(/^pub fn ae_json.*\n/m,'')+rs;
}
