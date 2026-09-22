import type { Milestone, Plan, Requirement, Task } from './model.ts';

export const SPEC_VERSION = '0.1.0';
export const BASELINE_COMMIT = '3c3c8ebe63078f104f1ab7d8182b088124e9b1c6';
export const SOURCE_SHA256 = '82cadd47583b7abff072f5acc7c3f73801008860a0310956da3859e62f9b37ed';

const requirements: Requirement[] = [];
const tasks: Task[] = [];
function task(
  id: string, title: string, milestone: Milestone, owner: string,
  deps: string[], deliverables: string[], criteria: string[],
  covers: string[] = [], kind: Task['kind'] = 'implementation',
): void {
  tasks.push({ id, title, milestone, owner, deps, deliverables, requirements: covers,
    kind, status: 'planned', gates: criteria.map((criterion, i) => ({ id: `${id}/G${i + 1}`, criterion })) });
}
function requirement(id: string, title: string, source: string, target: string): void {
  requirements.push({ id, title, source, target });
}

// The first slice is intentionally implementation-ready; SPEC sections C1–C6
// define interfaces, failure behavior and test cases for these tasks.
task('V4-F01', 'Preserve state during local topology movement', 'baseline', 'runtime', [], [
  'ProductionRuntime export/import snapshot and atomic TopologyHost handoff; retain public reference identity.',
  'Cover every rebuilt unit, nested aliases, allocations and migration rollback; preserve policy and telemetry.',
], [
  'The reviewed ledger reproduction retains balances 90/10 after movement and accepts the next transfer.',
  'Nested/shared/cyclic records and unrelated functions retain state; fresh allocations cannot collide.',
  'Same-unit movement is a no-op; invalid target, active call, snapshot failure or compile failure leaves the old plan and heaps usable.',
], ['V4-FR-4.1', 'V4-FR-3.1']);
task('V4-F02', 'Replace estimated acceptance with reproducible measurements', 'baseline', 'measurement', [], [
  'Real tokenizer measurements for warm bodies, complete warm messages, cold modules and complete change sessions.',
  'Machine-readable benchmark manifests; distinguish correctness, measurement and target enforcement commands.',
  'Correct README/test-count/dependency and density claims using measured scope.',
], [
  'The default ledger reproduces 698 TypeScript / 343 IR body / 375 warm message tokens with cl100k_base, or records an explained versioned fixture change.',
  'A truthful measured miss is recorded as fail, never rewritten to pass; --enforce returns nonzero for failed or unmeasured required targets.',
  'Ratios use summed actual tokens and include dictionary/framing costs; reports bind commit, tokenizer, corpus, environment and raw samples.',
], ['V4-NFR-11']);
task('V4-F03', 'Implement versioned identities and canonical envelopes', 'baseline', 'substrate', [], [
  'Versioned execution manifest, state identity and metadata sidecars; explicit v1 object compatibility.',
  'Canonical tagged value encoding and hashed envelopes shared by effects, replication and evidence.',
], [
  'Existing v1 object addresses remain readable and unchanged; schema changes allocate a new encoding version.',
  'Different semantic/dependency/policy versions cannot reuse an execution-manifest digest; metadata-only observations do not change AST identity.',
  'Malformed tags, duplicate map keys, unsafe integer conversions, unsupported versions and oversized payloads fail before mutation.',
], ['V4-FR-1.1', 'V4-FR-1.3']);
task('V4-F04', 'Implement effect broker and replay contracts', 'baseline', 'runtime', ['V4-F03'], [
  'Single broker for invoke, nondeterministic reads, effect identity, durable outcomes and replay/shadow/speculative modes.',
  'Reservation interface for budgets and explicit adapter support for prepare/commit, idempotency and reconciliation.',
], [
  'Replay and shadow invoke no live mutating adapter; replay mismatch fails deterministically.',
  'Identical retries return the recorded outcome; reused effect ID with a different payload is rejected.',
  'Crash after external commit but before receipt persistence becomes indeterminate and is reconciled; no blind retry or false abort.',
], ['V4-FR-3.4', 'V4-FR-3.7', 'V4-FR-4.4']);
task('V4-F05', 'Implement replication envelopes and delivery harness', 'baseline', 'distribution', ['V4-F03'], [
  'Authenticated replica/occurrence/operation identities, causal frontier and durable operation ingestion.',
  'Deterministic test transport with duplication, reordering, drops, partitions and restart.',
], [
  'Duplicate operations are idempotent and reuse of an operation ID with different bytes is rejected.',
  'Unknown causal predecessors remain pending, invalid signatures cannot mutate the workspace, and restart restores accepted operations.',
  'Candidate synchronization cannot update production roots; harness reports missing replicas and delivery assumptions.',
], ['V4-FR-1.6']);
task('V4-F06', 'Validate proof evidence against exact execution subjects', 'baseline', 'verification', ['V4-F03'], [
  'Evidence envelope and admission policy around existing VerificationReport; distinguish local solver evidence from portable certificates.',
  'Closed-world obligation enumeration, dependency closure, assumptions, resource limits and invalidation checks.',
], [
  'Changed AST, contract, callee, semantics, compiler, capability policy or target invalidates dependent evidence.',
  'Missing/truncated/duplicate obligations, undeclared assumptions, timeout, forged reports and unchecked caller preconditions cannot authorize proof elision.',
  'Property evidence never satisfies a formal-required gate; local reports received from an untrusted peer are reverified.',
], ['V4-FR-2.2', 'V4-FR-2.10']);
task('V4-F07', 'Make state handoff durable across actual processes', 'baseline', 'distribution', ['V4-F01', 'V4-F04'], [
  'Authenticated framed process transport and scoped remote references; durable migration intent, snapshots, ownership epochs and recovery.',
  'Unify direct/cross-unit call admission and explicit timeout, cancellation and committed/indeterminate outcomes.',
], [
  'Two real child processes preserve ledger state and aliasing after migration, restart and failures at every handoff boundary.',
  'At most one ownership epoch may write; stale owner calls and unauthorized transport calls fail.',
  'No heap address is mistaken for a record in another heap; in-flight effects cannot be duplicated by migration or timeout retries.',
], ['V4-FR-4.1', 'V4-FR-2.4', 'V4-FR-3.4']);
task('V4-F08', 'Integrate exact-root admission and baseline recovery slice', 'baseline', 'governance', ['V4-F02', 'V4-F05', 'V4-F06', 'V4-F07'], [
  'Durable candidate → validated → authorized → prepared → active promotion state machine with compare-and-swap on the parent root.',
  'Local authenticated governor authorization adapter; heterogeneous quorum remains a separate requirement.',
], [
  'Combined edits are reverified at the resulting root; stale authorization, old parent root and changed policy cannot promote.',
  'Crash/restart at every state converges to the durable decision, with one active root and an auditable recovery record.',
  'End-to-end ledger flow uses two processes, a recorded effect, migration, candidate rejection, promotion and rollback without duplicate appends.',
], ['V4-FR-1.3', 'V4-FR-2.6', 'V4-FR-4.4']);

