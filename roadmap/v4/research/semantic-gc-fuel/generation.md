# Fuel-preserving wrapper mechanism generation

Generation stage only, 2026-09-24. No concept below has passed critique, proof, implementation or end-to-end verification. The fixed brief, 15 reframes and source links are in [invention-state.md](invention-state.md). Three independent agent first passes covered eight lenses; the two additional source-coordinate/AST mechanisms were generated sequentially by the primary agent after those passes.

## Independent lens first passes

| Idea | Lens | Cause → effect mechanism | Assumption challenged | Frame/analogy |
| --- | --- | --- | --- | --- |
| ECO-01 | Economics | Charge a certified temporal tariff of each deleted wrapper tick/frame/trace event at its old position before direct target dispatch. | AST execution must incur each observable debit. | F04; A01/A04 |
| ECO-02 | Economics | Check remaining fuel at the former boundary; use direct dispatch with source-shaped observations when proved safe, otherwise execute archived source. | Every budget uses one route. | F05/F14; A10 |
| BIO-01 | Biology | Extract an executable transition graft from signed wrapper history; a direct call invokes the graft around target dispatch. | Deleted behavior requires a live declaration. | F02/F06; A18 |
| BIO-02 | Biology | Run direct and historical executions in isolated paired lanes, buffering effects and publishing only a reconciled historical event stream. | Redundant execution must stop immediately. | F08; A11 |
| GAME-01 | Game theory | Require an independent simulation-game certificate mapping every removed source step to target/sidecar transitions before promotion. | Return-value proof authorizes deletion. | F01/F07/F13; A11 |
| GAME-02 | Game theory | Bind in-flight calls/receipts to predecessor schedule and future calls to a new manifest with virtual observations. | One executor version serves all cohorts. | F11/F12; A14/A16 |
| IE-01 | Industrial engineering | Compile wrapper to a small ordered itinerary of frame/tick/contract/return stages, carried by redirected edges. | AST node deletion must remove stages. | F01/F04; A12 |
| IE-02 | Industrial engineering | Install a guarded bypass after source argument evaluation; scarce-fuel calls take archived source, others run a debited direct path. | One path is required for all calls. | F05/F06; A05/A10 |
| AR-01 | Architecture | Keep old symbol as a shared semantic doorway in a link table while removing the FunctionDecl; calls resolve through a virtual frame. | Every caller must be rewritten. | F02/F03; A13 |
| AR-02 | Architecture | Split old suspended continuations from new direct entries at a durable generation handoff. | In-flight and future execution switch together. | F11/F12; A14/A16 |
| PS-01 | Psychology | Replace wrapper with a defunctionalized continuation token that runs original prelude and epilogue around the target, remaining on the logical stack on fault. | A real AST activation must remember pending obligations. | F02/F11; A08 |
| PS-02 | Psychology | Record a compact wrapper episode; reconstruct trace lazily, but emit eagerly for `onStep`, while live logical frame drives faults/effect IDs. | Trace text must always be stored eagerly. | F01/F06; A03/A08 |
| MED-01 | Medicine | Route quota-sensitive calls through archived source; bypass only when a certified guard proves surplus fuel, with source-shaped frame observations. | All invocations need the same route. | F05/F06; A07 |
| MED-02 | Medicine | A runtime pacer emits the original event schedule and halts at the exact source fuel boundary before direct target entry. | Wrapper body must remain to generate steps. | F01/F02/F04; A01/A13 |
| INV-01 | Industry inversion | Replace many wrapper declarations with one shared trampoline plus signed per-wrapper schedule descriptors. | Each wrapper needs its own live implementation. | F09/F13; A12 |
| INV-02 | Industry inversion | Send a signed origin token to the callee; it pulls predecessor wrapper obligations before and after its own body. | Obligations belong to caller-side wrapper code. | F03/F10; A15 |
| ROOT-01 | Source-coordinate perspective | Make a source logical program counter/fuel clock primary; optimized physical instructions map to source transitions at runtime. | Fuel is tied to target AST traversal. | F01/F13; A15 |
| ROOT-02 | AST-only perspective | Retain a typechecked stutter skeleton and virtual call marker in the new AST, so ordinary evaluation itself emits the removed steps without a sidecar interpreter. | A new runtime instruction is necessary. | F03/F04; A12 |

## Causal families after merging equivalent first-pass mechanisms

The table merges shared mechanisms rather than counting renamed ideas. Families are generation candidates; none is ranked.

