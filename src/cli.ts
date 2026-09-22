#!/usr/bin/env node
/**
 * The Aether command line.
 *
 * Every command here is a *secondary* interface. The primary consumer is an
 * agent calling the libraries directly; this exists so a human can see what the
 * fabric is doing, which is the Auditor persona's whole requirement.
 */

import { readFileSync } from 'node:fs';
import { GraphStore } from './tier1/store.ts';
import { AetherRepository } from './tier1/repository.ts';
import { encode, IrContext } from './tier1/agent-ir.ts';
import { merge3 } from './tier1/merge.ts';
import * as b from './tier1/build.ts';
import { SymbolSpace } from './tier1/symbols.ts';
import { measure } from './util/tokens.ts';
import { TypeScriptProjector, projectTypeScript } from './projection/typescript.ts';
import { parseTypeScript } from './projection/parse.ts';
import { typecheck } from './tier2/typecheck.ts';
import { formatReport, verifyFunction } from './tier2/verify.ts';
import { compileSpec, parseSpec } from './tier2/spec.ts';
import { Runtime } from './tier3/runtime.ts';
import { ProductionRuntime, formatCompilation } from './tier3/compile.ts';
import { formatMicroWorld, simulateModule } from './tier3/microworld.ts';
import { compareShapes, formatPlan, generateGlue, slice } from './tier4/topology.ts';
import { applyTuning, findSurfaces, tune, verifyOnlyParametersChanged } from './tier4/surfaces.ts';
import { formatOutcome, synthesize } from './synthesis/loop.ts';
import { EnumerativeSynthesizer } from './synthesis/enumerative.ts';
import { ACCOUNT, CAP_LEDGER_APPEND, buildLedgerExample, ledgerTelemetry } from './examples/ledger.ts';
import type { Value } from './tier3/values.ts';
import type { Term } from './tier1/ast.ts';
import type { SymbolId } from './tier1/ids.ts';

const HELP = `aether — a unified, agent-native programming fabric

Usage: aether <command> [options]

  demo                 End-to-end walkthrough across all four tiers
  project [file.ts]    Project the graph into readable TypeScript
  ir [--body]          Show the Agent-IR encoding and its token cost
  check [file.ts]      Type-check, capability-check and verify
  run                  Execute the worked example and show the trace
  compile [--policy p] Compile the stripped production artifact (Risk R2)
  simulate             Run the micro-world suites
  topology [--shape s] Compile deployment topologies from telemetry
  tune                 Run the background tuning agent over the surfaces
  synth                Synthesize a body from a contract alone
  spec <file.spec>     Compile an executable product specification
  provenance           Show the causal lineage of the example
  merge                Demonstrate a three-way structural merge
  fsck [store]         Verify every durable object, commit, and named root

With no file argument, commands operate on the built-in worked example.
`;

const ex = () => buildLedgerExample();
const members = (m: Term) => (m as Extract<Term, { kind: 'Module' }>).members;

function environmentOf(module: Term): Map<SymbolId, Term> {
  const env = new Map<SymbolId, Term>();
  for (const m of members(module)) if (m.kind === 'FunctionDecl') env.set(m.symbol, m);
  return env;
}

function bindingsOf(module: Term): Map<string, SymbolId> {
  const table = (module as Extract<Term, { kind: 'Module' }>).symbolTable;
  const out = new Map<string, SymbolId>();
  if (table.kind === 'SymbolTable') for (const [sym, name] of table.entries) out.set(name, sym);
  return out;
}

/** Load a module: either a projected TypeScript file, or the built-in example. */
function load(file: string | undefined) {
  const example = ex();
  if (!file) return { module: example.module, syms: example.syms, example };
  const source = readFileSync(file, 'utf8');
  const syms = new SymbolSpace(`cli:${file}`);
  const module = parseTypeScript(source, { symbols: syms });
  return { module, syms, example };
}

const rule = (title: string) => {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log('─'.repeat(Math.max(24, title.length)));
};

// ---------------------------------------------------------------------------

function cmdProject(file?: string): void {
  const { module, syms, example } = load(file);
  console.log(projectTypeScript(module, syms, file ? {} : { ledger: example.ledger }));
}

function cmdIr(bodyOnly: boolean): void {
  const { module, syms } = load(undefined);
  const ir = encode(module);
  if (bodyOnly) {
    console.log(ir.body);
    return;
  }
  console.log(ir.text);
  const ts = measure(projectTypeScript(module, syms, {}));
  rule('token cost');
  console.log(`TypeScript projection : ${ts.tokens} tokens, ${ts.bytes} bytes`);
  console.log(`Agent-IR (cold)       : ${ir.tokens} tokens, ${ir.bytes} bytes`);
  console.log(`Agent-IR (body only)  : ${ir.bodyTokens} tokens`);
  console.log(`Marginal reduction    : ${(ts.tokens / ir.bodyTokens).toFixed(2)}x`);
}

