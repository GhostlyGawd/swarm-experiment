# Implementation specification changelog

## Current-source SMT cutoff preflight — 2026-09-24

- At clean `b096579`, the unchanged six-shape [NFR-08 campaign](evidence/nfr08-b096579/REVIEW.md) passed **30/30** measured complete calls under the **1,500 ms** bound; maximum **1,483.031 ms**. The verifier recomputes raw verdicts and arithmetic from saved source snapshots. This is bounded built-in solver evidence only: the default release row remains unmeasured, and external fallback/full proof-pipeline qualification remains open.

## NFR-09 three-target projection throughput preflight — 2026-09-24

- Added a preregistered, source-pinned benchmark of the real TypeScript, Python and Rust `executableBundle` projection plus complete target-source parse and exact entry/dependency identity. Eight authored scalar/composite/ledger/atomic/linked/nested workloads and one literal edit each produce 48 bundles and 8,902 entry+dependency lines per trial. The profile fixes one warmup, five trials, line accounting and an every-target/every-trial **75,000 lines/s** rule. Raw per-output projection/parse timings, line counts, source/tool/hardware hashes and an independent tamper-aware verifier are retained. [Profile](../../../roadmap/v4/research/projection-throughput/README.md).
- [Clean exact-source preflight](evidence/nfr09-fc3b4c3/REVIEW.md) at `fc3b4c3`: every trial misses the unchanged target—TypeScript **11,707–12,329**, Python **10,181–10,924**, Rust **11,274–11,660** complete lines/s. Bundle-generation-only diagnostic rates also miss. The corpus is authored and does not execute external target compilers or represent production repository sizes, so release-wide NFR-09 and V4-Q02 stay open; the default release inventory remains unmeasured and the tracker stays **20/62**.

## Combined V18 and living-campaign focused checkpoint — 2026-09-24

- At clean `459ed63`, [combined focused evidence](evidence/integration-459ed63/REVIEW.md) passes **134/134** projection/resident-pressure tests and **2/2** external-sink tests, plus build, typecheck and roadmap. The saved external fault evidence independently verifies with a fresh replay. V18's 75-case saved audit verifies its contents but retains its own `bb15b30` exact-source identity; the combined tests cover the integrated source.
- The exact-current-source default release inventory remains **ineligible**: warm ledger **5.6290×** passes one required row, cold/full-session diagnostics miss, and **15 required NFR targets are unmeasured**. The last serial full-suite pass is still `888bfeb`; T1-02, T3-03 and the tracker remain **20/62**.

## Signed integrated `/2` accounting and observed memory pressure — 2026-09-24

- Versioned the integrated living campaign's registration/measurement as `/2` under accepted [D21](decisions/D21-living-campaign-throughput-boundary.md). It retains the **2,000,000/s R04 generator/evaluator** target as a separate named boundary and removes the old full signed-campaign pass/fail comparison. Both complete signed execution rates remain reported with all 15 cases, zero filters, crash/retry and broken-root shrink/replay counts intact. Historical `/1` raw results are unchanged.
- Added an opt-in signed resource case under **64 MiB of real resident process pressure**, with three controller OS RSS samples, worker RSS, touched-page checksum and fresh-process replay. The clean `497da3a` [campaign evidence](evidence/t303-rss-497da3a/REVIEW.md) records a **67,141,632-byte OS RSS rise**, 15/15 good cases and four durable broken-root replays; the focused suite passes **7/7**. This does not induce a real allocation failure or close T3-03/G1. The task count stays **20/62**.
- A proposed general dead-code GC profile was discarded before commit: the current signed evidence checker refuses Task/Await source declarations even when unreachable. A new structural proof policy is required before that path can be admitted safely.

## Fresh record task contract projection V18 — 2026-09-24

- Added `aether.executable-projection/18` for a new task that creates a scalar-field record and is directly awaited and consumed by one field read inside a checked contract closure. The certificate binds the exact owner/lambda roots, and the checker refuses record escape, ambient callbacks and unrelated task forms. Actual TypeScript, Python and Rust execution matches the reference with zero external callbacks; a pinned V17 source/runtime fixture remains byte-identical. [Profile and limits](../../../roadmap/v4/research/projections/FRESH-RECORD-TASK-CONTRACTS-V18.md).
- The generated 15×5 reference-valid audit still finds unjoined task identity, sequence-valued task results and awaited-record identity as native gaps. Its authored cold token ratios miss 4×; AE6 history and thresholds are unchanged. T1-02/G1, G2, FR-1.2 and Q03 stay open at **20/62**.

## Witnessed external fault shrink and fresh candidate restart — 2026-09-24

- Added a versioned `aether.living-external-fault-shrink/1` profile over the same signed Aether execution manifest and policy body. Its bounded delta debugger reruns the complete 15-case witnessed sink campaign for every proposal, drops optional malformed/truncated/healthy prefix actions only when the real committed-sink/unknown-host property survives, and retains every raw proposal. After the lost reply, the first candidate process persists its failed pipeline phase and receives real `SIGKILL`; a fresh process observes unknown while disconnected, reconciles the original signed receipt after rejoin and executes all remaining cases. No original failure or filter is hidden.
- [Exact-source evidence](evidence/t303-external-shrink-2611c4e/REVIEW.md) at clean `2611c4e`: three reductions from three optional actions to none, plus fresh replay. Five full observations executed **75/75** generated cases with zero filters, 88 candidate attempts, five explicit partition failures, ten recovery calls and 45 signed sink decisions. Complete signed rates remain separately reported around **1.05–1.13 cases/s**. Under accepted [D21](decisions/D21-living-campaign-throughput-boundary.md), five unchanged R04 generator/evaluator trials pass **3.208–3.501M/s**. This is bounded external-fault shrinking, not global minimality or complete T3-03; cross-machine partitions, distinct custody, native races, real OS allocation failure, broader faults and ProcessHost proof admission remain open. The separate resident-pressure profile measures RSS without forcing OS allocation failure. Tracker stays **20/62**.

## Clean combined verification at `888bfeb` — 2026-09-24

- The exact-source serial full suite passed **1,204/1,206**, with zero failures and two existing skips, after integration of source-witness Artifact/4 config/18, V17 task projection and the living boundary pipeline. Build, typecheck, v4 roadmap and worker-bundle checks passed. [Raw checkpoint](evidence/integration-888bfeb/REVIEW.md).
- Independent release inventory verification matched the tested commit but returned `releaseEligible: false`: one fixed warm ledger row passes at **5.6290×**, cold/full-session diagnostics miss, and **15 required NFR targets remain unmeasured**. The tracker stays **20/62**; a green suite is not full gate closure.

## D21 living-campaign rate boundary decided — 2026-09-24

- The product owner delegated the FR-3.3 throughput interpretation. [D21](decisions/D21-living-campaign-throughput-boundary.md) confirms that the unchanged **2,000,000/s** criterion in specification 0.1.0 applies to the preregistered R04 four-field generator/evaluator, matching the PRD's synthesis wording and the tracker phrase “under the profile fixed by R04.” Signed candidate execution, fault injection, transport and durability are separate measurements; every declared case must still execute and survive before graduation. This is an interpretation of the existing criterion, so the specification version and all 20 prior verified-task evidence manifests remain unchanged.
- Five exact-source R04 trials pass at **2.682–3.076M/s**. The complete external campaign reports **1.0741 cases/s** and 15/15 bounded survivors; that rate is not compared with 2M/s. The R04 pass is narrow quantitative evidence, not full FR-3.3 or T3-03 closure. G1's cross-machine, custody, native race, actual memory-pressure, ProcessHost and external-sink shrink gaps remain open; the tracker stays **20/62**. Historical raw evidence and its prior interpretation are retained.

## Direct pure lazy-task contract projection V17 — 2026-09-24

