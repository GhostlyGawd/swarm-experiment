# Agent-IR v2 and executable native projections

## Delivered interfaces

`encodeAgentIrBinary` / `decodeAgentIrBinary` use the `AEB2` binary format: a fixed assignment of 45 AST opcodes, a canonical UTF-8 string dictionary, typed scalar values, explicit grouped child indices, and the original v1 BLAKE3 root. The graph is emitted in deterministic postorder. Decoding rejects truncation, trailing bytes, noncanonical integers/dictionaries, invalid grouped arity, forward/duplicate/unreachable records, root mismatches, excessive expansion, and opaque source objects. Scalars distinguish arbitrary integers from ordinary integer-valued metadata.

`encodeAgentIrModel` / `decodeAgentIrModel` use a separate `AE2` model message with the root and complete dictionary/framing costs. AE2 escapes free dictionary atoms before using the existing opcode grammar, including control characters and delimiters that the raw AE1 pools cannot represent reliably. AE1 data and shared-context APIs are unchanged; stored AE1 percent text is never reinterpreted as AE2 escaping. Binary bytes are not counted as model tokens.

`projectExecutable` / `parseExecutable` and the named TypeScript/Python/Rust V2 wrappers implement `aether-reference-scalar/1`. `executableBundle` provides the source, runtime support, and native aliases for function entry symbols. All three outputs execute native function bodies, branches, loops, calls, and expressions. There is no embedded IR/body used to override visible source edits. Symbols, types, provenance, tuning surfaces, and contract labels remain explicit metadata; requires/ensures expressions are executable source. Parsed bodies are typechecked, reconstructed, and compared against the permitted scaffolding. Token boundaries, line breaks, and Python indentation cannot silently change scaffold behavior. The serialized profile uses LF line endings; Unicode line separators are escaped in literals and metadata.

## Explicit projection scope

The scalar profile covers modules of implemented function and type declarations; scalar parameters/locals/results; `Int`, `Bool`, `Str`, `Unit`, fixed integers, and scalar nominal/owned wrappers; arithmetic/comparison/Boolean operators; conditions, calls, effects, assignments, blocks, branches, loops, assertions, quantifiers, yield safe points, surfaces, and requires/ensures/old/result contracts. Loop invariants/variants are retained as visible annotations, matching the reference production path's annotation behavior. Ordinary native syntax outside the emitted grammar is rejected.

Limitations remain explicit:

- Records, sequences, result sums, closures, tasks, atomic blocks, imports, nested modules, generic declarations, and `StringOp` are outside this projection profile. The binary/model codecs still cover every existing AST kind.
- Old expressions with nested binders and reused local binder identities require a later projection profile. New binder identities must be represented in the explicit alias/symbol metadata.
- Requires/ensures cannot contain indirect function or effect calls in this profile.
- The helpers accept trusted host grants/effect callbacks. They do not provide durable broker receipts, process migration, proof transfer, or VM isolation. Scalar return/argument checks, capability envelopes, and instruction fuel are enforced.
- Full v4 projection coverage and the release token-density target are **not complete**. The standard record-based ledger was retained as an unsupported workload in scalar campaigns 01–03; composite version 3 below now supports it.

The parser preserves exact AST identity for supported source, including non-block statement bodies and contract presence. Editing a visible integer from `-7` to `-10` changes both the parsed root and actual target execution (`-10 / 3 = -3`). Unsupported code or modified scaffolding is refused.

## Execution verification

`test/projection/executable.test.ts` executes actual Node TypeScript, Python, and Cargo/Rust artifacts. It covers strict booleans, negative quotient/remainder, 80-digit inputs and a 4,401-digit computed result, wrap/saturate/trap overflow, lazy branches, nested calls, loop/entry-state contracts, Unicode/control strings, and one explicit effect. The Rust runtime uses arbitrary-precision `num-bigint-dig`, not `i128`; Python disables its decimal string conversion ceiling to preserve arbitrary integer output. No microVM or performance qualification is inferred.

