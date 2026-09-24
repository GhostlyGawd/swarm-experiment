# T3-03 process/socket campaign refreshed on exact source `4b5b7a7`

The fixed profile and transitive source hashes were registered before timing
from a clean worktree. All **6 declared/generated cases executed with zero
filters**. Stable effect IDs passed 3/3 and attempt-derived IDs caused two
durable sink writes in 3/3. Every case exercised a disconnected partial TCP
frame, malformed TCP frame, independent worker `SIGKILL` after sink fsync,
fresh-worker dead-owner broker recovery, duplicate delivery and isolated
terminal replay. Raw journals, sink files and exact replay are retained and
verified.

Complete elapsed was **2,257.304166 ms**, or **2.6580 cases/s**, including
worker launches, six kills, recovery, replay and raw case publication. This
fails the unchanged R04 2,000,000-per-second threshold. It does not include a
host-level partition or run the new signed effectful candidate through the
worker. The first [process campaign](../t303-process-aa7285c/REVIEW.md) is
historical exact-source evidence at `aa7285c`; this refresh pins the changed
`LivingCampaign` implementation at `4b5b7a7`.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-broker/process-campaign.ts --verify docs/implementation/v4/evidence/t303-process-4b5b7a7
node --experimental-strip-types --test roadmap/v4/research/microworld-broker/process-harness.test.ts
```
