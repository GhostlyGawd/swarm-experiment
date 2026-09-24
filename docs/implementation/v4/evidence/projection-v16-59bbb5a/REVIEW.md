# Bounded V16 closure projection checkpoint

Tested source commit: `59bbb5a8f0faa930b08c485fe0a873e0bc207bec`
on `agent/t102-closure-v16`, based on main
`21e42c97ab79a694b5da820ed1144ac6a76c1fd6`. The worktree was clean
before and after verification. Specification version was `0.1.0`; Node was
`v26.7.0`, Python `3.14.7`, Rust `1.97.1` on macOS, and actual token counts
used `js-tiktoken` `1.0.21`. Dependencies were in a local ignored
`node_modules` directory.

| Check | Result | Raw output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types 'test/projection/*.test.ts'` | 119/119 pass | [projection.log](projection.log) |
| `node --test --experimental-strip-types test/tier1/agent-ir-v6.test.ts` | 4/4 pass | [ae6.log](ae6.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | pass, 62 tasks / 71 obligations | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

V16's actual TypeScript, Python and Rust fixture executes scalar locals in
both `If` factory arms, quantifier and Result binders, passed closures with
exact-root pure helper calls, sequence map/fold callbacks, nested immediate
lambdas and fresh scalar record reads. It compares outcomes with the
reference runtime. A helper-body edit changes the derived certificate;
an exact-address imported helper closes over its dependency root. Raw host
closures and record captures are refused before their callbacks run.
TypeScript and Python also refuse a certified closure after host capture
mutation. A pinned V15 fixture's source and runtime SHA-256 hashes are
byte-identical in all three targets.

## Generated audit and actual token costs

The [machine-readable report](report.json) retains 55 deterministic AST
cases (11 closure bodies × five carriers), each typechecked and executed by
the reference runtime, and 165 native target parser/round-trip outcomes.
It records **150 round trips and 15 open outcomes**: the effect-free lazy-task
closure fails across all five carriers and three targets. Four carriers are
explicitly rejected; a passed-function carrier parses but receives no
certificate and is refused before native contract execution. The [raw
model and legacy-review strings](samples.json) are retained for both
tokenizers. This is an authored diagnostic corpus, not representative
autonomous code or full language-semantic coverage.

| Actual tokenizer | Legacy TypeScript review | Complete AE2 model | Ratio of sums | 4× diagnostic |
| --- | ---: | ---: | ---: | --- |
| cl100k_base | 6,560 | 22,977 | 0.2855× | fail |
| o200k_base | 6,572 | 22,735 | 0.2891× | fail |

The independent verifier recounts every raw sample and aggregate,
regenerates all 55 ASTs and all 165 native classifications, checks source
hashes and the tested commit or its evidence-only descendant, and returns
`verified:true, sourceMatches:true`.
[Audit output](audit.log), [verification output](verify.log). A copied report
with one sample ID changed fails the verifier with exit 1 before recount;
the [tamper output](tamper.log) is retained. Reproduce from this evidence
commit; the verifier checks that its only change after the tested code commit
is this evidence directory:

```sh
node --experimental-strip-types roadmap/v4/research/projections/verify-valid-contexts-v16.ts docs/implementation/v4/evidence/projection-v16-59bbb5a --exact-source
```

**V4-T1-02/G1 remains open.** The lazy-task case is a concrete
reference-valid missing context, and combinations outside this generator
remain unaudited. G2's named boolean, negative division, overflow and
effect-call fixtures pass in the projection suite, but the current audit is
not the representative changed-session measurement required by FR-1.2 or
V4-Q03. The unchanged historical [AE6 report](../../../../../roadmap/v4/research/agent-ir6/README.md)
at source `06709eb60525489b44207e38f4fd6aaa2baa8ca4` records 5.629×
for four unchanged warm wires, 0.941× cold and 1.141× for the complete
changed session (cl100k). Those values are historical and were not relabeled
as a V16 release result. No T1-02 gate manifest was produced; the tracker
remains **20/62 verified**. The whole repository serial suite was not run
in this worktree.

V16 certificates and the native whitelist bind parser-checked source bytes,
not a hostile same-process host. Code with access to the exported certificate
constructor could reuse a known certificate; this slice does not establish
hostile-adapter containment, signed Artifact admission or ProcessHost effect
safety.
