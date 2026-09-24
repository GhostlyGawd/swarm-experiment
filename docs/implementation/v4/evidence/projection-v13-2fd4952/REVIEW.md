# Bounded V13 projection checkpoint

Tested source commit: `2fd495219f900538497880da35d67bdec7cee502` on
`agent/t102-closure`, based on `33068d28a7e8d971808981c670ffd2a030d1e311`.
The worktree was clean before and after these commands. Specification version
was `0.1.0`; Node was `v26.7.0`, Python `3.14.7`, and Rust `1.97.1` on macOS.
The local `node_modules` directory held the repo's pinned package tree. The
first attempted build with an external symlink was rejected by the worker
bundle's closed-import-graph check; that setup attempt is not counted below.

| Command | Result | Raw output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types 'test/projection/*.test.ts'` | 99/99 pass | [projection.log](projection.log) |
| `node --test --experimental-strip-types test/tier1/agent-ir-v6.test.ts` | 4/4 pass | [ae6.log](ae6.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | pass, 62 tasks / 71 obligations | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

The projection suite includes actual TypeScript, Python and Rust execution of
booleans, negative division and remainder, arbitrary and fixed-width overflow,
and effect calls. The new V13 cases execute composite/generic contract helpers,
map/fold callbacks, old record reads, precondition refusal and source edits.
They reject mutation in direct/transitive pure-labeled helpers, effectful
callbacks, and tampered generic call scaffolding. An exact-address typed helper
bundle parses to the original entry and dependency roots. The all-kind audit
round-trips all 45 named AST kinds in representative contexts.

**V4-T1-02/G1 is not verified.** The added negative fixture is a concrete
counterexample to complete declared-semantic coverage: a capability-free
closure predicate typechecks and returns `1` in the reference runtime, while
all three native projectors refuse it. A checked closure effect/read-only
summary and broader cross-feature differential corpus are next. G2's four
named target-language behaviors pass, but current V13 corpus token costs were
not measured in this checkpoint, so no G2 closure manifest is produced.

The unchanged historical [AE6 report](../../../../../roadmap/v4/research/agent-ir6/README.md)
measured actual cl100k tokens: 698/124 (5.629×) for four unchanged warm
wires, 878/933 (0.941×) cold, and 1,361/1,193 (1.141×) for the complete
changed session. Its pinned source is `06709eb60525489b44207e38f4fd6aaa2baa8ca4`;
this checkpoint did not rerun the AE6 token campaign or recast those historic
ratios as current-source release evidence. FR-1.2's ≥4× changed-workload
requirement and V4-Q03 remain open independently of T1-02's projection gate.
The tracker remains 20/62 verified. No V4-T1-02 gate manifest was created.

SHA-256 of the six raw logs is recorded by `shasum -a 256 *.log` in this
directory; the exact hashes can be recomputed from these retained files.
