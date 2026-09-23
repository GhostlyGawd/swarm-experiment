# Preregistered HVF map-coalescing comparison

Registered before implementing or running this campaign on 2026-09-23. The
unchanged user-approved boundary is a fresh guest on an already-running
controller/hypervisor. Each observation starts before fresh `mmap` allocation,
zero fill and image/frame copy, and stops only after the EL1 HVC, guest status,
`DONE` marker, and exact expected response bytes have been checked. Each
observation creates and destroys its own VM and vCPU. Guest mapped and resident
backing bytes are measured separately; the 2 MB target remains unchanged.

## Single proposed change

The baseline makes separate `hv_vm_map` calls for the two-page read/write
frame and one-page read/write stack. The candidate maps their three contiguous
pages with one `hv_vm_map`. The RX code page and all permissions, bounds,
addresses, frame bytes, guest image, VM/vCPU lifecycle, and response checks are
identical. A one-shot semantic test compares both modes with the independently
expected frame and the existing packed guest differential suite remains a
separate gate.

## Workload and measurement

Use the exact `packed-hvf-guest` freestanding EL1 kernel. A deterministic
16-row packed frame has 128 mixed read/add operations and trapped overflow,
with a separately computed exact expected response. Compile the controller
with Apple clang `-O2`; code sign for Hypervisor.framework. One persistent
process loads the kernel once, runs 20 unrecorded warmup guests per mode, then
records 1,000 guests per mode in alternating order (mode order flips every
pair). Capture raw Mach ticks at allocation start, after data copy,
`hv_vm_create`, RX map, RW mapping(s), vCPU configuration, and validated
response; also record mincore resident bytes and mapped bytes for every run.
Store exact source hashes, executable/image hashes, environment, raw samples,
and independent verifier output. No failed or timeout observation is dropped.

## Decision rule

Compare median and maximum fresh-guest-to-validated-response time for each
mode, plus stage differences. Count coalescing as an optimization only if the
candidate median is lower and all semantic/memory checks pass. Regardless of
relative improvement, the 1 ms boot gate passes **only** if the candidate
maximum of all 1,000 measured fresh guests is at most 1,000,000 ns. The full
v4 runtime gate remains open because this is a bounded guest research path.
