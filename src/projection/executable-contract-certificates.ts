import { createHash } from 'node:crypto';
import { GraphStore } from '../tier1/store.ts';
import { moduleFunctions } from './executable-generic-plan.ts';
import { linkGroups, walk, type Term, type Ty } from '../tier1/ast.ts';
import type { SymbolId } from '../tier1/ids.ts';

export const CONTRACT_CLOSURE_PROFILE = 'aether.executable-projection/15';
const BODY_KINDS = new Set(['Lit', 'Var', 'Bin', 'Un', 'Cond', 'IntCast', 'FixedBin', 'StringOp']);

function scalar(ty: Ty): boolean {
  if (ty.t === 'Nominal') return scalar(ty.repr);
  if (ty.t === 'Owned') return scalar(ty.inner);
  return ['Int', 'Bool', 'Str', 'Unit', 'IntN'].includes(ty.t);
}

/** Conservative certificate set for native closure bodies. The parser
 * recomputes it from the visible AST; runtime admission also checks captures. */
export function contractClosureCertificates(module: Term): ReadonlyMap<string, string> {
  const result = new Map<string, string>(), store = new GraphStore();
  for (const fn of moduleFunctions(module)) {
    if (fn.typeParams.length) continue;
    const entry = new Map<SymbolId, Ty>();
    for (const param of fn.params) entry.set(param.symbol, param.ty);
    for (const surface of fn.surfaces) {
      if (surface.kind !== 'Surface') continue;
      entry.set(surface.symbol, surface.domain.d === 'range' ? { t: 'Int' } : { t: 'Str' });
    }
    const ownerRoot = store.intern(fn);
    const visitExpr=(node:Term,scope:ReadonlyMap<SymbolId,Ty>):void=>{
      if(node.kind==='Lambda'){
        if(node.capabilities.length||!scalar(node.returns)||node.params.some(param=>!scalar(param.ty))
          ||[...scope.values()].some(ty=>!scalar(ty)))return;
        const bound=new Set([...scope.keys(),...node.params.map(param=>param.symbol)]);
        if([...walk(node.body)].some(child=>!BODY_KINDS.has(child.kind)
          ||child.kind==='Var'&&!bound.has(child.symbol)))return;
        const lambdaRoot=store.intern(node);
        const subject = `${CONTRACT_CLOSURE_PROFILE}\n${ownerRoot}\n${lambdaRoot}`;
        const digest = createHash('sha256').update(subject).digest('hex');
        result.set(`${fn.symbol}/${lambdaRoot}`, `cc15:${digest}`);
        return;
      }
      for(const group of linkGroups(node))for(const child of group.links)visitExpr(child,scope);
    };
    const visitStmt=(node:Term,scope:Map<SymbolId,Ty>):void=>{
      if(node.kind==='Block'){const inner=new Map(scope);node.stmts.forEach(stmt=>visitStmt(stmt,inner));return;}
      if(node.kind==='Let'){visitExpr(node.init,scope);scope.set(node.symbol,node.ty);return;}
      if(node.kind==='If'){visitExpr(node.cond,scope);visitStmt(node.then,new Map(scope));if(node.otherwise)visitStmt(node.otherwise,new Map(scope));return;}
      if(node.kind==='While'){visitExpr(node.cond,scope);node.invariants.forEach(inv=>visitExpr(inv,scope));if(node.variant)visitExpr(node.variant,scope);visitStmt(node.body,new Map(scope));return;}
      if(node.kind==='Atomic'){visitStmt(node.body,new Map(scope));return;}
      for(const group of linkGroups(node))for(const child of group.links)visitExpr(child,scope);
    };
    if(fn.contract?.kind==='Contract')for(const clause of [...fn.contract.requires,...fn.contract.ensures])if(clause.kind==='Clause')visitExpr(clause.expr,entry);
    if(fn.body)visitStmt(fn.body,new Map(entry));
  }
  return result;
}

export function closureCertificateKey(owner: SymbolId, lambda: Extract<Term, { kind: 'Lambda' }>): string {
  return `${owner}/${new GraphStore().intern(lambda)}`;
}
