# Fresh guest qualification campaigns

The user-approved [D07 qualification profile](../../../../docs/implementation/v4/decisions/D07-native-qualification-profile.json)
keeps the **1 ms** boot and **2,000,000 byte** memory limits. Boot begins when a
fresh guest is created on an initialized controller/hypervisor and ends after
its first useful response is validated. Memory covers guest-resident code,
data, stacks, heaps and guest drivers; controller RSS and host hypervisor memory
are separate diagnostics.

The initialized-hypervisor campaign passed these bounds for the declared scalar
fixture: **1,000 fresh guests, maximum 167.375 µs, peak guest-resident memory
65,536 bytes**. This is bounded workload evidence. It does not complete the
native runtime, drivers, compiler or full unikernel requirements.

## Preserved history

| Record | Preregistered protocol | Executed guests | Maximum boot | Guest memory | Result |
|---|---|---:|---:|---:|---|
| [01](results/fresh-guest-campaign-2026-09-22-01/report.json) | v1: running controller, capacity query only | 1,000 | 2,534.583 µs | 65,536 bytes | Boot fails; memory passes |
| [02](results/fresh-guest-campaign-2026-09-22-02/run-refusal.json) | v2: explicit empty VM/vCPU initialization | 0 | Not measured | Not measured | Source-pin check refused execution before launching the controller |
| [03](results/fresh-guest-campaign-2026-09-22-03/report.json) | v2: explicit empty VM/vCPU initialization | 1,000 | 167.375 µs | 65,536 bytes | Both bounds pass for the bounded campaign |

Campaign 01 retains both misses: guest 0 took 2,534.583 µs and guest 17 took
1,403.958 µs. The initial research results in `results/m4-pro-2026-09-22` and
campaign 01's native measurement sources, profiles and results were not replaced.

Campaign 02 never executed a guest: `src/tier3/compile.ts` changed after its
registration while another task was integrating code. Its registration,
admission artifacts and explicit refusal remain available. Campaign 03 used
the same v2 protocol/counts, newly registered against the current source bytes.

## Why protocol v2 changes initialization

Apple's documentation and the installed SDK describe
[`hv_vm_get_max_vcpu_count`](https://developer.apple.com/documentation/hypervisor/hv_vm_get_max_vcpu_count%28_%3A%29.md)
as a capacity query. They do not promise that it initializes the VM/vCPU resource
paths. [`hv_vm_create`](https://developer.apple.com/documentation/hypervisor/hv_vm_create%28_%3A%29.md)
and [`hv_vcpu_create`](https://developer.apple.com/documentation/hypervisor/hv_vcpu_create%28_%3A_%3A_%3A%29.md)
create those objects; guest execution is a separate `hv_vcpu_run` operation.
A capacity query alone therefore did not establish the intended precondition.

Before `controller_ready`, protocol v2 creates one empty VM and one vCPU, then
destroys both. It maps **zero guest bytes** and executes **zero guest
instructions** during this initialization. All counts and the initialization
duration are reported separately. No initialized VM or vCPU is reused by the
measured campaign. Any additional lazy work on the first actual guest execution
remains inside guest 0's measurement.

The first v2 measured guest is retained and took **58.500 µs**. The empty-context
initialization took **984.250 µs**, inside controller startup diagnostics. The
1 ms threshold was never increased, and no executed guest warmup was excluded.

## Measurement boundary and evidence

Both protocols preregister 1,000 serial guests and zero executed guest warmups.
For every guest, timing includes fresh anonymous allocation and zeroing, copying
the admitted image into that fresh memory, VM creation, guest mappings, vCPU
creation/register setup, actual execution and response validation. Validation
checks HVC exception class, result and status before an AArch64 instruction
barrier and the stop timestamp. Generated assembly was inspected to confirm
that order. The historical `boot.c` endpoint was not reused.

The AST-derived guest computes `gross / 200 + adjustment`. Guest `i` receives
`gross = 1000 + 200*i` and `adjustment = 7`, so its validated result is `12+i`.
The raw image contains 60 bytes of AArch64 instructions. It has one RX code page
and nonexecutable RW stack/data pages, totaling 65,536 bytes. Each VM/vCPU is
destroyed and its anonymous mapping released before the next guest begins.
Cleanup failures invalidate the campaign rather than enabling reuse.

`mincore` observed all 65,536 guest bytes resident after each response, before
destruction. This equals the peak upper bound: the guest has no mappings beyond
that fixed region and no mechanism to grow them. Controller and hypervisor
allocation are not relabeled as guest memory.

Campaign 03 results:

| Metric | Result |
|---|---:|
| Valid, fresh, destroyed guests | 1,000 / 1,000 |
| First guest | 58.500 µs |
| Minimum / median / p95 / p99 | 20.667 / 27.792 / 35.792 / 58.167 µs |
| Maximum | **167.375 µs** |
| Latency misses above 1 ms | **0** |
| Observed and bounded peak guest residency | **65,536 bytes** |
| Controller launch to ready, excluded diagnostic | 167.099 ms |
| Empty VM/vCPU initialization, included in startup diagnostic | 984.250 µs |
| Peak controller-process RSS, excluded diagnostic | 6,635,520 bytes |
| Host hypervisor kernel allocation | Not measured; explicitly excluded by approved profile |

Hardware: Apple M4 Pro, 12 logical CPUs, 24 GiB RAM, Darwin 25.6.0. Ambient load
averages were recorded before and after the campaign; no exclusive-core or
controlled release-isolation claim is made. Compiler, linker, ABI, AST roots,
source hashes and binary hashes are captured in each registration/admission.
The timestamp scale is `mach_absolute_time`, 125/3 ns per tick.

For campaign 03, preregistration was written at `2026-09-22T22:09:22.690Z`, before
compilation/admission; execution began at `2026-09-22T22:09:23.950Z`. Every raw
sample remains in [raw.jsonl](results/fresh-guest-campaign-2026-09-22-03/raw.jsonl),
including guest 0. The [report](results/fresh-guest-campaign-2026-09-22-03/report.json)
binds raw data, parsed execution, preregistration, admission and approved-profile
hashes. Missing, repeated or reordered guests, invalid answers, unmatched timer
counters, missing cleanup, source drift and artifact changes fail qualification.

## Reproduction

Use a new output directory for each campaign; previous registrations and runs
cannot be overwritten or rerun in place.

```sh
node --experimental-strip-types --test test/research/fresh-guest-campaign.test.ts
node --experimental-strip-types roadmap/v4/research/native/initialized-guest-campaign.ts register /tmp/aether-fresh-guest-new
node --experimental-strip-types roadmap/v4/research/native/initialized-guest-campaign.ts run /tmp/aether-fresh-guest-new
```

Registration compiles and checks the native arithmetic corpus but executes no
guest. The `run` command exits nonzero when the full preregistered campaign is
invalid, incomplete or misses either approved bound. Hardware execution needs
Apple silicon, Hypervisor.framework, the macOS SDK, `codesign`, Clang and the
installed Rust `ld.lld`. All prerequisites were available locally; no paid
resource or production deployment was used.