Rust dependencies are pinned by `Cargo.lock` and `RUST_PROJECTION_CARGO`. Tests use `cargo --locked --offline`; seed an isolated Cargo project with the exported manifest and this lock, then `cargo fetch --locked` when setting up a new machine. Python 3 and a Node version supporting TypeScript stripping are required. Runtime support is emitted separately from each human source file, and its token cost is reported separately.

## Actual tokenizer evidence

Run from the repository root:

```sh
node --experimental-strip-types roadmap/v4/research/projections/measure.mjs roadmap/v4/research/projections/results/NEW-DIRECTORY
node --experimental-strip-types roadmap/v4/research/projections/verify.mjs roadmap/v4/research/projections/results/NEW-DIRECTORY
```

The runner refuses existing result directories. It records the corpus and source hashes before counting, retains complete source/messages, pins the actual `js-tiktoken` package, and reports both `cl100k_base` and `o200k_base`. Session totals include an original complete module and two complete-module replacements, with every dictionary/header counted. Ratios use summed tokens.

Campaigns retain the misses. On the four small authored workloads, cold AE2 used **763 cl100k tokens versus 342 legacy TypeScript review tokens** (ratio 0.448), and **761 o200k tokens versus 343** (0.451). The complete cl100k change sessions used 2,309 AE2 tokens versus 1,026 legacy review tokens; shared AE1 sessions used 1,067. These do not meet the 4× target. Native V2 source counts include substantial explicit metadata and helper scaffolding, so their larger ratios are diagnostic and cannot establish production density. This is a small authored corpus, not a representative production benchmark.

Campaigns 01 and 02 preserve their admitted source snapshots. Campaign 03 records the final source after Unicode line-separator handling and strict LF validation. No run claims a release density pass.

## Composite profile (header version 3)

The next version extends executable projections to **records, sequence literals/index/length/map/fold, and Result construction/matching**. `projectExecutable` selects version 3 when these types/forms are present; named V2 producers retain the scalar profile. The common parser accepts both headers, and the earlier scalar campaign still passes the current parser audit. Use `executableBundle` to pair source with its matching support library; low-level `executableRuntime(target, true)` selects composite support.

Composite values carry native identities. Record aliases remain shared through sequences, Result payloads, callbacks, and field writes. Entry snapshots copy the reachable data while retaining logical identities, allowing both `old(record.field)` and `record == old(record)` to hold. Snapshot records reject writes through the supported helpers. Field and nested Place assignment evaluate the value before resolving the target. Record names and field types are checked, and Owned argument regions reject reachable overlap before a callback runs. These are call-boundary checks, not a general linear ownership or distributed heap protocol.

The native fixtures now execute the **standard ledger** in TypeScript, Python and Rust: transfer and settlement preserve total balances, accrue executes its loop, aliased accounts and revoked grants are refused, and only the two intended effect callbacks run. Additional fixtures execute an actual visible record-value edit; shared record/sequence/Result identities; lazy error branches; map/fold; nested target mutation order; old sequence/Result contracts; nominal mismatch and snapshot-write refusals; and positive/negative Owned arguments.

The inspection JSON for native composite values is not C1 logical-reference serialization. Host adapters and runtime support remain trusted. Modifies metadata is preserved, while production proof/admission and durable effect receipts remain separate requirements. There is no new heap migration, opaque authority transfer, or sandbox claim.

**Remaining FR-1.2 scope:** Lambda/Apply, Spawn/Await, Atomic, Import, StringOp, generic declarations/types, nested modules, unsynthesized bodies, and the documented binder-context restrictions. T1-02 remains in progress.

Campaign 04's old assertion that the ledger must be unsupported failed because record support removed that limitation. Its preregistration, exact source snapshots, and explicit failure record are retained; it has no completed quality report. Campaign 05 measures the original scalar corpus plus a composite workload and the full ledger, with all source/messages and both runtime-library costs retained. No historical results are overwritten, and Q03 remains open.

## Continuation profile (header version 4)

Version 4 adds executable `Lambda`, `Apply`, `Spawn` and `Await`, plus `Fn` and `Task` types. The common producer selects it automatically; V2/V3 producers and their emitted sources remain supported. `executableBundle` supplies matching runtime support; the low-level equivalent is `executableRuntime(target, true, true)`.

