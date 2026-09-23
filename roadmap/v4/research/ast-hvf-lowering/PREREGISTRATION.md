# AST-to-HVF bounded research registration

## Question

Can an admitted subset of the real Tier 1 AST produce different freestanding AArch64 guest images when its source changes, and return the same values as `ResumableRuntime` on actual Apple Hypervisor.framework EL1 execution?

## Fixed workload and measurements

- Three one-function modules: bounded signed 64-bit arithmetic with `Cond`; `If`/`Return` with two packed integer fields; signed division.
- Fifty-seven successful vectors: nine named boundary cases and 24 seeded arithmetic plus 24 seeded packed-record cases. Seed `0x9a37ab21` and xorshift32 sequence are fixed in `run.ts`.
- Adversarial checks: source literal 3→4 changes AST root, generated source, image SHA-256 and result; stale root; supported-typed but unsupported `Let`; mismatched packed layout; out-of-bounds host record; changed manifest digest reaching EL1; malformed packed field reaching EL1; signed overflow; division by zero.
- Guest interval starts in the controller before allocating fresh memory and creating the VM/vCPU and ends after HVC and response validation. Record raw ticks, conversion factor, mapped and observed guest backing bytes, code image bytes, source and binary hashes. Do not treat process launch or compilation as part of that interval.
- Compare guest values against a new `ResumableRuntime` for each input. Differential success requires all 57 value matches and expected failure statuses. The report records all inputs, outputs and raw samples.

## Scope and refusal

The compiler accepts only one pure, effect-free function, at most eight `Int`/`Bool` parameters and one record parameter of bounded packed `Int` fields, `Lit`/`Var`/`Field`/`Un`/`Bin`/`Cond` expressions, and `Return`/`If`/`Block` statements. Arithmetic is signed 64-bit with trap on overflow, a narrower domain than arbitrary-precision Aether `Int`. Unsupported AST, effects, multiple records, type/manifest mismatches, bad frame or field codes fail closed. The record is read-only. The existing Tier 2 typechecker and resumable program compiler validate the exact module and manifest before lowering; this is still a research ABI, not release admission.

The 1 ms maximum and 2 MB complete guest-memory limits stay unchanged. These samples describe a bounded guest backing allocation, not total hypervisor memory or complete runtime boot. This work does not establish capability containment, effects, proof checking, replication, checkpoint recovery, or full Tier 1 semantics inside the guest.

## Reproduction

After the source commit, run `node --experimental-strip-types roadmap/v4/research/ast-hvf-lowering/run.ts --record` once, then `node --experimental-strip-types roadmap/v4/research/ast-hvf-lowering/run.ts --verify`. Preserve all samples, including outliers. The verifier rebuilds and executes new guests before comparing stable artifacts and all saved vector outcomes.
