# Clean native boundary campaign

Subject: `5bb4f1cfa0478ea4afb940e268400e17bf102434`, specification `0.1.0`. The detached source checkout was clean before registration and remained unchanged through execution. Four campaign-assessment tests passed. Registration, admission, execution and source hashes were independently checked against the retained bytes.

Under the user-approved fresh-guest/initialized-hypervisor boundary, **all 1,000 fresh guests passed**:

| Measurement | Result |
|---|---:|
| Median / p99 startup | 26.917 / 62.375 µs |
| Maximum startup | **159.542 µs**, below 1 ms |
| Observed and bounded guest resident memory | **65,536 bytes**, below 2,000,000 |
| Empty VM/vCPU initialization, excluded startup diagnostic | 935.167 µs |
| Controller launch to ready, excluded diagnostic | 169.765 ms |
| Peak controller RSS, excluded diagnostic | 6,701,056 bytes |

The protocol creates and destroys one empty VM/vCPU before readiness, with no guest memory mapping or executed guest instruction. Each measured guest then gets a new allocation, image copy, VM/vCPU and validated result. Every guest, including guest 0, is retained in `campaign/raw.jsonl`; no timing sample was excluded. Cleanup completed for every guest. The approved limits were unchanged.

This repeats the initialized-hypervisor protocol at a clean exact commit. Earlier controller-only failures, the source-pin refusal and the prior initialized campaign remain in the source history. The experiment uses a 60-byte scalar AArch64 guest on an Apple M4 Pro. It establishes the declared bounded prototype result, not the full native runtime, drivers, unikernel implementation or universal latency. Host hypervisor kernel overhead remains unmeasured and outside the approved guest-memory boundary.

Reproduce using the register/run commands in `roadmap/v4/research/native/FRESH-GUEST-CAMPAIGNS.md` from the subject commit and a new output directory. The complete preregistration, admission, binaries, raw output, report and command logs are retained alongside `manifest.json`.