Native callback bodies receive explicit capture and argument arrays. The complete visible lexical scope is copied by value at creation, including unreferenced records relevant to Owned reachability. Record references remain shared. Nested shadowing, quantifier binders and Result branch binders preserve their identities. The parser reconstructs the visible body and verifies all derived capture scaffolding; it cannot accept a substituted capture array while ignoring its runtime meaning.

Closures and tasks have distinct identities. Spawn is lazy. Successful task execution is cached, including when authority is revoked after an effect but before the result can be disclosed. Restoring authority allows access to that cached result without another dispatch. Host policy and caller capability envelopes are rechecked on Apply and Await, including completed tasks. Version 4 contexts accept a synchronous trusted `policy(capability)` callback in addition to explicit grants. Executable values, including those nested in record/sequence/Result payloads, are rejected at effect boundaries.

These are in-process native continuations. Body faults leave a task pending, matching reference retry behavior; a failed task can repeat already performed external work when retried. Durable broker idempotency, checkpoint restoration, portable code witnesses, process migration and heap reclamation are not supplied by these libraries. Opaque continuation inspection exposes identity/state metadata, never transferable execution authority. Cyclic awaits fail rather than execute recursively forever.

Atomic is deliberately not approximated with heap-only rollback: exact local rollback and nonlocal returns require a separate lowering. Remaining FR-1.2 scope includes Atomic, Import, StringOp, generic declarations/types, nested modules, unsynthesized bodies and the documented restricted control/contract contexts. Conditional declarations require explicit Blocks; indirect execution in contract predicates is rejected.

The continuation fixtures run actual TypeScript, Python and Rust code. They verify edited capture values, live record aliases, unreferenced captured ownership, nested shadowing, closure identity, lazy/distinct task identities, map-like binder contexts, opaque payload refusal, and late-revocation caching. Campaign 06 adds a closure/task workload to the six prior workloads: 21 complete messages are retained for each tokenizer. Cold totals are 1,478 legacy review versus 2,367 AE2 cl100k tokens (ratio 0.624), and 1,492 versus 2,357 o200k tokens (0.633). Q03 remains open; no 4× qualification is claimed.

## Atomic profile (header version 5)

Version 5 adds statement `Atomic` to the continuation profile. The common producer selects it for modules containing Atomic; named V2, V3 and V4 producers retain their earlier kind sets and emitted scaffolding. Use `executableBundle` for matching source/runtime, or `executableRuntime(target, true, true, true)`. `projectTypeScriptV5`, `projectPythonV5`, `projectRustV5` and `ATOMIC_PROJECTION_PROFILE` are available from the executable projection module.

Atomic is visible native control flow: TypeScript `try/catch/finally`, a Python `with` manager, and a Rust RAII guard. The parser reconstructs the actual visible body and checks the complete rollback scaffold. Native `return` commits the enclosing Atomic blocks before function postconditions run. A fault while evaluating the return expression rolls back. A callee's failed postcondition rolls back an enclosing caller Atomic, even if the callee's own Atomic already committed.

The native runtime journals record writes and allocations across nested calls, closure/task execution, and trusted adapters using the supported record helpers. Reverse application restores the same record cells in place, preserving aliases; nested successful journals merge into their parent. Failed allocations retire their record cells, and subsequent allocations reuse those slots in reference order. The native execution counter returns to its Atomic entry value on fault; it retains the earlier profiles' native tick accounting, which is not the development interpreter's instruction count. Local bindings use native lexical storage: successful assignments and returns remain visible within the function, while a propagated fault discards the native frame. The supported AST has no exception-catching statement and closure/task captures copy scalar values, so fault-unwound locals cannot subsequently be observed by Aether code. This does not implement debugger restoration of native stacks.

