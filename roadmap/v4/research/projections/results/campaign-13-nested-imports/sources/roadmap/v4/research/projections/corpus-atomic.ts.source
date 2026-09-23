import * as b from '../../../../src/tier1/build.ts';
import {SymbolSpace} from '../../../../src/tier1/symbols.ts';
import type {Term,Ty} from '../../../../src/tier1/ast.ts';
export function atomicProjectionFixture(){
 const symbols=new SymbolSpace('projection-atomic'),fn=Object.fromEntries(['write','fail','normal','returned','postFail','outerPostFail','innerFail','returnFault','overflow','allocate','makeTask','taskWork','awaitFail','awaitTask','revoke'].map(n=>[n,symbols.define(n)]));
 const r=symbols.define('record'),x=symbols.define('local'),a=symbols.define('allocated'),task=symbols.define('task'),cap='cap:test:emit' as never;
 const box:Ty={t:'Record',name:'type:atomic:box' as never,fields:[['value',b.Int]]},taskTy:Ty={t:'Task',result:box};
 const write=(n:number)=>b.assign(b.place(r,'value'),b.int(n));
 const record=(n:number)=>b.record(box,{value:b.int(n)});
 const fail=b.assert_(b.bool(false),'atomic-fault');
 const decl=(name:string,body:Term,returns:Ty=b.Unit,effectful=false,contract:Term|null=null)=>b.fn({symbol:fn[name],params:[b.param(r,box)],returns,body,capabilities:effectful?[cap]:[],purity:effectful?'effectful':'pure',contract});
 const members=[
  decl('write',b.block(write(11),b.ret(b.unit()))),
  decl('fail',b.block(b.let_(x,b.Int,b.int(1)),b.atomic(b.block(b.assign(b.place(x),b.int(20)),write(9),b.exprStmt(b.invoke(cap,b.v(r))),b.exprStmt(b.call(fn.write,b.v(r))),b.let_(a,box,record(50)),b.exprStmt(b.invoke(cap,b.v(a))),fail))),b.Unit,true),
  decl('normal',b.block(b.atomic(b.block(write(2),b.atomic(b.block(write(3))))),write(4),b.ret(b.field(b.v(r),'value'))),b.Int),
  decl('returned',b.block(b.let_(x,b.Int,b.int(1)),b.atomic(b.block(b.assign(b.place(x),b.int(3)),b.atomic(b.block(write(7),b.while_(b.bool(true),b.block(b.ret(b.add(b.field(b.v(r),'value'),b.v(x))))))),write(99))),b.ret(b.int(99))),b.Int),
  decl('postFail',b.block(b.atomic(b.block(write(8),b.ret(b.int(8)))),b.ret(b.int(0))),b.Int,false,b.contract({ensures:[b.clause(b.bool(false),'post-return')]})),
  decl('outerPostFail',b.atomic(b.block(write(2),b.exprStmt(b.call(fn.postFail,b.v(r)))))),
  decl('innerFail',b.atomic(b.block(write(2),b.atomic(b.block(write(3),fail))))),
  decl('returnFault',b.block(b.atomic(b.block(write(5),b.ret(b.div(b.int(1),b.int(0))))),b.ret(b.int(0))),b.Int),
  decl('overflow',b.atomic(b.block(write(6),b.exprStmt(b.intCast({t:'IntN',bits:8,signed:true,overflow:'trap'},b.int(128)))))),
  b.fn({symbol:fn.allocate,returns:box,body:b.ret(record(99))}),
  b.fn({symbol:fn.makeTask,returns:taskTy,purity:'effectful',capabilities:[cap],body:b.ret(b.spawn(b.call(fn.taskWork)))}),
  b.fn({symbol:fn.taskWork,returns:box,purity:'effectful',capabilities:[cap],body:b.block(b.exprStmt(b.invoke(cap,b.int(1))),b.ret(record(60)))}),
  b.fn({symbol:fn.awaitFail,params:[b.param(task,taskTy)],returns:b.Unit,purity:'effectful',capabilities:[cap],body:b.atomic(b.block(b.let_(a,box,b.await_(b.v(task))),fail))}),
  b.fn({symbol:fn.awaitTask,params:[b.param(task,taskTy)],returns:box,purity:'effectful',capabilities:[cap],body:b.ret(b.await_(b.v(task)))}),
  decl('revoke',b.atomic(b.block(write(10),b.exprStmt(b.invoke(cap,b.int(1))),write(12),b.exprStmt(b.invoke(cap,b.int(2))))),b.Unit,true),
 ];
 return{symbols,fn,box,taskTy,cap,module:b.module_({symbol:symbols.define('module'),members,symbolTable:symbols.table()})};
}
export function atomicProjectionCorpus(){const f=atomicProjectionFixture();return[{id:'atomic-nested-return-fault',symbols:f.symbols,module:f.module}];}
