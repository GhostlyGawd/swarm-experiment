# V4-NFR-09 three-target projection throughput preflight

The preregistration was written on clean source commit
`fc3b4c30bdd4a675671c2f0bc0e1f84cc9900075` before timing. It pins the
unchanged **≥75,000 generated lines/s** target, one warmup, five measured
trials, eight authored workloads with one exact-root literal edit each, 46
transitive source/dependency SHA-256 hashes, and the actual Apple M4 Pro /
Node v26.7.0 environment. It retains 12 reported logical CPU models, Node,
Python 3.14.7, Rust 1.97.1 and TypeScript 5.8.3 binary paths/versions/hashes.
The Python/Rust/TypeScript tools are diagnostics; the timed parser is Aether's
target-language parser, not those external compilers.

Each trial projected and parsed **16 exact-root cases per target**: 48 bundles
and **8,902 emitted entry plus dependency source lines** in total. Every
parsed entry matched its original or edited AST root. Every addressed
dependency closure matched its exact content root. No case, target, edit or
line was excluded. Source/runtime/dependency hashes and individual projection
and parse/identity nanoseconds are in the [warmup and five raw trial files](trials/).

| Target | Emitted lines/trial | Complete projection + parse/identity, five-trial range | Bundle projection span only, diagnostic | ≥75,000/s preflight |
| --- | ---: | ---: | ---: | --- |
| TypeScript | 3,174 | **11,707–12,329 lines/s** | 22,077–23,122 lines/s | Miss, 5/5 |
| Python | 2,736 | **10,181–10,924 lines/s** | 19,072–20,500 lines/s | Miss, 5/5 |
| Rust | 2,992 | **11,274–11,660 lines/s** | 21,077–21,812 lines/s | Miss, 5/5 |

The pass rule uses each target's actual wall span around `executableBundle`,
`parseExecutableBundle`, entry/dependency identity checks and line counting.
Source hashing and raw-file publication happen outside that span. The line
numerator counts the emitted entry and dependency sources; runtime-support
lines are excluded, although `executableBundle` constructs runtime support
during its measured call. This is a conservative public-bundle preflight; it
does not isolate a bare `projectExecutable` implementation rate.

The [independent verifier](../../../../../roadmap/v4/research/projection-throughput/verify.ts)
checks the source and tool pins, regenerates all 16 cases, reprojects and
reparses all 48 target bundles, validates original/edited roots and complete
dependency addresses, compares source/runtime/dependency hashes and line
counts against all six raw files, then recomputes every rate and pass flag.
Its tamper test changes one generated line count and confirms rejection. The
verifier repeats behavior and arithmetic, not historical timing.

This authored preflight **misses** the unchanged NFR-09 target on all three
targets. Linked string and generic nested-import bundles are among the slowest
observed rows, but these measurements do not prove a single cause. The corpus
does not sample production repository sizes, edits, hardware load or the full
projectable/unsupported v4 domain, and it does not execute external target
compilers in the timed boundary. V4-Q02/G1 and release-wide NFR-09 remain
open; the tracker remains **20/62**.

```sh
node --experimental-strip-types roadmap/v4/research/projection-throughput/verify.ts docs/implementation/v4/evidence/nfr09-fc3b4c3
node --experimental-strip-types --test roadmap/v4/research/projection-throughput/verify.test.ts
```
