/** Profile 5 native transaction support. The generated try/with/RAII block keeps
 * native returns intact. Journals cover the synchronous native heap domain,
 * including writes performed by callees and trusted effect adapters. */
const ts=`
const ae_transactions:AeAtomic[]=[];
const ae_recycled_records:AeRecord[]=[];
function ae_undo(operation:()=>void):void{ae_transactions.at(-1)?.undo.push(operation);}
export class AeAtomic {
 undo:(()=>void)[]=[];ctx:Context;steps:number;rolled=false;closed=false;
 constructor(ctx:Context){this.ctx=ctx;this.steps=ctx.steps;ae_transactions.push(this);}
 rollback():void{if(this.closed||this.rolled||ae_transactions.at(-1)!==this)throw Error('atomic_order');for(let i=this.undo.length-1;i>=0;i--)this.undo[i]();this.undo=[];this.ctx.steps=this.steps;this.rolled=true;}
 close():void{if(this.closed||ae_transactions.at(-1)!==this)throw Error('atomic_order');ae_transactions.pop();if(!this.rolled){const parent=ae_transactions.at(-1);if(parent)for(const operation of this.undo)parent.undo.push(operation);}this.undo=[];this.closed=true;}
}
export function ae_atomic(ctx:Context):AeAtomic{return new AeAtomic(ctx);}
function ae_allocate_record(ty:any,fields:Map<string,V>):V{const record=ae_recycled_records.pop()??new AeRecord(ty,fields);record.ty=ty;record.fields=fields;record.live=true;record.frozen=false;ae_undo(()=>{record.live=false;record.fields=new Map();ae_recycled_records.push(record);});return record;}
function ae_record_write(record:AeRecord,name:string):void{const value=record.fields.get(name)!;ae_undo(()=>{record.fields.set(name,value);});}
`;
const py=`
_ae_transactions=[]
_ae_recycled_records=[]
def _ae_undo(operation):
    if _ae_transactions: _ae_transactions[-1].undo.append(operation)
class AeAtomic:
    def __init__(self,ctx): self.ctx=ctx; self.steps=ctx.steps; self.undo=[]
    def __enter__(self):
        _ae_transactions.append(self)
        return self
    def __exit__(self,kind,value,trace):
        if not _ae_transactions or _ae_transactions[-1] is not self: raise RuntimeError('atomic_order')
        _ae_transactions.pop()
        if kind is not None:
            for operation in reversed(self.undo): operation()
            self.ctx.steps=self.steps
        elif _ae_transactions: _ae_transactions[-1].undo.extend(self.undo)
        self.undo=[]
        return False
def ae_atomic(ctx): return AeAtomic(ctx)
def _ae_allocate_record(ty,fields):
    record=_ae_recycled_records.pop() if _ae_recycled_records else AeRecord(ty,fields)
    record.ty=ty; record.fields=fields; record.live=True; record.frozen=False
    def undo():
        record.live=False; record.fields={}; _ae_recycled_records.append(record)
    _ae_undo(undo)
    return record
def _ae_record_write(record,name):
    value=record.fields[name]
    _ae_undo(lambda: record.fields.__setitem__(name,value))
`;
const rs=`
#[cfg(panic="abort")] compile_error!("Aether Atomic requires Rust panic=unwind");
thread_local! {
 static AE_TRANSACTIONS:RefCell<Vec<Vec<AeUndo>>>=RefCell::new(vec![]);
 static AE_RECYCLED_RECORDS:RefCell<Vec<Rc<RefCell<AeRecord>>>>=RefCell::new(vec![]);
}
enum AeUndo {Write(Rc<RefCell<AeRecord>>,String,Value),Allocate(Rc<RefCell<AeRecord>>)}
fn ae_undo(undo:AeUndo){AE_TRANSACTIONS.with(|stack|{if let Some(frame)=stack.borrow_mut().last_mut(){frame.push(undo)}});}
pub struct AeAtomic {depth:usize,steps:usize,restore:Rc<std::cell::Cell<Option<usize>>>}
pub fn ae_atomic(ctx:&mut Context)->AeAtomic {let depth=AE_TRANSACTIONS.with(|s|{let mut s=s.borrow_mut();s.push(vec![]);s.len()});AeAtomic{depth,steps:ctx.steps,restore:ctx.atomic_restore.clone()}}
impl Drop for AeAtomic {fn drop(&mut self){let undo=AE_TRANSACTIONS.with(|s|{let mut s=s.borrow_mut();assert_eq!(s.len(),self.depth,"atomic_order");s.pop().unwrap()});if std::thread::panicking(){for item in undo.into_iter().rev(){match item{AeUndo::Write(record,name,value)=>{record.borrow_mut().fields.iter_mut().find(|(k,_)|k==&name).unwrap().1=value;},AeUndo::Allocate(record)=>{let mut r=record.borrow_mut();r.live=false;r.fields.clear();drop(r);AE_RECYCLED_RECORDS.with(|s|s.borrow_mut().push(record));}}}self.restore.set(Some(self.steps));}else{AE_TRANSACTIONS.with(|s|{if let Some(parent)=s.borrow_mut().last_mut(){parent.extend(undo)}});}}}
fn ae_allocate_record(ty:J,fields:Vec<(String,Value)>)->Value {let record=AE_RECYCLED_RECORDS.with(|s|s.borrow_mut().pop()).unwrap_or_else(||Rc::new(RefCell::new(AeRecord{ty:J::Null,fields:vec![],id:ae_id(),frozen:false,live:true})));{let mut r=record.borrow_mut();r.ty=ty;r.fields=fields;r.live=true;r.frozen=false;}ae_undo(AeUndo::Allocate(record.clone()));Value::Record(record)}
fn ae_record_write(record:&Rc<RefCell<AeRecord>>,name:&str){let value=record.borrow().fields.iter().find(|(k,_)|k==name).unwrap().1.clone();ae_undo(AeUndo::Write(record.clone(),name.to_string(),value));}
`;
function replace(source:string,needle:string,value:string):string{if(!source.includes(needle))throw Error('Atomic runtime integration drift: '+needle.slice(0,60));return source.replace(needle,value);}
export function extendAtomicRuntime(base:string,target:'typescript'|'python'|'rust'):string{
 const changes:[string,string][]=target==='typescript'?[
  ["readonly kind='record';ty:any;", "readonly kind='record';live=true;ty:any;"],
  ['return new AeRecord(ty,new Map(fields));','return ae_allocate_record(ty,new Map(fields));'],
  ["ae_check(field[1],value);v.fields.set(name,value);","ae_check(field[1],value);ae_record_write(v,name);v.fields.set(name,value);"],
  ['if(!(v instanceof AeRecord)||ae_base(v.ty)', 'if(!(v instanceof AeRecord)||!v.live||ae_base(v.ty)'],
  ["if(!(v instanceof AeRecord)||!v.fields.has(name))", "if(!(v instanceof AeRecord)||!v.live||!v.fields.has(name))"],
  ["if(!(v instanceof AeRecord)||v.frozen)", "if(!(v instanceof AeRecord)||!v.live||v.frozen)"],
  ["if(v instanceof AeRecord){const copy=new AeRecord", "if(v instanceof AeRecord){if(!v.live)throw Error('record_retired');const copy=new AeRecord"],
 ]:target==='python'?[
  ['self.ty=ty; self.fields=fields;', 'self.live=True; self.ty=ty; self.fields=fields;'],
  ['        copy=AeRecord(v.ty,{},v.id,True);', "        if not v.live: raise RuntimeError('record_retired')\n        copy=AeRecord(v.ty,{},v.id,True);"],
  ['return AeRecord(ty,values)','return _ae_allocate_record(ty,values)'],
  ["_ae_check(field[1],value); v.fields[name]=value", "_ae_check(field[1],value); _ae_record_write(v,name); v.fields[name]=value"],
  ["if type(v) is not AeRecord or _ae_base(v.ty)", "if type(v) is not AeRecord or not v.live or _ae_base(v.ty)"],
  ["if type(v) is not AeRecord or name not in v.fields", "if type(v) is not AeRecord or not v.live or name not in v.fields"],
  ["if type(v) is not AeRecord or v.frozen", "if type(v) is not AeRecord or not v.live or v.frozen"],
 ]:[
  ['pub frozen:bool}', 'pub frozen:bool,pub live:bool}'],
  ['id,frozen:true}', 'id,frozen:true,live:true}'],
  ['Value::Record(Rc::new(RefCell::new(AeRecord{ty,fields:fields.into_iter().map(|(k,v)|(k.to_string(),v)).collect(),id:ae_id(),frozen:false})))', 'ae_allocate_record(ty,fields.into_iter().map(|(k,v)|(k.to_string(),v)).collect())'],
  ['r.borrow_mut().fields.iter_mut().find(|(k,_)|k==name)', 'ae_record_write(&r,name);r.borrow_mut().fields.iter_mut().find(|(k,_)|k==name)'],
  ['if row.frozen{panic!("record_write")}', 'if !row.live||row.frozen{panic!("record_write")}'],
  ['pub policy:fn(&str)->bool}', 'pub policy:fn(&str)->bool,atomic_restore:Rc<std::cell::Cell<Option<usize>>>}'],
  ['policy:|_|true}', 'policy:|_|true,atomic_restore:Rc::new(std::cell::Cell::new(None))}'],
  ['self.frames.pop();match out', 'self.frames.pop();if let Some(steps)=self.atomic_restore.take(){self.steps=steps;}match out'],
 ];
 for(const[a,b]of changes)base=replace(base,a,b);
 if(target==='rust'){
  base=replace(base,'let row=r.borrow();(row.id,row.ty.clone(),row.fields.clone())', 'let row=r.borrow();if !row.live{panic!("record_retired")}(row.id,row.ty.clone(),row.fields.clone())');
  base=replace(base,'if let Value::Record(r)=v{let out=r.borrow().fields.iter()', 'if let Value::Record(r)=v{if !r.borrow().live{panic!("record_retired")}let out=r.borrow().fields.iter()');
  base=replace(base,'let row=r.borrow();(row.ty.clone(),row.fields.clone())', 'let row=r.borrow();if !row.live{panic!("record_retired")}(row.ty.clone(),row.fields.clone())');
 }
 return base+(target==='typescript'?ts:target==='python'?py:rs);
}
