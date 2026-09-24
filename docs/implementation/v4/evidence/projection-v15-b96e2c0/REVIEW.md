# Bounded V15 projection checkpoint

Tested source commit: `b96e2c06623e36620462b6684091a09dcd5b6e4a` on
`agent/t102-closure-dataflow`, based on main
`2ac1259023258b0af2d292a2c3ef325cd0ecaeaa`. The worktree was clean
before and after these commands. Specification version was `0.1.0`; Node was
`v26.7.0`, Python `3.14.7`, and Rust `1.97.1` on macOS. Dependencies were in
an ignored local `node_modules` directory, so the worker-bundle closed-import
check did not depend on an external symlink.

| Command | Result | Raw output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types 'test/projection/*.test.ts'` | 116/116 pass | [projection.log](projection.log) |
| `node --test --experimental-strip-types test/tier1/agent-ir-v6.test.ts` | 4/4 pass | [ae6.log](ae6.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | pass, 62 tasks / 71 obligations | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

V15's native fixtures compare reference execution with actual TypeScript,
Python and Rust for a passed function value, scalar block-local capture,
local function binding and both direct `If` factory arms. They exercise
contract preconditions/postconditions and refuse a raw host closure, a
record-capturing closure and a passed closure whose direct helper call lacks
a checked certificate before executing its body. TypeScript and Python also
refuse a certified closure after host capture mutation. Rust retains closure
custody by `Rc` identity and compares the body, metadata and capture snapshot.
The parser checks exact AST roots, exact-address imported factory roots,
owner-only and lambda edits, altered certificate sites/headers and matching
runtime whitelist bytes. Earlier V2–V14 projection tests still pass.

**V4-T1-02/G1 remains open.** The [valid-context audit](../../../../../test/projection/contract-context-audit.test.ts)
retains three typechecked, reference-executed counterexamples: branch-local
captures and a quantifier binder inside a lambda are explicitly rejected;
a passed lambda with a direct pure helper call round-trips but has no V15
certificate and is denied at native contract execution. These are current
gaps in complete declared-semantics coverage, beyond the 45/45 named-kind
representative matrix. No full G1 or G2 manifest is produced.

The closure marker is derived from the checked `/15` profile, exact owner
declaration root and exact lambda root. Parser and matched runtime recheck
the header's certificate set. This is a trusted native-source boundary,
not same-process hostile-host containment: code with access to the exported
certificate helper can reuse a known certificate. An ordinary host-created
`ae_lambda` is refused. ProcessHost/Artifact custody would need a separate
qualification for hostile execution.

G2's named boolean, negative division, fixed overflow and effect-call native
fixtures pass in the 116-test suite. This checkpoint did not measure current
V15 corpus token costs. The unchanged historical [AE6 report](../../../../../roadmap/v4/research/agent-ir6/README.md)
at source `06709eb60525489b44207e38f4fd6aaa2baa8ca4` records 698/124
cl100k tokens (5.629×) for four unchanged warm wires, 878/933 (0.941×)
cold, and 1,361/1,193 (1.141×) for the complete changed session. Those
are historical measurements, not current V15 release evidence. FR-1.2's
≥4× changed-workload requirement and V4-Q03 remain open. The tracker stays
20/62 verified. The whole repository serial suite was not run in this
worktree.

The six raw log SHA-256 digests are reproducible with `shasum -a 256 *.log`
in this directory.