task('V4-R01', 'Select and model replication and quorum algorithms', 'baseline', 'distribution', ['V4-F03'], [
  'ADR with occurrence-tree algorithm, state/operation representation, Byzantine protocol and key lifecycle.',
], ['Model cycles, concurrent moves, quorum intersection, equivocation, membership changes and partition recovery; record assumptions and rejected alternatives.'], [], 'research');
task('V4-R02', 'Measure native target feasibility', 'baseline', 'compiler', [], [
  'ADR and bounded prototypes for ABI, typed native lowering, hypervisor/driver target, fallback and boot measurements.',
], ['Measure real code and boot artifacts with named hardware; report misses for 50 ns / 1 ms / 2 MB without weakening the targets.'], [], 'research');
task('V4-R03', 'Select certificate calculus and private attestation statement', 'baseline', 'verification', ['V4-F03'], [
  'ADR for proof kernel, solver proof extraction, ZK statement/witness, target binding and key/setup assumptions.',
], ['Prototype a nontrivial certificate and private artifact assertion, reject false claims, measure proof generation/checking and document fragment limits.'], [], 'research');
task('V4-R04', 'Define numerical and learning experiment contracts', 'baseline', 'synthesis', [], [
  'ADR for numeric semantics, differentiable subset, model/adapter API and held-out workload/budget protocol.',
], ['Demonstrate a gradient path and adapter load/train path on bounded fixtures; document numerical behavior, cost and provider capability constraints.', 'Fix numerical acceptance profiles for the source millions-of-permutations-per-second and tens-of-iterations targets before experiments; state exact thresholds and supported workloads.'], [], 'research');

