# T3-03 signed campaign with observed resident memory pressure

Clean source: `497da3a5e963da3e7472a66a52b739650c1d639e` on
`aether/v4-implementation`, specification 0.1.0. The `/2` integrated profile
was committed before registration. The [registration](raw/registration.json)
records that commit, an empty Git status, the profile and source hashes, signed
good/broken/pressure authorizations and all generated cases. The independent
[verifier](verify.log) passed after the raw campaign was copied into this
evidence directory. [Hashes](hashes.sha256) bind the retained raw files and
logs; [hash verification](hash-check.log) passed.

| Measurement | Exact-source result |
| --- | ---: |
| Signed good cases generated/executed/passed/filtered | 15 / 15 / 15 / 0 |
| Actual attempts, including crash/retry/duplicate | 17 |
| Complete good process campaign | 12.9500 cases/s |
| Signed broken cases generated/executed/failed/shrunk | 15 / 15 / 4 / 4 |
| Complete broken campaign, including shrink/replay | 15.3377 original cases/s |
| Additional signed resource case under resident pressure | passed, zero filters |
| Controller `ps` RSS before / during / after case | 112,640,000 / 179,781,632 / 179,961,856 bytes |
| Observed OS RSS rise before execution | **67,141,632 bytes**; preregistered minimum 50,331,648 |
| Worker RSS before / during / after case | 112,148,480 / 179,781,632 / 179,961,856 bytes |
| Resident buffer pages touched and rechecked after case | 16,384 pages, checksum 2,088,960 |

The worker checked the signed authorization and exact generated case, touched
one byte per 4 KiB page in a 64 MiB buffer, and held the buffer while the same
signed Aether candidate ran the bounded resource case. The controller sampled
OS RSS independently before pressure, after pressure and after case execution.
The worker re-read every touched page after execution. The offline verifier
rechecks the stored observation, its digest, seed/case identity, all 15-case
results and raw effect evidence, then reruns the signed campaign and pressure
case in fresh processes. Changing the stored pressure checksum fails
verification; a worker given a different public key refuses before execution.

The `/2` [result](raw/results.json) reports complete signed candidate speeds
separately from the unchanged **2,000,000/s R04 generator/evaluator target**
under [D21](../../decisions/D21-living-campaign-throughput-boundary.md). It
does not label either complete-campaign speed as an R04 failure or pass. The
fixed R04 rate evidence remains [separate](../t303-pipeline-faf2172/REVIEW.md).

This result proves resident pressure during **one** signed resource case on
this host. Its allocation refusal remains the campaign's bounded quota model;
no OS allocation failure or native race is induced. Cross-machine partitions,
distinct operator custody, ProcessHost proof admission and external-sink
shrinking remain open. T3-03/G1 and the whole task stay unverified at
**20/62**. The [focused tests](tests.log) pass **7/7**; [build](build.log),
[typecheck](typecheck.log) and [roadmap validation](roadmap.log) pass.