- Added `aether.executable-projection/17` for a directly awaited new scalar task inside a checked closure. Static admission binds the exact task body under the owner/lambda certificate, rejects unjoined tasks and ambient callback/effect paths, and retains earlier native task laziness and completed-result behavior. Actual TypeScript, Python and Rust execution matches the reference with zero external-effect callbacks; pinned V16 source/runtime bytes remain identical. [Profile and limits](../../../roadmap/v4/research/projections/PURE-LAZY-TASK-CONTRACTS-V17.md).
- The generated 13×5 reference-valid corpus still finds two task-state gaps in all five carriers: a fresh-record task result and unjoined task identity. The authored actual-token cold ratios remain below 4×; historical AE6 results and thresholds are unchanged. T1-02/G1, G2, FR-1.2 and Q03 remain open at **20/62**.

## Signed living boundary pipeline and throughput decision record — 2026-09-24

- Added versioned `aether.living-boundary-pipeline/1` for the V4 signed candidate: immutable generation, every original/retry/duplicate Aether execution, both recovery calls, raw per-attempt/publication timing, complete recount and offline tamper audit. The one failed partition attempt remains visible when its retry succeeds; zero filters are required. It does not grant deployment authority. [Contract](LIVING-PIPELINE-V1.md).
- [Clean-source stage campaign](evidence/t303-pipeline-faf2172/REVIEW.md) at `faf2172`: 15 rich signed cases generated at **95,389.5/s**, 17 actual candidate attempts at **1.3735/s**, 15 worker pipeline cases at **1.1177/s**, and complete witnessed external campaign at **1.0741/s**. The unchanged four-field R04 JSON kernel passes five trials at **2.682–3.076M/s**; 100 direct serial file-plus-directory fsync samples have a **2.792 ms** minimum. [D21](decisions/D21-living-campaign-throughput-boundary.md) records the owner decision needed to resolve the exact 2M/s qualification workload, without changing the target. T3-03/G2 remains failed, G1 remains incomplete, and the tracker stays **20/62**.

## Clean combined verification checkpoint — 2026-09-24

- At clean `244684b`, the serial full suite passed **1,199/1,201** with zero failures and two existing skips; build, typecheck, v4 roadmap and independently rebuilt worker-bundle checks passed. The exact-source default release inventory verifies a **5.6290×** warm ledger fixture pass but remains ineligible with 15 required NFR targets unmeasured; cold and changed-session diagnostic ratios miss. The tracker stays **20/62**. [Raw evidence and scope](evidence/integration-244684b/REVIEW.md).

## Bounded closure dataflow projection V16 — 2026-09-24

- Added `aether.executable-projection/16` for scalar captures across both `If` factory arms, quantifier and Result binders, exact transitive pure helper roots, checked sequence map/fold, nested immediate lambdas and fresh scalar record reads. Real TypeScript, Python and Rust executions match the reference fixtures; a pinned V15 source/runtime hash comparison remains byte-identical. [Profile, trust boundary and limits](../../../roadmap/v4/research/projections/DATAFLOW-CLOSURES-V16.md).
- A generated 11×5 corpus typechecks and executes 55 reference-valid cases, then checks 165 native projection outcomes. The effect-free lazy-task body remains a valid counterexample: four carriers are rejected and the passed-function carrier lacks a certificate. Actual-token authored-corpus ratios remain far below 4×; the historical AE6 corpus and threshold are unchanged. T1-02/G1, G2, FR-1.2 and Q03 stay open; **20/62** is unchanged.

## Witnessed external living campaign and same-host partition — 2026-09-24

- Added signed effect authorization `/4` with a distinct signature/campaign domain. It binds the exact Aether root and generated plan to signed V2 resource policy, approved adapter artifact, preselected sink anchor and two externally supplied witness identities. The executor uses a broker V4 journal and attested sink adapter; unknown transport/status cannot become success, and V4 cannot mint a V2 local admission receipt. Prior V2/V3 bytes and behavior remain explicit. [Contract](LIVING-EFFECT-CAMPAIGN.md).
- [Clean-source external campaign](evidence/t303-external-f8ccbdf/REVIEW.md) at `f8ccbdf`: separate sink, witness, gateway and candidate processes execute/pass all 15 generated cases with zero filters, one separately counted failed partition attempt, signed recovery after rejoin, nine witnessed append decisions, 48 coverage labels and **1.1126 complete cases/s**. This same-host transport partition and same-UID research custody do not establish cross-machine fault coverage or independent production operator custody. Native races, actual RSS pressure, ProcessHost admission and a new external-sink shrink campaign remain open; the fixed 2M/s target fails. T3-03 remains in progress and the tracker stays **20/62**.

## Portable certificate check latency preflight — 2026-09-24

- Added a versioned, raw-sample NFR-05 preflight for a complete seven-obligation portable AST certificate check. The clean `5ce3447` campaign measured 200 checks on Apple M4 Pro: 1,903.583 µs median, 2,203.166 µs maximum, all above the unchanged 50 µs bound. The independent verifier checks source pins, certificate and sample verdict. This bounded fixture does not qualify NFR-05 for release; it stays unmeasured in the default inventory. [Evidence and limits](evidence/nfr05-proof-check-5ce3447/REVIEW.md).
- Strengthened the verifier to compare recorded Node/macOS/CPU/RAM identity with the exact-source environment. The clean `18efdf5` [second preflight](evidence/nfr05-proof-check-18efdf5/REVIEW.md) again misses: 1,790.375 µs median, 2,095.958 µs maximum, 200/200 above 50 µs. This remains bounded research evidence, not a release pass.
- Added a separate [raw stage profile](evidence/nfr05-stages-69577e5/REVIEW.md) at clean `69577e5`: full-call median 1,988.667 µs, independent derivation 961.458 µs and formula checking 453.375 µs on the bounded bundle. Stage samples overlap and are diagnostic; this does not change the release target or task count.

## Checked closure values in contract projection V15 — 2026-09-24

- Added `aether.executable-projection/15` for capability-free function values passed into contracts and straight-line factories with scalar block-local captures. The projector derives exact owner/lambda-root certificates, the parser recomputes the certificate set, and matched native runtimes refuse unmarked host closures and mutable captures before contract execution. [Bounded profile and trust limits](../../../roadmap/v4/research/projections/CHECKED-CLOSURE-VALUES.md).
- The valid-context audit retains branch-local captures, binder-bearing lambdas and passed lambdas with pure direct helper calls as reference-valid G1 gaps. Both direct `If` return arms are checked in V15. Current V15 token costs and FR-1.2's ≥4× changed-session requirement remain open; V4-T1-02 and Q03 status do not change.

## Combined signed living process campaign — 2026-09-24

- Added signed effect authorization `/3` with a separate signature and campaign-manifest domain for one explicit, opt-in worker `SIGKILL` after the local sink write and before the broker receipt. V2 signatures and fault modes remain unchanged. An exact generated case can be recovered only after dead-owner lock release and definitive sink reconciliation; unknown remains refused. V3 cannot mint a V2 local admission receipt. [Contract](LIVING-EFFECT-CAMPAIGN.md).
- [Clean-source T3-03 campaign](evidence/t303-integrated-82d88b6/REVIEW.md) at `82d88b6` executes the same signed effectful Aether candidate in real TCP workers across all 15 generated scheduler, quota, corrupted-frame and out-of-order cases: 15/15 passed, zero filters, 17 attempts including crash/retry/duplicate, 48 coverage labels. A signed broken root executes 15 cases, fails four lost-update schedules, and retains four shrunk replays. Complete rates are **12.7784 good cases/s** and **15.0576 broken original cases/s including shrinking/replay**, separately measured against the unchanged 2M/s target. G1 still lacks host partitions, native races/actual memory pressure and independent external sink/proof admission; G2 fails. The historical four-field JSON kernel pass does not qualify this full campaign. T3-03 stays in progress and the tracker stays **20/62**.

## Read-only closure contract projection V14 — 2026-09-24

- Added `aether.executable-projection/14` for inline capability-free contract lambdas and direct pure factories returning visible lambdas with scalar captures. A transitive static check refuses mutable/opaque captures, effectful or unknown targets, nonlocal writes and unsupported closure state. Actual TypeScript, Python and Rust execution, exact-root edits and imported-factory checks pass. [Profile and limits](../../../roadmap/v4/research/projections/READ-ONLY-CONTRACT-CLOSURES.md).
- A function-valued parameter and a factory with a captured block local remain valid in the reference runtime but are explicitly rejected by the native projection profile. V4-T1-02/G1 remains open. FR-1.2's measured cold/changed-session density misses and V4-Q03 are unchanged; no task count changes.

