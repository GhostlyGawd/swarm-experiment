import type { ExecutableTarget } from './executable-runtime.ts';

/** V15-only native custody. The whitelist comes from independently checked
 * AST declaration/lambda roots in the projection header. */
export function extendContractClosureRuntime(base: string, target: ExecutableTarget, certificates: readonly string[]): string {
  const allowed = JSON.stringify(certificates);
  if (target === 'typescript') return base + `
const ae_contract_allowed = new Set<string>(${allowed});
const ae_contract_custody = new WeakMap<AeClosure,{certificate:string,captures:V[],body:AeClosure['body'],meta:string}>();
const ae_contract_scalar = (v:V):boolean => v===null||['bigint','boolean','string'].includes(typeof v);
function ae_contract_scalar_type(t:any):boolean{if(t.t==='Nominal')return ae_contract_scalar_type(t.repr);if(t.t==='Owned')return ae_contract_scalar_type(t.inner);return ['Int','Bool','Str','Unit','IntN'].includes(t.t);}
export function ae_certified_lambda(ctx:Context,text:string,symbols:string[],captures:V[],body:(ctx:Context,captures:V[],args:V[])=>V,certificate:string):V {
  if(!ae_contract_allowed.has(certificate))throw Error('contract_certificate');
  const value=ae_lambda(ctx,text,symbols,captures,body);
  if(!(value instanceof AeClosure)||value.meta.capabilities.length||!value.captures.every(ae_contract_scalar)||!value.meta.params.every((p:any)=>ae_contract_scalar_type(p.ty))||!ae_contract_scalar_type(value.meta.returns))throw Error('contract_closure_shape');
  ae_contract_custody.set(value,{certificate,captures:[...value.captures],body:value.body,meta:JSON.stringify(value.meta)});
  return value;
}
export function ae_contract_apply(ctx:Context,value:V,args:V[]):V {
  const retained=value instanceof AeClosure?ae_contract_custody.get(value):undefined;
  if(!(value instanceof AeClosure)||!retained||!ae_contract_allowed.has(retained.certificate))throw Error('unverified_contract_closure');
  if(value.body!==retained.body||JSON.stringify(value.meta)!==retained.meta||value.captures.length!==retained.captures.length||value.captures.some((capture,i)=>capture!==retained.captures[i]))throw Error('contract_closure_tamper');
  if(value.meta.capabilities.length||!value.captures.every(ae_contract_scalar)||!args.every(ae_contract_scalar))throw Error('contract_closure_shape');
  const result=ae_apply(ctx,value,args);if(!ae_contract_scalar(result))throw Error('contract_closure_result');return result;
}
`;
  if (target === 'python') return base + `
import weakref as _ae_contract_weakref
_ae_contract_allowed=set(${allowed})
_ae_contract_custody={}
def _ae_contract_scalar(v): return v is None or type(v) in (int,bool,str)
def _ae_contract_scalar_type(t):
    if t['t']=='Nominal': return _ae_contract_scalar_type(t['repr'])
    if t['t']=='Owned': return _ae_contract_scalar_type(t['inner'])
    return t['t'] in ('Int','Bool','Str','Unit','IntN')
def ae_certified_lambda(ctx,text,symbols,captures,body,certificate):
    if certificate not in _ae_contract_allowed: raise RuntimeError('contract_certificate')
    value=ae_lambda(ctx,text,symbols,captures,body)
    if type(value) is not AeClosure or value.meta['capabilities'] or not all(_ae_contract_scalar(x) for x in value.captures) or not all(_ae_contract_scalar_type(p['ty']) for p in value.meta['params']) or not _ae_contract_scalar_type(value.meta['returns']): raise RuntimeError('contract_closure_shape')
    key=id(value)
    _ae_contract_custody[key]=(_ae_contract_weakref.ref(value,lambda _ref: _ae_contract_custody.pop(key,None)),certificate,tuple(value.captures),value.body,json.dumps(value.meta,sort_keys=True))
    return value
def ae_contract_apply(ctx,value,args):
    retained=_ae_contract_custody.get(id(value))
    if type(value) is not AeClosure or retained is None or retained[0]() is not value or retained[1] not in _ae_contract_allowed: raise RuntimeError('unverified_contract_closure')
    if value.body is not retained[3] or json.dumps(value.meta,sort_keys=True)!=retained[4] or tuple(value.captures)!=retained[2]: raise RuntimeError('contract_closure_tamper')
    if value.meta['capabilities'] or not all(_ae_contract_scalar(x) for x in value.captures) or not all(_ae_contract_scalar(x) for x in args): raise RuntimeError('contract_closure_shape')
    result=ae_apply(ctx,value,args)
    if not _ae_contract_scalar(result): raise RuntimeError('contract_closure_result')
    return result
`;
  return base + `
thread_local! {static AE_CONTRACT_CUSTODY:RefCell<HashMap<usize,(std::rc::Weak<AeClosure>,String,Vec<Value>,J,AeBody)>>=RefCell::new(HashMap::new());}
fn ae_contract_allowed(cert:&str)->bool{${certificates.map(c=>`cert==${JSON.stringify(c)}`).join('||')||'false'}}
fn ae_contract_scalar(v:&Value)->bool{matches!(v,Value::Int(_)|Value::Bool(_)|Value::Str(_)|Value::Unit)}
fn ae_contract_scalar_type(t:&J)->bool{match t["t"].as_str().unwrap(){"Nominal"=>ae_contract_scalar_type(&t["repr"]),"Owned"=>ae_contract_scalar_type(&t["inner"]),"Int"|"Bool"|"Str"|"Unit"|"IntN"=>true,_=>false}}
pub fn ae_certified_lambda<F:Fn(&mut Context,&[Value],&[Value])->Value+'static>(ctx:&mut Context,text:&str,symbols:&[&str],captures:Vec<Value>,body:F,cert:&str)->Value{
  if !ae_contract_allowed(cert){panic!("contract_certificate")}
  let value=ae_lambda(ctx,text,symbols,captures,body);
  if let Value::Closure(c)=&value{if c.meta["capabilities"].as_array().unwrap().len()!=0||!c.captures.iter().all(ae_contract_scalar)||!c.meta["params"].as_array().unwrap().iter().all(|p|ae_contract_scalar_type(&p["ty"]))||!ae_contract_scalar_type(&c.meta["returns"]){panic!("contract_closure_shape")}
    AE_CONTRACT_CUSTODY.with(|table|{let mut retained=table.borrow_mut();retained.retain(|_,(weak,_,_,_,_)|weak.strong_count()>0);retained.insert(Rc::as_ptr(c) as usize,(Rc::downgrade(c),cert.to_string(),c.captures.clone(),c.meta.clone(),c.body.clone()));});
  }else{panic!("contract_closure_shape")}
  value
}
pub fn ae_contract_apply(ctx:&mut Context,value:Value,args:Vec<Value>)->Value{
  let c=if let Value::Closure(c)=&value{c}else{panic!("unverified_contract_closure")};
  let admitted=AE_CONTRACT_CUSTODY.with(|table|table.borrow().get(&(Rc::as_ptr(c) as usize)).is_some_and(|(weak,cert,captures,meta,body)|weak.upgrade().is_some_and(|same|Rc::ptr_eq(&same,c))&&ae_contract_allowed(cert)&& &c.captures==captures && &c.meta==meta && Rc::ptr_eq(&c.body,body)));
  if !admitted{panic!("unverified_contract_closure")}
  if c.meta["capabilities"].as_array().unwrap().len()!=0||!c.captures.iter().all(ae_contract_scalar)||!args.iter().all(ae_contract_scalar){panic!("contract_closure_shape")}
  let result=ae_apply(ctx,value,args);if !ae_contract_scalar(&result){panic!("contract_closure_result")}result
}
macro_rules! ae_certified_lambda {($ctx:expr,$meta:expr,[$($symbol:expr),*],[$($v:expr),*],$c:ident,$captured:ident,$args:ident,$body:expr,$cert:expr)=>{{let captured=vec![$($v),*];ae_certified_lambda($ctx,$meta,&[$($symbol),*],captured,|$c,$captured,$args|$body,$cert)}}}
macro_rules! ae_contract_apply {($ctx:expr,$value:expr,[$($arg:expr),*])=>{{let value=$value;let args=vec![$($arg),*];ae_contract_apply($ctx,value,args)}}}
`;
}
