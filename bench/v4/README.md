# Versioned benchmark evidence

Run `npm run bench:v4:measure` to write `manifest.json` and `samples.json` under
`.aether-store/benchmarks/v4/latest`. Override the directory with `-- --output PATH`.
Measurement succeeds when records were produced, including measured misses.

`npm run bench:v4:enforce` produces the same evidence and exits nonzero for every
failed, unmeasured or inconclusive required target. It currently fails. Keep this
command as an open release gate; a successful measurement command is not a
successful release qualification.

`npm run bench:v4:verify -- OUTPUT_DIRECTORY --exact-source` independently
recounts the saved raw corpus with the pinned tokenizer, reconstructs every
measurement/verdict and target profile, checks canonical JSON and artifact
digests, and compares the recorded commit and source bytes with the current
checkout. Omit `--exact-source` to audit a historical artifact's internal
arithmetic without claiming that the current checkout is its source. A valid
failed measurement verifies successfully and reports `releaseEligible: false`;
verification never turns a missed or unmeasured release target into a pass.

Profiles are selected with `-- --profile NAME`:

- `ledger-baseline/1` measures the default ledger corpus with pinned
  `js-tiktoken@1.0.21` / `cl100k_base`. Complete warm messages must reach ≥4× per
  workload and in aggregate. Body, cold and full-session ratios are reported as
  diagnostics and cannot replace the warm-message gate.
- `v4-release/1` (default) additionally inventories all remaining v4 NFRs as
  `not_measured`. Storage, hardware, proof, numerical and other task-specific
  profiles must be implemented before those gates can pass. This inventory
  does not qualify KPI, governance or full release obligations.

The fixture `ledger-baseline/1` measures the cold default module and four warm
unmodified declarations. Its complete session separately requests changing
`feeFor` from `gross/100` to `gross/200`, sends an incorrect candidate, executes
it, reports the failure, sends a repair and executes the passing candidate.
Both candidates round-trip through IR and run with existing runtime contracts.
Raw evidence includes the request, every candidate, actual execution responses,
initial context/dictionary, roles and JSONL framing. No traffic is discarded.

Candidates are generated deterministically in this offline fixture; no model is
called. This is a complete measured change session, not a representative
engineering campaign or an API billing claim. Later live campaigns must capture
all retries, repair attempts and responses. No training or inference is
performed here. Learned-adapter costs belong in later campaign economic evidence.

The reference counts remain 698 TypeScript / 343 IR-body / 375 complete warm
IR-message tokens, and 878/933 cold tokens. The ≥4× target fails. Corpus aggregates
divide summed token counts; they never average individual ratios.

Every manifest binds the full corpus, profile, raw sample artifact, source-file
digests, current Git commit, dirty-tree flag, package lock, tokenizer, OS, CPU,
RAM and Node version. Source digests also cover untracked implementation files
so a dirty run cannot masquerade as pristine commit evidence. Release evidence
must be regenerated on its tested commit. Tokenization is deterministic: one
trial and zero warmup, with no latency claim. Changing the fixture or tokenizer
requires a new declared fixture/profile version and an explanation of count
changes; never adjust a threshold to disguise a miss.
