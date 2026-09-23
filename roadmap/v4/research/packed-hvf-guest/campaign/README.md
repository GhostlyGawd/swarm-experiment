# Authenticated checkpoint in a persistent HVF controller

The [registration](registration.md) fixes the workload and pass rule before
measurement. This campaign uses the ordinary packed guest bridge to validate
an actual resumable checkpoint, exact executable and layout digests, and a
128-operation plan. A dedicated controller runs that exact frame through 20
warmup and 1,000 measured **fresh** EL1 guests in one process. Each guest gets
new memory, VM, vCPU, mappings, frame copy and response validation. The
bridge checks the returned bytes against the `PackedHeap` model and validates
the candidate image.

The raw record retains all seven timing ticks and `mincore` resident backing
bytes for every measured guest, plus source and binary hashes. The verifier
checks the pinned source commit, rebuilds both binaries, recalculates the
maximum and median, and repeats the semantic campaign.

```sh
node --test --experimental-strip-types roadmap/v4/research/packed-hvf-guest/bridge.test.ts
node --experimental-strip-types roadmap/v4/research/packed-hvf-guest/campaign/run.ts /tmp/hvf-hot.json
node --experimental-strip-types roadmap/v4/research/packed-hvf-guest/campaign/verify.ts /tmp/hvf-hot.json
```

This is a bounded packed-field research path. The measured interval excludes
checkpoint preparation, executable authentication, controller launch and disk
image load, all of which happen before the guest creation boundary. It includes
fresh guest allocation, zeroing, image and frame copy, HVF VM/vCPU creation and
configuration, guest execution and response checks. `mincore` reports backing
page residency, not total hypervisor memory. The full runtime boot and 2 MB
release gates remain open.
