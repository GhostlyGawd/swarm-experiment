import * as b from '../../../../src/tier1/build.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import type { Term, Ty } from '../../../../src/tier1/ast.ts';
/** One additional authored workload; the original scalar corpus remains intact. */
export function compositeProjectionCorpus():{id:string;module:Term;symbols:SymbolSpace}[]{
 const symbols=new SymbolSpace('projection-composite-corpus'),main=symbols.define('updateSharedRecord'),increment=symbols.define('increment'),sum=symbols.define('sum');
 const row=symbols.define('row'),alias=symbols.define('alias'),item=symbols.define('item'),acc=symbols.define('acc'),ok=symbols.define('ok'),err=symbols.define('error');
 const record:Ty={t:'Record',name:'type:corpus:counter' as never,fields:[['value',b.Int]]},result={t:'Result' as const,ok:record,err:b.Str};
 const members=[b.typeDecl('type:corpus:counter' as never,record),b.fn({symbol:main,returns:{t:'Seq',element:b.Int},body:b.block(
  b.let_(row,record,b.record(record,{value:b.int(1)})),b.let_(alias,record,b.v(row)),b.assign(b.place(alias,'value'),b.add(b.field(b.v(row),'value'),b.int(1))),
  b.ret(b.seq(b.Int,b.matchResult(b.ok(result,b.v(row)),ok,b.field(b.v(ok),'value'),err,b.int(0)),b.fold(b.map(b.seq(b.Int,b.int(1),b.int(2)),increment),b.int(0),sum))),
 )}),b.fn({symbol:increment,params:[b.param(item,b.Int)],returns:b.Int,body:b.ret(b.add(b.v(item),b.int(1)))}),b.fn({symbol:sum,params:[b.param(acc,b.Int),b.param(item,b.Int)],returns:b.Int,body:b.ret(b.add(b.v(acc),b.v(item)))})];
 return[{id:'composite-alias-collections',symbols,module:b.module_({symbol:symbols.define('module'),members,symbolTable:symbols.table()})}];
}