function feature(
  tier: number, number: number, title: string, milestone: Milestone, owner: string,
  deps: string[], deliverable: string, gates: string[],
): void {
  const id = `V4-FR-${tier}.${number}`;
  requirement(id, title, `PRD §5 FR-${tier}.${number}`, 'Full functional scope in the preserved v4 PRD, qualified only by explicit versioned decisions.');
  task(`V4-T${tier}-${String(number).padStart(2, '0')}`, title, milestone, owner,
    deps, [deliverable], gates, [id]);
}

feature(1, 1, 'Content-addressed AST persistence', 'v2', 'substrate', ['V4-F03'],
  'Versioned durable DAG, reachability/index maintenance, import/export and compatibility migration.',
  ['Check hashes, grouped child semantics, deduplication and corruption detection across reopen/import.', 'Verify concurrent durable root updates and GC preserve committed, leased and pending-promotion roots.']);
feature(1, 2, 'Agent-IR and bidirectional projections', 'v2', 'language', ['V4-F02', 'V4-T1-01'],
  'Versioned binary wire and model-facing representations; complete TS/Rust/Python projections and parsers over declared Aether semantics.',
  ['Every supported AST kind round-trips with identical identity and contracts; unsupported host syntax is rejected explicitly.', 'Execute target-language fixtures for booleans, negative division, overflow and effect calls; report actual corpus token costs.']);
feature(1, 3, 'Causal lineage and invariant fences', 'v2', 'governance', ['V4-T1-01', 'V4-F06'],
  'Durable inherited provenance, exact-root fence validation and transitive spec invalidation.',
  ['Every production artifact resolves to signed intent and evidence; shared nodes preserve all causal links.', 'Spec edits invalidate all relevant evidence and prevent stale fence discharge.']);
feature(1, 4, 'Structural and semantic index', 'v2', 'retrieval', ['V4-T1-01'],
  'Versioned embeddings, backfill, typed graph filters and native hybrid query API.',
  ['Compare recall against a labeled corpus and exact-search baseline.', 'Reject stale embedding/model versions and measure index storage, update and query cost.']);
feature(1, 5, 'Continuous semantic garbage collection', 'v3', 'synthesis', ['V4-T1-03', 'V4-T2-10', 'V4-F08'],
  'Background rewrite proposals with equivalence obligations, export/reachability policy and rollback.',
  ['Remove dead code and collapse wrappers while preserving effects, contracts and exported behavior.', 'Reject unsafe rewrites and keep audit, replay, active-task and causally unstable replication records.']);
feature(1, 6, 'Tree-CRDT concurrency', 'v2', 'distribution', ['V4-F05', 'V4-R01', 'V4-T1-01'],
  'Occurrence-tree replication with deterministic moves, cycle avoidance, causal stability and tombstone collection.',
  ['All replicas converge under reordered/duplicated overlapping edits and concurrent moves, including restart and partition recovery.', 'Converged invalid programs remain candidates; no discarded tombstone may resurrect an obsolete edit.']);
feature(1, 7, 'Module LoRA training and loading', 'v3', 'synthesis', ['V4-R04', 'V4-T1-09', 'V4-T2-05', 'V4-F08'],
  'Versioned base-model/adapter artifacts, verified training examples, budgeted updates and rollback.',
  ['Train and load actual compatible weights with reproducible data lineage.', 'Measure held-out improvement, regressions and full compute/token cost; reject incompatible or poisoned artifacts.']);
feature(1, 8, 'Semantic binary lifting', 'v4', 'compiler', ['V4-R02', 'V4-T2-04', 'V4-T3-10'],
  'Wasm/LLVM/C++ import adapters with explicit supported semantics, capability inference and isolated opaque fallback.',
  ['Differentially execute lifted fixtures and reject unsupported undefined semantics.', 'Adversarial buffers, dangling references and undeclared effects cannot escape the declared imported-code boundary.']);
feature(1, 9, 'Typed cognitive scratchpads', 'v2', 'substrate', ['V4-T1-01', 'V4-T1-03'],
  'Typed claims, hypotheses, decisions, delegations and evidence sidecars with ACL/retention.',
  ['Agents recover structured task state after restart and distinguish claims from verified facts.', 'Scratchpad updates preserve executable hashes and enforce access/retention controls.']);
feature(1, 10, 'Federated private rewrite lemmas', 'v4', 'verification', ['V4-T1-05', 'V4-T2-09'],
  'Federation protocol for rewrite rules, applicability assumptions, private equivalence evidence and revocation.',
  ['Reuse a lemma across independent repositories within the defined disclosure boundary.', 'Reject replay, invalid proof, unavailable dependencies and unsatisfied preconditions.']);