function cmdCheck(file?: string): void {
  const { module, syms, example } = load(file);
  rule('types and capabilities');
  const checked = typecheck(module, { registry: example.capabilities, symbols: syms });
  if (checked.ok) {
    console.log(`clean. capabilities reached: ${checked.usedCapabilities.join(', ') || '(none)'}`);
  } else {
    for (const d of checked.diagnostics) {
      console.log(`  ${d.code}: ${d.message}`);
      console.log(`    at ${d.path.join('.')}`);
      if (d.hint) console.log(`    hint: ${d.hint}`);
    }
    process.exitCode = 1;
  }

  rule('contract verification');
  const env = environmentOf(module);
  for (const m of members(module)) {
    if (m.kind !== 'FunctionDecl') continue;
    console.log(formatReport(verifyFunction(m, { symbols: syms, environment: env }), (s) => syms.nameOf(s)));
  }
}

function cmdRun(): void {
  const example = ex();
  const rt = new Runtime({ registry: example.capabilities, symbols: example.syms, trace: true });
  rt.load(example.module);
  const alice = rt.allocateRecord(ACCOUNT, { id: 'alice', balance: 100_000n });
  const bob = rt.allocateRecord(ACCOUNT, { id: 'bob', balance: 2_500n });

  rule('settle(alice, bob, 40000)');
  const mark = rt.checkpoint('before');
  const result = rt.call(example.symbols.settle, [alice, bob, 40_000n]);
  console.log(result.ok ? `returned ${result.value} in ${result.steps} steps` : `fault: ${result.fault.message}`);

  rule('heap');
  console.log(JSON.stringify(rt.inspect().heap, null, 2));

  rule('effects (no stdout was involved)');
  for (const e of rt.effects) console.log(`  step ${e.step}: ${e.capability}(${e.args.join(', ')})`);

  rule('trace tail');
  console.log(rt.formatTrace(18));

  rule('time travel');
  rt.restore(mark);
  console.log('after restore:', JSON.stringify(rt.inspect().heap));
}

function cmdCompile(policy?: string): void {
  const example = ex();
  const env = environmentOf(example.module);
  const reports = new Map<SymbolId, ReturnType<typeof verifyFunction>>();
  for (const [symbol, decl] of env) {
    reports.set(symbol, verifyFunction(decl, { symbols: example.syms, environment: env }));
  }
  const effects = new Map([[CAP_LEDGER_APPEND, () => null as Value]]);

  rule('compilation');
  const prod = ProductionRuntime.compile(example.module, {
    registry: example.capabilities,
    symbols: example.syms,
    effects,
    verification: reports,
    policy: (policy as never) ?? 'verified_elision',
    entryPoints: [example.symbols.settle, example.symbols.accrue],
  });
  console.log(formatCompilation(prod.report));

  rule('overhead against the development runtime');
  const iterations = 20_000;
  const dev = new Runtime({ registry: example.capabilities, symbols: example.syms, effects });
  dev.load(example.module);
  const devA = dev.allocateRecord(ACCOUNT, { id: 'a', balance: 10n ** 15n });
  const devB = dev.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
  let started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) dev.call(example.symbols.settle, [devA, devB, 1000n]);
  const devMs = Number(process.hrtime.bigint() - started) / 1e6;

  const prodA = prod.allocateRecord(ACCOUNT, { id: 'a', balance: 10n ** 15n });
  const prodB = prod.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
  started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) prod.call(example.symbols.settle, [prodA, prodB, 1000n]);
  const prodMs = Number(process.hrtime.bigint() - started) / 1e6;

  console.log(`development (journaling) : ${devMs.toFixed(0)} ms`);
  console.log(`production  (stripped)   : ${prodMs.toFixed(0)} ms`);
  console.log(`speedup                  : ${(devMs / prodMs).toFixed(1)}x`);
  console.log(
    `identical heap           : ${
      JSON.stringify(prod.snapshot()) === JSON.stringify(dev.inspect().heap)
    }`,
  );
}

function cmdSimulate(): void {
  const example = ex();
  for (const report of simulateModule(example.module, {
    registry: example.capabilities,
    symbols: example.syms,
    seed: 'cli',
  })) {
    console.log(formatMicroWorld(report, (s) => example.syms.nameOf(s)));
  }
}

