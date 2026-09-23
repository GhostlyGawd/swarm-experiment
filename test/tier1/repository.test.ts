import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { AetherRepository } from '../../src/tier1/repository.ts';
import { ModuleResolver } from '../../src/tier1/modules.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { ProvenanceLedger } from '../../src/tier1/provenance.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import type { InvariantId } from '../../src/tier1/ids.ts';

const directories: string[] = [];
const temporary = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-repository-'));
  directories.push(directory);
  return directory;
};
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test('A1: graph objects survive process-local store instances', () => {
  const directory = temporary();
  const first = new GraphStore({ directory });
  const term = b.block(b.ret(b.add(b.int(20), b.int(22))));
  const ref = first.intern(term);
  const reopened = new GraphStore({ directory });
  assert.equal(reopened.has(ref), true);
  assert.deepEqual(reopened.hydrate(ref), term);
});

test('A2: named roots resolve immutable commit history', () => {
  const repository = new AetherRepository(temporary());
  const firstRoot = repository.store.intern(b.int(1));
  const first = repository.commit('main', firstRoot, { timestamp: 1, message: 'first' });
  const secondRoot = repository.store.intern(b.int(2));
  const second = repository.commit('main', secondRoot, { timestamp: 2, message: 'second' });
  assert.equal(repository.resolve('main')?.root, secondRoot);
  assert.deepEqual(second.parents, [first.id]);
  assert.equal(repository.readCommit(first.id).root, firstRoot);
  assert.deepEqual(repository.listBranches(), ['main']);
});

test('A3: provenance records, bindings, and invalidation flags are durable', () => {
  const directory = temporary();
  const store = new GraphStore({ directory });
  const ref = store.intern(b.int(7));
  const clause = 'inv:b3:durable' as InvariantId;
  const ledger = new ProvenanceLedger({ directory, clock: () => 10 });
  const provenance = ledger.record({
    intent: 'durable intent',
    origin: { kind: 'spec_clause', ref: 'DURABLE-1' },
    specClauses: [clause],
  });
  ledger.bind(ref, provenance);
  ledger.invalidateSpecClause(clause, store);

  const reopened = new ProvenanceLedger({ directory, clock: () => 11 });
  assert.equal(reopened.get(provenance).intent, 'durable intent');
  assert.equal(reopened.provenanceOf(ref), provenance);
  assert.equal(reopened.isInvalidated(ref), true);
  reopened.reconcile(ref);
  assert.equal(new ProvenanceLedger({ directory }).isInvalidated(ref), false);
});

test('A4: symbol names and allocator progress survive reopening', () => {
  const directory = temporary();
  const first = new SymbolSpace({ directory, seed: 'durable-symbols' });
  const amount = first.define('amount');
  first.rename(amount, 'amountInCents');
  const reopened = new SymbolSpace({ directory, seed: 'durable-symbols' });
  assert.equal(reopened.nameOf(amount), 'amountInCents');
  const next = reopened.define('next');
  assert.notEqual(next, amount);
  assert.equal(new SymbolSpace({ directory, seed: 'durable-symbols' }).lookup('next'), next);
});

test('A5/A6: GC keeps named history and fsck validates the repository', () => {
  const repository = new AetherRepository(temporary());
  const live = repository.store.intern(b.block(b.ret(b.int(1))));
  repository.commit('main', live, { timestamp: 1 });
  const orphan = repository.store.intern(b.str('orphan'));
  assert.equal(repository.store.has(orphan), true);
  const collected = repository.collectGarbage();
  assert.equal(collected.removedObjects, 1);
  assert.equal(repository.store.has(orphan), false);
  assert.deepEqual(repository.fsck(), []);
});

test('A7: a packfile recreates objects, commits, and named roots', () => {
  const source = new AetherRepository(temporary());
  const root = source.store.intern(b.block(b.ret(b.int(42))));
  source.commit('main', root, { timestamp: 42, message: 'portable' });
  const bytes = source.exportPackfile();

  const destination = new AetherRepository(temporary());
  destination.importPackfile(bytes, { updateRefs: true });
  assert.deepEqual(destination.store.hydrate(destination.resolve('main')!.root), source.store.hydrate(root));
  assert.deepEqual(destination.fsck(), []);
});