## Signed effectful living campaign and current-source T3-03 measurement — 2026-09-24

- Added an opt-in signed `LivingCampaign` `/2` path for arbitrary statically typed Aether modules within the declared scalar/record boundary. It binds the exact module root and scenario plan to signed execution and effect policies, routes effects through a per-case durable sandbox broker, persists seeded case and effect evidence, rechecks raw files at local admission, and rejects unknown post-dispatch outcomes or hidden precondition filters. The original pure `/1` path retains its denying router and wire bytes. [Contract and limits](LIVING-EFFECT-CAMPAIGN.md).
- [Exact-source signed campaign](evidence/t303-effect-4b5b7a7/REVIEW.md) at clean `4b5b7a7`: 5/5 declared/generated/executed/passed, zero filters, five committed effects, 13 coverage labels, **11.6202 complete cases/s**. [Process/socket refresh](evidence/t303-process-4b5b7a7/REVIEW.md) on the same source: 6/6 declared/generated/executed, zero filters, **2.6580 complete cases/s**. Both miss the unchanged 2M/s R04 threshold; the historical four-field JSON kernel pass does not qualify these full campaigns. The signed candidate is not yet integrated with real process faults/external sinks or a combined out-of-order/race/memory/corrupt-network profile. T3-03 remains in progress and the tracker stays **20/62**.

## Typed read-only contract projection V13 — 2026-09-24

- Added `aether.executable-projection/13` for direct composite and generic helpers and pure sequence map/fold callbacks in contracts. A transitive read-only check rejects pure-labeled helpers that mutate caller records, as well as effectful and indirect callees. Actual TypeScript, Python and Rust fixtures check exact roots, edits, pre/postconditions and adversarial refusals. Earlier named V11/V12 producers remain available. [Profile and limits](../../../roadmap/v4/research/projections/TYPED-CONTRACT-CALLS.md).
- A valid capability-free closure predicate still typechecks and runs in the reference interpreter but lacks an admitted native contract projection. V4-T1-02/G1 remains open. The historic AE6 cold and changed-session misses remain separate FR-1.2/Q03 obligations; no task status or threshold changes.

## T3-03 process and socket fault campaign — 2026-09-24

- Added a real loopback TCP and independent-worker extension to the living effect-broker campaign. The first worker is SIGKILLed after a durable sink write and before broker receipt; a fresh worker explicitly recovers the dead journal owner, reconciles, accepts a duplicate request, and replays terminal effects without live callbacks. Truncated and malformed socket frames do not dispatch. Stable logical IDs produce one sink write; attempt-derived IDs produce two.
- [Preregistered exact-source evidence](evidence/t303-process-aa7285c/REVIEW.md) at clean `aa7285c` executed 6/6 generated process/socket cases with zero filters. Good candidate 3/3 passed; faulty candidate 3/3 failed. Complete rate was 2.0224 cases/s against the unchanged 2M/s R04 threshold. T3-03 remains in progress because G2 fails and arbitrary effectful candidate admission, host partitions and broader schedules remain open. The tracker stays **20/62**.

## Cold-bound Agent-IR V6 and measured worker subject — 2026-09-24

- Added an opt-in Agent-IR V6 wire with full 256-bit root references and a checked one-literal edit. The unchanged ledger warm fixture now passes 4× on both pinned tokenizers, while cold and changed-session ratios miss. The clean [default release inventory](evidence/bench-fa2fc64/REVIEW.md) verifies 5.629× warm compression at `fa2fc64` and retains 15 unmeasured required NFR targets; representative FR-1.2 and Q03 remain open. [Protocol](AGENT-IR-V6.md).
- Added a host-side Artifact/4 validator that binds signed pure-candidate evidence to an independently rebuilt worker-bundle V2 manifest. This was initially host-only; the following init/3 slice enables one pure worker. ProcessHost and ProcessDeployment still reject Artifact/4, so T1-05 remains open. [Subject and limits](ARTIFACT4-SUBJECT.md).
- Added explicit Artifact/4 ProcessChannel init/3 and an independent child proof/byte check for one pure worker, with real-process execution, snapshot restart and tamper refusal. ProcessHost, ProcessDeployment, effects, and full executable custody remain open. [Worker profile and limits](ARTIFACT4-SUBJECT.md).
- Added opt-in Artifact/4 ProcessHost config/16 for a pure one-unit signed candidate: exact artifact/trust identity, durable snapshot/head reopen, signed-spec invalidation before call intent, and authorized replay after a real controller SIGKILL. Legacy ProcessDeployment factories are explicitly barred from injecting it; versioned governor deployment promotion remains open. [Host profile and limits](ARTIFACT4-SUBJECT.md).
- Added a separate pure Artifact/4 governor admission contract and versioned prepared/deployment journal schemas. The contract binds signed source/candidate, measured worker subject, archived wrapper, one-unit plan, snapshot ownership rebinding, no-effects approval, and independent witness identities. The virtual deployment journal uses a monotone operator CAS and restores a stale local mirror. A live governor ProcessDeployment driver and cross-commit crash campaign remain open. [Contract and limits](ARTIFACT4-SUBJECT.md).
- Added a separate one-way pure Artifact/4 PromotionDriver with strict-lineage governor admission, witnessed config/17 candidate preparation, a synchronous exact-source commit fence, and versioned `/2` deployment operation receipts. A process-external virtual witness namespace checks monotone preparation and invocation transitions. Real controller SIGKILL tests cover precommit abort and postcommit activation; the pure source host still has only local journal custody. [Deployment profile and limits](ARTIFACT4-SUBJECT.md).
- Hardened the pure Artifact/4 driver against caller mutation by capturing operator selections and cloning signed artifact, trust, topology plans and optional source seed. New witnessed deployment journal `/3` pins source/candidate plan digests, source seed, sealer-key commitment and recovery-authority identity on reopen; `/2` requires explicit migration and is refused by the live driver. The recovery callback remains a live operator policy under its stable identity. [Versioned deployment contract](ARTIFACT4-SUBJECT.md).
- Added an exact signed-source Artifact/4 worker init `/4` and separately witnessed ProcessHost config `/18`. Governor migration plan `/2` and prepared record `/2` bind the source host configuration, witness revision and complete journal, plan, signed source intent, snapshot/state head and operation inventory. The source-host writer ticket covers the synchronous governor commit decision; an out-of-band source call after prepare blocks commit and leaves serving refused until reconciled. Clean source reopen does not create no-op witness revisions; actual calls and crash recovery still advance the witness. Historical config/16/17 and legacy Artifact/1–2 remain separate. [Source witness and limits](ARTIFACT4-SUBJECT.md).
- Added opt-in witnessed Artifact/4 ProcessHost config/17 with an independent complete host-journal CAS, exact trust/artifact/witness identity, and separate-service precommit replay and postcommit reopen after controller crashes. Config/16 retains its historical local identity. Same-UID witness custody, governor deployment admission and effectful dispatch remain open. [Host profile and limits](ARTIFACT4-SUBJECT.md).
- Extended same-UID V11 resource-scoped controller crash and signed-fence tests through predispatch, postcommit, noncommit recovery and cached target revocation. The full effect-path matrix and independent external sink custody remain open. [Bounded evidence](evidence/v11-resource-crash-fence/REVIEW.md).
- Strict lineage reopen now checks exact physical AST leases for every signed spec, intent and admitted artifact before permitting another admission. A missing role pin cannot be masked by another lease holding the bytes. Historical audit pins remain nonexpiring; [scope and recovery](LINEAGE-AUDIT-RETENTION.md).

## Checked virtual forwarding and semantic retention expansion — 2026-09-24

