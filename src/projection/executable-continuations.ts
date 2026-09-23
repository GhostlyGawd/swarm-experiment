/** Opaque native continuations. No executable AST is stored or interpreted. */
const ts=`
export class AeClosure {readonly kind='closure';id=ae_id();constructor(meta:any,captures:V[],body:(ctx:Context,captures:V[],args:V[])=>V){this.meta=meta;this.captures=[...captures];this.body=body;}meta:any;captures:V[];body:(ctx:Context,captures:V[],args:V[])=>V;}
export class AeTask {readonly kind='task';id=ae_id();state:'pending'|'running'|'completed'='pending';result:V=null;constructor(ty:any,caps:string[],captures:V[],body:(ctx:Context,captures:V[],args:V[])=>V){this.ty=ty;this.caps=[...caps];this.captures=[...captures];this.body=body;}ty:any;caps:string[];captures:V[];body:(ctx:Context,captures:V[],args:V[])=>V;}
function ae_type_equal(a:any,b:any):boolean{const normalize=(v:any,key=''):any=>Array.isArray(v)?(key==='capabilities'?[...v].sort():v.map(x=>normalize(x))):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k],k)])):v;return JSON.stringify(normalize(a))===JSON.stringify(normalize(b));}
function ae_executable_check(t:any,v:V):void{if(t.t==='Fn'){if(!(v instanceof AeClosure)||!ae_type_equal(t,{t:'Fn',params:v.meta.params.map((p:any)=>p.ty),returns:v.meta.returns,capabilities:v.meta.capabilities}))throw Error('closure_type');}else if(!(v instanceof AeTask)||!ae_type_equal(t,v.ty))throw Error('task_type');}
function ae_host_allowed(ctx:Context,cap:string):boolean{const allowed=ctx.policy(cap);return allowed===true&&ctx.grants.includes(cap);}
function ae_authority(ctx:Context,caps:string[]):void{ctx.authority();if(caps.some(c=>!ae_host_allowed(ctx,c)||!ctx.frames.at(-1)?.includes(c)))throw Error('capability_denied');}
export function ae_capture(values:V[],index:string):V{if(!/^(0|[1-9][0-9]*)$/.test(index)||!Number.isSafeInteger(Number(index))||Number(index)>=values.length)throw Error('capture_index');return values[Number(index)];}
export const ae_arg=ae_capture;
export function ae_lambda(ctx:Context,text:string,symbols:string[],captures:V[],body:(ctx:Context,captures:V[],args:V[])=>V):V{const meta=JSON.parse(text);if(symbols.length!==captures.length)throw Error('capture_shape');ae_authority(ctx,meta.capabilities);return new AeClosure(meta,captures,body);}
export function ae_apply(ctx:Context,value:V,args:V[]):V{if(!(value instanceof AeClosure))throw Error('closure_type');ae_authority(ctx,value.meta.capabilities);ae_arguments(JSON.stringify(value.meta.params.map((p:any)=>p.ty)),args);const result=ctx.function(value.meta.capabilities,ctx=>ae_bind(JSON.stringify(value.meta.returns),value.body(ctx,[...value.captures],[...args])));ae_authority(ctx,value.meta.capabilities);return result;}
export function ae_spawn(ctx:Context,text:string,symbols:string[],captures:V[],body:(ctx:Context,captures:V[],args:V[])=>V):V{const ty=JSON.parse(text),caps=ctx.frames.at(-1);if(!caps||ty.t!=='Task'||symbols.length!==captures.length)throw Error('task_shape');ae_authority(ctx,caps);return new AeTask(ty,caps,captures,body);}
export function ae_await(ctx:Context,value:V):V{if(!(value instanceof AeTask))throw Error('task_type');ae_authority(ctx,value.caps);if(value.state==='completed')return value.result;if(value.state==='running')throw Error('task_cycle');value.state='running';try{const result=ctx.function(value.caps,ctx=>ae_bind(JSON.stringify(value.ty.result),value.body(ctx,[...value.captures],[])));value.result=result;value.state='completed';}catch(error){value.state='pending';value.result=null;throw error;}ae_authority(ctx,value.caps);return value.result;}
function ae_effect_values(values:V[]):void{const seen=new Set<object>();const check=(v:V):void=>{if(v instanceof AeClosure||v instanceof AeTask)throw Error('opaque_effect_value');if(v instanceof AeRecord||v instanceof AeSeq||v instanceof AeResult){if(seen.has(v))return;seen.add(v);if(v instanceof AeRecord)v.fields.forEach(check);else if(v instanceof AeSeq)v.items.forEach(check);else check(v.value);}};values.forEach(check);}
`;
const py=`
class AeClosure:
    def __init__(self,meta,captures,body): self.meta=meta; self.captures=list(captures); self.body=body; self.id=_ae_id()
    def __eq__(self,other): return type(other) is AeClosure and self.id==other.id
class AeTask:
    def __init__(self,ty,caps,captures,body): self.ty=ty; self.caps=list(caps); self.captures=list(captures); self.body=body; self.id=_ae_id(); self.state='pending'; self.result=None
    def __eq__(self,other): return type(other) is AeTask and self.id==other.id
def _ae_type_equal(a,b):
    def normalize(v,key=''):
        if type(v) is list: return sorted(v) if key=='capabilities' else [normalize(x) for x in v]
        if type(v) is dict: return {k:normalize(x,k) for k,x in v.items()}
        return v
    return normalize(a)==normalize(b)
def _ae_executable_check(t,v):
    if t['t']=='Fn':
        if type(v) is not AeClosure or not _ae_type_equal(t,{'t':'Fn','params':[p['ty'] for p in v.meta['params']],'returns':v.meta['returns'],'capabilities':v.meta['capabilities']}): raise RuntimeError('closure_type')
    elif type(v) is not AeTask or not _ae_type_equal(t,v.ty): raise RuntimeError('task_type')
def _ae_host_allowed(ctx,cap):
    allowed=ctx.policy(cap)
    return allowed is True and cap in ctx.grants
def _ae_authority(ctx,caps):
    if any(not _ae_host_allowed(ctx,c) or not ctx.frames or c not in ctx.frames[-1] for c in caps): raise RuntimeError('capability_denied')
def ae_capture(values,index):
    i=int(index)
    if str(i)!=index or i<0 or i>=len(values): raise RuntimeError('capture_index')
    return values[i]
ae_arg=ae_capture
def ae_lambda(ctx,text,symbols,captures,body):
    meta=json.loads(text)
    if len(symbols)!=len(captures): raise RuntimeError('capture_shape')
    _ae_authority(ctx,meta['capabilities']); return AeClosure(meta,captures,body)
def ae_apply(ctx,value,args):
    if type(value) is not AeClosure: raise RuntimeError('closure_type')
    _ae_authority(ctx,value.meta['capabilities']); ae_arguments(json.dumps([p['ty'] for p in value.meta['params']]),args)
    with ctx.function(value.meta['capabilities']): result=ae_bind(json.dumps(value.meta['returns']),value.body(ctx,list(value.captures),list(args)))
    _ae_authority(ctx,value.meta['capabilities']); return result
def ae_spawn(ctx,text,symbols,captures,body):
    ty=json.loads(text)
    if ty['t']!='Task' or not ctx.frames or len(symbols)!=len(captures): raise RuntimeError('task_shape')
    caps=ctx.frames[-1]; _ae_authority(ctx,caps); return AeTask(ty,caps,captures,body)
def ae_await(ctx,value):
    if type(value) is not AeTask: raise RuntimeError('task_type')
    _ae_authority(ctx,value.caps)
    if value.state=='completed': return value.result
    if value.state=='running': raise RuntimeError('task_cycle')
    value.state='running'
    try:
        with ctx.function(value.caps): result=ae_bind(json.dumps(value.ty['result']),value.body(ctx,list(value.captures),[]))
        value.result=result; value.state='completed'
    except BaseException:
        value.state='pending'; value.result=None; raise
    _ae_authority(ctx,value.caps); return value.result
def _ae_effect_values(values):
    seen=set()
    def check(v):
        if type(v) in (AeClosure,AeTask): raise RuntimeError('opaque_effect_value')
        if type(v) in (AeRecord,AeSeq,AeResult):
            if id(v) in seen: return
            seen.add(id(v))
            if type(v) is AeRecord:
                for x in v.fields.values(): check(x)
            elif type(v) is AeSeq:
                for x in v.items: check(x)
            else: check(v.value)
    for v in values: check(v)
`;
const rs=`
type AeBody=Rc<dyn Fn(&mut Context,&[Value],&[Value])->Value>;
pub struct AeClosure{pub id:u64,pub meta:J,pub captures:Vec<Value>,pub body:AeBody}
pub struct AeTask{pub id:u64,pub ty:J,pub caps:Vec<String>,pub captures:Vec<Value>,pub body:AeBody,pub state:u8,pub result:Value}
impl std::fmt::Debug for AeClosure{fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.debug_struct("AeClosure").field("id",&self.id).field("meta",&self.meta).field("captures",&self.captures).finish()}}
impl std::fmt::Debug for AeTask{fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.debug_struct("AeTask").field("id",&self.id).field("ty",&self.ty).field("caps",&self.caps).field("captures",&self.captures).field("state",&self.state).field("result",&self.result).finish()}}
fn ae_type_equal(a:&J,b:&J)->bool{fn norm(v:&J,key:&str)->J{match v{J::Array(xs)=>{let mut values:Vec<J>=xs.iter().map(|x|norm(x,"")).collect();if key=="capabilities"{values.sort_by_key(|v|v.as_str().unwrap().to_string());}J::Array(values)},J::Object(xs)=>J::Object(xs.iter().map(|(k,v)|(k.clone(),norm(v,k))).collect()),_=>v.clone()}}norm(a,"")==norm(b,"")}
fn ae_executable_check(t:&J,v:&Value){if t["t"]=="Fn"{let c=if let Value::Closure(c)=v{c}else{panic!("closure_type")};let actual=serde_json::json!({"t":"Fn","params":c.meta["params"].as_array().unwrap().iter().map(|p|p["ty"].clone()).collect::<Vec<_>>(),"returns":c.meta["returns"],"capabilities":c.meta["capabilities"]});if !ae_type_equal(t,&actual){panic!("closure_type")}}else{let task=if let Value::Task(t)=v{t}else{panic!("task_type")};if !ae_type_equal(t,&task.borrow().ty){panic!("task_type")}}}
fn ae_host_allowed(ctx:&Context,cap:&str)->bool{(ctx.policy)(cap)&&ctx.grants.iter().any(|c|c==cap)}
fn ae_authority(ctx:&Context,caps:&[String]){if caps.iter().any(|c|!ae_host_allowed(ctx,c)||!ctx.frames.last().is_some_and(|f|f.contains(c))){panic!("capability_denied")}}
pub fn ae_capture(values:&[Value],index:&str)->Value{let i:usize=index.parse().expect("capture_index");if i.to_string()!=index{panic!("capture_index")}values.get(i).expect("capture_index").clone()}
pub fn ae_arg(values:&[Value],index:&str)->Value{ae_capture(values,index)}
pub fn ae_lambda<F:Fn(&mut Context,&[Value],&[Value])->Value+'static>(ctx:&mut Context,text:&str,symbols:&[&str],captures:Vec<Value>,body:F)->Value{let meta:J=serde_json::from_str(text).unwrap();let caps:Vec<String>=meta["capabilities"].as_array().unwrap().iter().map(|c|c.as_str().unwrap().to_string()).collect();if symbols.len()!=captures.len(){panic!("capture_shape")}ae_authority(ctx,&caps);Value::Closure(Rc::new(AeClosure{id:ae_id(),meta,captures,body:Rc::new(body)}))}
pub fn ae_apply(ctx:&mut Context,value:Value,args:Vec<Value>)->Value{let c=if let Value::Closure(c)=value{c}else{panic!("closure_type")};let caps:Vec<String>=c.meta["capabilities"].as_array().unwrap().iter().map(|s|s.as_str().unwrap().to_string()).collect();ae_authority(ctx,&caps);let types:Vec<J>=c.meta["params"].as_array().unwrap().iter().map(|p|p["ty"].clone()).collect();ae_arguments(&serde_json::to_string(&types).unwrap(),&args);let borrowed:Vec<&str>=caps.iter().map(String::as_str).collect();let result=ctx.function(&borrowed,|ctx|ae_bind(&c.meta["returns"].to_string(),(c.body)(ctx,&c.captures,&args)));ae_authority(ctx,&caps);result}
pub fn ae_spawn<F:Fn(&mut Context,&[Value],&[Value])->Value+'static>(ctx:&mut Context,text:&str,symbols:&[&str],captures:Vec<Value>,body:F)->Value{let ty:J=serde_json::from_str(text).unwrap();let caps=ctx.frames.last().expect("task_frame").clone();if ty["t"]!="Task"||symbols.len()!=captures.len(){panic!("task_shape")}ae_authority(ctx,&caps);Value::Task(Rc::new(RefCell::new(AeTask{id:ae_id(),ty,caps,captures,body:Rc::new(body),state:0,result:Value::Unit})))}
pub fn ae_await(ctx:&mut Context,value:Value)->Value{let task=if let Value::Task(t)=value{t}else{panic!("task_type")};let(ty,caps,captures,body,state,result)={let t=task.borrow();(t.ty.clone(),t.caps.clone(),t.captures.clone(),t.body.clone(),t.state,t.result.clone())};ae_authority(ctx,&caps);if state==2{return result}if state==1{panic!("task_cycle")}task.borrow_mut().state=1;let borrowed:Vec<&str>=caps.iter().map(String::as_str).collect();let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||ctx.function(&borrowed,|ctx|ae_bind(&ty["result"].to_string(),body(ctx,&captures,&[])))));match outcome{Ok(v)=>{{let mut t=task.borrow_mut();t.state=2;t.result=v.clone();}ae_authority(ctx,&caps);v},Err(e)=>{task.borrow_mut().state=0;std::panic::resume_unwind(e)}}}
macro_rules! ae_lambda {($ctx:expr,$meta:expr,[$($symbol:expr),*],[$($v:expr),*],$c:ident,$captured:ident,$args:ident,$body:expr)=>{{let captured=vec![$($v),*];ae_lambda($ctx,$meta,&[$($symbol),*],captured,|$c,$captured,$args|$body)}}}
macro_rules! ae_spawn {($ctx:expr,$meta:expr,[$($symbol:expr),*],[$($v:expr),*],$c:ident,$captured:ident,$args:ident,$body:expr)=>{{let captured=vec![$($v),*];ae_spawn($ctx,$meta,&[$($symbol),*],captured,|$c,$captured,$args|$body)}}}
macro_rules! ae_lambda_generic {($ctx:expr,$meta:expr,[$($symbol:expr),*],[$($v:expr),*],$c:ident,$captured:ident,$args:ident,$body:expr,$types:ident)=>{{let captured=vec![$($v),*];let $types=$types.clone();ae_lambda($ctx,$meta,&[$($symbol),*],captured,move |$c,$captured,$args|$body)}}}
macro_rules! ae_spawn_generic {($ctx:expr,$meta:expr,[$($symbol:expr),*],[$($v:expr),*],$c:ident,$captured:ident,$args:ident,$body:expr,$types:ident)=>{{let captured=vec![$($v),*];let $types=$types.clone();ae_spawn($ctx,$meta,&[$($symbol),*],captured,move |$c,$captured,$args|$body)}}}
macro_rules! ae_apply {($ctx:expr,$value:expr,[$($arg:expr),*])=>{{let value=$value;let args=vec![$($arg),*];ae_apply($ctx,value,args)}}}
macro_rules! ae_await {($ctx:expr,$value:expr)=>{{let value=$value;ae_await($ctx,value)}}}
fn ae_effect_values(values:&[Value]){fn check(v:&Value,seen:&mut HashSet<usize>){match v{Value::Closure(_)|Value::Task(_)=>panic!("opaque_effect_value"),Value::Record(r)=>{let row=r.borrow();if !seen.insert(Rc::as_ptr(r) as usize){return}for(_,x)in &row.fields{check(x,seen);}},Value::Seq(s)=>{let row=s.borrow();if !seen.insert(Rc::as_ptr(s) as usize){return}for x in &row.items{check(x,seen);}},Value::Result(r)=>{let row=r.borrow();if seen.insert(Rc::as_ptr(r) as usize){check(&row.value,seen);}},_=>{}}}let mut seen=HashSet::new();for value in values{check(value,&mut seen);}}
`;
export function extendContinuationRuntime(base:string,target:'typescript'|'python'|'rust'):string{
 if(target==='typescript')return base.replace('frames: string[][] = []; steps = 0;','frames: string[][] = []; steps = 0; policy:(cap:string)=>boolean=()=>true;').replace('!this.grants.includes(c)||','!ae_host_allowed(this,c)||').replace('!this.grants.includes(cap)||','!ae_host_allowed(this,cap)||').replace(' | AeResult;',' | AeResult | AeClosure | AeTask;').replace("if(depth>64)throw Error('type_depth');","if(depth>64)throw Error('type_depth');if(t.t==='Fn'||t.t==='Task')return ae_executable_check(t,v);")
 .replace("function ae_regions(v:V,out:Set<number>,seen=new Set<number>()):void{","function ae_regions(v:V,out:Set<number>,seen=new Set<number>()):void{if(v instanceof AeClosure||v instanceof AeTask){if(seen.has(v.id))return;seen.add(v.id);v.captures.forEach(x=>ae_regions(x,out,seen));if(v instanceof AeTask&&v.state==='completed')ae_regions(v.result,out,seen);return;}")
 .replace("if(v instanceof AeRecord&&t.t==='Record')", "if(t.t==='Fn'||t.t==='Task'){ae_regions(v,region??borrowed);return;}if(v instanceof AeRecord&&t.t==='Record')")
 .replace("function ae_equal(a:V,b:V):boolean{","function ae_equal(a:V,b:V):boolean{if(a instanceof AeClosure||a instanceof AeTask)return(a instanceof AeClosure&&b instanceof AeClosure||a instanceof AeTask&&b instanceof AeTask)&&a.id===(b as AeClosure|AeTask).id;")
 .replace("const value=this.effects(cap,args);","ae_effect_values(args);const value=this.effects(cap,args);")
 .replace("const encode=(v:V):any=>{","const encode=(v:V):any=>{if(v instanceof AeClosure)return{tag:'closure',id:String(v.id),capabilities:v.meta.capabilities};if(v instanceof AeTask)return{tag:'task',id:String(v.id),state:v.state};")+ts;
 if(target==='python')return base.replace('self.grants=set(grants);','self.policy=lambda cap: True; self.grants=set(grants);').replace('c not in self.grants or','not _ae_host_allowed(self,c) or').replace('cap not in self.grants or','not _ae_host_allowed(self,cap) or').replace("    if t['t']=='Record':\n", "    if t['t'] in ('Fn','Task'): return _ae_executable_check(t,v)\n    if t['t']=='Record':\n")
 .replace("    if type(v) not in (AeRecord,AeSeq,AeResult) or v.id in seen: return", "    if type(v) in (AeClosure,AeTask):\n        if v.id in seen: return\n        seen.add(v.id)\n        for x in v.captures: _ae_regions(x,out,seen)\n        if type(v) is AeTask and v.state=='completed': _ae_regions(v.result,out,seen)\n        return\n    if type(v) not in (AeRecord,AeSeq,AeResult) or v.id in seen: return")
 .replace("        if t['t']=='Record':", "        if t['t'] in ('Fn','Task'): return _ae_regions(v,borrowed if region is None else region)\n        if t['t']=='Record':")
 .replace("        result=self.effects(cap,args)","        _ae_effect_values(args)\n        result=self.effects(cap,args)")
 .replace("    def encode(v):\n", "    def encode(v):\n        if type(v) is AeClosure: return {'tag':'closure','id':str(v.id),'capabilities':v.meta['capabilities']}\n        if type(v) is AeTask: return {'tag':'task','id':str(v.id),'state':v.state}\n")+py;
 return base.replace('pub effects:fn(&str,Vec<Value>)->Value}', 'pub effects:fn(&str,Vec<Value>)->Value,pub policy:fn(&str)->bool}').replace('limit:100000,effects}', 'limit:100000,effects,policy:|_|true}').replace('!self.grants.iter().any(|g|g==c)||','!ae_host_allowed(self,c)||').replace('!self.grants.iter().any(|g|g==cap)||','!ae_host_allowed(self,cap)||').replace('Result(Rc<RefCell<AeResult>>) }','Result(Rc<RefCell<AeResult>>), Closure(Rc<AeClosure>), Task(Rc<RefCell<AeTask>>) }')
 .replace('Value::Result(r)=>Some((2,r.borrow().id)),','Value::Result(r)=>Some((2,r.borrow().id)),Value::Closure(c)=>Some((3,c.id)),Value::Task(t)=>Some((4,t.borrow().id)),')
 .replace('match t["t"].as_str().unwrap(){\n "Nominal"','match t["t"].as_str().unwrap(){\n "Fn"|"Task"=>ae_executable_check(t,v),\n "Nominal"')
 .replace('Value::Result(r)=>ae_regions(&r.borrow().value.clone(),out,seen),','Value::Result(r)=>ae_regions(&r.borrow().value.clone(),out,seen),Value::Closure(c)=>{for x in &c.captures{ae_regions(x,out,seen);}},Value::Task(t)=>{let(captures,result)={let row=t.borrow();(row.captures.clone(),row.result.clone())};for x in captures{ae_regions(&x,out,seen);}ae_regions(&result,out,seen);},')
 .replace('seen:&mut HashSet<String>){match t["t"].as_str().unwrap(){','seen:&mut HashSet<String>){match t["t"].as_str().unwrap(){"Fn"|"Task"=>{if let Some(i)=region{ae_regions(v,&mut owned[i],&mut HashSet::new());}else{ae_regions(v,borrowed,&mut HashSet::new());}},')
 .replace('fn copy(v:Value,memo:&mut HashMap<u64,Value>)->Value{','fn copy(v:Value,memo:&mut HashMap<u64,Value>)->Value{if matches!(v,Value::Closure(_)|Value::Task(_)){return v}')
 .replace('let v=(self.effects)(cap,args);','ae_effect_values(&args);let v=(self.effects)(cap,args);')
 .replace('fn encode(v:&Value,seen:&mut HashSet<u64>)->J{','fn encode(v:&Value,seen:&mut HashSet<u64>)->J{match v{Value::Closure(c)=>return serde_json::json!({"tag":"closure","id":c.id.to_string(),"capabilities":c.meta["capabilities"]}),Value::Task(t)=>return serde_json::json!({"tag":"task","id":t.borrow().id.to_string(),"state":(["pending","running","completed"][t.borrow().state as usize])}),_=>{}}')+rs;
}