feature(1, 11, 'Topological role induction', 'v3', 'synthesis', ['V4-T1-04', 'V4-T1-07', 'V4-T1-09', 'V4-T2-05'],
  'Cluster dependency/churn graph; assign bounded contexts, local adapters and capabilities.',
  ['Measure specialization against a fixed-context baseline on held-out tasks.', 'Rebalance on graph changes without conflicting task ownership or widening authority.']);

feature(2, 1, 'Executable cross-layer specifications', 'v2', 'language', ['V4-T1-02', 'V4-T1-03'],
  'Versioned formal DSL and intent translation boundary; client/API/database enforcement adapters.',
  ['One rule version is enforced across a real client, gateway and database; incompatible rollout is rejected.', 'Ambiguous input remains unresolved instead of silently selecting business behavior.']);
feature(2, 2, 'Contract-first autonomous repair', 'v2', 'runtime', ['V4-T2-01', 'V4-F04', 'V4-F06', 'V4-F08', 'V4-T3-07'],
  'Durable fault-to-purge-to-synthesis supervisor and atomic verified body replacement.',
  ['A production fault schedules bounded repair while preserving the authorized contract and safe fallback.', 'Failed repair, worker crash and duplicate job delivery cannot activate an unverified body or repeat effects.']);
feature(2, 3, 'Invariant CEGIS', 'v2', 'verification', ['V4-F06', 'V4-T2-01'],
  'Candidate invariant grammar and initiation, preservation, exit and termination obligations.',
  ['Find invariants for named benchmark loops and replay counterexamples across attempts.', 'Budget exhaustion returns unknown; no solution is obtained by weakening authorized intent.']);
feature(2, 4, 'Object-capability containment', 'v2', 'security', ['V4-F04', 'V4-F07'],
  'Unforgeable scoped grants, complete boundary checking, revocation epochs and trusted-adapter policy.',
  ['Every direct, closure, cross-process and external-effect path checks grants and revocation.', 'Forged, expired, wrong-audience or widened tokens fail before side effects; trust assumptions are explicit.']);
feature(2, 5, 'Economic resource types', 'v2', 'runtime', ['V4-F04', 'V4-T2-04'],
  'Linear budget split/reserve/consume/refund typing and durable runtime metering.',
  ['Concurrent forks/retries cannot double-spend money, tokens, time or memory reservations.', 'Exhaustion selects a statically declared safe path; committed charges persist through heap rollback.']);
feature(2, 6, 'Heterogeneous Byzantine promotion quorum', 'v2', 'governance', ['V4-R01', 'V4-F08', 'V4-T1-06', 'V4-T2-10'],
  'Validator enrollment, threshold signatures, family eligibility and durable consensus/membership protocol.',
  ['Test f faulty nodes, equivocation, withheld votes, view changes and membership transitions under named synchrony assumptions.', 'A single model family or signatures for stale root/policy/epoch cannot satisfy production authorization.']);
feature(2, 7, 'State lens synthesis', 'v2', 'persistence', ['V4-F07', 'V4-T2-01', 'V4-T2-10'],
  'Supported schema grammar, lawful lenses, complement storage and mixed-version database adapter.',
  ['Prove GetPut/PutGet for accepted lenses and reject unsupported information loss.', 'Mixed-version writes, indexes, failures and rollback preserve data in an actual database.']);
feature(2, 8, 'Minimal distinguishing examples', 'v2', 'synthesis', ['V4-T2-01', 'V4-T1-09'],
  'Bounded competing-behavior search, minimality ordering and governor choice persistence.',
  ['Produce a concrete witness distinguishing fixture behaviors and minimize it under the declared order.', 'Chosen behavior versions the spec and invalidates old dependents; unknown search stays unresolved.']);
feature(2, 9, 'Zero-knowledge module attestation', 'v4', 'verification', ['V4-R03', 'V4-T2-10', 'V4-T1-08'],
  'Prover/verifier binding private artifact, invariants, effect policy and executed target code.',
  ['Verify the declared universal/bounded safety statement without exposing the specified private witness.', 'Reject altered artifact, contract, policy and invalid proof; report proving and checking resources independently.']);
