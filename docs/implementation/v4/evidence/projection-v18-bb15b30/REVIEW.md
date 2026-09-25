# Bounded V18 fresh-record task projection checkpoint

Tested source commit: `bb15b308a962c4d08bb778f2e210eaff455aec54`
on `agent/t102-record-task-v18`, based on main
`cd605d455ecf0dfe3d58c5b6384727ad03d9fb93`. The worktree was clean
before and after verification. Specification version was `0.1.0`; Node was
`v26.7.0`, Python `3.14.7`, Rust `1.97.1` on macOS, and actual token counts
used `js-tiktoken` `1.0.21`. Dependencies were in a local ignored
`node_modules` directory.

| Check | Result | Raw output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types 'test/projection/*.test.ts'` | 127/127 pass | [projection.log](projection.log) |
| `node --test --experimental-strip-types test/tier1/agent-ir-v6.test.ts` | 4/4 pass | [ae6.log](ae6.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | pass, 62 tasks / 71 obligations | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

The V18 target fixture executes a newly spawned task that constructs a
fresh scalar-field record, awaits it and immediately reads one field in
actual TypeScript, Python and Rust. Direct and passed-function calls match
the reference runtime; an intentionally wrong field value fails the
precondition. External-effect callback count is zero despite a host sink
being installed. The source and parser round-trip the exact AST root,
reject stale visible edits and altered certificate/runtime bytes, and
accept a regenerated bundle for a changed AST root. This proves the
bounded scalar field outcome. It does not prove identity or alias parity
after a record task result escapes. Pinned V17 source/runtime SHA-256 bytes
remain identical in all three targets.

## Generated audit and actual token costs

The [machine-readable report](report.json) retains 75 deterministic AST
cases (15 body forms × five carriers), each typechecked and executed by the
reference runtime, and 225 native target parser/round-trip outcomes. It
records **180 round trips and 45 open outcomes** across three
reference-valid Task contexts: unjoined task identity, sequence-valued task
results and identity comparison of awaited records. In each body form, four
carriers are explicitly rejected; a passed-function carrier parses but
has no certificate and is refused at contract execution. The [raw model
and legacy-review strings](samples.json) are retained. This is an authored
diagnostic corpus, not representative autonomous code or complete language
coverage.

| Actual tokenizer | Legacy TypeScript review | Complete AE2 model | Ratio of sums | 4× diagnostic |
| --- | ---: | ---: | ---: | --- |
| cl100k_base | 9,119 | 31,522 | 0.2893× | fail |
| o200k_base | 9,137 | 31,217 | 0.2927× | fail |

The independent verifier recounts every raw sample and aggregate,
regenerates all 75 ASTs and 225 native classifications, checks source
hashes and the tested commit or an evidence-only descendant, and returns
`verified:true, sourceMatches:true`. [Audit output](audit.log),
[verification output](verify.log). A copied report with one sample ID
changed fails with exit 1 before recount; the [tamper output](tamper.log)
is retained. Reproduce from this evidence commit:

```sh
node --experimental-strip-types roadmap/v4/research/projections/verify-valid-contexts-v18.ts docs/implementation/v4/evidence/projection-v18-bb15b30 --exact-source
```

**V4-T1-02/G1 remains open.** The three Task forms are concrete
reference-valid missing contexts, and combinations outside the generator
remain unaudited. G2's named boolean, negative division, overflow and
effect-call fixtures pass in the projection suite, but this authored audit
is not the representative changed-session measurement required by FR-1.2
or V4-Q03. The unchanged historical [AE6 report](../../../../../roadmap/v4/research/agent-ir6/README.md)
at source `06709eb60525489b44207e38f4fd6aaa2baa8ca4` records 5.629×
for four unchanged warm wires, 0.941× cold and 1.141× for the complete
changed session (cl100k). Those values are historical and were not relabeled
as a V18 release result. No T1-02 gate manifest was produced; the tracker
remains **20/62 verified**. The whole repository serial suite was not run
in this worktree.

V18 certificates and the native whitelist bind parser-checked source bytes,
not a hostile same-process host. Code with access to the exported certificate
constructor could reuse a known certificate; this slice does not establish
hostile-adapter containment, signed Artifact admission or ProcessHost effect
safety.
