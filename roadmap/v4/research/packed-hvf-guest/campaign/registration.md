# Preregistered authenticated packed guest hot-controller campaign

Registered 2026-09-23 before implementation and measurement. The approved
boundary is a fresh guest on an already-running controller/hypervisor. The
authenticated resumable checkpoint, executable digest, layout digest and
operation plan are prepared and validated by the existing `bridge.ts` before
the controller runs. The controller reads and holds the pinned guest image and
one input frame, then completes 20 unrecorded warmup guests and 1,000 recorded
fresh guests in the same process. Each guest independently gets new zero-filled
backing, an image and frame copy, a new HVF VM/vCPU, RX code and combined RW
frame/stack mappings, register setup, EL1 execution, HVC/status/DONE response
checks, and exact response equality against the first run. The bridge compares
the returned frame to the `PackedHeap` reference model and revalidates the
candidate heap.

The measured interval starts immediately before fresh guest allocation and
stops immediately after HVC/status/DONE and exact frame comparison. It includes
image/frame copy and all VM/vCPU creation/mapping/configuration. Record raw
Mach ticks for allocation start, copy completion, VM creation, RX map, RW map,
vCPU configuration, and validated response. Observe resident host backing
with `mincore` after each measured response. Do not count process launch or
controller image load as guest start; retain separate process wall time. The
resident observation is a lower bound on backing pages, not total hypervisor
memory accounting.

Use a deterministic 16-record linked checkpoint with bounded int, bool and
relative ref fields and 128 mixed read/add operations, including trap-policy
overflows. Pin source and executable hashes, environment, raw ticks, and the
exact input/candidate image digests. The semantic test of the normal one-shot
driver must pass on the same source. No failed, timed-out, or mismatched sample
is discarded: failure aborts the campaign.

**Decision rule:** the bounded campaign meets the unchanged 1 ms boot maximum
only if the largest of all 1,000 fresh-guest-to-validated-response observations
is at most 1,000,000 ns. The 2 MB resident-memory gate and full-runtime boot
gate remain open until guest plus hypervisor memory and complete v4 runtime
features are included. The campaign cannot upgrade the production release
status by extrapolation.
