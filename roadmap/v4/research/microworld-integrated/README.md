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
Both miss the fixed R04 **2,000,000/s** threshold. The earlier four-field JSON
kernel pass is not a complete-campaign result.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-integrated/campaign.ts --verify docs/implementation/v4/evidence/t303-integrated-82d88b6
node --experimental-strip-types --test roadmap/v4/research/microworld-integrated/fixture.test.ts
```
