/**
 * The gap-closing roadmap, as data.
 *
 * `docs/ROADMAP.md` is the readable version; this is the checkable one. The
 * two are asserted to agree by `test/roadmap.test.ts`, so a feature cannot be
 * edited in one and left stale in the other.
 *
 * The distinction that matters here is **hard dependency versus sequencing
 * judgment**. `deps` means "cannot be built until": a blocker derived from the
 * design, not an opinion about order. A judgment about what to do first is
 * recorded separately, in `CRITICAL_PATH`, precisely so that nobody mistakes
 * an opinion for a constraint. `degradedUntil` is the third case: the feature
 * can ship, and will be incomplete in a stated way until something else lands.
 */

export type Size = 'S' | 'M' | 'L' | 'XL';

/**
 * A checkable justification that a feature is still open.
 *
 * `absent` greps the named files and requires the pattern *not* to appear —
 * if it does, the thing has been built and the roadmap is lying. `none` is for
 * items where no grep is a fair proxy, and must say why.
 */
export type Evidence =
  | { readonly kind: 'absent'; readonly pattern: string; readonly files: readonly string[] }
  | { readonly kind: 'none'; readonly reason: string };

export interface Feature {
  readonly id: string;
  readonly epic: string;
  readonly title: string;
  readonly why: string;
  readonly size: Size;
  /** Hard blockers: this cannot be built until all of these exist. */
  readonly deps: readonly string[];
  /** Ships without these, but incomplete in the stated way until they land. */
  readonly degradedUntil?: readonly string[];
  readonly evidence: Evidence;
}

export interface Epic {
  readonly id: string;
  readonly title: string;
}

export const EPICS: readonly Epic[] = [
  { id: 'A', title: 'Durability — make it a repository' },
  { id: 'B', title: 'Language surface — make real programs expressible' },
  { id: 'C', title: 'Verification reach' },
  { id: 'D', title: 'Real distribution' },
  { id: 'E', title: 'Concurrency' },
  { id: 'F', title: 'Governance — the last Phase 3 deliverable' },
  { id: 'G', title: 'Agent ergonomics' },
  { id: 'H', title: 'Projection' },
];

const STORE = 'src/tier1/store.ts';
const AST = 'src/tier1/ast.ts';

