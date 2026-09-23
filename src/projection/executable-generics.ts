const ts=`
function ae_generic_json(text:string):any{if(typeof text!=='string'||new TextEncoder().encode(text).length>65536)throw Error('generic_witness_limit');const value=JSON.parse(text);let count=0;const visit=(v:any,depth:number):void=>{if(++count>4096||depth>64)throw Error('generic_witness_limit');if(v&&typeof v==='object')Object.values(v).forEach(x=>visit(x,depth+1));};visit(value,0);return value;}
function ae_generic_value(value:any,bindings:Record<string,any>):any{if(value===null||typeof value!=='object')return value;if(Array.isArray(value))return value.map(v=>ae_generic_value(v,bindings));if(value.t==='TypeVar'){if(!Object.hasOwn(bindings,value.name))throw Error('unbound_type_variable');return bindings[value.name];}return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,ae_generic_value(v,bindings)]));}
export function ae_specialize(text:string,bindings:string):string{return JSON.stringify(ae_generic_value(ae_generic_json(text),ae_generic_json(bindings)));}
export function ae_generic_bindings(text:string,actual:string,args:V[]):string{
 const spec=ae_generic_json(text),types=ae_generic_json(actual),bindings:Record<string,any>=Object.create(null);if(!Array.isArray(types)||types.length!==spec.params.length)throw Error('generic_arity');
 const closed=(v:any):void=>{if(v&&typeof v==='object'){if(v.t==='TypeVar')throw Error('open_type_witness');Object.values(v).forEach(closed);}};types.forEach(closed);
 const canon=(v:any):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
 const unify=(p:any,a:any):void=>{if(p.t==='TypeVar'){if(Object.hasOwn(bindings,p.name)&&!ae_type_equal(bindings[p.name],a))throw Error('generic_type');bindings[p.name]=a;return;}if(!a||p.t!==a.t)throw Error('generic_type');switch(p.t){case'Nominal':if(p.name!==a.name)throw Error('generic_nominal');unify(p.repr,a.repr);break;case'Owned':unify(p.inner,a.inner);break;case'Record':if(p.name!==a.name||p.fields.length!==a.fields?.length)throw Error('generic_record');p.fields.forEach(([k,t]:any,i:number)=>{if(k!==a.fields[i][0])throw Error('generic_field');unify(t,a.fields[i][1]);});break;case'Seq':unify(p.element,a.element);break;case'Result':unify(p.ok,a.ok);unify(p.err,a.err);break;case'Fn':if(p.params.length!==a.params?.length)throw Error('generic_function');p.params.forEach((t:any,i:number)=>unify(t,a.params[i]));unify(p.returns,a.returns);break;case'Task':unify(p.result,a.result);break;case'IntN':if(canon(p)!==canon(a))throw Error('generic_fixed');}}
 spec.params.forEach((p:any,i:number)=>unify(p.ty.t==='Owned'?p.ty.inner:p.ty,types[i]));if(spec.typeParams.some((t:string)=>!Object.hasOwn(bindings,t)))throw Error('uninferred_type_variable');ae_arguments(JSON.stringify(types),args);return JSON.stringify(bindings);
}
export function ae_generic_call(ctx:Context,f:(ctx:Context,args:V[],types:string)=>V,args:V[],types:string):V{return f(ctx,args,types);}
export function ae_generic_map(ctx:Context,v:V,f:(ctx:Context,args:V[],types:string)=>V,types:string):V{return new AeSeq([...ae_items(v)].map(item=>{ctx.tick();return f(ctx,[item],types);}));}
export function ae_generic_fold(ctx:Context,v:V,initial:V,f:(ctx:Context,args:V[],types:string)=>V,types:string):V{let result=initial;for(const item of [...ae_items(v)]){ctx.tick();result=f(ctx,[result,item],types);}return result;}
`;
const py=`
def _ae_generic_json(text):
    if type(text) is not str or len(text.encode('utf-8'))>65536: raise RuntimeError('generic_witness_limit')
    value=json.loads(text); count=0
    def visit(v,depth):
        nonlocal count
        count+=1
        if count>4096 or depth>64: raise RuntimeError('generic_witness_limit')
        if type(v) is dict:
            for x in v.values(): visit(x,depth+1)
        elif type(v) is list:
            for x in v: visit(x,depth+1)
    visit(value,0)
    return value
def _ae_generic_value(value,bindings):
    if type(value) is list: return [_ae_generic_value(v,bindings) for v in value]
    if type(value) is not dict: return value
    if value.get('t')=='TypeVar':
        if value['name'] not in bindings: raise RuntimeError('unbound_type_variable')
        return bindings[value['name']]
    return {k:_ae_generic_value(v,bindings) for k,v in value.items()}
def ae_specialize(text,bindings): return json.dumps(_ae_generic_value(_ae_generic_json(text),_ae_generic_json(bindings)))
def ae_generic_bindings(text,actual,args):
    spec=_ae_generic_json(text); types=_ae_generic_json(actual); bindings={}
    if type(types) is not list or len(types)!=len(spec['params']): raise RuntimeError('generic_arity')
    def closed(v):
        if type(v) is dict:
            if v.get('t')=='TypeVar': raise RuntimeError('open_type_witness')
            for x in v.values(): closed(x)
        elif type(v) is list:
            for x in v: closed(x)
    for ty in types: closed(ty)
    def unify(p,a):
        if p['t']=='TypeVar':
            if p['name'] in bindings and not _ae_type_equal(bindings[p['name']],a): raise RuntimeError('generic_type')
            bindings[p['name']]=a; return
        if type(a) is not dict or p['t']!=a.get('t'): raise RuntimeError('generic_type')
        tag=p['t']
        if tag=='Nominal':
            if p['name']!=a['name']: raise RuntimeError('generic_nominal')
            unify(p['repr'],a['repr'])
        elif tag=='Owned': unify(p['inner'],a['inner'])
        elif tag=='Record':
            if p['name']!=a['name'] or len(p['fields'])!=len(a['fields']): raise RuntimeError('generic_record')
            for (name,ty),(other,value) in zip(p['fields'],a['fields']):
                if name!=other: raise RuntimeError('generic_field')
                unify(ty,value)
        elif tag=='Seq': unify(p['element'],a['element'])
        elif tag=='Result': unify(p['ok'],a['ok']); unify(p['err'],a['err'])
        elif tag=='Fn':
            if len(p['params'])!=len(a['params']): raise RuntimeError('generic_function')
            for pty,aty in zip(p['params'],a['params']): unify(pty,aty)
            unify(p['returns'],a['returns'])
        elif tag=='Task': unify(p['result'],a['result'])
        elif tag=='IntN' and p!=a: raise RuntimeError('generic_fixed')
    for p,a in zip(spec['params'],types): unify(p['ty']['inner'] if p['ty']['t']=='Owned' else p['ty'],a)
    if any(t not in bindings for t in spec['typeParams']): raise RuntimeError('uninferred_type_variable')
    ae_arguments(json.dumps(types),args)
    return json.dumps(bindings)
def ae_generic_call(ctx,f,args,types): return f(ctx,args,types)
def ae_generic_map(ctx,v,f,types):
    out=[]
    for item in list(ae_items(v)): ctx.tick(); out.append(f(ctx,[item],types))
    return AeSeq(out)
def ae_generic_fold(ctx,v,initial,f,types):
    out=initial
    for item in list(ae_items(v)): ctx.tick(); out=f(ctx,[out,item],types)
    return out
`;
const rs=`
fn ae_generic_json(text:&str)->J{if text.len()>65536{panic!("generic_witness_limit")}let value:J=serde_json::from_str(text).unwrap();fn visit(v:&J,depth:usize,count:&mut usize){*count+=1;if *count>4096||depth>64{panic!("generic_witness_limit")}match v{J::Array(rows)=>for x in rows{visit(x,depth+1,count)},J::Object(row)=>for x in row.values(){visit(x,depth+1,count)},_=>{}}}visit(&value,0,&mut 0);value}
fn ae_generic_value(value:&J,bindings:&J)->J{match value{J::Array(rows)=>J::Array(rows.iter().map(|v|ae_generic_value(v,bindings)).collect()),J::Object(row)=>{if row.get("t")==Some(&J::String("TypeVar".to_string())){return bindings.get(row["name"].as_str().unwrap()).expect("unbound_type_variable").clone()}J::Object(row.iter().map(|(k,v)|(k.clone(),ae_generic_value(v,bindings))).collect())},_=>value.clone()}}
pub fn ae_specialize(text:&str,bindings:&str)->String{ae_generic_value(&ae_generic_json(text),&ae_generic_json(bindings)).to_string()}
pub fn ae_generic_bindings(text:&str,actual:&str,args:&[Value])->String{
 let spec=ae_generic_json(text);let types=ae_generic_json(actual);let types=types.as_array().expect("generic_arity");let params=spec["params"].as_array().unwrap();if types.len()!=params.len(){panic!("generic_arity")}let mut bindings=serde_json::Map::new();
 fn closed(v:&J){match v{J::Array(rows)=>for x in rows{closed(x)},J::Object(row)=>{if row.get("t")==Some(&J::String("TypeVar".to_string())){panic!("open_type_witness")}for x in row.values(){closed(x)}},_=>{}}}for ty in types{closed(ty)}
 fn unify(p:&J,a:&J,bindings:&mut serde_json::Map<String,J>){if p["t"]=="TypeVar"{let name=p["name"].as_str().unwrap();if bindings.get(name).is_some_and(|v|!ae_type_equal(v,a)){panic!("generic_type")}bindings.insert(name.to_string(),a.clone());return}if p["t"]!=a["t"]{panic!("generic_type")}match p["t"].as_str().unwrap(){"Nominal"=>{if p["name"]!=a["name"]{panic!("generic_nominal")}unify(&p["repr"],&a["repr"],bindings)},"Owned"=>unify(&p["inner"],&a["inner"],bindings),"Record"=>{let fields=p["fields"].as_array().unwrap();let values=a["fields"].as_array().expect("generic_record");if p["name"]!=a["name"]||fields.len()!=values.len(){panic!("generic_record")}for(p,a)in fields.iter().zip(values){if p[0]!=a[0]{panic!("generic_field")}unify(&p[1],&a[1],bindings)}},"Seq"=>unify(&p["element"],&a["element"],bindings),"Result"=>{unify(&p["ok"],&a["ok"],bindings);unify(&p["err"],&a["err"],bindings)},"Fn"=>{let params=p["params"].as_array().unwrap();let actual=a["params"].as_array().expect("generic_function");if params.len()!=actual.len(){panic!("generic_function")}for(p,a)in params.iter().zip(actual){unify(p,a,bindings)}unify(&p["returns"],&a["returns"],bindings)},"Task"=>unify(&p["result"],&a["result"],bindings),"IntN"=>if p!=a{panic!("generic_fixed")},_=>{}}}
 for(p,a)in params.iter().zip(types){let ty=&p["ty"];unify(if ty["t"]=="Owned"{&ty["inner"]}else{ty},a,&mut bindings)}for ty in spec["typeParams"].as_array().unwrap(){if !bindings.contains_key(ty.as_str().unwrap()){panic!("uninferred_type_variable")}}ae_arguments(&J::Array(types.clone()).to_string(),args);J::Object(bindings).to_string()
}
macro_rules! ae_generic_call {($ctx:expr,$f:ident,[$($arg:expr),*],$types:expr)=>{{let args=vec![$($arg),*];let types=$types;$f($ctx,args,&types)}}}
macro_rules! ae_generic_map {($ctx:expr,$value:expr,$f:ident,$types:expr)=>{{let value=$value;let types=$types;let mut out=vec![];for item in ae_items(value){$ctx.tick();out.push($f($ctx,vec![item],&types));}ae_sequence(out)}}}
macro_rules! ae_generic_fold {($ctx:expr,$value:expr,$initial:expr,$f:ident,$types:expr)=>{{let value=$value;let mut out=$initial;let types=$types;for item in ae_items(value){$ctx.tick();out=$f($ctx,vec![out,item],&types);}out}}}
`;
export function extendGenericRuntime(base:string,target:'typescript'|'python'|'rust'):string{return base+(target==='typescript'?ts:target==='python'?py:rs);}