test('A8: named-root updates use compare-and-swap semantics', () => {
  const directory = temporary();
  const first = new AetherRepository(directory);
  const second = new AetherRepository(directory);
  const root1 = first.store.intern(b.int(1));
  const root2 = first.store.intern(b.int(2));
  const commit1 = first.createCommit(root1, { timestamp: 1 });
  const commit2 = first.createCommit(root2, { timestamp: 2 });
  first.updateRef('main', commit1.id, null);
  assert.throws(() => second.updateRef('main', commit2.id, null), /reference main moved/);
  second.updateRef('main', commit2.id, commit1.id);
  assert.equal(first.head('main'), commit2.id);
});

test('B6: exact-address imports resolve explicit symbols across modules', () => {
  const repository = new AetherRepository(temporary());
  const syms = new SymbolSpace('module-imports');
  const incrementSymbol = syms.define('increment');
  const value = syms.define('value');
  const increment = b.fn({
    symbol: incrementSymbol, params: [b.param(value, b.Int)], returns: b.Int,
    body: b.block(b.ret(b.add(b.v(value), b.int(1)))),
  });
  const dependency = b.module_({
    symbol: syms.define('dependency'), members: [increment], symbolTable: syms.table(),
  });
  const dependencyRoot = repository.store.intern(dependency);
  const mainSymbol = syms.define('main');
  const main = b.fn({
    symbol: mainSymbol, returns: b.Int, body: b.block(b.ret(b.call(incrementSymbol, b.int(41)))),
  });
  const application = b.module_({
    symbol: syms.define('application'),
    members: [b.import_(dependencyRoot, [incrementSymbol]), main],
    symbolTable: syms.table(),
  });
  const root = repository.store.intern(application);
  const resolved = new ModuleResolver(repository.store).resolve(root);
  assert.deepEqual(resolved.dependencies, [dependencyRoot]);
  assert.ok(resolved.module.members.some((member) => member.kind === 'FunctionDecl' && member.symbol === incrementSymbol));
  assert.equal(resolved.module.members.some((member) => member.kind === 'Import'), false);
});

test('nested exact-address imports link inside their owning module and execute without hoisting state', () => {
  const store = new GraphStore(), symbols = new SymbolSpace('nested-module-imports');
  const helper = symbols.define('helper'), argument = symbols.define('argument'), entry = symbols.define('entry');
  const library = b.module_({ symbol: symbols.define('library'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: helper, params: [b.param(argument, b.Int)], returns: b.Int,
      body: b.ret(b.add(b.v(argument), b.int(1))) }),
  ] });
  const address = store.intern(library);
  const nested = b.module_({ symbol: symbols.define('nested'), symbolTable: symbols.table(), members: [
    b.import_(address, [helper]), b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.call(helper, b.int(41))) }),
  ] });
  const outer = b.module_({ symbol: symbols.define('outer'), symbolTable: symbols.table(), members: [nested] });
  const linked = new ModuleResolver(store).resolve(store.intern(outer));
  assert.deepEqual(linked.dependencies, [address]);
  assert.equal(linked.module.members.length, 1);
  const inner = linked.module.members[0]; assert.equal(inner.kind, 'Module');
  assert.equal(inner.members.some(member => member.kind === 'Import'), false);
  assert.equal(inner.members.some(member => member.kind === 'FunctionDecl' && member.symbol === helper), true);
  const result = new Runtime({ registry: new CapabilityRegistry() }).load(linked.module).call(entry, []);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value, 42n);
  if (library.kind !== 'Module') throw new Error('fixture library');
  const duplicate = b.module_({ symbol: symbols.define('duplicate'), symbolTable: symbols.table(), members: [
    b.import_(address, [helper]), library.members[0], b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(0)) }),
  ] });
  assert.throws(() => new ModuleResolver(store).resolve(store.intern(duplicate)), /duplicate imported symbol/);
});
