# Tier 1 AST to actual EL1 guest: bounded research

`compiler.ts` accepts a real Tier 1 `Module`, an exact execution manifest, and one entry symbol. It invokes the production resumable compiler for type, capability and dependency validation, rejects AST outside its declared subset, then generates freestanding C from AST expressions and statements. Clang targets `aarch64-none-elf`; the resulting AArch64 image runs at EL1 through Apple Hypervisor.framework. The guest independently checks frame size, manifest digest, argument count, packed field bounds and padding. The controller requires an expected HVC exit, zero guest status and a guest-written `DONE` marker.

The comparison runner compiles three distinct ASTs and runs 57 fixed vectors against `ResumableRuntime`. It also edits a literal in the AST and checks that the AST root, generated source, guest image and observed answer change. It rejects stale manifests, unsupported syntax, incompatible layouts, invalid packed codes, arithmetic overflow and division by zero. See [registration](PREREGISTRATION.md) and retained [report](results/local-01/report.json).

The retained `Mac16,8` / macOS 26.7 campaign pins source commit `e707c5f99e4f87d8d96e48c8e55727cdfdd758c4`. Its 57 fresh-guest intervals range from **440,292 ns** to **785,833 ns** (median **577,458 ns**); the three generated images are 4,852–5,032 bytes. The controller mapped and observed 65,536 bytes of guest backing for each sample. Earlier exploratory runs of this code showed a sample above 1 ms; those unretained runs are not qualification evidence. The finite retained workload and incomplete runtime mean the full 1 ms maximum gate is still open.

Run on Apple silicon with the Hypervisor entitlement available:

```sh
node --experimental-strip-types roadmap/v4/research/ast-hvf-lowering/verify.ts
```

This is a narrow research ABI. Its signed 64-bit trap domain differs from Aether's arbitrary-precision `Int`; overflow is refused as an out-of-domain case. The manifest's `compilerDigest` and `target.artifactDigest` in the runner are research placeholders and are not a release artifact admission. The guest only reads one packed record; it does not execute the general resumable machine, validate proofs, broker effects, enforce a full capability policy, replicate, or recover state. Its mapped backing is not a full hypervisor residency measurement. V4-T3-10, V4-T4-05 and all full release gates remain open.