feature(2, 10, 'Portable AST proof certificates', 'v2', 'verification', ['V4-R03', 'V4-F06'],
  'Independent bounded proof kernel and certificate generator for a declared calculus and semantic fragment.',
  ['A consumer without the original solver validates a certificate against exact AST/contract/dependency identities.', 'Malformed, oversized, stale and semantically false certificates fail; unsupported theories remain unproved.']);
feature(2, 11, 'Metamorphic relation synthesis', 'v3', 'verification', ['V4-T2-03', 'V4-T3-03'],
  'Relation grammar, independent validation corpus and transformation-aware testing.',
  ['Synthesized relations detect seeded faults in sorting/search/heuristic fixtures.', 'Relations contradicted by intent or independent evidence cannot become self-validating oracles.']);
feature(2, 12, 'Multimodal intent anchors', 'v3', 'language', ['V4-T2-08', 'V4-T3-08'],
  'Versioned Figma, interaction-video and heatmap adapters with source anchors and uncertainty.',
  ['Extract layout equations and transition specifications against labeled artifacts.', 'Ambiguous or unsupported input is surfaced for resolution; no unverified extraction is silently promoted.']);

feature(3, 1, 'Reversible execution and resumable checkpoints', 'v2', 'runtime', ['V4-F07'],
  'Versioned heap, frames, task scheduler and event cursor checkpoints with production instrumentation.',
  ['Rewind and resume at declared safe points produces the same logical state and effect sequence as uninterrupted execution.', 'Reopen durable checkpoints after restart; invalid code/state/event versions fail explicitly.']);
feature(3, 2, 'MCTS over copy-on-write heaps', 'v3', 'synthesis', ['V4-T3-01', 'V4-T2-05', 'V4-T3-03', 'V4-F08'],
  'Copy-on-write snapshots, search tree policy, bounded scoring and atomic winning-branch adoption.',
  ['Mutating one branch cannot affect siblings or duplicate external effects.', 'Validate selected programs before promotion and compare search quality/fork memory against baseline under equal budgets.']);
feature(3, 3, 'Living micro-world campaigns', 'v2', 'verification', ['V4-F04', 'V4-T3-01', 'V4-R04'],
  'Campaign manifests, scheduler exploration and adversarial resource/network/event models.',
  ['Seeded failures shrink into persisted replayable cases; admitted candidates achieve 100% survival of the declared campaign without hidden exclusions.', 'Report generated and executed cases, coverage, seeds and throughput separately; meet the source millions-of-boundary-permutations-per-second target under the profile fixed by R04.']);
feature(3, 4, 'Historical counterfactual replay', 'v2', 'runtime', ['V4-T3-01', 'V4-T3-03'],
  'Bitemporal production events, snapshots, code/version retention and isolated counterfactual branch API.',
  ['Inject failure at an exact historic event and measure reproducible state/output deviation.', 'Counterfactual runs cannot write to live sinks; missing history yields an explicit incomplete-replay result.']);
feature(3, 5, 'Polyhedral accelerator kernels', 'v4', 'compiler', ['V4-R02', 'V4-R04', 'V4-T3-10', 'V4-T2-10'],
  'Affine loop/array IR, dependence analysis, verified tiling/vectorization and Wasm SIMD/SPIR-V lowering.',
  ['Execute real target kernels with differential correctness and transformation legality checks.', 'Meet or exceed the preregistered hand-written C/CUDA baseline on each claimed target workload; reject unsupported aliasing/numeric semantics.']);
feature(3, 6, 'Differentiable program relaxation', 'v4', 'synthesis', ['V4-R04', 'V4-T3-02', 'V4-T3-05'],
  'Gumbel-Softmax choices and a measured loss/gradient path through supported program candidates.',
  ['Discretized candidates are reverified; gradient estimates never substitute for correctness evidence.', 'Report convergence, task success and cost against MCTS/enumeration on held-out workloads.']);
feature(3, 7, 'Three-level runtime fallback trees', 'v2', 'runtime', ['V4-F04', 'V4-F06', 'V4-T3-01'],
  'Typed speculative/conservative/static-abort cascade with reversible state and async repair events.',
  ['Faults at each level select the next permitted path; revoked authority is not reintroduced by fallback.', 'Failed speculative writes are suppressed and committed external effects are reconciled before retry; terminal trap preserves declared safe state.']);
feature(3, 8, 'Spatial-semantic UI runtime', 'v3', 'language', ['V4-T1-02', 'V4-T2-01'],
  'Layout constraint AST, incremental Cassowary engine, soft priorities and usable renderer.',
  ['Detect hard constraint contradictions and relax only permitted soft constraints.', 'Inspect rendered text/content/viewport fixtures for clipping and behavior; maintain semantic and accessibility tree correspondence.']);
