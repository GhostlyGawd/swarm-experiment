import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as b from '../../../../src/tier1/build.ts';
import type { Term } from '../../../../src/tier1/ast.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { typeName, type SymbolId } from '../../../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { ResourceBudgetLedger, RESOURCE_BUDGET_PROFILE, type ResourceAmounts, type ResourceRequest, type ResourceSettlement } from '../../../../src/tier2/resource-budget.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { checkLinearBudget, type LinearBudgetContract } from './checker.ts';

const amount = (n: number): ResourceAmounts => ({ usdMicros: String(n), tokens: String(n), nanoseconds: String(n), memoryBytes: String(n) });
function program() {
  const names = new SymbolSpace('linear-budget-research');
  const entry = names.define('entry'), reserve = names.define('reserve'), consume = names.define('consume'), fallback = names.define('fallback');
  const budget = names.define('budget'), reserveParam = names.define('reserveBudget'), reserved = names.define('reserved');
  const consumeParam = names.define('consumeReserved'), denied = names.define('denied'), fallbackParam = names.define('fallbackBudget');
  const budgetTy = { t: 'Nominal' as const, name: typeName('type:budget:available'), repr: b.Str };
  const reservedTy = { t: 'Nominal' as const, name: typeName('type:budget:reserved'), repr: b.Str };
  const reserveResult = { t: 'Result' as const, ok: reservedTy, err: budgetTy };
  const entryResult = { t: 'Result' as const, ok: b.Unit, err: b.owned(budgetTy) };
  const registry = new CapabilityRegistry();
  const reserveCap = registry.declare('cap:budget:reserve', { arity: 1, description: 'research host reserve' }).name;
  const consumeCap = registry.declare('cap:budget:consume', { arity: 1, description: 'research host consume' }).name;
  const entryDecl = b.fn({ symbol: entry, params: [b.param(budget, budgetTy)], returns: entryResult,
    capabilities: [reserveCap, consumeCap],
    body: b.block(b.ret(b.matchResult(b.call(reserve, b.v(budget)), reserved,
      b.ok(entryResult, b.call(consume, b.v(reserved))), denied,
      b.err(entryResult, b.call(fallback, b.v(denied)))))),
  });
  const reserveDecl = b.fn({ symbol: reserve, params: [b.param(reserveParam, b.owned(budgetTy))],
    returns: reserveResult, capabilities: [reserveCap], purity: 'effectful' });
  const consumeDecl = b.fn({ symbol: consume, params: [b.param(consumeParam, b.owned(reservedTy))],
    returns: b.Unit, capabilities: [consumeCap], purity: 'effectful' });
  const fallbackDecl = b.fn({ symbol: fallback, params: [b.param(fallbackParam, b.owned(budgetTy))],
    returns: b.owned(budgetTy), body: b.block(b.ret(b.v(fallbackParam))) });
  const module = b.module_({ symbol: names.define('module'), symbolTable: names.table(), members: [entryDecl, reserveDecl, consumeDecl, fallbackDecl] });
  const contract: LinearBudgetContract = { entry, reserve, consume, fallback, maximum: amount(10), reservation: amount(10), committedCharge: amount(10) };
  return { module, contract, registry, symbols: { entry, reserve, consume, fallback, budget, reserved, denied } };
}
function replaceEntry(module: Term, change: (body: Term) => Term): Term {
  assert.equal(module.kind, 'Module'); const member = module.members[0]; assert.equal(member.kind, 'FunctionDecl'); assert.ok(member.body);
  return { ...module, members: [{ ...member, body: change(member.body) }, ...module.members.slice(1)] };
}
function replaceMatch(module: Term, change: (match: Extract<Term, { kind: 'MatchResult' }>) => Term): Term {
  return replaceEntry(module, body => {
    assert.equal(body.kind, 'Block'); const ret = body.stmts[0]; assert.equal(ret.kind, 'Return'); assert.equal(ret.value.kind, 'MatchResult');
    return b.block(b.ret(change(ret.value)));
  });
}
function errors(module: Term, contract: LinearBudgetContract, registry: CapabilityRegistry): string {
  return checkLinearBudget(module, contract, registry).diagnostics.join('\n');
}

