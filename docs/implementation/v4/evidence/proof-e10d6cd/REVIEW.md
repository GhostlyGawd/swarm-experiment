# Portable AST certificate verification

`V4-T2-10` passes its two gates for specification `0.1.0` at `e10d6cd9c9668d8714383b731c8f30f16d6e5f77`.

The clean checkout passed **429 tests**, build, typechecking and both roadmap checks. The package was built and installed separately: its public producer/checker exports generated and checked a 3,529-byte certificate, admitted the closed artifact, returned 42 from input 41, and retained its entry precondition. Source identities, package and logs are recorded in `manifest.json`.

## G1: independent exact-subject checking

The consumer reconstructs the complete obligation set from the actual AST, formal contracts and content-checked dependency bodies. Expected execution context comes from the consumer, covering specification, semantics, compiler, target/ABI/artifact, capability policy and evidence policy. Prover-supplied formulas cannot replace those obligations.

Proof search is separate from the exact integer/propositional kernel. Isolated consumer processes receive only checker/derivation dependencies; original solver, verifier and producer files are absent. They successfully check both formula certificates and full AST bundles. Serialized checked-object fields cannot recreate the local acceptance brand.

The declared fragment covers pure unbounded Int/Bool functions, complete if/short-circuit paths, assertions, acyclic modular calls, old/result substitution, mutable by-value parameters, inductive loop invariants, ranking functions and return completeness. All required obligations must pass. Closed-artifact compiler admission requires every proved dependency body to be loaded, enforces scalar argument/result types and retains runtime contracts.

## G2: false, stale, malformed and excessive inputs

Tests reject incorrect postconditions, missing returns, broken ranking, stale loop values, mutable-callee post-state confusion, changed AST/contract/callee/specification/context, incomplete/reordered/exchanged proofs, invalid multipliers and over-limit input. Unknown theories and property-only clauses remain unproved.

Independent review reproduced changing accessor-backed formula inputs and invalid unreachable lexical/type syntax. Formula inputs are now copied through strict schema/size validation without invoking getters or proxy traps. Canonical wire data also rejects proxies. A separate lexical/type preflight checks dead syntax, including malformed declaration shapes and nonlinear tails. Multiplication is deliberately limited to syntactically closed constant factors; inferred local-variable constants are outside this profile.

The frozen review corpus uses seed **982451653** and SHA-256 `a572a8a3907c14c6789d4fda737b41b8d9815e2eafd6685ec21483cdcb48d77a`. At the clean checkpoint, **982 formulas matched an independent evaluator over 98,200 valuations**. All **18 resource-limited cases** are retained by index, without omission or threshold changes. This is differential implementation evidence, not a universal metaproof. The test suite also concretely executes 43 scalar-program cases in the reference runtime.

## Limits and reproduction

Natural-language specification text is bound by identity; the checker proves the formal AST contracts. Heap/effect operations, fixed-width arithmetic, nonlinear theories, recursion and unsupported constructs are not admitted by this portable profile. Compiler correctness and host scheduling remain stated assumptions. No portable proof-latency or full native lowering target is claimed.

Run the commands in `manifest.json` at its subject commit. The fixed corpus runner accepts an output path and records the exact source hashes and all 1,000 outcomes. The retained installed-package smoke script runs from a directory with this package installed. Later lineage, replication and assurance tasks remain open; previous foundation evidence is preserved and rechecked by the complete suite.
