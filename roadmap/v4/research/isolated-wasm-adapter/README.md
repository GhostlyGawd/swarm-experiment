# Import-free Wasm effect adapter candidate

This is a bounded V4-T2-04 containment slice for a read-only, one-argument
`Invoke`. An approved V3 descriptor binds exact Wasm bytes, capability, adapter
ID, `aether.adapter-wasm-i32-readonly/1` profile, 64 KiB source ceiling,
declared linear memory maximum (1–256 64 KiB pages), and a 1–5000 ms worker
deadline. Admission copies source bytes and checks their SHA-256 against the
independently approved descriptor before compiling in a disposable child.

The parent `EffectAdapter.execute` accepts only the actual router envelope:
`sequence([string(expectedCapability), int(signed_i32)])`. The child receives
the integer and a request digest, not grants, signed policies, sink handles,
network credentials, or an external-effect API. The Wasm module must have no
imports (including WASI), no table or start function, exactly one memory with
an explicit maximum, and only `memory` and `run(i32)->i32` exports. The parent
checks the worker response and turns it into a tagged integer. A timeout sends
SIGKILL to the child. Trap, timeout, and child loss cause an error; the durable
broker retains an indeterminate dispatch until explicit reconciliation. Since
this guest has no route to an external sink, reconciliation can definitively
report `not_committed`; a new effect ID can then compute again.

This is a **candidate**, not completion of V4-T2-04. The parent remains trusted,
Node child RSS is larger than Wasm linear memory, and this is not an OS sandbox
against a runtime exploit. It covers only one signed 32-bit argument/result;
general tagged values and effectful adapters require a separate trusted-parent
sink contract. Existing JavaScript adapter profiles still run with ambient Node
authority. Full cross-process grant coverage, revocation, hostile adapter
containment, and production benchmarks remain open.

Run `node --test --experimental-strip-types test/tier2/isolated-wasm-adapter.test.ts`
and `npm run typecheck`. The test builds the Wasm modules from explicit bytes,
then checks exact source identity, router capability binding, imports, memory
limits, wrong ABI, `memory.grow`, a killed infinite loop, forged/tampered worker
requests, and durable broker crash/retry behavior.

`results/local-01/` pins the six relevant source/test files to commit
`890114ab66728ccf359d42fe432b0f11e21444fa`. The combined V3 admission
and worker campaign passed 14/14 targeted tests, typecheck, and build on
Node 26.7.0 / Darwin arm64. Run `node roadmap/v4/research/isolated-wasm-adapter/verify.mjs`
to independently check source blobs and retained log hashes. This campaign is
candidate evidence only; it does not satisfy the full release gate.