- Added an exact one-wrapper candidate builder and independently checked descriptor `/1`. Reference execution preserves the archived call frame and finite AST-step observations; compiled execution retains its host guard boundary; the opt-in resumable profile binds the descriptor and archived declaration in its program identity and restores source bytecode. It still executes the wrapper physically. [D16](decisions/D16-checked-virtual-forward-reference.md), [D17](decisions/D17-virtual-forward-resumable.md).
- Added evidence policy `/3`: the checked rewritten call sites contribute archived-wrapper dependency edges to the exact candidate manifest. Strict causal lineage now pins that dependency under a signed candidate intent, and a test reopens it after collection. This is a signed local evidence closure, not permission for semantic-GC promotion. Legacy `/1` proposals remain blocked by D14. [D18](decisions/D18-virtual-forward-evidence-closure.md).
- Added a separate V2 one-wrapper local GC proposal that binds signed source/candidate manifests, descriptor, trusted exports and retention snapshot into governor plans. It recompiles the pure resumable candidate, stages the exact local AST head, and recovers only the persisted proposal ID. An adversarial review led to caller-options snapshots and wrong-head retry refusal. This does not carry a measured executable or descriptor to ProcessHost/broker, does not cover effectful modules, and cannot protect the public local head against a later unrelated writer. [Bounded profile and limits](VIRTUAL-GC-V2.md).
- Added a separate Artifact `/3` codec for a pure virtual-forward process subject. It rechecks canonical source/candidate IR, descriptor, archived declaration, V2/V3 signed evidence and direct source-intent parentage, and remeasures current Node, selected bundle and declared source bytes. Live ProcessDeployment still rejects Artifact `/3`; the declared source list is not a complete transitive executable measurement or worker launch. [Boundary and limits](PROCESS-ARTIFACT-V3.md), [exact-source checkpoint](evidence/integration-2c9aa41/REVIEW.md).
- Added a separate pure worker init `/2`: parent and child independently reopen the signed source/candidate Artifact `/3`, verify the measured launched file and compile the checked virtual call sites locally. Legacy worker init is unchanged. A deterministic esbuild `0.28.2` recipe emits a closed single-file JS bundle with exact input/tool hashes; a real test launches that rebuilt bundle via Artifact `/3`. The V2 measurement also hashes transitive non-system Mach-O static libraries. System-cache member bytes, dynamic loads and live deployment custody remain outside this profile, and Artifact `/3` does not yet require the closure manifest. [Worker contract](PROCESS-VIRTUAL-WORKER.md), [JS integration checkpoint](evidence/integration-d4abb3d/REVIEW.md), [current native/static evidence](evidence/integration-085b587/REVIEW.md).
- Added a bounded append-only active-task retention release `/2` after an independently witnessed terminal ProcessHost checkpoint, preserving replay pins and V1 history. D19 defines the explicit verifier/journal API; D20 wires one qualified host profile. Full G2 release remains open. [Decision D19](decisions/D19-process-active-retention-release.md).
- Added [D20 opt-in ProcessHost config `/15`](decisions/D20-witnessed-process-active-release.md) for the qualified V9 host-witness profile. It releases active-task role pins only after a witnessed committed checkpoint and reconciles interrupted release on fresh reopen. Replay pins remain live. Existing host profiles keep their original bytes; signed-sink V13 and other lifecycle releases remain unqualified.
- Refreshed [exact-source v4 release inventory](evidence/bench-3099734/REVIEW.md) at clean `3099734`: actual tokenizer warm-message compression remains **1.8613×** against **4×**, and 17 required targets fail or lack qualifying measurements. Independent sample/source verification passes; release eligibility remains false.
- Added opt-in direct checkpoint journal `/2` replay pins, direct active-task pins before the first frame, and versioned tree-workspace configuration `/2` with unstable-replication pins before frame publication. Adapter/sink retirement analyzes retained modules with their exact dependency declarations. These monotone profiles protect the bounded lifecycles; safe release, all producers and full G2 remain open. [Direct replay retention](DIRECT-CHECKPOINT-RETENTION.md), [direct active-task retention](DIRECT-ACTIVE-TASK-RETENTION.md), [replication retention](REPLICATION-SEMANTIC-RETENTION.md).
- Focused combined `4e21063` evidence passed 86/86 plus build/typecheck/roadmap checks before evidence policy `/3` and the later active/replication slices. Current-source integration evidence and release benchmark qualification remain pending. The tracker stays **20/62**.

## Governor-admitted signed sink adapter retirement — 2026-09-24

- Added versioned signed effect policy `/7`, declarative attested sink table `/2`, and independent retirement proof `/2`. Artifact `/2` embeds all three, with complete current broker adapter-map admission; old artifact/policy/table bytes remain explicit. Strict-lineage ProcessDeployment `/12` and ProcessHost V13 bind the live table to governor approval, operator signer/clock/sink witnesses and a retention-fenced durable commit. Historical predecessor Artifact `/2` remains available for exact receipt inspection but cannot dispatch new calls.
- A direct V12 campaign passes 4/4 across real workers, signed sink outcomes, retirement, stale-epoch administrative restart, retained predecessor receipts and a late task pin. A separate-process 2/2 campaign uses sink and witness services and real controller SIGKILL before/after governor commit, with fresh recovery and custody outage/rollback refusal. [Decision and trust limits](decisions/D15-signed-sink-adapter-retirement.md).
- This covers one signed sink registration profile, not general adapter execution, distinct-UID custody, full active-task/replay retention release, or fuel-equivalent wrapper collapse. T1-05/T2-04 remain open and the tracker stays **20/62**.
- [Exact-source checkpoint](evidence/integration-c8d3de3/REVIEW.md) at `c8d3de3`: **1,047/1,048** serial full-suite tests pass with one existing skip; V12 direct and real-process campaigns pass 6/6; historical host, V2 proof, V7 policy/table, broker-map, witness and governor focused runs pass. Build, typecheck, roadmaps and package dry run pass. Exact-source benchmark verification succeeds for the still-failed release result: 1.861× warm-message compression and 17 unmet required targets.

## Semantic GC fuel and retention safety — 2026-09-24

- A tight `maxSteps` campaign found that old branch flattening could make an effect execute when the source would have exhausted its step budget. Added a versioned fuel-preserving branch profile that removes only the proved cold arm while keeping the executed guard and arm; new promotion of historical step-changing branch/wrapper/shim proposals is denied before a governor decision. Historical committed decisions remain recoverable.
- Adapter candidate retirement now holds the retention lock through its final recheck and durable table publication, with a real concurrent task-pin regression. TreeWorkspace pins incoming content before frame publication and reconciles current epoch roots on reopen; missing content fails closed. [Decision and remaining gates](decisions/D14-semantic-gc-fuel-and-retention.md).
- `npm test` now runs files serially. The prior two full-suite runs remain failed diagnostic evidence; their isolated reruns did not substitute for a complete passing run. T1-05 remains open and the tracker stays **20/62**.
- [Exact-source checkpoint](evidence/integration-9e092d9/REVIEW.md) at `9e092d9`: the complete serial suite passes **1,020/1,021** with one existing skip, and focused semantic GC, adapter retention and tree recovery suites pass 38/38, 9/9 and 19/19. Build, typecheck, roadmap checks and package dry run pass. Exact-source benchmark verification succeeds for the still-failed release result: 1.861× warm-message compression and 17 unmet required targets.

## Witnessed budgeted sink through direct ProcessHost — 2026-09-24

- Added opt-in V5 budget broker and direct ProcessHost config `/11`. An operator predeclares the exact signed target, effect request and reservation before host construction. The host checks the worker's actual request before accepting its proposed snapshot; broker, bridge, ledger and sink witness bind the same request and fixed charge. Signed noncommit permits refund, while unknown status keeps funds encumbered.
- Complete bridge and ledger journals use separately held monotonic witness heads. The effect witness accepts journal `/5`, pins the bridge profile, and rejects a forged profile change. Direct host tests pass charge-once, retry/reopen, pre-reserve denial, signed-fence refund and sink-witness outage refusal. The ledger evidence-policy digest is checked at host admission.
- This is a bounded same-UID fixed-charge profile. Deployed promotion, full effect path coverage, general metering, distinct-UID custody and independently validated witness transitions remain open. T2-04/T2-05 and the **20/62** task count are unchanged. [Decision and limits](decisions/D12-signed-sink-budget-evidence.md).
- [Exact-source checkpoint](evidence/integration-cc9347c/REVIEW.md) at `cc9347c`: focused direct host, authority, historical host and witness tests pass; build/typecheck/roadmap checks pass. The full suite is **not green** (6 failures at default concurrency, 5 at concurrency 2); all five limited-run failures pass in isolated file reruns. Benchmark verification passes for the retained failed release result: 1.861× warm-message compression and 17 unmet required targets.

