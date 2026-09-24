# Executable projection V14: checked read-only closure predicates

V14 closes one valid G1 gap left by V13. A contract can apply an inline
capability-free lambda or call a directly named, synthesized pure factory
whose body directly returns a visible lambda. The factory can capture scalar
parameters and surfaces. Its closure executes native code in the same
TypeScript, Python and Rust context as the enclosing contract; no AST or IR
interpreter is hidden in metadata.

The checker walks the reachable direct call, map and fold graph. It refuses
effect invocation, spawn/await, nonlocal record writes, mutable or opaque
captures, capability-bearing closures, recursive closure factories, nested
lambdas, `old`/result references
inside closure bodies, and closure targets whose producing function cannot be
identified exactly. The generated closure captures every visible outer
binding, so the checker validates all outer binding types, including ones the
body does not read. Only scalar Aether values are admitted as captures and
closure arguments/results. V11, V12 and V13 remain explicit older producers.

The [V14 tests](../../../../test/projection/contract-closures.test.ts) compare
reference execution to actual TypeScript, Python and Rust for a scalar
capture, inline predicate, successful call, refused precondition and failed
postcondition. An owner body reassigns its scalar parameter before an inline
postcondition closure reads the live value; all three targets match the
reference. They check exact-root parsing, a visible literal edit,
tampered capture scaffolding and an exact-address imported factory. A record
capture is rejected even though the reference runtime accepts and executes
it; this is a deliberate read-only proof boundary. Capability-bearing
closures and unknown function-valued targets are refused.

Two valid forms remain executable only in the reference runtime: `Apply` of
a function-valued parameter and a pure factory that first binds a scalar
local before returning its capturing lambda. Both typecheck and run in the
fixture; all three native producers reject them explicitly. The first needs
an authenticated/read-only summary on the passed closure value. The second
needs dataflow proof across local bindings and control flow. These examples
show why V4-T1-02/G1 is still open despite all 45 named AST kinds having
representative round trips. Additional cross-feature contexts also need an
adversarial differential audit.

G2's named boolean, negative division, fixed overflow and effect-call
fixtures still run in all three targets. This V14 slice has no new
representative tokenizer campaign. Historical AE6 warm-only compression and
its cold/changed-session misses remain unchanged; FR-1.2's ≥4× and V4-Q03
remain open. No T1-02 gate or verified-task count changes here.
