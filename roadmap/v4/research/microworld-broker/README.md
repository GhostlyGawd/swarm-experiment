# Effectful living micro-world companion campaign

This is a bounded research extension of `src/tier3/living-campaign.ts`. Each
preregistered case first executes an exact generated `faulted-json-network`
case against the actual Aether module from `../microworld/fixture.ts`. It then
passes a serialized intent through a deterministic host queue into an actual
Aether `Runtime` ledger transfer, `BrokerEffectRouter`, and
`DurableEffectBroker`. This does **not** add live effects to the production
LivingCampaign profile or make its admission receipt authorize production use.

The host queue supports partition, withheld delivery, duplicate, drop and heal.
The sink persists one file per effect ID and fsyncs the file and directory. The
broker journals the request before dispatch. The full schedule injects one
failure when persisting the committed receipt after the sink has acted. It
reopens the broker, reconciles the uncertain effect from the sink record, retries
the duplicated delivery, then consumes all terminal journal events in replay
mode with policy and live adapter callbacks forbidden.

Two candidate identity policies run the same cases. The correct policy assigns
the same logical execution ID to every delivery; the router assigns its first
operation ID consistently. The seeded faulty policy derives the execution ID
from the delivery attempt. Duplicate frames then become two distinct
effects and write the sink twice. The shrinker removes one action at a time,
preserving the exact `duplicate-effect` failure, and stores the original and
reduced case with their replay results. It does not claim globally minimal
counterexamples.

## Evidence and limits

`results/campaign01/` is preregistered before timing. Its registration keeps
the Git head, worktree status, profile, all generated cases, hardware/runtime
diagnostics and SHA-256 pins of 27 transitive source/dependency files. Every
case observation, broker journal, sink write, and shrink attempt is retained.
The verifier checks the source pins, regenerates cases, replays all original
cases and both counterexample forms, and checks recorded broker/sink bytes
against their digests. It checks the arithmetic of the reported throughput;
it does not repeat historical timing.

On the registered Apple M4 Pro / Node v26.7.0 run (Git head
`f3a5a4ed68a86f3dfe0f813c09b7383ae2d7df06`, exact source pins in the
registration; this harness was uncommitted at registration), all six stable-ID
cases passed and all six attempt-ID cases
exposed two durable sink writes. The good cases each produced one broker event
and consumed it in isolated replay; the broken cases each produced two. The
injected post-sink receipt failure was reconciled after reopening. One faulty
case shrank from 14 actions to four (`send`, `duplicate`, `deliver`, `deliver`)
in 36 attempts and 10 accepted reductions. Original-case execution plus raw
publication and that shrink took 5,039.925 ms: **2.38 original cases/s** using
12 original cases as the numerator. The exact-source verifier passed, and a
separate altered sink file was rejected by the raw-artifact audit.

The timer covers all original case execution, durable observation writes and
one bounded shrink campaign. The reported rate uses **12 original cases** as
the numerator, and includes shrink time in the denominator. Thus it is an
honest complete-campaign rate for this local profile, not the rate of the R04
four-field JSON kernel and not millions of distributed cases per second.
The original companion has no socket or independent host partition, native-thread
race, real process SIGKILL, independent distributed sink, or full effectful Aether
candidate admission. The extension below covers the socket and process crash
boundaries only; the other gaps remain open for V4-T3-03.

## Independent process and TCP extension

`process-harness.ts` and `process-worker.ts` add a separately measured bounded
campaign. Real loopback TCP connections carry each request to an independent
worker process. An incomplete request is disconnected, a malformed request is
rejected, and neither can dispatch an effect. The first valid request runs an
Aether ledger transfer through `BrokerEffectRouter` and `DurableEffectBroker`.
The worker receives `SIGKILL` after its adapter fsyncs the sink record and
before the broker persists the committed receipt. A new worker explicitly
recovers the dead journal owner, reconciles the uncertain effect from the sink,
receives a duplicate request, and replays every terminal event with live policy
and adapter callbacks forbidden. Stable logical IDs produce one sink write;
attempt-derived IDs produce two and fail the same invariant.

The fixed network/process boundary schedule runs for three seeded source
network cases per candidate. Source cases vary; the process fault sequence is
fixed. The actual socket is disconnected for incomplete frames. This does not
simulate a host-level partition or qualify arbitrary effectful candidate
admission. The production `LivingCampaign` still rejects live effects.

[Historical exact-source campaign evidence](../../../../docs/implementation/v4/evidence/t303-process-aa7285c/REVIEW.md)
pins clean commit `aa7285c`, profile and transitive source hashes. All six
declared/generated cases executed, with zero filters. Stable IDs passed 3/3;
attempt-derived IDs failed 3/3 with `duplicate-effect`. All six cases and raw
broker/sink records replayed under the verifier. The complete campaign took
2,966.8315 ms, or **2.0224 cases/s**, versus the unchanged R04 threshold of
2,000,000 boundary permutations/s. It therefore fails T3-03/G2. The earlier
four-field JSON kernel pass cannot be substituted for this complete campaign.

The [current-source refresh](../../../../docs/implementation/v4/evidence/t303-process-4b5b7a7/REVIEW.md)
repeats all six cases after signed effectful `LivingCampaign` was added. It
verified 6/6 with zero filters and ran at 2.6580 complete cases/s. The earlier
exact-source verifier remains reproducible only at its registered source bytes.

```sh
node --experimental-strip-types --test roadmap/v4/research/microworld-broker/process-harness.test.ts
node --experimental-strip-types roadmap/v4/research/microworld-broker/process-campaign.ts --verify docs/implementation/v4/evidence/t303-process-4b5b7a7
```

## Reproduce

From the repository root, with the pinned source bytes:

```sh
node --experimental-strip-types --test roadmap/v4/research/microworld-broker/harness.test.ts
node --experimental-strip-types roadmap/v4/research/microworld-broker/campaign.ts --verify roadmap/v4/research/microworld-broker/results/campaign01
```

To preregister a separate local attempt:

```sh
node --experimental-strip-types roadmap/v4/research/microworld-broker/campaign.ts --register /tmp/aether-microworld-broker-new
node --experimental-strip-types roadmap/v4/research/microworld-broker/campaign.ts --run /tmp/aether-microworld-broker-new
```

`--run` refuses an existing attempt. An interrupted run leaves raw data but
cannot be called a complete campaign until its final results file exists.