**Reference behavior with important limits:** external callbacks already performed are not undone. Completed task caches are not journaled. The reference oracle demonstrates a cached task result whose allocation was rolled back: it is unusable until a later allocation reuses that record slot, at which point the retained reference denotes the replacement. V5 preserves this reference behavior, including identity equality. Native typed boundaries may reject a retired result earlier than a field read does. These are local runtime record handles, not C1 references, migration ownership epochs, or safe portable capabilities. These libraries provide neither durable effect idempotency nor transactional external storage.

Each loaded native runtime library is one trusted, synchronous heap/journal domain. Source, support libraries, and adapters are trusted; direct mutation of implementation fields, mixing independent runtime libraries' values, native threads, and asynchronous callbacks are outside this profile. Rust requires `panic=unwind` and explicitly refuses `panic=abort`; process termination cannot unwind or roll back memory. The profile retains the existing source/node and native execution limits, without a crash-durability or sandbox claim.

Actual TypeScript/Python/Rust fixtures cover nested success/failure, alias restoration, writes through callees, return through a loop, successful local reassignment, return-expression failure, integer overflow, postcondition ordering, allocation retirement/reuse, settled-task cache persistence, no redispatch of the settled task effect, fresh capability denial, and step-quota rollback. A visible literal edit inside Atomic changes the parsed AST and the executed result in every target. A development `Runtime` oracle independently establishes the return/fault/allocation observations. The fixtures include an unreachable fallback after unconditional Atomic returns because the current shared typechecker conservatively reports Atomic as falling through. A direct Atomic body declaration requires an explicit Block to avoid introducing a native-only scope.

Campaign 07 adds an Atomic workload to the prior seven workloads. It retains **24 complete messages**, all native source edits, **17 source snapshots**, and the exact runtime text/cost for each of the four profiles. Cold totals are **2,149 legacy TypeScript review / 3,222 AE2 cl100k tokens (0.667×)** and **2,169 / 3,208 o200k tokens (0.676×)**. The raw audit recomputes these counts, binary/model identities, native parse identities and all stored runtime text hashes/costs. These authored workloads do not meet 4× and do not qualify as a representative production corpus.

**Remaining FR-1.2 scope:** Import, StringOp, generic declarations/types, nested modules, unsynthesized bodies, and the documented restricted control/contract contexts. T1-02 and Q03 remain open. The versioned binary/model codec preserves all existing AST forms, but that does not establish executable target-language coverage of the remaining forms.

## Unicode and linked-import profile (header version 6)

V6 adds all six `StringOp` operations and module-level `Import`. `projectExecutable` and `executableBundle` select it when either kind is present. Named V2–V5 producers retain their kind sets; their source and runtime protocols remain supported. Direct-module named V6 producers and `LINKED_PROJECTION_PROFILE` are exported from `src/projection/executable.ts`; shared package barrels are unchanged in this slice.

### Exact-address native import files

Supply the hydrated dependency modules explicitly:

```ts
const bundle = executableBundle(rootModule, symbols, 'typescript', {
  modules: new Map([[dependencyRoot, dependencyModule]])
});
const checked = parseExecutableBundle(bundle);
```

The bundle contains `source`, its matching `runtime`, and a `dependencies` map of content-address-derived filenames to **executable source**. Write TypeScript/Python dependency files beside the entry and runtime; put Rust files together in `src`. No network, package registry, ambient filename search or implicit dependency fetch is used by the projector/parser. Native execution requires the exact files validated by `parseExecutableBundle`; changing a file after validation is outside that check.

Each original module and Import declaration round-trips separately. Generated imports bind the actual dependency functions: TypeScript imports/re-exports, Python imports, and Rust module declarations/public imports. All modules share the same runtime types, record identity domain and capability context. Import metadata records the content address and symbol selection; regenerating the complete native scaffold checks that metadata against the executable path and aliases. Dependency bodies are not embedded in comments or hidden IR.