feature(3, 9, 'Persona and accessibility evaluation', 'v3', 'verification', ['V4-T3-08', 'V4-T3-03'],
  'Task runner over real browser/accessibility trees, persona profiles and calibrated metrics.',
  ['Keyboard, screen-reader and constrained-network tasks produce actionable failures and replayable evidence.', 'Calibrate task/cognitive/layout metrics; label synthetic estimates separately from observed human performance.']);
feature(3, 10, 'Packed heap and native value ABI', 'v4', 'compiler', ['V4-R02', 'V4-R04', 'V4-T3-01'],
  'Typed bounds, packed fields, relative references, overflow policy and versioned native state migration.',
  ['Pack/unpack/mutate preserves values and aliases; invalid bounds/offsets are rejected.', 'Measure memory footprint and locality across distributions; map native checkpoints back to logical state.']);
feature(3, 11, 'Gradient-directed fuzzing', 'v3', 'verification', ['V4-R04', 'V4-T3-03'],
  'Branch-distance instrumentation, supported gradient paths and discrete search fallback.',
  ['Reach preregistered deep branch fixtures within the tens-of-iterations budget fixed by R04 and compare coverage with random generation.', 'Unsupported/discontinuous guards remain explicit; produced failures replay and shrink.']);
feature(3, 12, 'Bayesian failure risk surfaces', 'v3', 'measurement', ['V4-T1-03', 'V4-T3-03', 'V4-F08'],
  'Versioned risk features, priors, calibration/drift reports and verification-gated maintenance proposals.',
  ['Evaluate calibrated risk on held-out temporal data without leakage.', 'High risk may propose work but cannot bypass budgets, contracts or promotion authorization.']);

feature(4, 1, 'Fluid production topology', 'v3', 'distribution', ['V4-T2-04', 'V4-T2-07', 'V4-T2-06', 'V4-F07'],
  'Actual monolith/service/edge deployment adapters, sovereignty/placement policy and stateful reconfiguration.',
  ['Move and fuse live units while preserving state, effect ordering, policy and failure recovery.', 'Deploy runnable artifacts on each claimed target and measure transport/cost changes under real traffic.']);
feature(4, 2, 'Negotiated ephemeral wire codecs', 'v4', 'distribution', ['V4-T4-01', 'V4-T3-10'],
  'Distribution-aware codecs, authenticated epoch negotiation and bounded dual-codec transitions.',
  ['Mixed-version peers decode in-flight traffic and out-of-range fields safely during renegotiation.', 'Reject malformed frames and stale/downgrade negotiation; measure full wire savings including control traffic.']);
feature(4, 3, 'Production optimization surfaces', 'v3', 'measurement', ['V4-T4-01', 'V4-T2-05', 'V4-F08'],
  'Measured multi-parameter objectives, constraints, noisy-gradient controls and safe parameter promotion.',
  ['Only authorized parameter nodes change; all correctness and cost bounds remain enforced.', 'A real workload demonstrates improvement without unstable oscillation; report confidence and measurement overhead.']);
feature(4, 4, 'Evolutionary shadow deployment', 'v3', 'distribution', ['V4-T4-01', 'V4-T3-04', 'V4-T3-07', 'V4-T4-03'],
  'Mirrored ingress, isolated effects, comparable metrics, confidence-based Pareto promotion and rollback.',
  ['A candidate processes actual mirrored requests with no writes to live sinks and satisfies correctness tolerances.', 'Promotion and rollback retain state/schema compatibility and reject statistical noise or stale authorization.']);
feature(4, 5, 'Bootable ephemeral unikernels', 'v4', 'compiler', ['V4-R02', 'V4-T3-10', 'V4-T2-04'],
  'Native image lowering, minimal declared drivers, hypervisor boot harness and artifact provenance.',
  ['Boot an actual image and execute a useful fixture with capability containment.', 'Measure boot-to-response, image size and resident footprint; unsupported targets and missed bounds remain open.']);

