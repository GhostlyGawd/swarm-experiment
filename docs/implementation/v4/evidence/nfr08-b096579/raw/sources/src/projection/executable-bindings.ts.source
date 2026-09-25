import type { ExecutableTarget } from './executable-runtime.ts';

/** V12 slots distinguish an unexecuted conditional Let from Aether Unit. */
export function extendBindingRuntime(base:string,target:ExecutableTarget):string {
  if(target==='typescript')return base+`\nexport function ae_slot(value:V|undefined):V { if(value===undefined)throw Error('unbound'); return value; }\nexport const ae_slot_bound=(value:V|undefined):boolean=>value!==undefined;\nexport const ae_slot_or=(value:V|undefined,fallback:()=>V):V=>value===undefined?fallback():value;\n`;
  if(target==='python')return base+`\n_AE_UNBOUND=object()\ndef ae_unbound(): return _AE_UNBOUND\ndef ae_slot(value):\n    if value is _AE_UNBOUND: raise RuntimeError('unbound')\n    return value\ndef ae_slot_bound(value): return value is not _AE_UNBOUND\ndef ae_slot_or(value,fallback): return fallback() if value is _AE_UNBOUND else value\n`;
  return base+`\npub fn ae_slot(value:Option<Value>)->Value{value.expect("unbound")}\npub fn ae_slot_bound(value:Option<Value>)->bool{value.is_some()}\nmacro_rules! ae_slot_or {($slot:expr,$fallback:expr)=>{{match $slot{Some(value)=>value,None=>$fallback}}}}\n`;
}
