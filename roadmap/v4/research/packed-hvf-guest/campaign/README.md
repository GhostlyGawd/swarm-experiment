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

## Retained M4 Pro result

`results/local-01.json` pins source commit
`a705390eefb4fe24f592ab50e9a7e16a9389ad1d` and retains every raw sample.
The verifier rebuilt the signed controller and guest, checked the Git source
bytes, and repeated the 128-operation semantic campaign.

| Measure | Result |
| --- | ---: |
| Guest samples | 1,000 |
| Fresh guest to validated response median | 38,500 ns |
| Fresh guest to validated response p95 | 94,417 ns |
| Fresh guest to validated response maximum | 181,125 ns |
| Guest mapped bytes | 65,536 B |
| Observed resident backing per sample | 65,536 B |
| Separate controller launch through exit | 379.7 ms |

The bounded fresh guest path passes the unchanged 1 ms maximum in this
preregistered campaign. It does not close the release boot or memory gates.

## Packed `/2` string extension

The [string registration](string-registration.md) fixes a separate 16-record,
128-operation UTF-8 read/equality workload and the same 20 warmup plus 1,000
fresh guest boundary. The controller accepts both frame versions; version 1
retains its exact input bytes. The `/2` guest validates dictionary spans and
UTF-8 before returning results. The host authenticates the `/2` resumable
checkpoint and compares exact guest bytes to the logical model. The new raw
campaign and its source-pinned verifier are:

```sh
node --experimental-strip-types roadmap/v4/research/packed-hvf-guest/campaign/string-run.ts /tmp/hvf-string.json
node --experimental-strip-types roadmap/v4/research/packed-hvf-guest/campaign/string-verify.ts /tmp/hvf-string.json
```

The string result is a bounded research result; historical fields, closures,
tasks, effect routing and full runtime admission remain outside this guest.
