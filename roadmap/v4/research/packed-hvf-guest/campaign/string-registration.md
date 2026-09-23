# Preregistered packed `/2` string guest campaign

Registered before running the `/2` measurement. The boundary is a fresh EL1
guest on an already-running Hypervisor.framework controller. The authenticated
checkpoint, layout, binary digests and operation plan are prepared before guest
creation. The campaign controller performs 20 warmups followed by 1,000 fresh
guests, each with new backing, VM and vCPU, RX and RW mappings, and a validated
HVC/DONE response. Raw seven-stage Mach ticks and observed resident backing
bytes are retained for every sample; no failed sample is dropped.

Workload: 16 typed records with a bounded UTF-8 string field, repeated and
distinct ASCII, empty, accented, emoji and embedded-NUL values. The frame
contains the packed `/2` string dictionary. There are 128 seeded string reads
and cross-record equality checks. The host authenticates the checkpoint and
compares exact guest frame bytes to the `PackedHeap` reference model. This is a
bounded research workload, not complete runtime boot or total hypervisor
resident accounting.

The unchanged bounded boot decision is maximum of all 1,000 fresh-guest to
validated-response durations at most 1,000,000 ns. This does not close the
full v4 1 ms boot or 2 MB memory gates.