export const FEATURES: readonly Feature[] = [
  // --- A. Durability -------------------------------------------------------
  {
    id: 'A1', epic: 'A',
    title: 'Object store: write-once blobs keyed by node address, read-through cache',
    why: 'The graph must outlive a process',
    size: 'M', deps: [],
    evidence: { kind: 'absent', pattern: 'writeFile', files: [STORE] },
  },
  {
    id: 'A2', epic: 'A',
    title: 'Named roots (branches/tags) + a commit object binding root × provenance × time',
    why: "Otherwise there's nothing to *find* a module by",
    size: 'S', deps: ['A1'],
    evidence: { kind: 'absent', pattern: 'branch', files: [STORE] },
  },
  {
    id: 'A3', epic: 'A',
    title: 'Durable provenance ledger and `InvalidatedSpec` flags',
    why: 'Currently in-memory Maps; the audit trail dies on exit',
    size: 'M', deps: ['A1'],
    evidence: { kind: 'absent', pattern: 'writeFile', files: ['src/tier1/provenance.ts'] },
  },
  {
    id: 'A4', epic: 'A',
    title: 'Durable `SymbolSpace`',
    why: 'The `SymbolTable` is already a node; the allocator isn\'t',
    size: 'S', deps: ['A1'],
    evidence: { kind: 'absent', pattern: 'writeFile', files: ['src/tier1/symbols.ts'] },
  },
  {
    id: 'A5', epic: 'A',
    title: 'Mark-and-sweep GC from roots',
    why: 'Every edit mints nodes; without this it only grows',
    size: 'M', deps: ['A1', 'A2'],
    evidence: { kind: 'absent', pattern: 'collectGarbage', files: [STORE] },
  },
  {
    id: 'A6', epic: 'A',
    title: '`aether fsck` — re-hash every object, confirm the address matches',
    why: 'Content addressing makes corruption *detectable*; nothing detects it yet',
    size: 'S', deps: ['A1'],
    evidence: { kind: 'absent', pattern: 'fsck', files: ['src/cli.ts'] },
  },
  {
    id: 'A7', epic: 'A',
    title: 'Packfile import/export',
    why: 'Ships a repo, and makes the 94.6% dedup figure a measurement on disk',
    size: 'M', deps: ['A1', 'A2'],
    evidence: { kind: 'absent', pattern: 'packfile', files: [STORE] },
  },
  {
    id: 'A8', epic: 'A',
    title: 'Cross-process write safety: temp-file + atomic rename, CAS on root updates',
    why: 'The lock-free claim currently holds *within one process* only',
    size: 'M', deps: ['A1', 'A2'],
    evidence: { kind: 'absent', pattern: 'rename', files: [STORE] },
  },

  // --- B. Language surface -------------------------------------------------
  {
    id: 'B1', epic: 'B',
    title: 'Sum types + constructors + a `Match` node',
    why: 'This is what makes `Result` real. Error handling is currently unexpressible',
    size: 'L', deps: [],
    evidence: { kind: 'absent', pattern: "kind: 'Match'", files: [AST] },
  },
  {
    id: 'B2', epic: 'B',
    title: 'Immutable sequences (index, length, map/fold)',
    why: 'No collection type exists at all',
    size: 'L', deps: [], degradedUntil: ['B4', 'C2'],
    evidence: { kind: 'absent', pattern: "t: 'Seq'", files: [AST] },
  },
  {
    id: 'B3', epic: 'B',
    title: 'Function values / closures',
    why: 'Interesting OCap problem: a closure captures authority, so the envelope becomes part of the value',
    size: 'XL', deps: [],
    evidence: { kind: 'absent', pattern: "t: 'Fn'", files: [AST] },
  },
  {
    id: 'B4', epic: 'B',
    title: 'Parametric types',
    why: 'B2 is barely usable without it',
    size: 'L', deps: [],
    evidence: { kind: 'absent', pattern: "t: 'TypeVar'", files: [AST] },
  },
  {
    id: 'B5', epic: 'B',
    title: 'String operations beyond `++`',
    why: 'Currently concat only',
    size: 'M', deps: [],
    evidence: { kind: 'absent', pattern: "'strlen'", files: [AST] },
  },
  {
    id: 'B6', epic: 'B',
    title: 'Cross-module imports + resolution rules',
    why: 'No multi-module repository is possible today',
    size: 'M', deps: ['A1', 'A2'],
    evidence: { kind: 'absent', pattern: "kind: 'Import'", files: [AST] },
  },
  {
    id: 'B7', epic: 'B',
    title: 'Integer width/overflow policy',
    why: 'Everything is arbitrary-precision; real targets have widths, and this changes both the solver and the production compiler',
    size: 'M', deps: [],
    evidence: { kind: 'absent', pattern: "t: 'IntN'", files: [AST] },
  },

  // --- C. Verification reach ----------------------------------------------
  {
    id: 'C5', epic: 'C',
    title: 'Proof cache keyed by node address',
    why: "The payoff of content addressing that isn't exploited yet — a proved subtree never needs re-proving. Cheap, large win",
    size: 'S', deps: ['A1'],
    evidence: { kind: 'absent', pattern: 'proofCache', files: ['src/tier2/verify.ts'] },
  },
  {
    id: 'C6', epic: 'C',
    title: 'Incremental verification: re-verify only what changed, or whose callee contracts changed',
    why: 'Follows directly from C5',
    size: 'M', deps: ['C5'],
    evidence: { kind: 'absent', pattern: 'verifyIncremental', files: ['src/tier2/verify.ts'] },
  },
  {
    id: 'C1', epic: 'C',
    title: 'Shell out to Z3/CVC5 on `unknown` — itself capability-bounded',
    why: 'The "escape velocity" claim is currently untested',
    size: 'S', deps: [],
    evidence: { kind: 'absent', pattern: 'execFile', files: ['src/tier2/solver.ts'] },
  },
  {
    id: 'C2', epic: 'C',
    title: 'Array/sequence theory',
    why: 'Required by B2 or verification silently degrades to fuzzing',
    size: 'L', deps: ['B2'],
    evidence: { kind: 'absent', pattern: "'select'", files: ['src/tier2/smt.ts'] },
  },
  {
    id: 'C3', epic: 'C',
    title: 'Bounded quantifiers',
    why: '"for all elements…" is unexpressible',
    size: 'L', deps: ['C2'],
    evidence: { kind: 'absent', pattern: "'forall'", files: ['src/tier2/smt.ts'] },
  },
  {
    id: 'C4', epic: 'C',
    title: 'Uninterpreted functions with congruence closure',
    why: 'Currently only implicit via abstraction',
    size: 'M', deps: [],
    evidence: { kind: 'absent', pattern: 'congruenceClosure', files: ['src/tier2/solver.ts'] },
  },
  {
    id: 'C7', epic: 'C',
    title: 'Materialize an SMT counterexample as a persisted micro-world case',
    why: 'Every refutation becomes a permanent regression test',
    size: 'S', deps: ['A1'],
    evidence: { kind: 'absent', pattern: 'materializeCounterexample', files: ['src/tier3/microworld.ts'] },
  },
  {
    id: 'C8', epic: 'C',
    title: 'Separation/ownership types so non-aliasing is *checked*',
    why: 'Open question 3; currently reported as an assumption',
    size: 'XL', deps: [],
    evidence: { kind: 'absent', pattern: 'separation', files: ['src/tier2/typecheck.ts'] },
  },
  {
    id: 'C9', epic: 'C',
    title: 'Termination checking when no variant is supplied',
    why: 'A variant is optional and unchecked if absent',
    size: 'M', deps: [],
    evidence: { kind: 'absent', pattern: 'inferVariant', files: ['src/tier2/verify.ts'] },
  },

  // --- D. Real distribution ------------------------------------------------
  {
    id: 'D1', epic: 'D',
    title: 'A host that loads a topology plan and actually runs units',
    why: 'The slicer emits text; nothing executes it',
    size: 'L', deps: ['A2'],
    evidence: { kind: 'none', reason: 'A new process host; there is no file it would be absent from' },
  },
  {
    id: 'D2', epic: 'D',
    title: 'Wire protocol with unforgeable capability tokens',
    why: 'Capabilities are strings today. Across a boundary they must be attenuable and unforgeable, or OCap is decorative',
    size: 'L', deps: ['D1'],
    evidence: { kind: 'absent', pattern: 'sealer', files: ['src/tier2/ocap.ts'] },
  },
  {
    id: 'D3', epic: 'D',
    title: 'Distributed fault semantics — what a contract means across a partition',
    why: 'Undefined',
    size: 'L', deps: ['D2'],
    evidence: { kind: 'none', reason: 'A semantic decision, not a missing symbol' },
  },
  {
    id: 'D4', epic: 'D',
    title: 'Hot reconfiguration: move a function between units live',
    why: 'The "fluid" claim implies it',
    size: 'XL', deps: ['D1', 'D2'],
    evidence: { kind: 'none', reason: 'Depends on a host that does not exist yet' },
  },
  {
    id: 'D5', epic: 'D',
    title: 'Telemetry collection',
    why: 'The slicer *takes* telemetry; nothing produces it',
    size: 'M', deps: ['D1'],
    evidence: { kind: 'absent', pattern: 'collectTelemetry', files: ['src/tier4/topology.ts'] },
  },

  // --- E. Concurrency ------------------------------------------------------
  {
    id: 'E1', epic: 'E',
    title: 'A concurrency model in the language',
    why: 'There are no threads or async at all',
    size: 'XL', deps: [],
    evidence: { kind: 'absent', pattern: "kind: 'Spawn'", files: [AST] },
  },
  {
    id: 'E2', epic: 'E',
    title: 'Systematic schedule exploration in micro-worlds',
    why: 'The lost-update race is modeled, not executed',
    size: 'L', deps: ['E1'],
    evidence: { kind: 'absent', pattern: 'exploreSchedules', files: ['src/tier3/microworld.ts'] },
  },
  {
    id: 'E3', epic: 'E',
    title: 'Transactions / atomicity',
    why: '`transfer` genuinely needs one; the advisory finding says so',
    size: 'L', deps: ['E1'],
    evidence: { kind: 'absent', pattern: "kind: 'Atomic'", files: [AST] },
  },
  {
    id: 'E4', epic: 'E',
    title: 'Feed concurrency findings to the slicer as placement constraints',
    why: 'Open question 4',
    size: 'S', deps: [],
    evidence: { kind: 'absent', pattern: 'concurrencyFindings', files: ['src/tier4/topology.ts'] },
  },

  // --- F. Governance -------------------------------------------------------
  {
    id: 'F1', epic: 'F',
    title: 'Lineage query API over the persisted ledger',
    why: '"Why does this node exist?" / "What does this clause justify?"',
    size: 'M', deps: ['A3'],
    evidence: { kind: 'absent', pattern: 'queryLineage', files: ['src/tier1/provenance.ts'] },
  },
  {
    id: 'F2', epic: 'F',
    title: 'Signed append-only audit export',
    why: 'Immutability is claimed; nothing attests it',
    size: 'M', deps: ['A3'],
    evidence: { kind: 'absent', pattern: 'sign', files: ['src/tier1/provenance.ts'] },
  },
  {
    id: 'F3', epic: 'F',
    title: 'Operator revocation console with a durable trail',
    why: "The list exists; it's in-memory and has no UI",
    size: 'S', deps: ['A3'],
    evidence: { kind: 'absent', pattern: 'persist', files: ['src/tier2/ocap.ts'] },
  },
  {
    id: 'F4', epic: 'F',
    title: 'Approval workflow for fence discharges',
    why: 'Who accepted a `property_checked` proof, and when?',
    size: 'M', deps: ['A3', 'F1'],
    evidence: { kind: 'absent', pattern: 'approval', files: ['src/tier1/provenance.ts'] },
  },
  {
    id: 'F5', epic: 'F',
    title: 'Incremental structural-key index',
    why: 'Open question 2',
    size: 'M', deps: ['A1'],
    evidence: { kind: 'absent', pattern: 'incrementalStructural', files: [STORE] },
  },

  // --- G. Agent ergonomics -------------------------------------------------
  {
    id: 'G1', epic: 'G',
    title: 'Wire protocol for the agent↔fabric session',
    why: 'In-process API only; no agent can connect',
    size: 'L', deps: ['A1', 'A2'],
    evidence: { kind: 'none', reason: 'A new transport surface; no existing file would contain it' },
  },
  {
    id: 'G2', epic: 'G',
    title: 'Subtree leases/claims',
    why: '1,000 agents will otherwise all synthesize the same function',
    size: 'M', deps: ['G1', 'A8'],
    evidence: { kind: 'absent', pattern: 'lease', files: [STORE] },
  },
  {
    id: 'G3', epic: 'G',
    title: 'Real tokenizer binding',
    why: 'The 4.25× is measured with a documented *estimator*',
    size: 'S', deps: [],
    evidence: { kind: 'absent', pattern: 'tiktoken', files: ['src/util/tokens.ts'] },
  },
  {
    id: 'G4', epic: 'G',
    title: 'Sampled production telemetry mode',
    why: 'Open question 1',
    size: 'M', deps: [],
    evidence: { kind: 'absent', pattern: 'sampling', files: ['src/tier3/compile.ts'] },
  },

  // --- H. Projection -------------------------------------------------------
  {
    id: 'H1', epic: 'H',
    title: 'Rust projection (read-only)',
    why: 'Deliberately descoped; one verified parser establishes the round-trip property',
    size: 'M', deps: [],
    evidence: { kind: 'absent', pattern: 'rust', files: ['src/index.ts'] },
  },
  {
    id: 'H2', epic: 'H',
    title: 'Python projection',
    why: 'Arguably more valuable than Rust for the "agents write Python" framing',
    size: 'M', deps: [],
    evidence: { kind: 'absent', pattern: 'python', files: ['src/index.ts'] },
  },
  {
    id: 'H3', epic: 'H',
    title: 'LSP / projectional editor so the virtual-filesystem story is real',
    why: '§5 describes editing through a virtual filesystem; there is none',
    size: 'XL', deps: ['A2'],
    evidence: { kind: 'none', reason: 'A separate server binary; no existing file would contain it' },
  },
  {
    id: 'H4', epic: 'H',
    title: 'Diff projection — render the change between two roots as readable text',
    why: 'A human reviewing an agent edit currently reads whole projections',
    size: 'M', deps: [],
    evidence: { kind: 'absent', pattern: 'projectDiff', files: ['src/projection/typescript.ts'] },
  },
];

