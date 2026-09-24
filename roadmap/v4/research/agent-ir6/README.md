# AE6 cold-bound ledger measurement

The pinned source is `06709eb60525489b44207e38f4fd6aaa2baa8ca4`.
The [dual-tokenizer report](results/source-06709eb/report.json) and
[raw strings](results/source-06709eb/samples.json) retain the complete cold
module, four unchanged warm declarations, the `/200` changed edit, the changed
full module, and all seven session messages. The
[release-profile manifest](results/source-06709eb/release/manifest.json) and
[benchmark samples](results/source-06709eb/release/samples.json) retain the
cl100k run with source hashes, environment, verdicts and unmeasured targets.

| Boundary | cl100k TypeScript / AE6 | Ratio | o200k TypeScript / AE6 | Ratio |
| --- | ---: | ---: | ---: | ---: |
| Cold complete module | 878 / 933 | 0.941× | 886 / 931 | 0.952× |
| Four unchanged warm wires | 698 / 124 | 5.629× | 706 / 124 | 5.694× |
| Four JSONL-framed warm messages | 791 / 172 | 4.599× | 803 / 172 | 4.669× |
| Changed `feeFor` declaration / E6 edit | 120 / 66 | 1.818× | 123 / 66 | 1.864× |
| Changed complete module | 878 / 933 | 0.941× | 886 / 931 | 0.952× |
| Full seven-message change session | 1361 / 1193 | 1.141× | 1377 / 1191 | 1.156× |

The `R6` and `E6` messages were emitted by the public codec from AST inputs,
decoded against the complete paid cold wire, and the changed module was run
through the runtime. The complete warm-wire benchmark uses the same TypeScript
baseline, four declarations and count boundary as `ledger-baseline/1`.
Historical AE1 corpus content matches the retained earlier sample corpus.
The warm gate passes for this deterministic fixture; cold, changed declarations
and full session remain below 4×. This is not a representative autonomous
campaign, a live model bill, or V4-Q03/FR-1.2 completion.

From a clean checkout of the pinned source, reproduce and independently verify:

```sh
node --experimental-strip-types roadmap/v4/research/agent-ir6/measure.ts verify roadmap/v4/research/agent-ir6/results/source-06709eb
node --experimental-strip-types bench/v4/verify.ts roadmap/v4/research/agent-ir6/results/source-06709eb/release --exact-source
```

The clean source passed 10 focused tests, typecheck, build and roadmap checks.
The release profile passed the ledger warm target but retained 15 required
unmeasured targets, so release enforcement exited 1.
