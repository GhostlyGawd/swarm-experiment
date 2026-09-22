# Operating the implemented v4 foundations

Use [TRACKER.md](TRACKER.md) for verified task status and [STATUS.md](STATUS.md) for current work. These interfaces implement the early foundations; full v4 deployment, scale and assurance gates remain open.

## State-preserving local movement

`TopologyHost.move(symbol, targetUnit, expectedGeneration?)` prepares replacement runtimes and imports validated snapshots before publishing a new local generation. Use `host.generation` as the expected generation when coordinating edits. A same-unit move is a no-op. Invalid placement, active calls, retained live closures/tasks and preparation failures leave the old state usable.

The local host maintains separate runtime arrays and copies the authoritative logical heap at cross-unit calls, including callbacks and continuation invocations. It coordinates allocations across units. This is a synchronous local state domain; it is not process isolation or a distributed migration protocol.

`ProductionRuntime.exportSnapshot()` / `importSnapshot()` provide module-bound local snapshots. They preserve references, aliases and cycles, reject malformed/dangling addresses, and copy nested containers. Live continuations prevent exporting/moving their owner. Do not delete their records or bypass these guards to force a move.

## Durable effects and runtime routing

Import `DurableEffectBroker` from `@ghostlygawd/aether/fabric` and `BrokerEffectRouter` from the root package or `@ghostlygawd/aether/tier3`.

1. Create an execution manifest from the actual code/build/policy context. Create a broker with a private journal directory, clock domain, authorization callback and optional durable budget adapter.
2. Register effect adapters with explicit transactional/idempotency/reconciliation semantics. A claim of sink idempotency must be implemented at the sink. Prepare/abort are reversible operations; reconciliation queries the original operation rather than dispatching another.
3. Construct one router per logical execution with a stable `executionId`, manifest, deadline, policy epoch and capability-grant resolver. Reconstruct the same context when retrying; effect indices are deterministic within that execution.
4. Pass `effectRouter` into `Runtime` or `ProductionRuntime.compile`. It takes precedence over legacy direct callbacks and binds to the loaded AST root. Raw record references need an explicit ownership translator; authority installation from effect return values is forbidden.
5. Supply an explicit isolated router factory before calling `Runtime.fork()` with a broker-backed runtime. Reusing live dispatch authority is rejected.

`committed` has a durable receipt. `rejected`/`aborted` describe established noncommit outcomes. `indeterminate` means that commit disposition is unresolved. Both runtimes preserve this as `effect_indeterminate` with a `recoveryId`. Host dispatch returns `committed: null`, `retryable: false` for that case, including when a deadline also expired.

After a worker crash, call `broker.recoverDeadWriter()` to release only tickets whose process is authoritatively dead. PID reuse, a live owner or unverifiable process status fails closed. Do not use elapsed time or manually remove an active owner's ticket. Then call `broker.reconcile(originalRequest, originalAdapter)`; preserve the original ID, payload, context and adapter identity. An unknown reconciliation remains unknown. A `not_committed` sink response must guarantee that the original operation cannot later commit.

Replay consumes the recorded ordered history and invokes no live adapter. Check `assertReplayComplete()` at the end. Duplicated, reordered or inconsistent events are rejected. Speculative/shadow modes may consume recorded outcomes; otherwise they buffer branch intents and report `isolated_intent_buffered`. Buffering does not fabricate a return value or claim a complete successful shadow run. Full isolated result providers and shadow deployment belong to later tasks.

The reference broker uses a bounded filesystem journal and retained immutable lock tickets. Ticket exhaustion requires coordinated quiescent maintenance, not sequence reuse or automatic deletion. Historical prototype lock layouts require an explicit offline migration. The filesystem must support atomic hard links and durable fsync. Authorization and recovery authority callbacks are trusted host boundaries.

## Candidate replication

`DurableReplica` receives an immutable trusted membership roster with enrolled Ed25519 public keys. Keep private signing keys outside graph/snapshot data. A journal binds its repository, local replica, membership epoch and count/byte capacity profile; opening it with incompatible identity or quota settings fails.

- `author(...)` durably allocates a sequence and publishes a complete signed operation before returning bytes for delivery.
- `ingest(bytes)` authenticates the complete canonical envelope. Exact duplicates are idempotent; conflicting signed variants are quarantined together with causal descendants.
- `operations()` exposes accepted, pending and quarantined candidate operations.
- `missingPredecessors()` and `framesFor(...)` drive causal retrieval. Do not mark a pending operation accepted because a timeout elapsed.
- `candidateDigest()` covers accepted operations; `journalDigest()` also covers dispositions and retained conflicting evidence.

Local journal admission serializes quota checks and immutable publication so competing processes cannot leave an overfull, unreadable store. Independent replica journals remain independent. A dead writer's admission ticket may be recovered after an authoritative process-death check; a live writer times out as busy. Resource exhaustion fails before new durable admission.

`ReplicationHarness` is a deterministic test transport for duplication, reordering, drops, partitions, disconnection and restart. It provides no actual network throughput or 1,000-agent convergence claim. These journals also have no production-root update API. The selected production tree/quorum algorithms are described separately in [D04](decisions/D04-replication-quorum.md).

## Proof evidence and compilation

Construct an `EvidenceContext` from the actual module, specification, compiler/semantics/target identity, capability policy and registry. The host must obtain expected identity from its own current build and authorization configuration; echoing an untrusted sender's asserted context does not establish authenticity.

