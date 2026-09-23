/** Candidate-only FR-2.5 static typing experiment. No production admission path. */
import { walk, type Term, type Ty } from '../../../../src/tier1/ast.ts';
import type { SymbolId } from '../../../../src/tier1/ids.ts';
import { typecheck, tyEqual } from '../../../../src/tier2/typecheck.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import type { ResourceAmounts } from '../../../../src/tier2/resource-budget.ts';

type Function = Extract<Term, { kind: 'FunctionDecl' }>;
export interface LinearBudgetContract {
  readonly entry: SymbolId;
  readonly reserve: SymbolId;
  readonly consume: SymbolId;
  readonly fallback: SymbolId;
  /** All four exact fixed-unit dimensions are mandatory. */
  readonly maximum: ResourceAmounts;
  readonly reservation: ResourceAmounts;
  readonly committedCharge: ResourceAmounts;
}
export interface BudgetCheck {
  readonly ok: boolean;
  readonly diagnostics: readonly string[];
}

const dimensions = ['usdMicros', 'tokens', 'nanoseconds', 'memoryBytes'] as const;
const max = (1n << 128n) - 1n;
function amounts(input: ResourceAmounts, label: string, errors: string[]): bigint[] | null {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join('|') !== [...dimensions].sort().join('|')) {
    errors.push(`${label}: four exact resource dimensions required`); return null;
  }
  const values: bigint[] = [];
  for (const key of dimensions) {
    const value = input[key];
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39 || BigInt(value) > max) {
      errors.push(`${label}: ${key} must be a canonical unsigned 128-bit integer`); return null;
    }
    values.push(BigInt(value));
  }
  return values;
}
const owned = (ty: Ty): Ty => ({ t: 'Owned', inner: ty });
const fn = (functions: Map<SymbolId, Function>, id: SymbolId, role: string, errors: string[]): Function | null => {
  const item = functions.get(id); if (!item) errors.push(`${role}: missing function declaration`); return item ?? null;
};
const isCall = (term: Term, id: SymbolId, arg: SymbolId): boolean =>
  term.kind === 'Call' && term.callee === id && term.args.length === 1 && term.args[0].kind === 'Var' && term.args[0].symbol === arg;
function exactlyOne(body: Term, id: SymbolId, label: string, errors: string[]): void {
  const count = [...walk(body)].filter(item => item.kind === 'Var' && item.symbol === id).length;
  if (count !== 1) errors.push(`${label}: linear handle used ${count} times; expected exactly once`);
}
function calls(term: Term): SymbolId[] {
  const result: SymbolId[] = [];
  for (const item of walk(term)) {
    if (item.kind === 'Call' || item.kind === 'SeqMap' || item.kind === 'SeqFold') result.push(item.callee);
  }
  return result;
}
function cyclic(functions: Map<SymbolId, Function>): boolean {
  const visiting = new Set<SymbolId>(), visited = new Set<SymbolId>();
  const visit = (id: SymbolId): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of calls(functions.get(id)?.body ?? { kind: 'Block', stmts: [] })) {
      if (functions.has(target) && visit(target)) return true;
    }
    visiting.delete(id); visited.add(id); return false;
  };
  return [...functions.keys()].some(visit);
}

/**
 * Intentionally accepts only a closed, fixed-charge slice of Aether AST:
 * reserve(Budget) -> Result<Reserved, Budget>; exhaustive success/denial arms;
 * consume(Reserved) -> Unit; fallback(Budget) -> Owned<Budget>. Any other
 * budget-bearing/control-flow form is rejected, not silently assumed safe.
 */
