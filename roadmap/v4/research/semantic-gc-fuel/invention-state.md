# Semantic GC fuel-preserving wrapper search

Status: **partial invention search**, 2026-09-24. Full mode began during the `c8d3de3` integration run. Deconstruction and reframing are recorded below; concept generation, constraint/mutation passes, critique, reconstruction, ranking and a prototype are pending. This file is a research continuation record, not T1-05 acceptance evidence.

## Brief and fixed requirements

The current semantic GC can prove a pure scalar forwarding wrapper's return value, but redirecting callers deletes runtime steps and a call frame. A finite `maxSteps` limit can then change a `step_budget` fault and whether a later effect reaches its sink. New promotions of those legacy rewrites are blocked by [D14](../../../../docs/implementation/v4/decisions/D14-semantic-gc-fuel-and-retention.md). The desired result is a smaller current AST with the redundant live wrapper bypassed while preserving exported values, contracts, faults, ordered effects, replay identity and observable reference-runtime traces under every admitted step budget. Historical AST/proof bytes remain available for audit and replay. A versioned mechanism is allowed; weakening the existing safety gate is not.

| Assumption | Evidence/status | Consequence if false |
| --- | --- | --- |
| `maxSteps` is observable behavior | Confirmed by `Runtime.tick()` and a retained differential test in `semantic-gc.test.ts`. | Value-only equivalence would suffice for one observer, but that is not the current runtime. |
| Exact pure forwarders have a fixed removed step pattern after argument evaluation | Hypothesis from `Runtime.eval(Call)` and `Runtime.enter`; not yet counted/proved across contracts, call shapes and backends. | A fixed virtual tick sequence cannot preserve quota faults. |
| Diagnostic call/return trace and fault bindings are part of the supported observable surface | Conservative requirement; `Runtime.trace` and fault data are public. | A weaker product decision could simplify implementation, but would require explicit specification change. |
| Process/resumable effect IDs may depend on call boundaries | Source inspection suggests this; exact differential campaign pending. | If independent, the proof's replay obligation is simpler. |
| Historical wrapper AST can be retained outside the active module | DurableGraphStore and signed lineage already retain historical roots; production binding still needs design. | Deoptimization or virtual-frame recovery would lack source material. |

## Reframes (15 distinct problem units; no solution selected)

| ID | Reframe | Assumption questioned |
| --- | --- | --- |
| F01 | Preserve the source's **observable events**, not its tree shape. | AST shape itself is the semantic contract. |
| F02 | Treat a wrapper as a **virtual frame** after it leaves the active module. | A source declaration must remain executable to remain observable. |
| F03 | Move the optimization point from AST rewrite to **runtime call dispatch**. | Cleanup must remove every runtime indirection immediately. |
| F04 | Treat each removed tick as a **resource debt** attached to its original position. | Total tick counts alone preserve quota behavior. |
| F05 | Optimize only when a **guard proves enough remaining fuel**, otherwise recover source execution. | One execution mode must serve every budget. |
| F06 | Keep the wrapper in an **archive of executable history** while removing it from the current module. | Historical material is merely passive audit data. |
| F07 | Represent the changed code with a **trace relation certificate** rather than equality of raw traces. | Byte-identical trace output is necessary for every consumer. |
| F08 | Preserve **effect boundaries first**, then fit value optimization inside those boundaries. | Return-value proof is the primary safety test. |
| F09 | Ask whether the redundancy is in **policy naming** rather than execution. | Every wrapper must be removed from code to reduce debt. |
| F10 | Analyze **call-site contexts** individually instead of retiring one wrapper globally. | A global rewrite is the only unit of cleanup. |
| F11 | Use **continuation state** as the unit, preserving the old frame in checkpoints while changing future calls. | Current and in-flight executions can switch together. |
| F12 | Model optimization as a **versioned migration** with old receipts bound to the predecessor. | The same manifest can describe both execution schedules. |
| F13 | Price the wrapper's cost in a **fuel-aware IR** before lowering to native code. | Cost semantics belong only in the interpreter. |
| F14 | Define a **no-observable-gain zone** near effect/contract boundaries where the old path remains. | Every call must take the optimized path. |
| F15 | Eliminate the need for a live wrapper by changing **how agents generate forwarding code**. | Cleanup must always happen after a wrapper exists. |

## Cross-field mechanism analogies (20 abstract mappings, unverified examples)

