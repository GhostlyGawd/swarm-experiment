# Implementation specification changelog

## Bounded record proof and native host binding — 2026-09-24

- Added a portable certificate checker for the selected one-field Int record Tier 2. It rederives obligations from the exact full AST/manifest, proves signed-i64 arithmetic, one bounded allocation, total return and frame preservation for alias and distinct-reference cases, and checks the precise postcondition condition for distinct inputs. Changed declarations, incomplete/forged proofs, unsupported syntax and possible overflow fail closed.
- Added proof-bearing native lowering that embeds the checked certificate and compiler-profile digests in executable bytes. A versioned native binding pins the actual ProcessHost source snapshot/head, generation, two tier symbols, checked proof and artifact hashes. A real host-state comparison matches native outcomes to durable worker results for alias and distinct inputs. Focused proof/native/host tests pass 10/10.
- The binding is a checked admission subject, not a host publication. The versioned witnessed host transaction, combined native effects, full values and FR-3.7 ≤50 ns qualification remain open. T3-07 and 20/62 status do not change. [Decision and limits](decisions/D13-native-fallback-host-transaction.md).

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
