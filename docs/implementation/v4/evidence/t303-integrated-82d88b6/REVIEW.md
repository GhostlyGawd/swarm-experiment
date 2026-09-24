# T3-03 combined signed candidate and process fault campaign

The registration at clean source `82d88b6c22d42ad78fcea85d60bcee46febf048f`
preceded timing. It retains both signed Aether candidate authorities, an Ed25519
public key, all 30 generated cases, the fixed R04 target, 40 transitive source
and dependency SHA-256 pins, and Apple M4 Pro / Node v26.7.0 diagnostics. The
private research key was not retained. `attempt.json`, raw case observations,
broker journals, sink writes, one crash marker, four shrunk counterexamples and
the complete results are preserved. The verifier checks source pins, generated
cases, all 15 good case observations against raw broker/sink bytes, all four
persisted broken replays, count/rate arithmetic and a fresh full campaign. It
does not reproduce historical wall time.

| Measurement | Good signed candidate, real workers | Broken signed candidate, local shrink/replay |
| --- | ---: | ---: |
| Declared / generated / executed | 15 / 15 / 15 | 15 / 15 / 15 |
| Filtered | 0 | 0 |
| Passed / failed | 15 / 0 | 11 / 4 |
| Case attempts | 17, including crash/retry/duplicate | 15 original; shrink executions additional |
| Counterexamples | 0 | 4 persisted and replayed |
| Complete elapsed | 1,173.859375 ms | 996.177958 ms |
| Complete case rate | **12.7784/s** | **15.0576/s** |
| Fixed R04 target | 2,000,000/s | 2,000,000/s |
| T3-03 G2 | **Failed** | **Failed** |

The good candidate is one signed Aether AST root with an effectful event
receiver. Its 15 generated cases include all six two-writer call-boundary
schedules, three materialized quota cases, three malformed/checksum/duplicate/
dropped-frame cases and three out-of-order event cases. Forty-eight distinct
coverage labels are recorded with all seeds. The outer TCP worker also rejects
one truncated and one malformed frame before candidate dispatch. The first
valid network case writes one sink record, then the first worker receives real
`SIGKILL` before its broker receipt. A new worker explicitly releases the dead
journal owner, reconciles the sink record, completes that case, receives its
duplicate without extra sink/journal records, then executes every remaining
declared case. The `/3` fault authorization and signed `/1` resource policy bind the same exact
candidate and generated plan on both workers.

The broken variant changes the Aether update declaration and therefore has a
different signed root. It finds four lost-update interleavings and persists
shrunk witnesses; the four records contain eight shrink proposal executions and
four accepted reductions, with no shrink limit exhausted. The timed run also
replays both original and shrunk witnesses for all four failures (eight further
executions). The broken rate uses only the 15 declared original cases as its
numerator while including shrink and replay work in elapsed time. A reopened
executor replays each failure again during verification. Separate regression
tests show unknown post-sink disposition, forged case identity, tampered sink
bytes and a legacy `/2` crash-mode substitution fail closed.

This still does **not** complete T3-03. The four-field JSON kernel's historical
2M/s pass measures a different boundary. This combined campaign misses the
unchanged full rate by several orders of magnitude. The TCP transport carries
case commands; out-of-order and corrupted event frames are materialized by the
deterministic Aether campaign inside the worker. Memory pressure is a bounded
host quota, and races are cooperative call-boundary schedules. There is no
host-level partition, native-thread race, independent external sink custody,
production ProcessHost admission or externally anchored trust key. V3 process
fault evidence is explicitly `productionAuthorized: false` and cannot mint a
local V2 admission receipt. G1's full production scope and G2 remain open;
the tracker stays **20/62**.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-integrated/campaign.ts --verify docs/implementation/v4/evidence/t303-integrated-82d88b6
node --experimental-strip-types --test roadmap/v4/research/microworld-integrated/fixture.test.ts
```
