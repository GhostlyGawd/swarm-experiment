# Living micro-world campaign, bounded profile

`src/tier3/living-campaign.ts` adds the opt-in
`aether.living-cooperative-campaign/1` profile. Existing v1 micro-world APIs and
acceptance rules are unchanged.

## Execution and admission

`LivingCampaign({ manifest, module, registry, directory })` binds a complete,
statically checked Aether module root to immutable manifest bytes.
`generate()` produces deterministic cases; `execute(case)` runs a concrete case;
`run()` retains case evidence and shrunk failures before publishing a report.
`admit(report)` accepts only the unmodified executor-produced report with all
declared cases passing, zero precondition exclusions, and all coverage obligations
met. Serialized success flags cannot authorize admission. The returned receipt
explicitly has `productionAuthorized: false`; production admission still requires
the fabric's signed evidence/quorum path.

The cooperative scheduler executes actual Aether functions on one shared heap.
An exhaustive schedule declaration must name the exact number of interleavings;
an insufficient bound is rejected before execution. Seeded campaigns declare their
finite sampled scope. Actor operation order is preserved. Shared read/write
fixtures expose real lost updates under four of six schedules.

Resource steps allocate and touch actual `Uint8Array` bytes, account for a declared
quota, refuse excess allocations, and release/reuse reservations. The Aether
fixture consumes the actual success/refusal result. This is a bounded host quota
model, not process RSS exhaustion or Aether heap allocation failure injection.

Network steps materialize serialized JSON frames, modify actual frame bytes or
checksum fields, queue/drop/duplicate/deliver them, and parse incoming frames.
Malformed/empty ingress is explicitly counted. Valid corrupted frames reach the
Aether candidate, which evaluates checksum/sequence guards. Undelivered frames
block success. These are deterministic in-memory network semantics, not sockets
or distributed hardware. Event ordering is exercised by delivering a later event
before an earlier one; the candidate rejects the stale sequence.

No ambient/live effect adapter is accepted. Invocations fail explicitly through
an isolated denying router; the old implicit successful Unit effect is not used.
This initial profile therefore does not qualify effectful adapter replay/outage
campaigns or all production module types. Entry values support scalar arguments,
scalar results and references to declared scalar-field records. Generic/opaque
boundaries are rejected. Calls have a strict instruction budget. There is no
wall-clock timeout that silently shortens the admitted campaign.

Coverage includes executed step identities, scheduler switches, concrete network
and resource outcomes, and observed runtime trace kinds. It does not claim full
path, instruction, source-line, or state-space coverage. Generated cases, attempted
case executions, precondition-filtered cases, successful cases, and actual
evaluated operations are separate counters. Failure can stop the remaining
operations in that case; its trace exposes the prefix and admission fails.

## Counterexamples and durability

Each failure retains its original case and result. Shrinking reduces bounded input
magnitudes and schedule inversions, always preserving every actor operation and
the exact failing property. It reports attempts, reductions and limit exhaustion;
no claim of globally minimal counterexamples is made. Numeric input domains are
never widened. The candidate/manifest identity, seed, order, oracle and concrete
replay results are retained. `replayCounterexample(digest)` checks immutable bytes
and executes both original and shrunk witnesses again, requiring exact results.

Artifacts use flushed immutable files, atomic hard-link publication, and directory
fsync. Actual SIGKILL tests before/after report publication show that an incomplete
run cannot issue admission and retries reproduce complete cases. Temporary files
left by dead processes are harmless retained artifacts; automated storage
collection is not implemented here. Reopening does not trust serialized admission
bits; a new executor must run the campaign again.

## Preregistered campaign01 results

The profile in `profile.json` was saved before timing. `results/campaign01/` retains
the preregistration, 23 source/dependency SHA-256 pins, the working-tree state,
hardware/load diagnostics, warmup, every raw measured trial, both complete
campaigns, and every durable counterexample. The source was uncommitted on top of
`02ff9007bfe6e20acb9033e4ca798deb0cc0380d`; source pins identify what was measured.
This is local implementation evidence, not clean-commit release qualification.

Hardware/runtime: Apple M4 Pro, Node v26.7.0. Ambient one-minute load at registration
was approximately 3.61. Root and reviewer test activity was paused for the short
timing window; this was not a controlled isolated release machine.

| Measurement | Result |
| --- | ---: |
| Good candidate declared/generated/executed/passed cases | 15 / 15 / 15 / 15 |
| Good candidate precondition exclusions / missing coverage | 0 / 0 |
| Broken candidate cases passed / failed | 11 / 4 |
| Broken counterexamples retained and replayed | 4 |
| Good run, including case publication (final report excluded) | 132.978 ms |
| Complete good campaign throughput | 112.80 cases/s; 744.49 evaluated operations/s |
| Broken run, including shrinking/case publication (final report excluded) | 229.291 ms |
| Broken campaign throughput | 65.42 cases/s; 431.77 original evaluated operations/s |

Shrinking adds executions outside the original-case operation counter; its attempt
counts are recorded per counterexample. Thus the broken report's operation rate
is not total engine work divided by time. Setup and preregistration are outside
these run timers; generation, case execution, shrinking and case/counterexample
publication are inside. Final report serialization/publication occurs after the
elapsed-time capture, as stated by the implementation.

### R04 fixed four-field JSON-event kernel

The R04 threshold remains **2,000,000 fully materialized and evaluated inputs/s
in every measured trial**. One warmup and five trials each process exactly 20,000
objects using `JSON.stringify`, `JSON.parse`, all four guards and uint32 coverage
accumulation. This matches the declared R04 input formulas. Each trial's checksum
is 25,534 (153,204 over warmup plus five trials). The first measured trial and
every observation are retained. Raw observation writes occur between timed
trials and are excluded by the preregistered profile.

| Trial | Fully materialized/evaluated JSON events/s | 2M result |
| --- | ---: | --- |
| 0 | 3,645,283 | Pass |
| 1 | 3,680,388 | Pass |
| 2 | 3,680,615 | Pass |
| 3 | 3,989,362 | Pass |
| 4 | 4,009,322 | Pass |

The **local R04 kernel passes**. Prior Python R04 misses remain unchanged in their
historical evidence. The complete durable Aether campaign runs at the much lower
rates above. **Millions of complete Aether/distributed adversarial cases per second
remain unqualified.** T3-03 remains in progress: this bounded G1 foundation and
fixed-profile throughput result do not complete all FR-3.3 production scope.

## Reproduction

From the repository root, using source bytes matching registration:

```sh
node --experimental-strip-types --test test/tier3/living-campaign.test.ts
node --experimental-strip-types roadmap/v4/research/microworld/campaign.ts --verify roadmap/v4/research/microworld/results/campaign01
node --experimental-strip-types roadmap/v4/research/microworld/audit.ts roadmap/v4/research/microworld/results/campaign01
```

The verifier and independent counter audit check pinned source, trial arithmetic/checksum/thresholds, every
generated case against the recorded inputs, all 30 actual execution results, and
all retained counterexample replays. It does not repeat timing.

For a new independent measured run, retain a new directory and both stages:

```sh
node --experimental-strip-types roadmap/v4/research/microworld/campaign.ts --register /tmp/aether-microworld-new-run
node --experimental-strip-types roadmap/v4/research/microworld/campaign.ts --run /tmp/aether-microworld-new-run
```

Source/profile changes after registration are rejected. An existing attempt
cannot be overwritten. Interrupted runs retain the attempt record and every raw
observation that had been published; they are not counted as completed campaigns.
