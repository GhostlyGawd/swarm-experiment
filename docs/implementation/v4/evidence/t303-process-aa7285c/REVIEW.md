# T3-03 process/socket campaign: measured failure and bounded correctness

Registration preceded timing on clean source commit `aa7285c`. `registration.json`
pins the profile, package lock and transitive source bytes, and records Apple M4
Pro, macOS 25.6.0, Node v26.7.0 and load diagnostics. `attempt.json` marks the
run. `results.json`, six case observations, broker journals and durable sink
files retain raw evidence. The verifier checks source pins, regenerated cases,
every original result, broker/sink digests, seed/count/coverage arithmetic and
six new process/socket replays. It does not reproduce historical wall time.

| Measure | Actual |
| --- | ---: |
| Declared / generated / executed / filtered | 6 / 6 / 6 / 0 |
| Stable-ID candidate survival | 3 / 3 |
| Attempt-derived-ID candidate failures | 3 / 3 duplicate effects |
| Seeds | `20260924/process-broker/0`, `/1`, `/2` |
| Complete process/socket elapsed | 2,966.8315 ms |
| Complete original case rate | 2.0224 cases/s |
| Fixed R04 threshold | 2,000,000 boundary permutations/s |
| T3-03 G2 throughput | **Failed** |

Each case executes a generated Aether source network case, then runs the fixed
process fault sequence through real loopback TCP and an independent worker. A
disconnected partial frame and malformed frame produce no effect. The first
valid request causes a real `SIGKILL` after the sink fsync and before the broker
receipt; a new worker performs explicit dead-owner lock recovery and sink
reconciliation. The duplicate request is idempotent only with a stable logical
execution ID. Isolated replay consumes every committed event with live adapter
and policy callbacks forbidden. Six coverage labels are present in every case,
listed in `results.json`; process IDs in observations show replacement workers.

This strengthens the bounded G1 fault/recovery evidence. The earlier broker
companion retains a persisted shrunk duplicate-write counterexample. This new
campaign uses a fixed process fault schedule across three source network cases;
it does not shrink a process schedule, admit arbitrary effectful candidate
modules, simulate a host-level partition, or exercise production deployment.
The local `LivingCampaign` continues to deny live effects. It cannot close G1
or G2 for the full FR-3.3 scope, and `V4-T3-03` remains **in progress**.

The timing includes worker launches, six real process kills, recovery, replay,
and durable raw observation publication. Registration and final report publication
are excluded. This rate is a complete bounded campaign rate, not the fast
four-field JSON kernel rate; no inference to millions of distributed cases is
supported.

Reproduce the exact-source audit:

```sh
node --experimental-strip-types roadmap/v4/research/microworld-broker/process-campaign.ts --verify docs/implementation/v4/evidence/t303-process-aa7285c
node --experimental-strip-types --test roadmap/v4/research/microworld-broker/process-harness.test.ts
npm run typecheck
```
