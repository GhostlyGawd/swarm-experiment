# Executable projection V16: bounded closure dataflow and direct helper proofs

V16 extends the checked native closure profile for three reference-valid
contexts left by V15: factories with scalar locals in both `If` return arms,
integer quantifier binders inside lambdas, and passed lambdas that call a
direct pure helper. The same checked path handles scalar `Result` match
binders, pure sequence map/fold callbacks, nested immediate lambdas, and
reads from freshly constructed scalar records. Actual TypeScript, Python
and Rust execute the new cases against the reference runtime. Named V15
producers retain their prior scope and bytes; a pinned source/runtime SHA-256
fixture checks that in all three targets.

## Exact checked subject

V16 certificates hash the profile identifier, immutable owner declaration
root, lambda root and sorted roots of every transitive direct helper used by
the lambda body. The helper summary accepts synthesized direct-return scalar
functions with no capabilities, no contract, no mutation or indirect calls.
It rejects cycles. Quantifier and Result binders are checked as local values;
branch-local `Let` values are tracked in lexical order. The parser
reconstructs the visible source, recalculates the certificate set from the
AST and exact linked imports, and refuses changed creation sites, headers or
runtime whitelists. A helper-body edit changes the certificate even when the
owner and lambda subtrees are identical. An exact-address imported helper
is checked through its dependency bundle and contributes its body root.

The native contract guard continues to refuse raw host closures and mutable
captures before callback execution. TypeScript and Python tests also alter a
certified capture and observe refusal. This is a matched trusted-source
profile. Same-process hostile code with access to the exported certificate
constructor can reuse a known certificate; V16 does not claim hostile-host
containment, signed Artifact admission or ProcessHost effect safety.

## Generated cross-feature audit

The [fixed corpus](corpus-valid-contract-contexts.ts) crosses eleven closure
body forms with five carriers, creating **55** typechecked,
reference-executed AST modules. The [audit runner](audit-valid-contexts-v16.ts)
checks exact roots through all three native parsers and counts complete
model and legacy TypeScript review messages with actual `js-tiktoken`
tokenizers. It retains the raw token input strings, per-context costs and
native source hashes; the [independent verifier](verify-valid-contexts-v16.ts)
recounts and checks exact-source native outcomes. The audit records both
projection refusals and sources that parse but cannot receive a runtime
certificate. This is an authored diagnostic corpus,
not representative autonomous code or a release profile.

The remaining current counterexample is an effect-free lazy task inside a
closure body. All five carrier forms run in the reference runtime. Four are
rejected explicitly by native contract projection; the passed-function form
round-trips but has no checked certificate and is refused at contract
execution. Its state/capability/lazy-result semantics need a separate
summary before native contract admission. Additional AST combinations beyond
this generator remain unaudited, so V4-T1-02/G1 is still open.

On the uncommitted development probe, the 55 cold complete modules cost
6,560 legacy TypeScript review tokens versus 22,977 AE2 model tokens
(**0.2855×**) with `cl100k_base`, and 6,572 versus 22,735 (**0.2891×**)
with `o200k_base`. The final exact-source report supersedes this probe.
These ratios miss 4× and do not replace the historical AE6 corpus. FR-1.2,
V4-Q03 and current-source representative changed-session measurement remain
open; the verified task count does not change.