function cmdTopology(shape?: string): void {
  const example = ex();
  const telemetry = ledgerTelemetry(example);
  if (shape) {
    const plan = slice(example.module, telemetry, { symbols: example.syms, shape: shape as never });
    console.log(formatPlan(plan, example.syms));
    rule('generated transport');
    console.log(generateGlue(plan, example.syms));
    return;
  }
  for (const { plan } of compareShapes(example.module, telemetry, { symbols: example.syms })) {
    console.log(formatPlan(plan, example.syms));
    console.log();
  }
}

function cmdTune(): void {
  const example = ex();
  const store = new GraphStore();
  const root = store.intern(example.module);
  const surfaces = findSurfaces(store, root);

  rule('surfaces');
  for (const s of surfaces) {
    const domain = s.node.domain.d === 'choice'
      ? `choice(${s.node.domain.options.join(', ')})`
      : `range(${s.node.domain.min}..${s.node.domain.max})`;
    console.log(`  ${example.syms.nameOf(s.symbol)}: ${domain} = ${s.node.current} ` +
      `[${s.node.objective}]`);
  }

  // A stand-in for production telemetry, convex with a minimum at 24.
  const policy: Record<string, number> = { none: 40, lru: 12, lfu: 18, arc: 9 };
  const result = tune(surfaces, {
    measure: (a) => {
      const batch = Number(a.get(example.symbols.batchSize) ?? 8n);
      const cache = String(a.get(example.symbols.cachePolicy) ?? 'none');
      return {
        latencyMs: (batch - 24) ** 2 / 12 + 30 + (policy[cache] ?? 40),
        costPerMonth: 20 + batch * 0.4,
        memoryMb: 32 + batch * 2,
      };
    },
  });

  rule('tuning');
  console.log(`baseline latency ${result.baseline.latencyMs.toFixed(1)}ms ` +
    `→ ${result.tuned.latencyMs.toFixed(1)}ms ` +
    `(${(result.improvement * 100).toFixed(1)}% better, ${result.evaluations} measurements)`);
  for (const step of result.history) {
    console.log(`  ${example.syms.nameOf(step.symbol)}: ${step.from} → ${step.to} ` +
      `(score ${step.score.toFixed(2)}${step.gradient === null ? '' : `, gradient ${step.gradient.toFixed(2)}`})`);
  }

  const applied = applyTuning(store, root, result.after);
  const audit = verifyOnlyParametersChanged(store, root, applied.root);
  rule('audit');
  console.log(audit.ok
    ? 'only Surface nodes and the spines leading to them were rewritten'
    : `tuner overstepped: ${audit.offending.join(', ')}`);
}

function cmdSynth(): void {
  const syms = new SymbolSpace('cli-synth');
  const example = ex();
  const max = syms.define('max');
  const x = syms.define('a');
  const y = syms.define('b');
  const spec = b.fn({
    symbol: max,
    params: [b.param(x, b.Int), b.param(y, b.Int)],
    returns: b.Int,
    purity: 'pure',
    contract: b.contract({
      ensures: [
        b.clause(b.ge(b.result(), b.v(x)), 'at_least_a'),
        b.clause(b.ge(b.result(), b.v(y)), 'at_least_b'),
        b.clause(b.or(b.eq(b.result(), b.v(x)), b.eq(b.result(), b.v(y))), 'is_one_of'),
      ],
    }),
    body: null,
  });

  rule('contract (no implementation)');
  console.log(projectTypeScript(spec, syms, {}));

  const outcome = synthesize(spec, new EnumerativeSynthesizer({
    registry: example.capabilities, seed: 'cli',
  }), { registry: example.capabilities, symbols: syms, seed: 'cli' });

  rule('synthesis');
  console.log(formatOutcome(outcome, syms));
  if (outcome.status === 'synthesized') {
    rule('synthesized implementation');
    console.log(projectTypeScript(outcome.declaration, syms, {}));
  }
}

function cmdSpec(file: string): void {
  const example = ex();
  const ctx = {
    symbols: example.syms,
    bindings: bindingsOf(example.module),
    typeNames: new TypeScriptProjector(example.syms, {}).typeNames,
  };
  const compiled = compileSpec(parseSpec(readFileSync(file, 'utf8'), ctx), ctx, example.ledger);
  for (const artifact of compiled.artifacts) {
    rule(`${artifact.layer}: ${artifact.rule}`);
    console.log(artifact.code);
  }
}

function cmdProvenance(): void {
  const example = ex();
  const store = new GraphStore();
  for (const m of members(example.module)) {
    if (m.kind !== 'FunctionDecl' || !m.provenance) continue;
    const ref = store.intern(m);
    example.ledger.bind(ref, m.provenance);
    rule(example.syms.nameOf(m.symbol));
    console.log(example.ledger.explain(ref));
  }
}

