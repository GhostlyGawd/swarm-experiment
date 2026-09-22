/**
 * Non-functional requirement measurements (§6).
 *
 * Every bound the PRD states is measured here rather than asserted. Where a
 * measurement cannot be taken honestly at the stated scale, the script says so
 * and reports what it did measure — a number with a caveat is worth more than
 * a number without one.
 *
 *   node bench/nfr.bench.ts
 */

import { GraphStore } from '../src/tier1/store.ts';
import { SymbolSpace } from '../src/tier1/symbols.ts';
import { merge3 } from '../src/tier1/merge.ts';
import { encode, IrContext } from '../src/tier1/agent-ir.ts';
import * as b from '../src/tier1/build.ts';
import { measure } from '../src/util/tokens.ts';
import { rng } from '../src/util/rng.ts';
import { projectTypeScript } from '../src/projection/typescript.ts';
import { verifyFunction } from '../src/tier2/verify.ts';
import { simulateModule } from '../src/tier3/microworld.ts';
import { Runtime } from '../src/tier3/runtime.ts';
import { ProductionRuntime, formatCompilation } from '../src/tier3/compile.ts';
import { buildLedgerExample, ACCOUNT, CAP_LEDGER_APPEND } from '../src/examples/ledger.ts';
import type { Value } from '../src/tier3/values.ts';
import type { Term } from '../src/tier1/ast.ts';
import type { NodeRef, SymbolId } from '../src/tier1/ids.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = () => Number(process.hrtime.bigint()) / 1e6;

interface Row {
  readonly id: string;
  readonly requirement: string;
  readonly bound: string;
  readonly measured: string;
  readonly verdict: 'met' | 'missed' | 'qualified';
  readonly note?: string;
}

const rows: Row[] = [];
const record = (row: Row) => {
  rows.push(row);
  const mark = { met: 'PASS', missed: 'FAIL', qualified: 'NOTE' }[row.verdict];
  console.log(
    `${mark}  ${row.id.padEnd(9)} ${row.requirement.padEnd(38)} ` +
      `${row.bound.padEnd(22)} ${row.measured}`,
  );
  if (row.note) console.log(`         ${row.note}`);
};

/** Percentile of a sorted-in-place sample. */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// ---------------------------------------------------------------------------
console.log('\nAether — non-functional requirements\n');

// --- 6.1 AST node resolution ------------------------------------------------
{
  const store = new GraphStore();
  const syms = new SymbolSpace('bench-store');
  const target = 1_000_000;
  const refs: NodeRef[] = [];
  const started = now();
  let built = 0;
  // Distinct leaves so the store cannot dedup the graph away.
  while (built < target) {
    const sym = syms.define(`v${built}`);
    const stmts: Term[] = [];
    for (let i = 0; i < 40 && built < target; i++) {
      stmts.push(b.let_(sym, b.Int, b.add(b.v(sym), b.int(built))));
      built += 4; // let + add + var + lit
    }
    refs.push(store.intern(b.block(...stmts)));
  }
  const buildMs = now() - started;

  const random = rng('lookup');
  const samples: number[] = [];
  for (let i = 0; i < 20_000; i++) {
    const ref = refs[random.int(0, refs.length - 1)];
    const t0 = now();
    store.get(ref);
    samples.push(now() - t0);
  }
  const p999 = percentile(samples, 0.999);
  record({
    id: 'NFR-6.1',
    requirement: 'AST node resolution',
    bound: '< 5 ms @ 10M nodes',
    measured: `p99.9 ${p999.toFixed(4)} ms @ ${store.size.toLocaleString()} nodes`,
    verdict: p999 < 5 ? 'qualified' : 'missed',
    note:
      `built in ${(buildMs / 1000).toFixed(1)}s. Measured at 1M rather than 10M nodes: ` +
      'the store is an in-memory hash index, so lookup is O(1) and 10M would measure the ' +
      'same, but materialising it needs multi-GB heap and the honest thing is to say ' +
      'which number was actually taken.',
  });
}