`mintLocalEvidence(context)` runs type/capability checks, derives the complete obligation set and obtains local solver evidence under a 1,500 ms default solver budget. `validateEvidence(evidence, context)` checks the context and obligations. Serialized peer claims are reverified; they do not inherit local authority from a `proved` field.

Pass the returned object through:

```ts
const local = mintLocalEvidence(context);
const vetted = validateEvidence(local, context);
const runtime = ProductionRuntime.compile(context.module, {
  registry: context.registry,
  evidence: { vetted, expectedManifest: createEvidenceManifest(context) },
});
```

Compilation verifies the unforgeable local evidence brand, manifest and report set, checks the module root, and retains external entry preconditions. It rejects unconditional elision and a simultaneous legacy verification map. Property-classified clauses may remain dynamically checked under explicit policy; they never become formal proofs.

The wrapper rejects demonstrated model gaps: nested mutable aliasing, unenforced ownership assumptions, hidden mutations in unsupported constructs, truncated exploration and incomplete obligations. Modeled flat-record ledger transitions and formally handled loops are exercised by tests. Unsupported cases require stronger verification/model support, not removal of the admission guard. A portable certificate checker is still a separate implementation task.

## Process state and recovery

`ProcessHost` from the root package or `@ghostlygawd/aether/tier4` runs topology units in actual Node child processes. Its public arguments, results and snapshots use C1 tagged values and logical references. Open it with the exact module/manifest, capability registry, topology plan, private durable directory and trusted service configuration. `issueTokens(symbol)` supplies scoped call grants; `call(symbol, args, { operationId, tokens })` requires them on direct and cross-unit entry.

Use a stable, unique operation ID for each logical call or allocation. Retries with identical payloads retrieve the recorded outcome; changing the payload under an existing ID is rejected. `allocateRecord` checks field types and returns a reference scoped to the heap and ownership epoch. A local numeric address is never a public cross-process reference. Stored references must use the current epoch after movement; do not reuse a stale reference as write authority.

`move(symbol, targetUnit, { migrationId, expectedGeneration })` records a transition, prepares new workers and publishes one canonical state generation. Startup recovers the durable migration decision. Migration does not transfer arbitrary suspended JavaScript frames. Calls, allocations and moves serialize within one complete snapshot domain, including nested calls across units. This baseline is local multiprocess execution; cross-machine replication and independently concurrent record ownership remain later work.

An interrupted call can return `indeterminate`. Keep its original ID and journal. `recoverOperation` requires a fresh trusted recovery authorization callback and either:

- `abort-before-effects`: establish from durable history that no effect boundary was entered, then record the abort.
- `isolated-replay`: reproduce the operation using its recorded/reconciled outcomes, without live effect dispatch, and validate the resulting state before publication.

Provide a broker-backed `effectRouterFactory` whose execution identity is the stable boundary ID supplied by ProcessHost. Reconcile unresolved external effects through their original adapter before replay. Neither timeout nor process death establishes noncommit. Recovery never accepts an arbitrary caller-supplied success snapshot.

The process channel authenticates bounded frames to a worker session, roles, sequence and execution scope. The parent bootstrap secret is supplied through a dedicated inherited descriptor. Parent death terminates workers, including running loops. Keep journal directories and trusted services private; these local process controls do not constitute the full v4 hostile-code containment boundary.

## Exact-root process deployment

`PromotionCoordinator` is exported by `@ghostlygawd/aether/fabric`. `ProcessDeployment` and its artifact/migration/effect-plan helpers are exported by the root package and tier4. The deployment object is both the execution gate and the coordinator's actual process driver.

Initialize a trusted genesis artifact, coordinator and reloadable factory map. Factories provide the current sealer, revocation state, effect router and recovery authority; functions and secrets are not serialized into artifacts. Register candidate artifacts with their complete module, evidence context, evidence and topology. Registration recomputes evidence and binds the durable artifact to its full configuration.

Create the migration plan from the current snapshot and candidate artifact digest, and the effect plan from its factory and policy identity. Approvals must sign the exact proposal, expected production parent, candidate manifest, evidence and plans under the current governor/membership/policy context. Combined edits require evidence for their resulting root. The baseline authorization adapter uses authenticated local governors; the heterogeneous Byzantine quorum is a separate task.

Execute application calls through `ProcessDeployment` so its shared durable gate covers promotion. Preparation freezes execution across deployment instances, seeds candidate workers from the bound source snapshot and preserves invocation/allocation receipts across versions. This implementation permits compatible schemas only; schema-changing state lenses and full evolutionary shadow execution remain later tasks.

If activation fails after the coordinator commits, serving stays blocked. Reopen with the same directories and trusted factories, then use coordinator recovery with the deployment driver. Recovery follows the durable commit/abort decision. It does not serve the old root after a committed target transition. A rollback is a newly authorized promotion from the current parent to an earlier artifact, carrying current state and a new generation.

Retain the coordinator, deployment, prepared-artifact, ProcessHost and effect journals together. Do not manually remove pending receipts or rewrite generations to clear a failure. Keep process startup paths available in the built package; `npm run build` emits the worker entry alongside the public API.

## Verification and benchmarks

```sh
npm test
npm run typecheck
npm run roadmap:check
npm run roadmap:v4:check
npm run bench:v4:measure
npm run bench:v4:enforce
```

The enforcement command currently fails because required targets are missed or unmeasured. `bench:record` records legacy observations without treating successful recording as successful qualification; `bench` retains nonzero failure for missed legacy targets. CI uploads the observations. See [benchmark documentation](../../../bench/v4/README.md) for pinned corpus definitions and raw manifests.