## Witnessed native fallback host transaction — 2026-09-24

- Added opt-in ProcessHost config `/10` and witnessed host journal `/5` for the exact pure one-field Int fallback. The native operation binds the source snapshot/head, generation, arguments, checked record proof, compiler profile and operator-pinned executable digest; an intent is witnessed before launch. The host publishes the native candidate, receipt and state head together, and same-ID retry reads the exact terminal result.
- The native runner independently regenerates proof-bearing source, checks packaged driver bytes, rebuilds with fixed Clang flags, compares both selected and rebuilt executable bytes to the binding, then executes only the rebuilt private copy. It checks the full result/state against independent contract-enforcing Aether execution. A swapped executable or malformed result cannot publish state.
- Focused v5 witness/runner/host tests pass 13/13 across alias commit, distinct Tier 3 rollback, denial, revocation, binary substitution, witness outage, controller close, older local state, malformed journal fields and real pre/postcommit controller SIGKILL. Recovery requires fresh grants and explicit authorization. The profile still trusts the toolchain, OS and controller UID and excludes native effects and general values; FR-3.7 ≤50 ns and T3-07 remain open. [Decision and limits](decisions/D13-native-fallback-host-transaction.md).

- [Exact-source checkpoint](evidence/integration-238de20/REVIEW.md) at `238de20`: 996/997 tests pass with one existing opt-in skip; 13/13 focused v5 witness/runner/host checks and build/typecheck/roadmap checks pass. The packaged driver is retained. Release benchmark enforcement remains failed at 1.861× warm-message compression and 17 failed or unmeasured required targets.

## Bounded record proof and native host binding — 2026-09-24

- Added a portable certificate checker for the selected one-field Int record Tier 2. It rederives obligations from the exact full AST/manifest, proves signed-i64 arithmetic, one bounded allocation, total return and frame preservation for alias and distinct-reference cases, and checks the precise postcondition condition for distinct inputs. Changed declarations, incomplete/forged proofs, unsupported syntax and possible overflow fail closed.
- Added proof-bearing native lowering that embeds the checked certificate and compiler-profile digests in executable bytes. A versioned native binding pins the actual ProcessHost source snapshot/head, generation, two tier symbols, checked proof and artifact hashes. A real host-state comparison matches native outcomes to durable worker results for alias and distinct inputs. Focused proof/native/host tests pass 10/10.
- The binding is a checked admission subject, not a host publication. The versioned witnessed host transaction, combined native effects, full values and FR-3.7 ≤50 ns qualification remain open. T3-07 and 20/62 status do not change. [Decision and limits](decisions/D13-native-fallback-host-transaction.md).

- [Exact-source checkpoint](evidence/integration-549ed6f/REVIEW.md) at `549ed6f`: 983/984 tests pass with one existing opt-in skip, 10/10 focused proof/native/host checks, and passing build/typecheck/roadmap checks. The benchmark remains ineligible at 1.861× warm-message compression with 17 required targets failed or unmeasured.

## Native snapshot bridge and signed fallback crash recovery — 2026-09-24

- Added a real-controller SIGKILL test after a separately witnessed signed sink commit and before the fallback terminal receipt. A fresh controller reopens the same signed V8 host and proved Tier 2 profile, returns the original Tier 1 result, and observes one sink decision and no Tier 2 host operation.
- Added a bounded native driver path fed by a validated `RuntimeSnapshotV1` projection with exact manifest, reference ownership, aliases and allocation capacity. Fourteen snapshot-fed native/reference cases match; stale references, malformed frames and binary-byte substitution are refused. The native path is still separate from ProcessHost admission and does not cover full values/effects or portable proof.
- A reproducible local clock probe shows 125/3 ns Mach ticks and the same effective ~41.667 ns cadence from the nanosecond clock APIs and ordered virtual counter. The prior one-tick observed switch maximum remains inconclusive for FR-3.7's ≤50 ns hard maximum. No target or task status changed. [Native research and limits](../../../roadmap/v4/research/native-fallback-ast/README.md).

- [Exact-source checkpoint](evidence/integration-0bbabae/REVIEW.md) at `0bbabae`: 976/977 tests pass with one existing opt-in skip; build, typecheck and both roadmap checks pass. The release benchmark remains ineligible at 1.861× warm-message compression with 17 failed or unmeasured required targets. The local clock probe qualifies resolution only.

## Signed sink fallback and terminal authority checks — 2026-09-24

- Exercised V2 fallback against a witnessed V8 ProcessHost and separate signed `/2` sink/witness processes. A signed Tier 1 commit is returned once across reopen; a signed noncommit fence allows independently proved pure Tier 2; outage prevents fallback until witnessed status is available. The focused signed-sink and process-fallback tests pass 28/28.
- The supervisor now rechecks authority after the host result and before its own receipt, refuses a terminal abort that conflicts with a later successful or unresolved host operation under the same tier identity, and checks the original host snapshot at terminal publication. Revocation, alias and concurrent-writer regressions pass.
- These are bounded same-UID process results. Native active-frame lowering, portable native proof, distinct-UID custody, full combined crash recovery and the FR-3.7 ≤50 ns hard maximum remain open. The task count stays 20/62. [Research and limits](../../../roadmap/v4/research/process-fallback/README.md).
- [Exact-source checkpoint](evidence/integration-8b92d14/REVIEW.md) at `8b92d14`: 974/975 tests pass with one existing opt-in skip; build, typecheck and both roadmap checks pass. The exact-source benchmark remains ineligible with 1.861× warm-message compression and 17 required targets failed or unmeasured.

## Bounded signed sink budget settlement — 2026-09-24

- Added a helper that checks fixed-charge settlement against the exact signed `/2` sink witness head and full operator-pinned effect requests. It supplies bridge observations and ledger settlement verification. Its stable policy digest binds trust roots, charge and request inventory into opt-in ledger identity.
- A real sink/broker test covers one charge after witnessed commit, cached/reopened idempotence, signed-fence refund, early and late witness outage, retained encumbrance and recovery. Focused helper, broker and historical bridge tests pass 18/18. This remains broker-level fixed-charge evidence; V11 host admission, measured usage, independent budget-journal custody and complete T2-04/T2-05 gates remain open. [Decision and limits](decisions/D12-signed-sink-budget-evidence.md).
- [Exact-source checkpoint](evidence/integration-9cf54e4/REVIEW.md) at `9cf54e4`: 967/968 tests pass with one existing opt-in skip; build, typecheck and both roadmap checks pass. The release benchmark remains ineligible at 1.861× warm-message compression with 17 required targets failed or unmeasured. T3-07 is the next complete-task target; FR-3.7's in-frame 50 ns requirement remains part of that closure.

## Opt-in V11 resource-scoped sink profile — 2026-09-24

- Added signed external sink policy `/6`, host configuration `/9`, deployment state `/11`, prepared `/9` and effect plan `/9`. One bounded tagged string argument selects a signed target path segment. The concrete path is checked against the original scoped grant before the proposed worker snapshot or effect intent is published and again before dispatch. Grant reference `/2` binds its path digest into the broker's signed request. V5/V10 sink-wide and earlier bytes remain explicit.
- Added fresh-controller V11 postcommit recovery with the exact retained target and one sink decision, including recovery after the original grant was revoked. An adversarial review found that cached V11 results could bypass target scope. Direct, deployed and cross-generation cached paths now recheck every retained effect target against the caller's current-generation grant before returning a result; an Alice grant cannot read Bob's saved result.
- The profile still selects only one string segment and does not prove a third-party sink's resource semantics or measured adapter executable, distinct-UID custody, complete budget settlement, or atomic revocation/result publication. V4-T2-04, NFR-16 and the 20/62 task count remain open. [Decision and limits](decisions/D11-resource-scoped-sink-profile.md).
- [Exact-source checkpoint](evidence/integration-fed67f5/REVIEW.md) at `fed67f5`: 960/961 tests pass with one existing opt-in skip; build, typecheck and both roadmap checks pass. The exact-source benchmark remains ineligible with 1.861× warm-message compression and 17 required targets failed or unmeasured.

