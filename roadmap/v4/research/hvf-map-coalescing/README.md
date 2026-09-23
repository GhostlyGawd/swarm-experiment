# Persistent HVF controller: map-coalescing experiment

This is a bounded V4-R02 / T4-05 research campaign on the user-approved boot
boundary: a fresh guest in an already-running controller. It compares the
existing split RW frame/stack mappings with one contiguous RW mapping. The RX
code page, guest image, permissions, frame, fresh VM and vCPU, and exact
validated response are the same in both modes. The controller loads the image
once, warms 20 guests per mode, then alternates mode order across 1,000 paired
samples. Every sample starts before fresh allocation, zero fill and copy and
ends after EL1 HVC and exact response validation. A failure aborts the run.

The raw campaign uses the actual packed EL1 guest, a deterministic 16-row,
128-operation field workload, and `mincore` observations for all four guest
backing pages. It does not authenticate a full checkpoint or run the complete
Aether hypervisor stack; the separate packed guest bridge tests cover
authenticated bounded execution. Mapped bytes and `mincore` are not a complete
hypervisor resident-memory accounting.

The [registration](registration.md) was written before implementation and
measurement. `run.ts` requires clean pinned sources and retains their Git
commit, SHA-256, binary hashes, environment and every raw timing tick. The
independent `verify.ts` checks historical and current source hashes, rebuilds
the exact binaries, checks pair and tick ordering, recomputes summary metrics,
and reports the unchanged 1 ms maximum gate for **this bounded workload**.

```sh
node --experimental-strip-types roadmap/v4/research/hvf-map-coalescing/run.ts /tmp/map-campaign.json
node --experimental-strip-types roadmap/v4/research/hvf-map-coalescing/verify.ts /tmp/map-campaign.json
```

The candidate optimization can be applied to the authenticated packed guest
controller after the campaign is verified. Full v4 boot and 2 MB gates stay
open until the admitted production guest, capabilities, effects, proof,
replication and recovery paths are included in the measured boundary.
