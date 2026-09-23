import * as b from '../../../../src/tier1/build.ts';
import {SymbolSpace} from '../../../../src/tier1/symbols.ts';
import {GraphStore} from '../../../../src/tier1/store.ts';
import type {Term} from '../../../../src/tier1/ast.ts';
export function stringImportProjectionFixture(){
 const symbols=new SymbolSpace('projection-strings-imports'),ids=Object.fromEntries(['length','contains','slice','lower','upper','trim','marker','bidi','transform','entry','task','awaitTask'].map(n=>[n,symbols.define(n)]));
 const text=symbols.define('text'),other=symbols.define('other'),start=symbols.define('start'),end=symbols.define('end'),task=symbols.define('task'),cap='cap:test:emit' as never;
 const op=(name:string,operation:'strlen'|'contains'|'slice'|'lower'|'upper'|'trim',returns:typeof b.Str,extra:ReturnType<typeof b.param>[]=[])=>b.fn({symbol:ids[name],params:[b.param(text,b.Str),...extra],returns,body:b.ret(b.stringOp(operation,b.v(text),...extra.map(p=>b.v(p.symbol))))});
 const leaf=b.module_({symbol:symbols.define('leaf'),members:[op('length','strlen',b.Int),op('contains','contains',b.Bool,[b.param(other,b.Str)]),op('slice','slice',b.Str,[b.param(start,b.Int),b.param(end,b.Int)]),op('lower','lower',b.Str),op('upper','upper',b.Str),op('trim','trim',b.Str),b.fn({symbol:ids.marker,returns:b.Str,body:b.ret(b.str('imported'))}),b.fn({symbol:ids.bidi,returns:b.Str,body:b.ret(b.stringOp('trim',b.str('x\u202ay\u2069')))})],symbolTable:symbols.table()});
 const store=new GraphStore(),leafRef=store.intern(leaf),mid=b.module_({symbol:symbols.define('middle'),members:[b.import_(leafRef,[]),b.fn({symbol:ids.transform,params:[b.param(text,b.Str)],returns:b.Str,body:b.ret(b.concat(b.call(ids.upper,b.call(ids.trim,b.v(text))),b.concat(b.str(':'),b.call(ids.marker))))})],symbolTable:symbols.table()}),midRef=store.intern(mid);
 const module=b.module_({symbol:symbols.define('entryModule'),members:[b.import_(midRef,[]),b.fn({symbol:ids.entry,returns:b.Str,capabilities:[cap],purity:'effectful',body:b.block(b.let_(text,b.Str,b.call(ids.transform,b.stringOp('slice',b.str('  Straße\ufeff'),b.int(0),b.int(999)))),b.exprStmt(b.invoke(cap,b.v(text))),b.ret(b.v(text)))}),b.fn({symbol:ids.task,params:[b.param(text,b.Str)],returns:{t:'Task',result:b.Str},body:b.ret(b.spawn(b.stringOp('upper',b.v(text))))}),b.fn({symbol:ids.awaitTask,params:[b.param(task,{t:'Task',result:b.Str})],returns:b.Str,body:b.ret(b.await_(b.v(task)))})],symbolTable:symbols.table()});
 return{symbols,ids,module:module as Extract<Term,{kind:'Module'}>,cap,leaf:leaf as Extract<Term,{kind:'Module'}>,leafRef,mid:mid as Extract<Term,{kind:'Module'}>,midRef,modules:new Map([[leafRef,leaf],[midRef,mid]])};
}
export function stringImportProjectionCorpus(){const f=stringImportProjectionFixture();return[{id:'strings-linked-imports',symbols:f.symbols,module:f.module,modules:f.modules}];}
/** Scalar strings that exercise JS-specific trim and Unicode casing boundaries. */
export const stringCases=['','A😀B','Straße','İIıi','ΟΣ','ΟΣΑ','Σ','AΣ\u0301','AΣ\u0301B','A\u0345Σ','AΣ\u0345','\ufeff\u00a0 hello \u2029','\u0085 keep \u001c','\u180e keep \u200b','ﬃ','ŉ','ǰ','𐐀𐐨','\u1c89\u1c8a','\u{1cce0}\u{1cce1}','é e\u0301'];
