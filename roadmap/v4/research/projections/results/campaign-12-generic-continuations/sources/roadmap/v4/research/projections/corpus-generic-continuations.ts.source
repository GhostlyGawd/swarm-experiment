import * as b from '../../../../src/tier1/build.ts';
import {SymbolSpace} from '../../../../src/tier1/symbols.ts';
import type {Ty} from '../../../../src/tier1/ast.ts';

/** Generic factory bodies retain concrete witnesses in closures and lazy tasks. */
export function genericContinuationFixture(){
 const symbols=new SymbolSpace('generic-continuations'),id=symbols.define('id'),make=symbols.define('make'),task=symbols.define('task'),main=symbols.define('main'),x=symbols.define('x');
 const T:Ty={t:'TypeVar',name:'T'},closure:Ty={t:'Fn',params:[],returns:T,capabilities:[]},result:Ty={t:'Record',name:'type:generic:continuations' as never,fields:[['integer',b.Int],['string',b.Str],['task',b.Str]]};
 const module=b.module_({symbol:symbols.define('module'),symbolTable:symbols.table(),members:[
  b.fn({symbol:id,typeParams:['T'],params:[b.param(x,T)],returns:T,body:b.ret(b.v(x))}),
  b.fn({symbol:make,typeParams:['T'],params:[b.param(x,T)],returns:closure,body:b.ret(b.lambda({returns:T,body:b.call(id,b.v(x))}))}),
  b.fn({symbol:task,typeParams:['T'],params:[b.param(x,T)],returns:{t:'Task',result:T},body:b.ret(b.spawn(b.call(id,b.v(x))))}),
  b.fn({symbol:main,returns:result,body:b.ret(b.record(result,{integer:b.apply(b.call(make,b.int(7))),string:b.apply(b.call(make,b.str('saved'))),task:b.await_(b.call(task,b.str('later')))}))}),
 ]});
 return{symbols,module,main};
}

export function genericContinuationCorpus(){const f=genericContinuationFixture();return[{id:'generic-captured-continuations',module:f.module,symbols:f.symbols}];}