// --- J2 durable object resolution -------------------------------------------
{
  const directory = mkdtempSync(join(tmpdir(), 'aether-durable-bench-'));
  try {
    const writer = new GraphStore({ directory });
    const refs: NodeRef[] = [];
    for (let i = 0; i < 5_000; i++) refs.push(writer.intern(b.add(b.int(i), b.int(i + 1))));
    const reader = new GraphStore({ directory });
    const random = rng('durable-lookup');
    const samples: number[] = [];
    for (let i = 0; i < 2_000; i++) {
      const ref = refs[random.int(0, refs.length - 1)];
      const started = now();
      reader.get(ref);
      samples.push(now() - started);
    }
    const p999 = percentile(samples, 0.999);
    record({
      id: 'J2',
      requirement: 'Durable object resolution',
      bound: '< 5 ms @ 5k roots',
      measured: `p99.9 ${p999.toFixed(4)} ms from disk/cache`,
      verdict: p999 < 5 ? 'met' : 'missed',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// --- 6.3 Deduplication over history -----------------------------------------
{
  // NFR 6.3 asks for a saving "over standard Git history", so the thing to
  // measure is a *repository with a past*, not a single snapshot. Git stores a
  // fresh compressed blob for every version of every changed file; a
  // content-addressed graph stores only the nodes an edit actually created,
  // and shares the rest with every earlier version by construction.
  const ex = buildLedgerExample();
  const store = new GraphStore();
  const versions = 200;

  let root = store.intern(ex.module);
  const snapshotSize = store.size;
  let independentTotal = snapshotSize;

  const random = rng('history');
  for (let v = 1; v < versions; v++) {
    // A typical commit: retune one literal somewhere in the module.
    const path = store.findPath(root, (node) => node.kind === 'Lit' && typeof node.value === 'bigint');
    if (!path) break;
    const replacement = store.intern(b.int(random.bigint(0n, 100_000n)));
    root = store.replaceAt(root, path, replacement);
    // What storing this version independently would have cost.
    independentTotal += snapshotSize;
  }

  const saving = 1 - store.size / independentTotal;
  record({
    id: 'NFR-6.3',
    requirement: 'Deduplication over version history',
    bound: '>= 40% saving',
    measured: `${(saving * 100).toFixed(1)}% ` +
      `(${store.size.toLocaleString()} nodes for ${versions} versions, ` +
      `vs ${independentTotal.toLocaleString()} stored independently)`,
    verdict: saving >= 0.4 ? 'met' : 'missed',
  });

  // The within-snapshot figure, which is a different and much weaker claim.
  const single = new GraphStore();
  single.intern(ex.module);
  const stats = single.stats();
  record({
    id: 'NFR-6.3',
    requirement: 'Structural sharing within one snapshot',
    bound: '(no stated bound)',
    measured: `${(stats.dedupRatio * 100).toFixed(1)}% ` +
      `(${stats.physicalNodes} stored / ${stats.logicalNodes} occurrences)`,
    verdict: 'qualified',
    note:
      'Reported separately because it is not the NFR. A four-function module ' +
      'has little repeated structure; sharing pays off across history and ' +
      'across a repository, which is what the requirement is about.',
  });
}

// --- 6.3 Concurrent writers -------------------------------------------------
{
  const store = new GraphStore();
  const syms = new SymbolSpace('bench-concurrency');
  const writers = 1000;
  const base = b.block(...Array.from({ length: writers }, (_, i) =>
    b.let_(syms.define(`slot${i}`), b.Int, b.int(0))));
  const baseRef = store.intern(base);
  const baseBlock = base as Extract<Term, { kind: 'Block' }>;

  // Phase 1: the property the NFR actually states. Every writer produces its
  // own version of the module against a shared store, with no coordination of
  // any kind. Writes are content-addressed and idempotent, so two writers that
  // happen to produce the same node produce the same address, and no writer
  // can observe or clobber another's work.
  //
  // Each writer edits through `replaceAt`, which is how structural mutation
  // actually works here: it rewrites the spine to the edited slot and reuses
  // every other subtree by address. Rebuilding and re-interning the whole
  // block instead would cost a thousand times more and measure the wrong thing.
  const writeStarted = now();
  const edits = Array.from({ length: writers }, (_, i) =>
    store.replaceAt(baseRef, [{ field: 'stmts', index: i }], store.intern(b.ret(b.int(i + 1)))));
  const writeMs = now() - writeStarted;
  void baseBlock;

  // Phase 2: reconciliation. Folded as a balanced tree, which is how parallel
  // agents would actually converge — and which keeps each merge's differing
  // region small, instead of growing it linearly as a sequential fold does.
  const mergeStarted = now();
  let conflicts = 0;
  let level = edits;
  while (level.length > 1) {
    const next: NodeRef[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const result = merge3(store, baseRef, level[i], level[i + 1]);
      conflicts += result.conflicts.length;
      next.push(result.ref);
    }
    level = next;
  }
  const mergeMs = now() - mergeStarted;

  const final = store.hydrate(level[0]) as Extract<Term, { kind: 'Block' }>;
  const survived = final.stmts.filter((s) => s.kind === 'Return').length;
  record({
    id: 'NFR-6.3',
    requirement: 'Concurrent writers, disjoint subtrees',
    bound: '1,000 writers, no lock',
    measured: `${survived}/${writers} edits survived, ${conflicts} conflicts ` +
      `(write ${writeMs.toFixed(0)} ms, reconcile ${mergeMs.toFixed(0)} ms)`,
    verdict: survived === writers && conflicts === 0 ? 'met' : 'missed',
    note:
      'Writing needs no coordination at all; the reconcile figure is the cost ' +
      'of folding 1,000 divergent versions back into one, which is a separate ' +
      'and much rarer operation.',
  });
}

// --- 6.1 Checkpoint rollback ------------------------------------------------
{
  const ex = buildLedgerExample();
  const rt = new Runtime({ registry: ex.capabilities, symbols: ex.syms });
  rt.load(ex.module);
  const accounts = Array.from({ length: 500 }, (_, i) =>
    rt.allocateRecord(ACCOUNT, { id: `a${i}`, balance: 1_000_000n }));

  const samples: number[] = [];
  for (let round = 0; round < 25; round++) {
    const mark = rt.checkpoint('bench');
    for (let i = 0; i + 1 < accounts.length; i += 2) {
      rt.call(ex.symbols.transfer, [accounts[i], accounts[i + 1], 7n]);
    }
    const t0 = now();
    rt.restore(mark);
    samples.push(now() - t0);
  }
  const worst = Math.max(...samples);
  record({
    id: 'NFR-6.1',
    requirement: 'Reversible checkpoint rollback',
    bound: '< 15 ms',
    measured: `worst ${worst.toFixed(2)} ms over 25 rounds of 250 transfers`,
    verdict: worst < 15 ? 'met' : 'missed',
  });
}

// --- 6.1 Micro-world harness ------------------------------------------------
{
  const ex = buildLedgerExample();
  const started = now();
  const reports = simulateModule(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, seed: 'bench',
  });
  const elapsed = now() - started;
  const worst = Math.max(...reports.map((r) => r.elapsedMs));
  record({
    id: 'NFR-6.1',
    requirement: 'Micro-world harness, local module',
    bound: '<= 250 ms per module',
    measured: `worst declaration ${worst} ms, whole suite ${elapsed.toFixed(0)} ms ` +
      `across ${reports.length} declarations`,
    verdict: worst <= 250 ? 'met' : 'missed',
  });
}

// --- 6.2 Formal verification budget ----------------------------------------
{
  const ex = buildLedgerExample();
  const env = new Map<SymbolId, Term>();
  for (const m of (ex.module as Extract<Term, { kind: 'Module' }>).members) {
    if (m.kind === 'FunctionDecl') env.set(m.symbol, m);
  }
  let worst = 0;
  let unproven = 0;
  for (const m of (ex.module as Extract<Term, { kind: 'Module' }>).members) {
    if (m.kind !== 'FunctionDecl') continue;
    const report = verifyFunction(m, { symbols: ex.syms, environment: env, budgetMs: 2000 });
    worst = Math.max(worst, report.elapsedMs);
    unproven += report.unprovenFormalContracts.length;
  }
  record({
    id: 'NFR-6.2',
    requirement: 'SMT budget per function',
    bound: '<= 2,000 ms',
    measured: `worst ${worst} ms, ${unproven} UnprovenFormalContract`,
    verdict: worst <= 2000 ? 'met' : 'missed',
  });
}

// --- 6.2 Reproducible execution ---------------------------------------------
{
  const fingerprint = () => {
    const ex = buildLedgerExample();
    const rt = new Runtime({ registry: ex.capabilities, symbols: ex.syms, trace: true });
    rt.load(ex.module);
    const a = rt.allocateRecord(ACCOUNT, { id: 'a', balance: 5000n });
    const c = rt.allocateRecord(ACCOUNT, { id: 'c', balance: 10n });
    for (let i = 1; i <= 20; i++) rt.call(ex.symbols.settle, [a, c, BigInt(i) * 3n]);
    return JSON.stringify({ heap: rt.inspect().heap, steps: rt.steps, trace: rt.trace });
  };
  const a = fingerprint();
  const identical = a === fingerprint() && a === fingerprint();
  record({
    id: 'NFR-6.2',
    requirement: 'Bit-level reproducible execution',
    bound: 'identical heap + trace',
    measured: identical ? 'identical across 3 runs' : 'DIVERGED',
    verdict: identical ? 'met' : 'missed',
  });
}

// --- R2 Dual-runtime overhead -----------------------------------------------
{
  const ex = buildLedgerExample();
  const env = new Map<SymbolId, Term>();
  for (const m of (ex.module as Extract<Term, { kind: 'Module' }>).members) {
    if (m.kind === 'FunctionDecl') env.set(m.symbol, m);
  }
  const reports = new Map<SymbolId, ReturnType<typeof verifyFunction>>();
  for (const [symbol, decl] of env) {
    reports.set(symbol, verifyFunction(decl, { symbols: ex.syms, environment: env }));
  }
  const effects = new Map([[CAP_LEDGER_APPEND, () => null as Value]]);
  const iterations = 20_000;

  const dev = new Runtime({ registry: ex.capabilities, symbols: ex.syms, effects });
  dev.load(ex.module);
  const devA = dev.allocateRecord(ACCOUNT, { id: 'a', balance: 10n ** 15n });
  const devB = dev.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
  let t = now();
  for (let i = 0; i < iterations; i++) dev.call(ex.symbols.settle, [devA, devB, 1000n]);
  const devMs = now() - t;

  const prod = ProductionRuntime.compile(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, effects,
    verification: reports, entryPoints: [ex.symbols.settle],
  });
  const prodA = prod.allocateRecord(ACCOUNT, { id: 'a', balance: 10n ** 15n });
  const prodB = prod.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
  t = now();
  for (let i = 0; i < iterations; i++) prod.call(ex.symbols.settle, [prodA, prodB, 1000n]);
  const prodMs = now() - t;

  const agree = JSON.stringify(prod.snapshot()) === JSON.stringify(dev.inspect().heap);
  record({
    id: 'Risk R2',
    requirement: 'Dual-runtime overhead',
    bound: 'production strips telemetry',
    measured: `${(devMs / prodMs).toFixed(1)}x faster ` +
      `(dev ${devMs.toFixed(0)} ms, prod ${prodMs.toFixed(0)} ms over ${iterations.toLocaleString()} calls)`,
    verdict: agree && prodMs < devMs ? 'met' : 'missed',
    note:
      `${prod.report.clausesElided} contract clause(s) elided as already proved, ` +
      `${prod.report.clausesKept} kept. Both runtimes end with an identical heap` +
      (agree ? '.' : ' — THEY DID NOT, which invalidates the comparison.'),
  });
}

// --- FR-1.2 Agent-IR density -------------------------------------------------
{
  const ex = buildLedgerExample();
  const members = (ex.module as Extract<Term, { kind: 'Module' }>).members;
  const ctx = new IrContext();
  encode(ex.module, ctx); // establish the session dictionary

  let ts = 0;
  let ir = 0;
  const perDeclaration: string[] = [];
  for (const m of members) {
    if (m.kind !== 'FunctionDecl') continue;
    const projected = measure(projectTypeScript(m, ex.syms, {})).tokens;
    const encoded = encode(m, ctx).bodyTokens;
    ts += projected;
    ir += encoded;
    perDeclaration.push(`${ex.syms.nameOf(m.symbol)} ${(projected / encoded).toFixed(2)}x`);
  }
  const cold = encode(ex.module);
  const coldRatio = measure(projectTypeScript(ex.module, ex.syms, {})).tokens / cold.tokens;

  record({
    id: 'FR-1.2',
    requirement: 'Agent-IR token reduction',
    bound: '>= 4x vs TypeScript',
    measured: `${(ts / ir).toFixed(2)}x aggregate per unit change`,
    verdict: ts / ir >= 4 ? 'met' : 'missed',
    note:
      `per declaration: ${perDeclaration.join(', ')}. ` +
      `Cold, dictionary included: ${coldRatio.toFixed(2)}x — the dictionary is paid once ` +
      'per session, so the marginal figure is the one a context budget feels.',
  });
}

// ---------------------------------------------------------------------------
const missed = rows.filter((r) => r.verdict === 'missed');
const qualified = rows.filter((r) => r.verdict === 'qualified');
console.log(
  `\n${rows.length - missed.length - qualified.length} met, ` +
    `${qualified.length} met with a caveat, ${missed.length} missed\n`,
);
if (missed.length) process.exitCode = 1;
