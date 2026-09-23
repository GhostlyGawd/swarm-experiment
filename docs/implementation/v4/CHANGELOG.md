# Implementation specification changelog

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