## Opt-in authenticated sink receipt and V3 broker — 2026-09-23

- Added a domain-separated Ed25519 sink receipt bound to the exact effect request, deployment, approved adapter artifact, grant/policy context and committed value or durable noncommit fence. A trusted wrapper and separate sink fixture verify and retain signed decisions; cross-deployment reuse of one logical effect ID conflicts rather than committing twice.
- Added witnessed broker journal `/3` with operator-pinned sink anchor and exact signed receipt per terminal post-dispatch event. Broker dispatch, reconciliation, cached reads and replay reverify the proof; historical V1/V2 journal bytes remain explicit. A real controller SIGKILL after sink commit but before broker terminal publication reconciles through signed status without another sink decision. Near-limit committed responses remain retrievable after restart.
- This is broker-level and same-UID fixture evidence. ProcessHost/Deployment admission, independent sink custody, general effectful adapters and a real third-party transaction are still required. T2-04/NFR-16 and the task count do not change. [Decision and limits](decisions/D09-authenticated-sink-outcomes.md).
- [Exact-source checkpoint](evidence/integration-2d6662c/REVIEW.md) at `2d6662c`: 932/933 tests pass with one opt-in skip; 22/22 focused sink tests pass. Benchmark verification confirms the unchanged failed 1.861× warm-message ratio and 17 failed/unmeasured required targets. The sink ledger still needs an independently witnessed monotonic head before rollback resistance can be claimed.

## V12 blockless binding semantics — 2026-09-23

- Added executable projection V12 for direct `Let` under `If`, `While` and `Atomic`. Scoped slots preserve branch selection, loop rebinding, temporary locals and reads/writes that fall back to an outer binding before a shadowing `Let` executes. Exact-root and import-closure checks pass; actual TypeScript, Python and Rust executions match the reference cases.
- The projection suite passes 92/92; 18 earlier V2/V7/V10/V11 and auto source/runtime outputs remain byte-identical against the prior source. Other valid cross-feature combinations and FR-1.2's unchanged 4× token target remain open; T1-02/Q03 status does not change.

## Process-external witness and controller crash campaign — 2026-09-23

- Added an operator-run Unix socket witness service with authenticated bounded frames, namespace-scoped identities, durable atomic CAS and exact readback for V9 effect, host and deployment heads. It refuses authenticated attempts to remove retained broker effects, host effects or outer invocation records. A second live service is refused; service SIGKILL/restart recovers the exact heads. A controlled-close race was found in review and fixed.
- Added real V9 ProcessHost and ProcessDeployment integration against the separate service. During service outage, reads fail closed; after restart, fresh witness objects reopen cached calls without broker redispatch. A separate controller SIGKILL after a committed read-only Wasm effect is recovered by a new controller, which refuses safe abort and records one guest dispatch.
- Expanded signed V9 direct/deployed grant refusals under the full host/broker path. Added a native peer-credential gateway using `getpeereid` on macOS, and routed real V9 host/deployment witness traffic through it. Service, gateway and controllers were tested under one UID; neither distinct-UID custody nor authenticated external sink results is qualified. T2-04, NFR-16 and the verified-task count remain open.
- [Exact-source checkpoint](evidence/integration-dc5de9d/REVIEW.md) at `dc5de9d`: 910/911 tests pass with one opt-in skip; 92/92 projection, 2/2 service, 2/2 peer and 3/3 V9 integration tests pass. Benchmark verification confirms a failed 1.861× warm-message ratio and 17 required targets failed or unmeasured. No task gate is closed by this checkpoint.

## V11 contract calls and V9 complete journal witnesses — 2026-09-23

- Added executable projection V11 for synthesized, closed, pure scalar helpers called directly inside contracts, including `old(Call(...))`, transitive helpers and exact-address imports. Actual TS/Python/Rust execution and exact-root round trips pass; older V2/V7/V10 fixture bytes are unchanged. Blockless bindings and the 4× token requirement remain open, so T1-02 and Q03 do not close.
- Added opt-in V9 complete host and deployment journal witnesses with a namespaced V2 per-effect witness. A reviewed V8 host omission could discard the only local effect inventory while the broker still recorded a commit; a reviewed outer registry omission after promotion could permit operation-ID reuse. V9 binds full canonical journals to separate operator CAS heads and refuses those omissions before cached results or redispatch. The V2 effect identity prevents cross-deployment reuse of one operation head.
- Direct and deployed real Wasm tests cover signed promotion, reopen, omission, stale/changed witness selection, lost CAS acknowledgment and historical profile refusal. Witness fixtures are in-memory and same-process; OS-separated custody, authenticated sink status, independent replay witnessing and full containment remain open. T2-04/NFR-16 and the verified-task count stay unchanged.
- [Exact-source checkpoint](evidence/integration-65d06e5/REVIEW.md) at `65d06e5`: 900/901 tests pass with one opt-in skip; build, typecheck and both roadmap checks pass. The independently verified release benchmark remains ineligible with a 1.861× complete warm-message ratio and 17 required targets failed or unmeasured.

## AE5 exact-base warm-reference research — 2026-09-23

- Added an opt-in root-bound reference for unchanged FunctionDecl members of a paid cold module. A fresh process reconstructs from the complete cold wire; changed declarations and stale/noncanonical references are refused.
- At clean source `b799b38`, actual-token ledger warm ratios are 4.716× cl100k and 4.903× o200k for four declarations. Cold ratios are 0.941×/0.952× and complete changed-session ratios are 1.110×/1.125×. This is a warm-only research pass, not FR-1.2, Q03, T1-02 or release qualification. The full source suite passed 877/878 tests with one existing opt-in skip.
- The 20/62 verified task count stays unchanged. Further density work must improve changed messages and the paid cold boundary; complete task closure takes priority over accumulating partial probes.

## Executable projection V10 and all-kind audit — 2026-09-23

- Added `aether.executable-projection/10` for valid `old(…)` expressions around quantifier and Result binders. TS/Python/Rust source keeps outer values in the pre-state while local binders remain local. V9 source/runtime/dependency bytes matched the pre-V10 commit.
- Added actual target-language and reference-runtime tests for nested old binders, plus a 45/45 AST-kind, 36-bundle exact-root round-trip audit and real execution of the five previously absent kinds. Unbound type variables fail explicitly.
- T1-02 remains in progress. FR-1.2 itself requires ≥4× token compression; the comparable campaign still measures 0.483× cl100k / 0.489× o200k cold ratios. Representative kind coverage and the separate V9 token report do not satisfy that requirement, and no threshold changed.

## Executable projection V9 null-body support — 2026-09-23

- Added `aether.executable-projection/9` for unsynthesized function declarations. TS/Python/Rust source and runtime explicitly trap on a call, while round-tripping `body: null`, exact contract and imported dependency identity. V8 source/runtime/dependency bytes matched the pre-V9 commit in all three targets.
- A clean-source `80a37c9` corpus retained actual cl100k/o200k counts over full JSON role/content source/runtime messages, including exact-address dependencies. The report is a cost record, not a 4× release comparison. T1-02 and Q03 remain open; no target changed.

## AST-derived native fallback campaign — 2026-09-23

- Added a bounded native compiler that derives both tier bodies and contract checks from the exact Aether fallback AST. One C call frame restores aliased record state and allocator before entering Tier 2. A source edit changes the root, generated source, binary and result; 14 native/reference cases match.
- A preregistered Apple M4 Pro campaign at clean source `9f7d5cf` retained 10,000 individual samples and an independent rebuild/recount. The switch bracket's observed maximum was 41.667 ns with zero samples over 50 ns, but timer resolution is 41.667 ns, so the result is **inconclusive**. The full-call maximum was 83.333 ns. No release threshold or T3-07 status changed.
- General values/effects, proof admission, durable host handoff and a qualified hard-maximum timing method remain open.

## Proved process fallback V2 — 2026-09-23