| Family | Parent ideas | Distinct changed link |
| --- | --- | --- |
| M01 ordered event tariff | ECO-01, IE-01, MED-02 | Runtime consumes a signed per-call sequence of source-only transitions before/after one direct target call. |
| M02 guarded source fallback | ECO-02, IE-02, MED-01 | Remaining fuel chooses between exact archived source and direct dispatch at a proved boundary. |
| M03 executable transition graft | BIO-01 | A compact extracted program, rather than an event list, regenerates wrapper behavior around target dispatch. |
| M04 isolated paired execution | BIO-02 | Two lanes run, with one reconciled result/effect publication. |
| M05 simulation-game authority | GAME-01 | Independent proof of a labeled source/target transition relation controls admission. |
| M06 generation cohort commitment | GAME-02, AR-02 | Durable call generation chooses old/new execution schedule; suspended state never switches mid-call. |
| M07 shared semantic doorway | AR-01, INV-01 | Calls retain a logical symbol resolved through one shared trampoline and per-wrapper descriptor. |
| M08 callee-pulled obligation | INV-02 | Target receives origin metadata and performs old wrapper obligations itself. |
| M09 defunctionalized continuation | PS-01 | A live token carries pre/post obligations and virtual stack state through target faults. |
| M10 reconstructible episode | PS-02 | Compact recorded episode plus archived source materializes trace on demand, with eager callback path. |
| M11 source logical PC | ROOT-01 | Fuel/trace advance in source-coordinate space independent of physical target AST nodes. |
| M12 typechecked stutter skeleton | ROOT-02 | New AST syntax/execution pattern, not a runtime sidecar, reproduces the removed schedule. |

## Temporary constraint passes

Each row applies only its named temporary constraint; all fixed correctness requirements remain active. Numerical changes are targets, not results.

| Pass | Additional constraint and baseline | Generated mechanism | Useful link after lifting |
| --- | --- | --- | --- |
| C01 | Cut wrapper metadata bytes by 90% vs archived full AST per call. | Share one content-addressed itinerary per wrapper, referenced by hash at call sites. | Descriptor deduplication can reduce current-module footprint. |
| C02 | Make hot wrapper dispatch 10× faster vs interpreter call chain. | Emit native direct call plus exact source-event pacer in a fused handler. | Fused physical work can coexist with logical steps; speed is unmeasured. |
| C03 | Add no human review labor. | Generate transition certificate and differential campaign during proposal; unknowns stay unadmitted. | Automatic proof production is separate from independent checking. |
| C04 | Add no new service/infrastructure. | Store signed itinerary/old root in existing GraphStore and lineage artifacts. | Existing durable roots can anchor deoptimization metadata. |
| C05 | Substitute **no new AST kind** for the reference “no software” restriction, which contradicts this compiler task. | Keep `Call` symbol and resolve a signed alias doorway at load time. | Symbol resolution is a separate migration path. |
| C06 | Substitute **no new global optimizer registry** for “no central authority,” since signed governor admission is firm. | Content-address itineraries inside each manifest. | Local proof identity can avoid another mutable head. |
| C07 | Substitute **no runtime solver** for “offline,” already a project requirement. | Verify portable transition certificate at promotion and execute fixed checked metadata only. | Admission and execution trust can be separated. |
| C08 | Require no caller/API behavior change. | Put transparent doorway behind the existing `Call` evaluator and manifest identity. | Existing call sites need not opt into a new mode. |
| C09 | Automate unsupported cases. | If proof, fuel map or archived root is unavailable, refuse promotion and keep current source; no guessed rewrite. | Failure handling can be a deliberate safe result. |
| C10 | Remove source-level rewrite entirely. | Keep AST but optimize compiled dispatch with virtual-frame metadata. | Compiler-only path may improve runtime but does **not** by itself satisfy AST cleanup. |

## Ideas an expert might reject immediately

These are assumption challenges, not accepted solutions.

| Idea | Expected objection | Condition that would have to hold |
| --- | --- | --- |
| Static up-front tick debit | Original arguments and contracts may fault or effect before the debit's true source position. | Prove exact total/pure argument order and a fixed wrapper-only segment for every admitted call. |
| Paired shadow execution | A real sink might be called twice or shadow state might leak into publication. | Fully isolate and buffer all external effects, with one authenticated commit and replay binding. |
| Omit traces from equivalence | Public trace/callback/fault state changes even when values match. | An explicit product/specification decision changes supported observations; not authorized here. |
| Keep old FunctionDecl in an archive and claim it was removed | Current runtime may still execute it and no abstraction layer was actually bypassed. | Demonstrate smaller live execution graph and exact virtualized behavior, not a renamed wrapper. |
| Trust a source-pattern match for forwarding | Type/capability/contract/fuel behavior can differ despite syntax. | Independent exact-subject transition proof and runtime differential evidence. |

Generation ends here for now. Mutation, distant combination, full critique, reconstruction, provisional ranking, five-category prior-art review and technical prototype remain pending; see [invention-state.md](invention-state.md).
