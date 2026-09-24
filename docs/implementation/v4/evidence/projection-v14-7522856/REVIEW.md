# Bounded V14 read-only closure checkpoint

Tested source commit: `752285669fa9ffcbfa6873ab1da55cbee30ef030` on
`agent/t102-closure-readonly`, based on main
`d9be39ec5f8b166d0baadaee12bbeb604a2cba28`.
The worktree was clean before and after verification. Specification version
was `0.1.0`; Node was `v26.7.0`, Python `3.14.7`, and Rust `1.97.1` on macOS.
Dependencies were in a local ignored `node_modules` directory; no external
symlink was used for the closed worker build.

| Command | Result | Raw output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types 'test/projection/*.test.ts'` | 105/105 pass | [projection.log](projection.log) |
| `node --test --experimental-strip-types test/tier1/agent-ir-v6.test.ts` | 4/4 pass | [ae6.log](ae6.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | pass, 62 tasks / 71 obligations | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

The V14 fixture's previously missing pure closure predicate now parses to
the same AST root and runs in actual TypeScript, Python and Rust. A direct
factory captures a scalar parameter; a second postcondition closure reads a
parameter after the owner body reassigns it, matching the reference runtime's
live value. The campaign checks positive and negative preconditions,
postcondition failure, an inline lambda, visible edits, tampered capture
indices, an exact-address imported factory, and rejection of record captures,
capability-bearing closures, opaque targets and recursive factories. V13's
explicit producer retains its prior refusal. Older projection tests, including
the named G2 boolean, negative division/remainder, overflow and effect-call
executions, pass within the 105-test campaign.

**V4-T1-02/G1 remains open.** Two valid AST forms typecheck and run in the
reference runtime but are explicitly rejected in all three native targets:
`Apply` of a function-valued parameter and a pure factory that binds a scalar
block local before returning a closure that captures it. The first needs an
authenticated read-only summary of the passed function value; the second
needs local dataflow proof. The 45-kind round-trip matrix covers representative
contexts, not all declared-semantics combinations. No full G1 manifest is
produced.

G2's named target-language behaviors pass, but this checkpoint did not
measure current V14 corpus token costs, so no G2 manifest is produced. The
unchanged historical [AE6 report](../../../../../roadmap/v4/research/agent-ir6/README.md)
at source `06709eb60525489b44207e38f4fd6aaa2baa8ca4` records 698/124
cl100k tokens (5.629×) for four unchanged warm wires, 878/933 (0.941×)
for cold delivery, and 1,361/1,193 (1.141×) for the complete changed
session. Those are historical measurements, not current-source V14 release
evidence. FR-1.2's ≥4× changed-workload requirement and V4-Q03 remain open;
the tracker stays 20/62 verified.

The six raw log SHA-256 digests can be recomputed with
`shasum -a 256 *.log` in this directory.