- Added opt-in process fallback profile `/2` and journal `/2`. An effectful Tier 1 may fall back to an independently proved pure scalar Tier 2 with the same exact contract and a proof digest in the durable profile. V1 histories remain explicit.
- Opt-in authorized `reconcileBroker: true` recovery reads the original exact request, checks host arguments/context, releases only a confirmed dead writer ticket, and reconciles before worker replay. V1 historical manual reconciliation is unchanged. The V2 supervisor keeps unknown effects blocked, replays committed effects without redispatch, and starts Tier 2 only after a trusted adapter reports definitive noncommit.
- Real-process SIGKILL tests cover committed, definitive-noncommit and unknown sink outcomes, proof mismatch and revoked Tier 2 authority. The local adapter is trusted; remote sink attestation, general proofs, native in-frame lowering and the 50 ns release limit remain open. T3-07 is still in progress.

## Opt-in operator witness catalog profile — 2026-09-23

- Added `scoped-anchored-wasm-v8` and `isolated-wasm-v6-witnessed`. Operator-supplied catalog identity is bound into deployment `/8`, prepared `/6`, host configuration `/6` and effect plan `/6`; the exact per-operation witness is checked before broker use. V7 histories retain their original formats and clock-only authority.
- The real-worker V8 campaign exposed a deployment settled-receipt shortcut that bypassed host/broker inspection. Settled deployment results now recheck the inner host on retry, recovery, initial response and reopen. Wrong witness, wrong catalog, replaceable broker methods, factory-supplied catalog and V7 adoption are refused; signed promotion and reopen pass.
- The test witness remains in-process, and external sink status, hostile-factory confinement and independently witnessed replay remain open. T2-04 and NFR-16 are not verified.

## Signed Wasm host-cache broker comparison — 2026-09-23

- Signed V4 Wasm ProcessHost now reconstructs the exact historical broker request and compares terminal effects through a nonvirtual, read-only broker inspection path. It applies on reopen, same-ID retries, public cached result/disposition reads, worker replay and recovery. Missing or mismatched broker outcomes refuse cached publication.
- A real worker fixture uses witnessed V2 journals and demonstrates fail-closed forged-local-journal reads on retry, recovery and reopen, plus restoration after local deletion. In-memory witness custody and the factory's broker selection are still trusted; no T2-04 or NFR-16 gate closes.

## Opt-in witnessed effect journal — 2026-09-23

- Added `aether.effect-journal/2` with a separately supplied complete-journal witness and a revision on every transition. Witness CAS precedes local publication and sink entry; reopen restores missing/older local bytes and refuses divergent same-revision bytes or witness rollback during the anchor lifetime. V1 histories remain explicit and byte-preserved.
- Focused tests exercise forged local terminal receipts, deletion, rollback, uncertain witness acknowledgment after the dispatch marker, wrong witness identity and V1/V2 adoption refusal. The in-memory test provider is not independent production custody. Host cache, replay, external sink attestation and OS-separated witness service remain open, so T2-04 and NFR-16 do not close.

## Active gate visibility — 2026-09-23

- The generated tracker now distinguishes seven active tasks with verified prerequisites from unstarted tasks that are ready. Its former “Ready now: none” label hid active work.
- Added a gate dependency ledger for the seven active tasks, with bounded evidence, remaining acceptance work and downstream dependencies. T2-04 broker receipt/host-cache integrity and T3-07 full fallback closure are made explicit. The task count remains 20/62; no acceptance or release threshold changed.

## Opt-in independently clocked Wasm authority — 2026-09-23

- Added `scoped-anchored-wasm-v7` with operator-provisioned trusted clock anchor `/1`, deployment `/7`, prepared `/5`, host configuration `/5` and effect plan `/5`. Signed V4 policy rules must use the anchor's clock domain. V6 remains byte-preserved under its explicit trusted-factory-clock model.
- The host checks independent grant lifetime at issue/entry/nested/effect boundaries and signed deadline before router creation. A nonvirtual broker path rechecks both after factory authorization and before sink entry. A real ProcessHost/ProcessDeployment test holds factory clocks frozen while independent time advances; expired grants and deadlines refuse new guests/sinks, including after promotion/reopen. The external provider must prevent rollback across restarts; general adapter isolation and T2-04 remain open.
- Corrected the broker's terminal pre-sink refusal path to persist an explicit no-dispatch transition after a durable dispatch marker. A crash before that terminal record remains indeterminate; no effect is blindly retried.
- Retained an independently verified 59-case capability campaign at exact source `c07e4aa`, with 57 zero-sink/unchanged-heap denials and two positive controls across local topology, workers, broker and deployment. It does not cover signed adapter deployment effects, cross-process closure transport or formal noninterference; T2-04 stays open.

## Verified native run control and AST-derived EL1 guest — 2026-09-23

- New `aether.process-packed-control/2` binds the native operation-list digest and requires a private in-process proof of the actual hash-checked binary run before ProcessHost publishes a packed correction. The runtime event subject v2 binds the operation, artifact, executable and plan identities; reopen recomputes it. New V1 control admission is refused while historical V1 audit remains readable. The runner executes a private copy of verified binary bytes; arbitrary callbacks and hash-checked shell scripts cannot publish a V2 candidate. Native code is still unsandboxed and no hardware attestation is claimed.
- A source-pinned research compiler derives freestanding AArch64 EL1 code from a pure Tier 1 AST subset. An independent verifier rebuilt 57 real guest/reference comparisons and source-edit changes. The bounded fresh-guest maximum was 0.786 ms with 65,536 B observed backing; full runtime boot, memory and native lowering gates remain open.

## Fused native row reader and durable packed ProcessHost control — 2026-09-23

- The checked C ABI now has a fused bounded-row reader. A preregistered Apple M4 Pro campaign pins unchanged locality fixtures, 504 raw samples, exhaustive reference-code checks and sanitizer results. It is 1.92–3.62× faster than the old checked ABI, yet slower than native pointers in 16 of 18 patterns; G2 and release targets remain open.
- Added `aether.process-packed-control/1` under the exclusive ProcessHost checkpoint lease. The request binds exact source, layout, candidate, artifact and executable identities; the layout is stored in an fsynced content-addressed sidecar. Reopen reconstructs the candidate from logical state and checks the one-event subject. Actual C execution, same-ID retry, pre/post-decision SIGKILL, reopen and production worker publication pass focused tests. The native executor remains a trusted callback, so external native attestation and full T3-10 remain open.
- Packed corrections now typecheck touched records, rejecting an in-bounds reference to a record of the wrong declared type. The runtime typed boundary checks record-name identity consistently with the language type relation.

## Native packed candidate handoff and C string ABI — 2026-09-23

- The compiled C process bridge now reads and compares bounded UTF-8 dictionary strings from authenticated `/2` packed checkpoints. Its `/1` textual frame remains unchanged; `/2` adds checked dictionary offsets, UTF-8 validation, field bounds and exact differential output. A source-pinned campaign retains 256 string operations and 30 process round trips. It does not measure guest boot.
- `ResumableRuntime.commitPackedCandidate` now validates exact source snapshot, layout and logical row identities, obtains candidate-specific trusted authorization, and publishes all changed fields in one reversible host event. Checkpoint replay checks the event's row identities and versions. A real C `/1` candidate passes this handoff and survives restore/rewind. Durable ProcessHost publication and full T3-10 remain open.
- The preregistered Apple M4 Pro native locality comparison retained 61,440 mapped records and 378 raw trials across three link distributions and three access patterns. Allocation shrank 11.9–14.4%, but checked packed reads were 3.36–9.27× slower and a prevalidated fast reader was 1.40–3.11× slower than the pointer baseline. T3-10 is marked in progress; G2 and release performance remain open.

## V8 nested imports and packed string guest — 2026-09-23

- V8 native projections resolve exact-address imports inside nested modules, including transitive dependencies, and parse/execute the resulting TypeScript, Python and Rust bundles. Campaign 13 retains complete dependency messages and actual tokenizer counts; its 0.483×/0.489× cold ratios miss the unchanged 4× goal. T1-02 remains open.
- The real EL1 packed guest now reads and compares bounded UTF-8 dictionary strings from `/2` checkpoint images, preserving `/1` frame bytes. The source-pinned 1,000-fresh-guest string campaign has a 41.667 µs median but a **1.364 ms maximum**, so the bounded 1 ms maximum gate fails. Full runtime boot and memory qualification remain open.

