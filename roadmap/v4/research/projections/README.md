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