// Every numeric/nonfunctional source obligation remains explicit. IDs are local
// because the source PRD names these metrics without requirement identifiers.
const nfr = [
  ['AST retrieval', '≤2 ms at 100M DAG nodes'],
  ['Tree-CRDT convergence', '≤50 ms across 1,000 agents'],
  ['Checkpoint rollback', '≤5 ms'],
  ['Fallback switch', '≤50 ns within the active frame'],
  ['Certificate checking', '≤50 µs per bounded certificate'],
  ['Unikernel cold boot', '≤1 ms; ≤2 MB footprint per FR-4.5'],
  ['State lens overhead', '≤3.5% versus raw SQL'],
  ['SMT hard cutoff', '≤1,500 ms'],
  ['Projection throughput', '≥75,000 lines/sec'],
  ['ZK module verification', '≤5 ms'],
  ['Agent-IR density', '≥4× actual token compression'],
  ['Multimodal extraction', '≤400 ms Figma-to-AST'],
  ['Concurrent mutation safety', '1,000 mutating agents; no lock contention, deadlocks or write skew'],
  ['Graph capacity', '100M nodes; hash-index retrieval with declared scaling behavior'],
  ['Bit-level determinism', 'Identical heaps/register states for identical event logs, inputs and tokens'],
  ['Capability containment', 'Pr[Escape] = 0 under the explicitly proved model and trusted computing base'],
];
nfr.forEach(([title, target], i) => requirement(`V4-NFR-${String(i + 1).padStart(2, '0')}`, title,
  i < 12 ? 'PRD §7 table' : i < 14 ? 'PRD §7.1' : 'PRD §7.2', target));
[
  ['Causal production audit', 'Every production byte links to signed provenance, spec, evaluators and validation logs'],
  ['Hardware-backed revocation', 'Governor hardware token revokes authority globally without rebuild/restart'],
  ['Governance export', 'Signed compliance ledger; named control mappings and independent assessment scope'],
].forEach(([title, target], i) => requirement(`V4-GOV-0${i + 1}`, title, `PRD §9.${i + 1}`, target));
[
  ['Feature completion time', '≤10 minutes autonomous MTTC'],
  ['Tokens per change', '≤18% of defined baseline'],
  ['Unhandled production regressions', '≤0.0001% of deployments'],
  ['Autonomous tuning dominance', '≥85% autonomously optimized'],
  ['Sandbox escape incidents', '0 incidents under the declared threat model'],
  ['Concurrency conflict stalls', '0% attributable to merge conflict stalls'],
  ['Proof latency KPI', '≤50 µs'],
  ['Cold-start KPI', '≤1 ms'],
  ['Development velocity reduction', '≥92% elapsed time reduction'],
  ['Total context reduction', '≥80% total input/output tokens saved'],
  ['Supply-chain containment', '100% unauthorized syscall/memory/exfiltration containment in stated model'],
  ['Autonomous Pareto improvement', '≥85% optimizations discovered and deployed without human engineering intervention'],
].forEach(([title, target], i) => requirement(`V4-KPI-${String(i + 1).padStart(2, '0')}`, title,
  i < 8 ? 'PRD §11 table' : `PRD §11 item ${i - 7}`, target));

const ids = (prefix: string, numbers: number[]) => numbers.map(n => `${prefix}-${String(n).padStart(2, '0')}`);
task('V4-Q01', 'Production-scale storage and replication evidence', 'v4', 'measurement', ['V4-F02', 'V4-T1-01', 'V4-T1-06', 'V4-T2-06'],
  ['100M-node store and 1,000-agent distributed workload manifests with raw latency/convergence/conflict samples.'],
  ['Run named cold/warm and mixed-load profiles at the actual required scale; no asymptotic extrapolation counts as measured success.', 'Run partition/recovery/overlapping-write campaigns and report assumptions, resource consumption and unresolved conflicts.'],
  ids('V4-NFR', [1, 2, 13, 14]), 'assurance');
task('V4-Q02', 'Runtime, proof and hardware performance gates', 'v4', 'measurement', ['V4-F02', 'V4-T1-02', 'V4-T2-07', 'V4-T2-09', 'V4-T2-10', 'V4-T3-01', 'V4-T3-07', 'V4-T4-05'],
  ['Target-specific repeated benchmarks for rollback, fallback, proofs, boot, lenses, solver cancellation and projections.'],
  ['Every required bound has raw samples, an approved workload/target profile and pass/fail/unknown result; misses fail release.', 'SMT cancellation is tested on hard queries; fallback measures detection-to-safe-path as well as dispatch alone.'],
  ids('V4-NFR', [3, 4, 5, 6, 7, 8, 9, 10]), 'assurance');