## Authenticated fresh-guest campaign — 2026-09-23

- Coalesced guest RW mappings and retained a preregistered 1,000-sample campaign in one running Hypervisor.framework controller. Every sample creates a fresh EL1 guest and executes a validated packed checkpoint plan. The bounded maximum is 181.125 µs under the approved guest-start boundary; the full runtime boot and peak resident-memory release gates remain open.

## Generic continuations and packed strings — 2026-09-23

- V7 native projections now round-trip and execute bounded generic Lambda/Spawn continuations in TypeScript, Python and Rust. A retained Rust type witness survives a factory return. Campaign 12 recomputes actual-token totals and still misses 4×; T1-02 remains open.
- Packed heap `/2` adds bounded UTF-8 dictionary fields, string mutation and resumable checkpoint migration. `/1` images remain byte-preserved. Three preregistered complete-image size cases pass their exact rerun; native process and guest bridges refuse strings until their ABIs expand. T3-10 remains open.

## Closed call-bearing semantic GC shims — 2026-09-23

- Added an opt-in V2 scalar-shim profile that expands only closed, pure, syntactically total helper calls before portable equivalence proof. It retains call-site argument evaluation and rejects partial arguments that expansion could erase. V1 proposal/profile bytes remain unchanged. Signed promotion and rollback pass focused tests; general semantic GC remains open.

## Opt-in V6 isolated Wasm capability profile — 2026-09-23

- Added adapter artifact `/3`, signed read-only Wasm effect policy `/4`, an external signer anchored host configuration `/4`, and an explicit `scoped-anchored-wasm-v6` deployment with `/6` state, `/4` prepared/effect-plan identities. The former V5 default and historical bytes remain unchanged.
- A real ProcessDeployment now checks the admitted adapter before readiness, serves one-argument i32 Wasm effects through actual workers and the durable broker, survives reopen and signed promotion, and refuses wrong context, capability, artifact, grants, epochs and malformed inputs. Trapped read-only guests have authorized reconciliation and safe abort paths.
- The profile remains narrow. Broker storage, parent factory and clock behavior are trusted; full object-capability containment and the NFR-16 release assurance gate remain open. See [profile and recovery contract](ISOLATED-WASM-PROFILE.md).

## Authenticated packed checkpoint to native process bridge — 2026-09-23

- A bounded research bridge validates a real resumable checkpoint and exact native executable, compares C packed-value operations against the host model, and revalidates the returned heap image. Source-pinned evidence reruns 768 seeded operations across six local/wide-reference and overflow-policy combinations. Candidate mutations still require durable host corrections; actual guest integration and T3-10 qualification remain open.

## Portable conservative fallback proof profile — 2026-09-23

- Added an opt-in, independently checked portable certificate for a closed scalar Tier 2 declaration. Its proof manifest must match the fallback execution context except for the standalone AST root; the proof digest is bound into the durable fallback profile. The remaining effectful/record/native paths are not proved or production authorized.

## Process fallback and packed heap candidates — 2026-09-23

- Added an opt-in effect-aware ProcessHost fallback supervisor with durable signed operation state, current grants, pre-effect abort, exact host replay and a repair outbox. Possible external commits block automatic Tier 2 selection. Portable proof admission and the 50 ns limit remain open.
- Retained a clean-source packed-heap measurement repeat and 26 native ABI checks. The bounded full image shrinks about 31–32%, while JavaScript traversal regresses 61–94×. Native guest integration and the complete value domain remain open.

## Independent benchmark artifact verification — 2026-09-23

- Added `bench:v4:verify` to recount retained token messages, recompute every target row and verdict, reject changed thresholds/raw data/noncanonical JSON, and optionally match exact source bytes, commit, lockfile and specification version.
- A verified failed benchmark remains a release miss. No target threshold, tokenizer fixture or specification version changed; V4-F02 evidence integrity is stronger while the 4× and other release gates stay open.

## Import-free adapter artifact profile — 2026-09-23

- Fresh ProcessDeployment histories default to `scoped-anchored-v5`, which requires signed effect resource policy `/3` and import-free adapter artifact `/2` for effectful modules. Deployment `/5`, prepared `/3`, effect plan `/3` and anchored host config `/3` bind the new authority profile. The trusted signer anchor remains external to the reloadable factory.
- The V2 adapter artifact signs exact source bytes and the `aether.adapter-js-import-free/1` rule. A pinned ES module parser rejects static/dynamic imports, re-exports from dependencies, `import.meta` and unsupported syntax before evaluating approved bytes. Existing V1 artifact and policy bytes remain available only through explicit legacy admission/profile choices.
- An adversarial review reproduced a signed-policy router-subclass bypass. Signed V2/V3 ProcessHost effects now call nonvirtual broker bind/mode/identity/invoke methods with JavaScript-private state, preventing that router override from dispatching an unapproved sink after identity validation.
- This closes ordinary module dependency resolution for the new trusted-JS profile. It does not confine ambient Node globals or malicious code. OS/guest isolation, external epoch rollback resistance, signer rotation and complete all-path containment remain open. Specification 0.1.0, acceptance gates and release thresholds are unchanged.

## Independently anchored effect-policy signer — 2026-09-23

- Fresh ProcessDeployment histories default to `scoped-anchored-v4`. A trusted operator/admission caller supplies an Ed25519 public key, signer/repository identity and stable epoch-authority identity outside the reloadable services factory. Factory-provided key and epoch callbacks are refused.
- Deployment `/4`, prepared `/2`, effect-plan `/2` and host-config `/2` bind the anchor digest. Signed policy v2 is checked against the anchor at admission, reopen, promotion and live effect boundaries. A direct signed ProcessHost without an anchor now requires an explicit legacy signer-trust selection.
- Old deployment and host formats remain byte-preserved under explicit historical profiles. In-place signer rotation or implicit adoption of an old unanchored history is not inferred; an authenticated new-deployment migration is required until a versioned rotation protocol exists.
- This closes the reproduced signer-key substitution path under the stated external trust boundary. The operator epoch source must itself prevent rollback. The V4-T2-04 acceptance gates and specification version 0.1.0 are unchanged; full all-path containment and adapter isolation remain open.

## Capability deployment profile implementation — 2026-09-22

- ProcessDeployment now persists capability authority as `aether.process-deployment/3`. Fresh effectful deployments default to signed resource/adapter-artifact policy v2 with scoped grants; signed descriptor-only v3, unsigned scoped-v2 and legacy sealed authority require explicit profiles.
- The default artifact profile now also requires `aether.evidence-policy/2`: process-isolated v4 SMT checking is part of the approved execution manifest. V1 evidence/checker behavior remains available in explicit compatibility profiles.
- Existing v1/v2 records require an explicit adoption choice. The active factory and existing host configuration are checked before the record is rewritten, retaining old bytes on mismatch or crash.
- This implements the existing V4-T2-04 containment contract; acceptance gates and specification version 0.1.0 are unchanged. Signed adapter code admission and complete path coverage remain open.

## Target-profile decision — 2026-09-22

- The user selected fresh guest startup on an already-running hypervisor and guest resident memory for the unchanged 1 ms / 2 MB limits.
- Added `decisions/D07-native-qualification-profile.json` version 1.0.0. Historical measurements remain intact; controller startup and RSS are diagnostics. The current guest-startup maximum still misses 1 ms.
- This fills a previously open target-profile parameter; functional contracts and specification version 0.1.0 remain unchanged.

## 0.1.0 — 2026-09-22

- Established the implementation specification against code commit `3c3c8ebe63078f104f1ab7d8182b088124e9b1c6` and the preserved v4.0 PRD.
- Defined state preservation, canonical identities, effect/replay behavior, candidate replication, proof validation, promotion recovery and benchmark evidence contracts.
- Added a separate v4 dependency tracker covering all 40 functional requirements, 16 NFR obligations, three governance obligations and 12 KPI statements.
- Prioritized the state-loss repair and real-tokenizer benchmark correction in an eight-task first slice.
- Recorded four research gates for replication/quorum, native targets, certificates/ZK and numerical/learning interfaces.
- Kept runtime implementation tasks planned; existing v1 completion records are unchanged.