function cmdMerge(): void {
  const example = ex();
  const store = new GraphStore();
  const base = store.intern(example.module);
  const mod = example.module as Extract<Term, { kind: 'Module' }>;

  // Two agents edit different declarations of the same module.
  const left = store.intern({
    ...mod,
    members: mod.members.map((m, i) =>
      i === 3 && m.kind === 'FunctionDecl'
        ? { ...m, body: b.block(b.ret(b.div(b.v(example.symbols.gross), b.int(50)))) }
        : m),
  });
  const right = store.intern({
    ...mod,
    members: mod.members.map((m, i) =>
      i === 4 && m.kind === 'FunctionDecl'
        ? { ...m, body: b.block(b.ret(b.v(example.symbols.principal))) }
        : m),
  });

  const result = merge3(store, base, left, right);
  rule('three-way structural merge');
  console.log(`clean: ${result.clean}`);
  console.log(`conflicts: ${result.conflicts.length}`);
  console.log(`subtrees reused untouched: ${result.reusedSubtrees}`);
  for (const c of result.conflicts) {
    console.log(`  ${c.reason} at ${c.path.map((s) => s.field).join('.')}: ${c.detail}`);
  }
}

function cmdDemo(): void {
  const example = ex();
  rule('1. the graph');
  const store = new GraphStore();
  const root = store.intern(example.module);
  const stats = store.stats();
  console.log(`module ${root}`);
  console.log(`${stats.physicalNodes} nodes stored for ${stats.logicalNodes} occurrences ` +
    `(${(stats.dedupRatio * 100).toFixed(1)}% deduplicated)`);

  rule('2. renaming touches one node');
  const before = store.intern(members(example.module)[2]);
  example.syms.rename(example.symbols.amount, 'amountInCents');
  const after = store.intern(members(example.module)[2]);
  console.log(`transfer before: ${before}`);
  console.log(`transfer after : ${after}`);
  console.log(before === after ? 'identical — the rename cannot invalidate a cache' : 'CHANGED');

  rule('3. agent-IR');
  const ctx = new IrContext();
  encode(example.module, ctx);
  const warm = encode(members(example.module)[2], ctx);
  const ts = measure(projectTypeScript(members(example.module)[2], example.syms, {}));
  console.log(warm.body);
  console.log(`${ts.tokens} tokens as TypeScript → ${warm.bodyTokens} as Agent-IR ` +
    `(${(ts.tokens / warm.bodyTokens).toFixed(2)}x)`);

  rule('4. verification');
  const env = environmentOf(example.module);
  for (const m of members(example.module)) {
    if (m.kind !== 'FunctionDecl') continue;
    console.log(formatReport(verifyFunction(m, { symbols: example.syms, environment: env }),
      (s) => example.syms.nameOf(s)));
  }

  rule('5. micro-worlds');
  for (const report of simulateModule(example.module, {
    registry: example.capabilities, symbols: example.syms, seed: 'demo',
  })) {
    console.log(formatMicroWorld(report, (s) => example.syms.nameOf(s)));
  }

  rule('6. topology');
  console.log(formatPlan(slice(example.module, ledgerTelemetry(example), { symbols: example.syms }),
    example.syms));

  rule('7. the production artifact');
  cmdCompile();

  rule('8. synthesis from a contract alone');
  cmdSynth();
}

function cmdFsck(directory = '.aether-store'): void {
  const issues = new AetherRepository(directory).fsck();
  if (issues.length === 0) {
    console.log(`ok: ${directory}`);
    return;
  }
  for (const issue of issues) console.error(`${issue.kind} ${issue.id}: ${issue.message}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a) => !a.startsWith('--') && rest[rest.indexOf(a) - 1]?.startsWith('--') !== true);

  switch (command) {
    case 'demo': return cmdDemo();
    case 'project': return cmdProject(positional[0]);
    case 'ir': return cmdIr(rest.includes('--body'));
    case 'check': return cmdCheck(positional[0]);
    case 'run': return cmdRun();
    case 'compile': return cmdCompile(flag('policy'));
    case 'simulate': return cmdSimulate();
    case 'topology': return cmdTopology(flag('shape'));
    case 'tune': return cmdTune();
    case 'synth': return cmdSynth();
    case 'spec':
      if (!positional[0]) throw new Error('spec needs a file argument');
      return cmdSpec(positional[0]);
    case 'provenance': return cmdProvenance();
    case 'merge': return cmdMerge();
    case 'fsck': return cmdFsck(positional[0]);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2));