export function checkLinearBudget(module: Term, contract: LinearBudgetContract, registry: CapabilityRegistry): BudgetCheck {
  const errors: string[] = [];
  if (module.kind !== 'Module') return { ok: false, diagnostics: ['root must be an Aether Module'] };
  const base = typecheck(module, { registry });
  if (!base.ok) errors.push(...base.diagnostics.map(d => `Aether typecheck ${d.code}: ${d.message}`));
  const functions = new Map<SymbolId, Function>();
  for (const member of module.members) {
    if (member.kind !== 'FunctionDecl') { errors.push('research profile requires only closed function declarations'); continue; }
    if (functions.has(member.symbol)) errors.push('duplicate function identity');
    functions.set(member.symbol, member);
  }
  if (new Set([contract.entry, contract.reserve, contract.consume, contract.fallback]).size !== 4) errors.push('budget roles must have distinct function identities');
  if (functions.size !== 4) errors.push('research profile requires exactly entry, reserve, consume and fallback functions');
  const limit = amounts(contract.maximum, 'signature maximum', errors);
  const reservation = amounts(contract.reservation, 'reservation', errors);
  const charge = amounts(contract.committedCharge, 'committed charge', errors);
  if (limit && reservation && charge) {
    if (limit.some((n, i) => n !== reservation[i]) || charge.some((n, i) => n !== reservation[i]))
      errors.push('fixed-charge research profile requires maximum = reservation = charge in all four dimensions');
    if (charge.every(n => n === 0n)) errors.push('empty spending annotation');
  }
  const entry = fn(functions, contract.entry, 'entry', errors), reserve = fn(functions, contract.reserve, 'reserve', errors);
  const consume = fn(functions, contract.consume, 'consume', errors), fallback = fn(functions, contract.fallback, 'fallback', errors);
  if (!entry || !reserve || !consume || !fallback) return { ok: false, diagnostics: errors };
  if (!entry.body || !fallback.body || reserve.body || consume.body) errors.push('entry and fallback must have bodies; reserve and consume must be host implementations');
  if (entry.params.length !== 1 || reserve.params.length !== 1 || consume.params.length !== 1 || fallback.params.length !== 1)
    errors.push('each research function must have exactly one handle parameter');
  const budget = entry.params[0]?.ty, reserved = consume.params[0]?.ty;
  const budgetInner = budget;
  const reserveInner = reserved?.t === 'Owned' ? reserved.inner : null;
  if (!budgetInner || budgetInner.t !== 'Nominal' || !reserveInner || reserveInner.t !== 'Nominal') errors.push('nominal Budget and Owned<Reserved> parameter types required');
  if (budgetInner && reserveInner && tyEqual(budgetInner, reserveInner)) errors.push('available and reserved handles require distinct nominal types');
  if (budgetInner && reserveInner) {
    const result: Ty = { t: 'Result', ok: reserveInner, err: budgetInner };
    const entryResult: Ty = { t: 'Result', ok: { t: 'Unit' }, err: owned(budgetInner) };
    if (!tyEqual(reserve.params[0].ty, owned(budgetInner)) || !tyEqual(reserve.returns, result)) errors.push('reserve must consume Owned<Budget> and return Result<Reserved,Budget>');
    if (!tyEqual(consume.returns, { t: 'Unit' })) errors.push('consume must return Unit');
    if (!tyEqual(fallback.params[0].ty, owned(budgetInner)) || !tyEqual(fallback.returns, owned(budgetInner))) errors.push('fallback must return the untouched Owned<Budget>');
    if (!tyEqual(entry.returns, entryResult)) errors.push('entry must return Result<Unit,Owned<Budget>>');
  }
  if (entry.purity !== 'effectful' || reserve.purity !== 'effectful' || consume.purity !== 'effectful' || fallback.purity !== 'pure' || fallback.capabilities.length)
    errors.push('entry/reserve/consume must be effectful and fallback must be capability-free pure');
  if (cyclic(functions)) errors.push('recursive budget call graph has no statically enforced bound');
  if (entry.body && entry.params[0]) {
    const body = entry.body;
    const expr = body.kind === 'Block' && body.stmts.length === 1 && body.stmts[0].kind === 'Return' ? body.stmts[0].value : null;
    const match = expr?.kind === 'MatchResult' ? expr : null;
    if (match) {
      exactlyOne(body, entry.params[0].symbol, 'entry budget', errors);
      exactlyOne(match.ok, match.okSymbol, 'reserved success handle', errors);
      exactlyOne(match.err, match.errSymbol, 'denied budget handle', errors);
      if (!isCall(match.value, contract.reserve, entry.params[0].symbol)) errors.push('entry must reserve its unique budget handle');
      if (match.ok.kind !== 'ResultValue' || match.ok.variant !== 'ok' || !isCall(match.ok.value, contract.consume, match.okSymbol)) errors.push('success must consume the reserved handle exactly once');
      if (match.err.kind !== 'ResultValue' || match.err.variant !== 'err' || !isCall(match.err.value, contract.fallback, match.errSymbol)) errors.push('exhaustion must explicitly call the declared fallback');
    } else errors.push('entry must return exhaustive MatchResult(reserve), with explicit success and exhaustion arms');
    const forbidden = [...walk(body)].find(item => ['Invoke', 'While', 'ForAll', 'Spawn', 'Await', 'Lambda', 'Apply', 'SeqMap', 'SeqFold', 'Assign', 'Atomic'].includes(item.kind));
    if (forbidden) errors.push(`unsupported budget control-flow node ${forbidden.kind}`);
    for (const target of calls(body)) if (![contract.reserve, contract.consume, contract.fallback].includes(target)) errors.push('undeclared spending or call from budget entry');
  }
  if (fallback.body && fallback.params[0]) {
    exactlyOne(fallback.body, fallback.params[0].symbol, 'fallback budget', errors);
    const valid = fallback.body.kind === 'Block' && fallback.body.stmts.length === 1 && fallback.body.stmts[0].kind === 'Return' && fallback.body.stmts[0].value.kind === 'Var' && fallback.body.stmts[0].value.symbol === fallback.params[0].symbol;
    if (!valid) errors.push('safe fallback must return the same unspent handle without effects');
    if ([...walk(fallback.body)].some(item => item.kind === 'Invoke' || item.kind === 'Call')) errors.push('fallback cannot spend or invoke outside effects');
  }
  return { ok: errors.length === 0, diagnostics: errors };
}
