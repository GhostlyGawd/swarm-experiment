# V4-NFR-09 projection throughput preflight

This versioned profile measures the actual public `executableBundle` path for
TypeScript, Python and Rust, then parses each complete entry/dependency bundle
with `parseExecutableBundle` and independently checks exact AST roots and
dependency addresses. Eight authored workloads include scalar arithmetic,
contracts/loops, records/sequences, the full ledger, atomic blocks, string
imports, generic nested imports and a nested addressed import. Each has an
original and a deterministic one-literal edit: **16 cases × 3 targets = 48
bundles per trial**.

One warmup and five fixed trials are retained. For each target, the pass rule
uses all emitted entry plus dependency source lines divided by wall time for
projection, parse, identity checking and line counting. Runtime-support lines
are excluded from the numerator; `executableBundle` still constructs that
support inside the measured projection call. Source hashing, corpus creation,
diagnostics and raw-file writes occur outside the timed target loop. Projection
span rates are reported separately and cannot replace the complete rate.
Every trial must meet the unchanged **75,000 lines/s** for every target.

The [clean-source evidence](../../../../docs/implementation/v4/evidence/nfr09-fc3b4c3/REVIEW.md)
at `fc3b4c3` retains every per-output projection/parse time, generated line
count, source/runtime/dependency hash, source closure, tool hashes and Apple M4
Pro diagnostics. Its independent verifier reprojects all 48 outputs, checks
entry and dependency identities, and recounts each trial. **All targets miss**
the 75,000 lines/s preflight gate. This authored corpus is not a representative
production repository distribution; no release-wide NFR-09 or V4-Q02 pass is
claimed.

From the repository root, to inspect the retained measurement:

```sh
node --experimental-strip-types roadmap/v4/research/projection-throughput/verify.ts docs/implementation/v4/evidence/nfr09-fc3b4c3
```

To preregister and measure a new output directory:

```sh
node --experimental-strip-types roadmap/v4/research/projection-throughput/campaign.ts --register /tmp/aether-projection-new
node --experimental-strip-types roadmap/v4/research/projection-throughput/campaign.ts --run /tmp/aether-projection-new
```

The runner refuses reuse of an attempt. The timed path uses Aether's
target-language projector and parser; it does not invoke external Python,
TypeScript or Rust compilers, execute generated code, or qualify full v4 syntax
coverage. Their binary paths, versions and hashes are retained as environment
diagnostics, not billed as timed work.
