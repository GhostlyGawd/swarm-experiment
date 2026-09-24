# D14 — Fuel-safe semantic cleanup and retention publication

Status: bounded T1-05 safety repair. T1-05/G1 and G2 remain open; specification 0.1.0 and all acceptance thresholds are unchanged.

## Decision

The reference runtime counts executed statements and expressions against `maxSteps`. Flattening a proved constant `If` or redirecting a forwarding call can therefore change a visible fault and whether a later effect reaches its sink. A differential example found limits at which the old source exhausted its budget before an `Invoke` while the shortened candidate invoked the sink. A value-only equivalence certificate cannot authorize that difference.

The new `aether.semantic-gc-fuel-preserving-branches/1` profile keeps the original `If` or `Cond`, original condition and executed arm. It replaces only the proved unreachable arm with a copy of the selected arm so both branches remain typed. The portable total-condition proof still establishes that the copied cold slot cannot execute; deleting its old references can remove newly unreachable declarations. The executed reference-runtime path, step points, effect order and contracts remain unchanged under the tested finite budgets. Historical branch and shim proposal formats remain readable. New promotion of a proposal that collapses wrappers, retires scalar shims or uses the older flattened-branch profiles is refused before the coordinator starts a decision. Recovery and activation of a decision already durably committed under a historical profile remain available.

Adapter retirement now holds the semantic-retention lock while it rechecks a proposed snapshot and publishes the candidate table. A concurrent `retain()` cannot land between the final check and publication; a cross-process test exercises that interleaving. This protects the candidate sidecar only. `DurableTreeWorkspace` also pins imported frame content before publishing the operation and rebuilds current-epoch content pins on reopen before releasing retired leases. A missing referenced AST object aborts ingest or reopen instead of leaving an apparently valid frame for collection.

## Remaining work

Full wrapper and shim collapse needs a versioned execution mechanism that reproduces the removed call's exact fuel, trace and fault placement, or another proof of observational equivalence under every admitted runtime budget. A static up-front step debit is insufficient for path-dependent evaluation. The new profile does not cover general value types, effectful helper replacement, opaque imports or broad path reasoning.

Production adapter retirement still needs a signed, versioned binding between its registration table and ProcessDeployment's effect policy, governor decision, historical generation and replay artifacts. The sidecar cannot change the live deployment. Active task and replay producers still do not write complete authoritative semantic-retention records; monotone manual pins and TreeWorkspace pins do not establish full G2 lifecycle coverage. Distinct crash, rollback and concurrent promotion campaigns remain required before either T1-05 gate is verified.

The repository's default test command now runs test files serially. This preserves per-test proof, worker and controller deadlines while avoiding unrelated file-level contention seen in two red full-suite runs. The [exact-source checkpoint](../evidence/integration-9e092d9/REVIEW.md) retains a clean uninterrupted complete run; isolated reruns alone did not substitute for it.