/**
 * The recommended first slice: make it a repository, and make proofs persist
 * with it. Asserted to be closed under dependencies.
 */
export const FIRST_SLICE: readonly string[] = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'C5'];

/**
 * The recommended build order from the brainstorm.
 *
 * Recorded as a claim to be *checked*, not assumed. The validator classifies
 * each step: either the graph forces the order (the later item transitively
 * requires the earlier one) or it does not, in which case the step is an
 * opinion and must carry a rationale in `SEQUENCING_RATIONALE`. An opinion
 * presented as a constraint is the most expensive kind of roadmap error, so
 * the two are rendered differently and the difference is enforced.
 */
export const CRITICAL_PATH: readonly string[] = ['A1', 'A2', 'B6', 'B2', 'C2', 'C3'];

/**
 * Why a step that the graph does *not* force is nonetheless recommended.
 * Keyed `from->to`. The validator requires one for every such step.
 */
export const SEQUENCING_RATIONALE: Readonly<Record<string, string>> = {
  'B6->B2':
    'Nothing forces sequences to wait for cross-module imports — B2 has no blockers ' +
    'at all. The judgment is that a multi-module corpus is what reveals which ' +
    'collection operations are actually needed, so building B2 first means designing ' +
    'against a guess about usage rather than against evidence of it.',
};