test('real Aether AST passes base typecheck and fixed-charge linear budget checker', () => {
  const p = program(); assert.deepEqual(checkLinearBudget(p.module, p.contract, p.registry), { ok: true, diagnostics: [] });
});
test('same success handle twice is rejected before host execution', () => {
  const p = program(); const changed = replaceMatch(p.module, match => ({ ...match, ok: b.ok((match.ok as Extract<Term, { kind: 'ResultValue' }>).ty,
    b.call(p.symbols.consume, b.v(match.okSymbol), b.v(match.okSymbol))) }));
  assert.match(errors(changed, p.contract, p.registry), /linear handle used 2 times/);
});
test('undeclared effect call or spending is rejected', () => {
  const p = program(), extra = new SymbolSpace('rogue').define('rogue');
  const changed = replaceMatch(p.module, match => ({ ...match, ok: b.ok((match.ok as Extract<Term, { kind: 'ResultValue' }>).ty,
    b.call(extra, b.v(match.okSymbol))) }));
  assert.match(errors(changed, p.contract, p.registry), /undeclared spending or call/);
});
test('missing or wrong exhaustion fallback is rejected', () => {
  const p = program(); const changed = replaceMatch(p.module, match => ({ ...match, err: b.err((match.err as Extract<Term, { kind: 'ResultValue' }>).ty, b.v(match.errSymbol)) }));
  assert.match(errors(changed, p.contract, p.registry), /must explicitly call the declared fallback/);
});
test('fallback cannot spend or regain an effect capability', () => {
  const p = program(); assert.equal(p.module.kind, 'Module');
  const fallback = p.module.members[3]; assert.equal(fallback.kind, 'FunctionDecl');
  const changed = { ...p.module, members: [...p.module.members.slice(0, 3), { ...fallback, body: b.block(b.ret(b.call(p.symbols.reserve, b.v(fallback.params[0].symbol)))) }] };
  assert.match(errors(changed, p.contract, p.registry), /fallback cannot spend or invoke outside effects/);
});
test('recursive budget call graph without an enforced bound is rejected', () => {
  const p = program(); assert.equal(p.module.kind, 'Module'); const fallback = p.module.members[3]; assert.equal(fallback.kind, 'FunctionDecl');
  const changed = { ...p.module, members: [...p.module.members.slice(0, 3), { ...fallback, body: b.block(b.ret(b.call(p.symbols.fallback, b.v(fallback.params[0].symbol)))) }] };
  assert.match(errors(changed, p.contract, p.registry), /recursive budget call graph has no statically enforced bound/);
});
test('all four dimensions and fixed charge bound are checked', () => {
  const p = program();
  assert.match(errors(p.module, { ...p.contract, maximum: { ...p.contract.maximum, memoryBytes: '9' } }, p.registry), /maximum = reservation = charge/);
  assert.match(errors(p.module, { ...p.contract, committedCharge: { ...p.contract.committedCharge, tokens: '-1' } }, p.registry), /canonical unsigned/);
  assert.match(errors(p.module, { ...p.contract, reservation: { usdMicros: '10', tokens: '10', nanoseconds: '10' } as ResourceAmounts }, p.registry), /four exact resource dimensions/);
});
test('unsupported branching/forks fail closed in the candidate checker', () => {
  const p = program(); const changed = replaceEntry(p.module, body => b.block(b.exprStmt(b.spawn(body)), ...((body as Extract<Term, {kind: 'Block'}>).stmts)));
  assert.match(errors(changed, p.contract, p.registry), /unsupported budget control-flow node Spawn/);
});

test('real durable ledger exhaustion keeps the original handle; committed charge survives reopen', () => {
  const p = program(); assert.equal(checkLinearBudget(p.module, p.contract, p.registry).ok, true);
  const root = mkdtempSync(join(tmpdir(), 'aether-linear-types-'));
  try {
    const privateKey = generateKeyPairSync('ed25519').privateKey;
    const binding = { executionId: 'typed-probe', effectId: 'effect-one', executionManifest: domainDigest('aether.execution/1', 'typed-probe'), payloadDigest: domainDigest('aether.payload/1', 'typed-probe'), policyEpoch: '1' };
    const witnessPath = join(root, 'meter.json');
    const options = (initial: ResourceAmounts, subdirectory: string) => ({ directory: join(root, subdirectory),
      profile: { format: RESOURCE_BUDGET_PROFILE, ledgerId: subdirectory, policyEpoch: '1', initialOwner: 'compiler-test', initial, maxOperations: 20 },
      key: privateKey, authorize: () => true, verifySettlement: (settlement: ResourceSettlement) => {
        if (settlement.evidence.tag !== 'string' || settlement.evidence.value !== 'meter') return false;
        try {
          const measured = JSON.parse(readFileSync(witnessPath, 'utf8')) as ResourceAmounts;
          return ['usdMicros', 'tokens', 'nanoseconds', 'memoryBytes'].every(key =>
            measured[key as keyof ResourceAmounts] === settlement.charge[key as keyof ResourceAmounts]);
        } catch { return false; }
      } });
    const exhausted = new ResourceBudgetLedger(options(amount(5), 'denied'));
    const deniedHandle = exhausted.genesisHandle('compiler-test');
    const request = (id: string, handle: typeof deniedHandle): ResourceRequest => ({ format: 'aether.resource-operation/1', operationId: id, actor: 'compiler-test', operation: { kind: 'reserve', handle, amounts: amount(10), binding, start: true } });
    const deniedReceipt = exhausted.apply(request('too-expensive', deniedHandle));
    assert.equal(deniedReceipt.status, 'exhausted');
    assert.equal(exhausted.snapshot('compiler-test').handles[0].body.id, deniedHandle.body.id);
    const successful = new ResourceBudgetLedger(options(amount(10), 'funded'));
    const initial = successful.genesisHandle('compiler-test');
    const receipt = successful.apply(request('fits', initial)); assert.equal(receipt.status, 'applied');
    const inflight = receipt.handles.find(handle => handle.body.state === 'inflight'); assert.ok(inflight);
    const fd = openSync(witnessPath, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(amount(10))); fsyncSync(fd); } finally { closeSync(fd); }
    successful.apply({ format: 'aether.resource-operation/1', operationId: 'settle', actor: 'compiler-test', operation: { kind: 'consume', handle: inflight, charge: amount(10), evidence: { tag: 'string', value: 'meter' } } });
    const spent = new ResourceBudgetLedger(options(amount(10), 'funded')).snapshot('compiler-test').spent;
    for (const dimension of ['usdMicros', 'tokens', 'nanoseconds', 'memoryBytes'] as const) assert.equal(spent[dimension], '10');
    assert.throws(() => successful.apply(request('duplicate', initial)), /stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
