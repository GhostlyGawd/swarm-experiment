import { createHash } from 'node:crypto';
import { GraphStore } from '../tier1/store.ts';
import { moduleFunctions } from './executable-generic-plan.ts';
import { linkGroups, walk, type Term, type Ty } from '../tier1/ast.ts';
import type { SymbolId } from '../tier1/ids.ts';

export const CONTRACT_CLOSURE_PROFILE = 'aether.executable-projection/15';
const BODY_KINDS = new Set(['Lit', 'Var', 'Bin', 'Un', 'Cond', 'IntCast', 'FixedBin', 'StringOp']);
const BODY_KINDS_16 = new Set([...BODY_KINDS, 'ForAll', 'Call', 'ResultValue', 'MatchResult',
  'SeqLit', 'SeqIndex', 'SeqLength', 'SeqMap', 'SeqFold', 'Lambda', 'Apply',
  'RecordLit', 'Field']);

function scalar(ty: Ty): boolean {
  if (ty.t === 'Nominal') return scalar(ty.repr);
  if (ty.t === 'Owned') return scalar(ty.inner);
  return ['Int', 'Bool', 'Str', 'Unit', 'IntN'].includes(ty.t);
}

/** Conservative certificate set for native closure bodies. The parser
 * recomputes it from the visible AST; runtime admission also checks captures. */
export function contractClosureCertificates(module: Term, version: 15 | 16 = 15): ReadonlyMap<string, string> {
  const result = new Map<string, string>(), store = new GraphStore();
  const functions = new Map(moduleFunctions(module).map(fn => [fn.symbol, fn] as const));
  const helperRoots = (node: Term, initial: ReadonlySet<SymbolId>): string[] | null => {
    const roots = new Set<string>(), checking = new Set<SymbolId>(), checked = new Set<SymbolId>();
    const safeExpression = (expression: Term, bound: ReadonlySet<SymbolId>): boolean => {
      if (!BODY_KINDS_16.has(expression.kind)) return false;
      if (expression.kind === 'Var' && !bound.has(expression.symbol)) return false;
      if (expression.kind === 'Lambda') {
        if (expression.capabilities.length || !scalar(expression.returns)
          || expression.params.some(param => !scalar(param.ty))) return false;
        return safeExpression(expression.body,
          new Set([...bound, ...expression.params.map(param => param.symbol)]));
      }
      if (expression.kind === 'Apply') {
        if (expression.fn.kind !== 'Lambda' || !safeExpression(expression.fn, bound)) return false;
        return expression.args.every(arg => safeExpression(arg, bound));
      }
      if (expression.kind === 'Call' && !safeHelper(expression.callee)) return false;
      if ((expression.kind === 'SeqMap' || expression.kind === 'SeqFold') && !safeHelper(expression.callee)) return false;
      if (expression.kind === 'SeqLit' && (expression.ty.t !== 'Seq' || !scalar(expression.ty.element))) return false;
      if (expression.kind === 'RecordLit' && (expression.ty.t !== 'Record'
        || expression.ty.fields.some(([,ty]) => !scalar(ty)))) return false;
      if (expression.kind === 'Field' && expression.object.kind !== 'RecordLit') return false;
      if (expression.kind === 'ForAll') {
        if (!safeExpression(expression.start, bound) || !safeExpression(expression.end, bound)) return false;
        return safeExpression(expression.body, new Set([...bound, expression.symbol]));
      }
      if (expression.kind === 'MatchResult') {
        const value = expression.value;
        if (value.kind !== 'ResultValue' || value.ty.t !== 'Result'
          || !scalar(value.ty.ok) || !scalar(value.ty.err) || !safeExpression(value, bound)) return false;
        return safeExpression(expression.ok, new Set([...bound, expression.okSymbol]))
          && safeExpression(expression.err, new Set([...bound, expression.errSymbol]));
      }
      for (const group of linkGroups(expression)) for (const child of group.links)
        if (!safeExpression(child, bound)) return false;
      return true;
    };
    const safeHelper = (symbol: SymbolId): boolean => {
      if (checking.has(symbol)) return false;
      if (checked.has(symbol)) return true;
      const fn = functions.get(symbol);
      if (!fn || fn.purity !== 'pure' || fn.capabilities.length || fn.typeParams.length
        || fn.contract !== null || fn.body?.kind !== 'Return' || !scalar(fn.returns)
        || fn.params.some(param => !scalar(param.ty)) || fn.surfaces.some(surface => surface.kind !== 'Surface')) return false;
      const bound = new Set(fn.params.map(param => param.symbol));
      for (const surface of fn.surfaces) if (surface.kind === 'Surface') bound.add(surface.symbol);
      checking.add(symbol);
      const safe = safeExpression(fn.body.value, bound);
      checking.delete(symbol);
      if (!safe) return false;
      checked.add(symbol);
      roots.add(store.intern(fn));
      return true;
    };
    return safeExpression(node, initial) ? [...roots].sort() : null;
  };
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
        const dependencies = version === 16 ? helperRoots(node.body, bound) : null;
        if(version===15&&[...walk(node.body)].some(child=>!BODY_KINDS.has(child.kind)
          ||child.kind==='Var'&&!bound.has(child.symbol)))return;
        if(version===16&&!dependencies)return;
        const lambdaRoot=store.intern(node);
        const profile=version===16?'aether.executable-projection/16':CONTRACT_CLOSURE_PROFILE;
        const subject = `${profile}\n${ownerRoot}\n${lambdaRoot}${version===16?`\n${dependencies!.join('\n')}`:''}`;
        const digest = createHash('sha256').update(subject).digest('hex');
        result.set(`${fn.symbol}/${lambdaRoot}`, `cc${version}:${digest}`);
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
