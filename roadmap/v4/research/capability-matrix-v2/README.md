# Capability boundary matrix, campaign 1

This is an adversarial research campaign for V4-T2-04. It exercises real
`TopologyHost`, `ProcessHost`, and `ProcessDeployment` boundaries. It does
not certify that task: one finite campaign cannot cover the entire authority
graph or all worker and broker fault schedules.

Run from the repository root:

```sh
node --experimental-strip-types roadmap/v4/research/capability-matrix-v2/run.ts
node roadmap/v4/research/capability-matrix-v2/verify.mjs --exact-source
```

The runner writes `results/campaign-01.json` only after the cases finish. It
records the Git commit and SHA-256 of every tracked `src/` file and the two
campaign programs, every case's expected outcome, actual result, effect-sink
count, and authoritative heap digest. Run it after the programs and all
runtime source edits are committed; the verifier requires `sourceCommitted`.
The
verifier is separate from the runner and refuses missing cases, a changed
source snapshot, an unexpected live sink call, or heap publication on denial.

The test matrix distinguishes pre-admission denial, in-flight revocation,
final-publication revocation, and retry/reopen behavior. Positive controls
prove that a valid nested cross-process call reaches a live broker sink and
that a valid deployment invocation changes the authoritative heap. A completed external
effect before a later revocation is recorded as such, not retroactively counted
as zero effects. A failed case remains in the raw JSON for debugging.

The deployment cases use the `scoped-v2` profile with a real admitted genesis
artifact and `ProcessHost` workers. They exercise the deployment admission
boundary and historical receipt gate; ProcessHost cases exercise a real
`DurableEffectBroker` through `BrokerEffectRouter`.

## Boundaries this does not prove

- Every distributed process/worker interleaving or real network partition.
- Isolated Wasm V6, independently signed policy V5, and packed native controls.
- Revocation during an actual adapter execute syscall; the hook fires before
  dispatch to the sink.
- Full closure/task transfer across a process boundary. Current process
  runtime rejects live closure migration; that limitation is recorded.
- Formal noninterference or the full V4-T2-04 acceptance gate.
