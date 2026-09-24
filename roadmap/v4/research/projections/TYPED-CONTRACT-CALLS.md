# Executable projection V13: typed read-only contract calls

The default producer selects `aether.executable-projection/13` when a
contract directly calls a helper with composite or generic input/output, or
uses a sequence map/fold callback. V11 and V12 remain explicit producers for
their original declared profiles. The V13 source still contains native
function bodies and visible contract clauses; the parser reconstructs the
exact AST root and checks the regenerated scaffold and linked dependencies.

V13 admits direct, synthesized, capability-free, pure callees with supported
typed inputs and results. A static transitive walk follows `Call`, `SeqMap`
and `SeqFold` edges. It rejects `Invoke`, `Lambda`, `Apply`, `Spawn`, `Await`,
and writes through record fields or nonlocal places in that call graph.
Local scalar assignments remain allowed. A declared `pure` flag alone is not
accepted as evidence that a helper cannot mutate a caller-owned record.

The [V13 fixture](../../../../test/projection/contract-composites.test.ts)
compares the reference runtime with actual TypeScript, Python and Rust for
preconditions, postconditions, old record values, a generic record identity
helper, pure sequence map/fold callbacks and a rejected precondition. It
checks exact-root round trips, a visible literal edit and tampered generic
call scaffolding, including an exact-address typed-helper import closure.
Adversarial cases reject a direct and transitive
pure-labeled record mutation and an effectful fold callback.

This is bounded production-semantic progress toward V4-T1-02/G1. A valid
capability-free closure predicate still typechecks and runs in the reference
runtime but is rejected by every executable projector; its function value
can hide captured mutable state, so admitting it requires a checked closure
effect/read-only summary. The fixture records this as an explicit G1 gap.
Other valid cross-feature combinations and complete source fidelity remain to
be audited. G2's named boolean, negative division, overflow and effect-call
fixtures already execute in [the scalar campaign](../../../../test/projection/executable.test.ts)
for all three targets; [the all-kind audit](../../../../test/projection/kind-audit.test.ts)
checks 45 kind names in representative contexts. Neither campaign proves
all contexts.

The historical [AE6 report](../agent-ir6/README.md) is unchanged. Its
four unchanged warm wires pass 4×, while cold delivery is 0.941× cl100k
and the complete changed session is 1.141×. FR-1.2's ≥4× requirement and
V4-Q03 therefore remain open. V4-T1-02/G1 is also open independently of
that density requirement; no task or release gate is claimed verified.

Next executable steps: define and check read-only summaries for closures
and task values in contract predicates, then run a larger cross-feature
reference/native differential corpus. Measure a preregistered representative
changed-workload corpus with actual tokenizers, including cold module,
dictionary, full messages, failed edits and responses. Keep every miss in
the result rather than treating the unchanged AE6 warm slice as release
qualification.