task('V4-Q03', 'Representative real-token efficiency gates', 'v4', 'measurement', ['V4-F02', 'V4-T1-02', 'V4-T1-07'],
  ['Pinned multi-workload change corpus and model/tokenizer identities including all session overhead.'],
  ['Required ≥4× ratio passes for the declared release corpus/profile; publish cold, warm and full-session measurements without hiding regressions.'],
  ['V4-NFR-11'], 'assurance');
task('V4-Q04', 'Multimodal quality and latency gates', 'v4', 'measurement', ['V4-F02', 'V4-T2-12', 'V4-T3-09'],
  ['Labeled design/video/heatmap corpus and timing boundary including source acquisition policy.'],
  ['Figma-to-AST meets 400 ms in the declared profile and extraction quality passes independent labeled checks.'],
  ['V4-NFR-12'], 'assurance');
task('V4-Q05', 'Determinism, containment and governance assurance', 'v4', 'security', ['V4-T1-03', 'V4-T1-08', 'V4-T2-04', 'V4-T2-06', 'V4-T2-09', 'V4-T3-04', 'V4-T3-05', 'V4-T3-10', 'V4-T4-05'],
  ['Threat model and formal containment argument; replay across all claimed targets; hardware-backed revocation and signed control evidence export.'],
  ['Native register/heap determinism is checked under a pinned execution target; unsupported GPU/JIT nondeterminism is not counted as passing.', 'Revocation includes partition/stale-token behavior; hardware token and auditor export are exercised with tamper detection.', 'Scope each formal claim to its TCB and assumptions; independent review and control mapping evidence are attached.'],
  [...ids('V4-NFR', [15, 16]), ...ids('V4-GOV', [1, 2, 3])], 'assurance');
task('V4-Q06', 'End-to-end KPI validation', 'v4', 'measurement', ['V4-Q01', 'V4-Q02', 'V4-Q03', 'V4-Q04', 'V4-Q05', 'V4-T1-10', 'V4-T1-11', 'V4-T3-06', 'V4-T3-12', 'V4-T4-04'],
  ['Matched baseline study over ledger, user workflow and numerical workloads; full cost accounting and production observation windows.'],
  ['All 12 KPI obligations have explicit denominators, confidence levels, dataset/workload identities and independently reproducible results.', 'Rare-regression claims need adequate observations/statistical bounds; zero observed failures in a tiny suite is insufficient.'],
  ids('V4-KPI', Array.from({ length: 12 }, (_, i) => i + 1)), 'assurance');

// Release closure depends on every task owned by that milestone and the previous
// release gate. Research is assigned baseline but does not delay the first slice.
for (const [milestone, previous] of [['baseline', null], ['v2', 'V4-M0'], ['v3', 'V4-M2'], ['v4', 'V4-M3']] as const) {
  const id = milestone === 'baseline' ? 'V4-M0' : `V4-M${milestone.slice(1)}`;
  task(id, `${milestone} completion gate`, milestone, 'release',
    [...tasks.filter(t => t.milestone === milestone).map(t => t.id), ...(previous ? [previous] : [])],
    ['Versioned release manifest collecting exact artifacts, task evidence and remaining requirement status.'],
    ['All prerequisite gates are verified with evidence for this specification version; no failed, waived or unmeasured required gate is labeled complete.'], [], 'release');
}

export const PLAN: Plan = {
  version: SPEC_VERSION, requirements,
  tasks: tasks.map(task => ['V4-F01', 'V4-F02', 'V4-F03'].includes(task.id)
    ? { ...task, status: 'verified' as const, evidence: `docs/implementation/v4/evidence/foundations-4a9b077/${task.id}.json` }
    : ['V4-F04', 'V4-F05', 'V4-F06'].includes(task.id)
      ? { ...task, status: 'verified' as const, evidence: `docs/implementation/v4/evidence/contracts-3dce2d6/${task.id}.json` }
      : ['V4-R01', 'V4-R02', 'V4-R03', 'V4-R04'].includes(task.id)
        ? { ...task, status: 'verified' as const, evidence: `docs/implementation/v4/evidence/research-749ce8b/${task.id}.json` }
        : ['V4-F07', 'V4-T1-01'].includes(task.id) ? { ...task, status: 'in_progress' as const } : task),
  firstSlice: ['V4-F01', 'V4-F02', 'V4-F03', 'V4-F04', 'V4-F05', 'V4-F06', 'V4-F07', 'V4-F08'],
};
