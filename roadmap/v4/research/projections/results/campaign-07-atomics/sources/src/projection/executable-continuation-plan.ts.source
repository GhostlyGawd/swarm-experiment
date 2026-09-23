import type {Term,Ty} from '../tier1/ast.ts';
import type {SymbolId} from '../tier1/ids.ts';
import {underlying} from '../tier2/typecheck.ts';
/** Type derivation supplies guards, never executable bodies. The parser checks
 * those guards against the actual source expressions by regenerating them. */
export function continuationType(term:Term,bindings:ReadonlyMap<SymbolId,Ty>,functions:ReadonlyMap<SymbolId,Extract<Term,{kind:'FunctionDecl'}>>,result:Ty):Ty{
 const infer=(node:Term)=>continuationType(node,bindings,functions,result);
 const call=(symbol:SymbolId)=>{const fn=functions.get(symbol);if(!fn)throw new TypeError('continuation references an undeclared function');return fn.returns;};
 switch(term.kind){
  case'Lit':return term.ty;case'Var':{const ty=bindings.get(term.symbol);if(!ty)throw new TypeError('unbound continuation capture');return ty;}
  case'Place':{let ty=bindings.get(term.symbol);if(!ty)throw new TypeError('unbound place');for(const field of term.path){const record=underlying(ty);if(record.t!=='Record')throw new TypeError('place type');ty=record.fields.find(([name])=>name===field)?.[1];if(!ty)throw new TypeError('field type');}return ty;}
  case'Field':{const record=underlying(infer(term.object));if(record.t!=='Record')throw new TypeError('field type');const ty=record.fields.find(([name])=>name===term.field)?.[1];if(!ty)throw new TypeError('field type');return ty;}
  case'Un':return term.op==='not'?{t:'Bool'}:infer(term.operand);
  case'Bin':{if(['eq','ne','lt','le','gt','ge','and','or'].includes(term.op))return{t:'Bool'};const l=infer(term.left),r=infer(term.right);if(['mul','div','mod'].includes(term.op)){if(l.t!=='Nominal'&&r.t!=='Nominal')return{t:'Int'};if(r.t!=='Nominal')return l;if(l.t!=='Nominal')return r;return term.op==='div'?{t:'Int'}:l;}return l;}
  case'Cond':return infer(term.then);case'Call':return call(term.callee);case'Invoke':return{t:'Unit'};
  case'Old':return infer(term.expr);case'ResultRef':return result;
  case'RecordLit':case'ResultValue':case'SeqLit':case'IntCast':case'FixedBin':return term.ty;
  case'SeqLength':return{t:'Int'};case'SeqIndex':{const ty=underlying(infer(term.sequence));if(ty.t!=='Seq')throw new TypeError('sequence type');return ty.element;}
  case'SeqMap':return{t:'Seq',element:call(term.callee)};case'SeqFold':return infer(term.initial);
  case'Lambda':return{t:'Fn',params:term.params.map(p=>p.ty),returns:term.returns,capabilities:term.capabilities};
  case'Apply':{const ty=underlying(infer(term.fn));if(ty.t!=='Fn')throw new TypeError('apply type');return ty.returns;}
  case'Spawn':return{t:'Task',result:infer(term.body)};case'Await':{const ty=underlying(infer(term.task));if(ty.t!=='Task')throw new TypeError('await type');return ty.result;}
  case'ForAll':return{t:'Bool'};
  case'MatchResult':{const ty=underlying(infer(term.value));if(ty.t!=='Result')throw new TypeError('match type');return continuationType(term.ok,new Map([...bindings,[term.okSymbol,ty.ok]]),functions,result);}
  default:throw new TypeError(`unsupported continuation result ${term.kind}`);
 }
}
