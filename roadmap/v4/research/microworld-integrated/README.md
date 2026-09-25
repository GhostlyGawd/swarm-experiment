# Combined signed living campaign

The [V3 contract](../../../../docs/implementation/v4/LIVING-EFFECT-CAMPAIGN.md)
separates a signed one-time independent-worker crash mode from the V2 local
admission profile. `fixture.ts` builds the same effectful Aether candidate for
scheduler, resource, corrupted network and out-of-order scenarios. `worker.ts`
receives generated cases over real TCP and independently verifies the signed
root, policy and response table. `harness.ts` disconnects a truncated frame,
rejects a malformed frame, witnesses `SIGKILL` after sink fsync, starts a new
worker, reconciles the exact case, retries it and duplicates delivery without
extra effects. It then executes all remaining cases.

[Clean-source evidence](../../../../docs/implementation/v4/evidence/t303-integrated-82d88b6/REVIEW.md)
at `82d88b6` reports 15 generated/executed/passed good cases, zero filters,
17 attempts, 48 coverage labels and **12.7784 complete cases/s**. A separate
signed broken candidate executes 15 cases, fails four schedules, and retains
four durable shrunk replays at **15.0576 original cases/s including shrinking**.
Those rates measure complete signed execution, not the frozen R04
generator/evaluator. [D21](../../../../docs/implementation/v4/decisions/D21-living-campaign-throughput-boundary.md)
places the unchanged **2,000,000/s** target on that separate R04 boundary.
The four-field JSON kernel pass does not establish full campaign survival.

## Versioned integrated profile `/2`

The current `/2` registration and measurement keep the 2M/s R04 target named,
but report complete signed candidate rates without comparing them to that
generator target. The same 15 good and 15 broken case sets, SIGKILL recovery,
zero-filter rule and shrunk replay remain required.

An additional bounded resource case runs the same signed candidate in a real
worker while 64 MiB of touched pages stay resident. The controller takes OS
RSS samples before pressure, after pressure, and after case execution, using
`ps` on macOS and the kernel's `/proc/<pid>/status` on Linux;
the worker independently reports its RSS and rechecks a checksum of every
touched page after the case. The preregistered minimum OS RSS rise is 48 MiB.
The offline audit binds the complete observation, verifies the case result and
repeats the signed case in a fresh pressured worker. A tampered checksum is
rejected. This demonstrates resident pressure during one case. The candidate's
allocation refusal is still the campaign's bounded quota model; this profile
does not induce a real OS allocation failure or qualify production RSS limits.
[Exact-source `/2` evidence](../../../../docs/implementation/v4/evidence/t303-rss-497da3a/REVIEW.md)
records 15/15 signed good cases, four durable broken-root replays and a 67.14 MB
observed OS RSS rise during the separate signed resource case.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-integrated/campaign.ts --verify docs/implementation/v4/evidence/t303-integrated-82d88b6
node --experimental-strip-types --test roadmap/v4/research/microworld-integrated/fixture.test.ts
```