The bundle parser first parses every visible file, verifies each original AST against its content address, then validates the complete source closure and native import scaffolding with the reference `ModuleResolver`. It rejects missing or mismatched dependencies, extra files, mismatched runtimes, requested symbols that do not exist, duplicate imported definitions, malformed/accessor-bearing AST dependencies, and Import outside module membership. Closures are bounded to 64 modules including the entry, 16 MiB of native source across the bundle, and the existing per-module node/source bounds. The resolver retains its selection semantics: an empty symbol list selects all linked declarations; explicit selection does not automatically add a selected function's callees. Such incomplete selections fail typechecking. Generic, nested or unsynthesized dependency declarations remain unsupported even when not selected by the entry.

V6 native aliases are derived from the module's symbol table and full SymbolId. Arbitrarily renaming only native import aliases is refused. A dependency-body edit must change its content address and rebind ancestor Import addresses. The actual target fixtures perform this flow: parse a changed string literal in a dependency, calculate its new root, rebind the middle and entry modules, and execute the changed program. A separate entry-body edit is also executed; the effect sink sees the edited result once.

### Unicode semantics

The reference uses code-point length and slicing (`[...text]`), JavaScript substring matching, default locale-independent casing, and JavaScript trim whitespace. This follows the ECMAScript [case-conversion rules](https://tc39.es/ecma262/2024/multipage/text-processing.html#sec-string.prototype.tolowercase), including Unicode default full mappings and [contextual Final_Sigma](https://www.unicode.org/Public/17.0.0/ucd/SpecialCasing.txt).

V6 pins Unicode **17.0**, matching the measured Node 26.7.0 / ICU 78.3 reference. `generate-string-data.mjs` reproducibly extracts the mappings and Cased/Case_Ignorable properties; `string-data-provenance.json` binds the resulting source hash and engine versions. All three native runtimes use these tables, including TypeScript, so a different Python/Rust Unicode version cannot change results. Updating Unicode requires an explicit new table/profile decision.

The tests compare upper/lower mappings, both contextual properties, and trim membership against the actual TypeScript reference for **all 1,112,064 valid Unicode scalar values**. Actual target-language calls also cover every mapped casing character, contextual range boundaries around Greek sigma, combining marks, astral characters, multi-character expansions, Unicode additions, JavaScript-specific trim differences, substring matching, negative slices, and 1,001-digit slice bounds. Native TypeScript is strictly typechecked before execution. Rust V6 escapes bidirectional controls in emitted literals so valid Aether strings compile under Rust's default source lint.

The supported string domain is well-formed Unicode scalar strings, consistent with canonical AST strings. Helpers explicitly reject isolated surrogate code units at host boundaries. Length is code-point length, not UTF-16 length or grapheme count. Huge integer slice bounds clamp without lossy conversion inside Python/Rust. No locale-sensitive casing, Unicode normalization, grapheme segmentation, native string-allocation quota or throughput claim is added.

### Retained token evidence

Campaign 08 preserves the first complete V6 measurement. Campaign 09 records the final dependency-validation ordering fix; campaign outputs and audits are retained separately. The final nine-workload campaign stores **27 root messages plus six dependency messages**, **23 source snapshots**, every native dependency source, and exact runtime text/costs. Imported workloads count JSON `{entry, dependencies}` framing and repeat the full dependency closure in every message. Neither binary/model encoding nor native imports hide dependency costs; reported binary bytes are summed binary payload sizes.

Cold totals are **2,584 legacy TypeScript review / 4,807 AE2 cl100k tokens (0.538×)** and **2,604 / 4,782 o200k tokens (0.545×)**. The V6 runtime, including Unicode tables, separately costs 32,657 / 32,071 / 35,505 cl100k tokens for TypeScript / Python / Rust. The audit re-decodes every AST and shared dictionary, checks dependency addresses and actual native parse identities, recomputes message counts, and rehashes/recounts each stored runtime. Both campaigns miss 4×; these authored workloads remain diagnostic rather than representative production qualification.

All AST *kind names* now have a bounded executable context in V6. This is not complete FR-1.2 coverage: generic declarations/types, nested modules, unsynthesized bodies, and earlier restricted control/contract/binder contexts still require work. T1-02 and Q03 remain open. Trusted native source/adapters, local runtime state, ordinary effect callbacks and import parsing do not establish proof admission, process sandboxing or durable external transactions.
