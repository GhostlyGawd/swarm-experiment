# AE5 exact-base warm references

AE5R is an opt-in research profile for an unchanged function declaration already present in a paid cold `Module`. The receiver first decodes and retains the complete cold module. Each warm message carries `AE5R:<full 256-bit base root in canonical base64url>:<decimal member index>`. The decoder checks the exact base root and member type, and returns a detached declaration. Changed declarations cannot use this profile. Historical Agent-IR wires remain explicit.

The [exact-source measurement](results/warm-b799b38/report.json) at `b799b3884c3543bd12810084a59344aa72e3731c` uses the unchanged `ledger-baseline/1` fixture and actual `js-tiktoken@1.0.21` tokenizers. Four unchanged warm declarations reconstruct from the paid cold module; a fresh receiver process test shows that the only receiver context is that cold wire.

| Tokenizer | Four warm TypeScript messages | Four AE5R references | Warm ratio | Cold TypeScript / AE1 ratio | Complete change-session ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| cl100k_base | 698 | 148 | 4.716× | 0.941× | 1.110× |
| o200k_base | 706 | 144 | 4.903× | 0.952× | 1.125× |

The warm slice passes 4× only because it reuses declarations that were already charged in the cold message. Cold and complete changed-session results still miss 4×. The complete session column retains the existing AE1 changed messages; it does not substitute AE5R for edits. This is not a V4-T1-02, FR-1.2, Q03 or release benchmark pass. The separate ten-workload AE4 campaign remains at 0.651× cl100k cold and 1.411× complete session versus the unchanged legacy TypeScript review baseline.

Run `node --experimental-strip-types roadmap/v4/research/agent-ir5/measure.ts verify roadmap/v4/research/agent-ir5/results/warm-b799b38` from the exact clean source commit to recount the retained [messages](results/warm-b799b38/messages.json) and check source hashes. The verifier intentionally refuses another commit or a dirty tree. [Integration evidence](../../../../docs/implementation/v4/evidence/integration-b799b38/REVIEW.md) records the full source test run.

Next experiment: a root-bound sparse edit for the changed `feeFor` declaration, with cold, changed-message, retry/repair and full-session costs charged in both tokenizers. No unchanged-reference win is transferable to an edit without that measurement.