These are mechanism prompts, not claims that a named external system implements Aether's contract.

| ID | Source system → neutral mechanism → Aether mapping → failure condition |
| --- | --- |
| A01 | Accounting ledger → preserve original debit timing in a compact entry → virtual fuel debt → debt applied after an effect. |
| A02 | Theater understudy → perform a role without the original actor → virtual wrapper frame → public trace differs. |
| A03 | Video codec side data → reconstruct omitted detail on demand → trace/proof sidecar → lost sidecar blocks replay. |
| A04 | Road tolling → charge at each crossed boundary → per-call tick positions → path-dependent calls change crossings. |
| A05 | Warehouse bypass lane → skip handling but preserve handoff scan → compiled direct call plus virtual event → scan occurs too late. |
| A06 | Insurance run-off book → old contracts remain serviceable after sales stop → predecessor wrapper archive → old receipt not bound to old code. |
| A07 | Surgical bypass with monitoring → shorten physical path, preserve monitored signals → optimized call with virtual observations → hidden side effects escape monitors. |
| A08 | Flight recorder → log enough state to replay an omitted transition → deoptimization map → insufficient locals/heap identity. |
| A09 | Railway timetable → preserve arrival order despite route change → ordered virtual ticks/effects → quota trap changes order. |
| A10 | Cache miss fallback → fast path until proof fails, exact slow path afterward → fuel-threshold deopt → fallback duplicates an effect. |
| A11 | Double-entry bookkeeping → maintain old and new views with reconciliation → trace relation certificate → views diverge under faults. |
| A12 | Manufacturing ghost station → remove equipment but retain process-time accounting → synthetic frame/ticks → timing itself is externally visible. |
| A13 | Network TTL → decrement at each logical hop, even if physical hop is collapsed → logical-call fuel → trace depth still missing. |
| A14 | Versioned database schema → old readers use old projection during migration → historical wrapper manifest → wrong-generation read. |
| A15 | Compiler source map → map optimized location to original call site → fault/trace provenance map → values absent at fault point. |
| A16 | Checkpointed workflow → pin in-flight state before switching executor → old continuation stays old, new calls optimize → pin/commit race. |
| A17 | Traffic signal green wave → reorder transit while keeping observed crossings → direct call with event schedule → source-level quota checks differ. |
| A18 | Error-correcting code → retain compact parity sufficient to reconstruct loss → wrapper proof as reconstruction data → arbitrary branch needs more than parity. |
| A19 | Memory hierarchy → hot path compact, cold path reconstructed → optimized/default plus exact trace mode → public mode switch changes semantics. |
| A20 | Legal redline → new operative text with old clause history attached → active AST plus signed predecessor proof → history cannot execute when needed. |

## Preliminary prior work (primary sources only)

- [Debugging Optimized Code with Dynamic Deoptimization](https://research.google/pubs/debugging-optimized-code-with-dynamic-deoptimization/) describes recovering source-level state and virtual activation frames after optimization; applicability to Aether's fuel is an inference, not demonstrated there.
- [One Compiler: Deoptimization to Optimized Code](https://labs.oracle.com/pls/apex/f?p=LABS%3A0%3A108042641457368%3AAPPLICATION_PROCESS%3DGETDOC_INLINE%3A%3A%3ADOC_ID%3A993) describes scope descriptors and virtual program counters for deoptimization. The exact paper needs deeper inspection before borrowing an implementation rule.
- [Trace-Relating Compiler Correctness and Secure Compilation](https://arxiv.org/abs/1907.05320) motivates checking relations between source and target traces rather than assuming ordinary input/output equivalence preserves trace properties.
- [Trusted CerCo Cost Annotating Compiler](https://cris.unibo.it/handle/11585/399568) is a cost-semantics precedent; no Aether-compatible fuel translation is claimed.

Search coverage is preliminary: patents, products and startups have not been checked. No novelty or freedom-to-operate claim is made.

## Next phase

Run the eight independent domain lenses from the skill's search operators, form at least 12 causally distinct mechanisms, then apply the temporary constraints/mutations and review/reconstruct a shortlist. The cheapest technical test is a versioned experimental virtual-frame instruction for a pure one-argument forwarder, differential against the unmodified source for `maxSteps` 1–64, traces, fault bindings, an effect after the call, checkpoint/replay IDs and two process restarts. A failure in any observation rejects or revises that mechanism; the prototype is not yet built.
