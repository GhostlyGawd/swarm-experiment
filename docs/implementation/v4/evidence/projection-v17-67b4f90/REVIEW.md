# Bounded V17 pure lazy-task projection checkpoint

Tested source commit: `67b4f90b4375eefe6644723ceb1830a7f6878ff8`
on `agent/t102-lazy-task-v17`, based on main
`9a0ecb8a38c60f58b1215ed7f4a5951d024edda9`. The worktree was clean
before and after verification. Specification version was `0.1.0`; Node was
`v26.7.0`, Python `3.14.7`, Rust `1.97.1` on macOS, and actual token counts
used `js-tiktoken` `1.0.21`. Dependencies were in a local ignored
`node_modules` directory.

| Check | Result | Raw output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types 'test/projection/*.test.ts'` | 121/121 pass | [projection.log](projection.log) |
| `node --test --experimental-strip-types test/tier1/agent-ir-v6.test.ts` | 4/4 pass | [ae6.log](ae6.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | pass, 62 tasks / 71 obligations | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

The V17 native fixture executes a directly awaited new scalar task inside
a checked contract closure in actual TypeScript, Python and Rust, both inline
and through a passed function value. Reference and target outcomes match.
It also exercises a division-by-zero task fault and observes zero actual
external-effect callbacks despite a host effect callback being installed.
The checked grammar requires each `Spawn` to be the direct child of its own
`Await`, with a scalar callback-free body and scalar captures. The existing
native continuation tests in the same 121-test suite separately cover task
laziness, completed-result caching, revocation and fault reset; V17 itself
qualifies the fresh direct-await form, not persisted or shared task state.
Raw host closures and record captures remain refused before callback
execution. A pinned V16 fixture's source and runtime SHA-256 hashes are
byte-identical in all three targets.

## Generated audit and actual token costs

The [machine-readable report](report.json) retains 65 deterministic AST
cases (13 body forms × five carriers), each typechecked and executed by the
reference runtime, and 195 native target parser/round-trip outcomes. It
records **165 round trips and 30 open outcomes**. Two reference-valid Task
contexts remain outside V17: a newly spawned task returning a fresh record
followed by a field read, and identity comparison of two unjoined new tasks.
For each context, four carriers are explicitly rejected while a
passed-function carrier parses but has no certificate and is refused at
contract execution. The [raw model and legacy-review strings](samples.json)
are retained. This is an authored diagnostic corpus, not representative
autonomous code or full language-semantic coverage.

| Actual tokenizer | Legacy TypeScript review | Complete AE2 model | Ratio of sums | 4× diagnostic |
| --- | ---: | ---: | ---: | --- |
| cl100k_base | 7,780 | 27,233 | 0.2857× | fail |
| o200k_base | 7,792 | 26,974 | 0.2889× | fail |

The independent verifier recounts every raw sample and aggregate,
regenerates all 65 ASTs and 195 native classifications, checks source
hashes and the tested commit or an evidence-only descendant, and returns
`verified:true, sourceMatches:true`. [Audit output](audit.log),
[verification output](verify.log). A copied report with one sample ID
changed fails with exit 1 before recount; the [tamper output](tamper.log)
is retained. Reproduce from this evidence commit:

```sh
node --experimental-strip-types roadmap/v4/research/projections/verify-valid-contexts-v17.ts docs/implementation/v4/evidence/projection-v17-67b4f90 --exact-source
```

**V4-T1-02/G1 remains open.** Both Task cases are concrete
reference-valid missing contexts, and combinations outside the generator
remain unaudited. G2's named boolean, negative division, overflow and
effect-call fixtures pass in the projection suite, but this authored audit
is not the representative changed-session measurement required by FR-1.2
or V4-Q03. The unchanged historical [AE6 report](../../../../../roadmap/v4/research/agent-ir6/README.md)
at source `06709eb60525489b44207e38f4fd6aaa2baa8ca4` records 5.629×
for four unchanged warm wires, 0.941× cold and 1.141× for the complete
changed session (cl100k). Those values are historical and were not relabeled
as a V17 release result. No T1-02 gate manifest was produced; the tracker
remains **20/62 verified**. The whole repository serial suite was not run
in this worktree.

V17 certificates and the native whitelist bind parser-checked source bytes,
not a hostile same-process host. Code with access to the exported certificate
constructor could reuse a known certificate; this slice does not establish
hostile-adapter containment, signed Artifact admission or ProcessHost effect
safety.
