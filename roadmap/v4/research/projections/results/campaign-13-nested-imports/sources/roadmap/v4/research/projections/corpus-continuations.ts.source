import * as b from '../../../../src/tier1/build.ts';
import {SymbolSpace} from '../../../../src/tier1/symbols.ts';
import type {Term,Ty} from '../../../../src/tier1/ast.ts';
export function continuationProjectionCorpus():{id:string;module:Term;symbols:SymbolSpace}[]{
 const symbols=new SymbolSpace('projection-continuation-corpus'),main=symbols.define('captureAndAwait'),x=symbols.define('captured'),y=symbols.define('argument'),f=symbols.define('closure'),t=symbols.define('pending'),one=symbols.define('first');
 const fnType:Ty={t:'Fn',params:[b.Int],returns:b.Int,capabilities:[]},taskType:Ty={t:'Task',result:b.Int};
 const member=b.fn({symbol:main,returns:b.Int,body:b.block(b.let_(x,b.Int,b.int(4)),b.let_(f,fnType,b.lambda({params:[b.param(y,b.Int)],returns:b.Int,body:b.add(b.v(x),b.v(y))})),b.let_(t,taskType,b.spawn(b.apply(b.v(f),b.int(8)))),b.assign(b.place(x),b.int(40)),b.let_(one,b.Int,b.await_(b.v(t))),b.ret(b.add(b.v(one),b.await_(b.v(t)))))});
 return[{id:'continuation-capture-task',symbols,module:b.module_({symbol:symbols.define('module'),members:[member],symbolTable:symbols.table()})}];
}
