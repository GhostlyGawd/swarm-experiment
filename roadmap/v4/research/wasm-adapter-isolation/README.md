# Import-free WebAssembly effect-adapter research

Status: **bounded research; not a production adapter or a V4-T2-04 acceptance result**.

This experiment puts executable WebAssembly bytes behind the existing `DurableEffectBroker` dispatch path. The guest computes a pure `i32 -> i32` result. JavaScript host code owns the broker and the external file sink. The guest receives **zero imports**, including no WASI and no Node API. The WebAssembly [core specification](https://webassembly.github.io/spec/core/exec/modules.html) defines imports as instantiation inputs, and the [JavaScript embedding specification](https://webassembly.github.io/spec/js-api/) exposes compiled import descriptors. Admission checks those descriptors before creating any instance.

## Exact experiment

The 40-byte valid guest in `fixtures.mjs` exports only `run(x) = x + 1`. Its SHA-256 is `0815ca7d6026206d0773fe10c6b9643862bfffe8ba361c9789369ef9668ee746`. Admission copies the caller's bytes, checks this exact hash, compiles the copy, rejects all imports, checks the export surface, and retains only the compiled module. The adapter ID includes the hash. An attempted caller-buffer mutation after admission does not alter execution.

`EffectAdapter.execute` instantiates and calls the guest only after the broker's durable `dispatchStarted` transition. The trusted host sink persists an output record containing the exact request digest and Wasm artifact hash. A repeated live dispatch or isolated replay uses the recorded broker outcome without calling the guest or sink. A denied broker grant leaves the sink untouched.

The 62-byte valid forged-import fixture declares `aether.emit`. It is rejected during admission, before instantiation, even when its exact hash is supplied. A valid byte edit that changes `i32.const 1` to `i32.const 2` fails against the original digest.

The crash worker calls `SIGKILL` after a file and directory sync of the host sink write. On reopening, the broker requires dead-writer lock recovery, reports the effect as indeterminate, then uses the sink's request-and-artifact-bound record to reconcile it as committed. It does not dispatch the effect again. A separate unknown-outcome test remains indeterminate with one sink attempt.

## Reproduce

From the repository root on Node 26.7.0:

```sh
node --test --experimental-strip-types roadmap/v4/research/wasm-adapter-isolation/wasm-adapter.test.mjs
```

Observed local result: **6 tests passed, 0 failed**, including one actual `SIGKILL` child process. The test uses temporary local directories and cleans them afterward.

## Trust boundary and remaining work

The Wasm import check limits what the **guest** can call through the WebAssembly module interface. It does not isolate the trusted JavaScript host, broker, sink, filesystem, or V8 process. This prototype allows internal Wasm memory, start code, and loops; a hostile guest can still exhaust CPU or memory and harm its host process. The 64 KiB artifact-size check is not a runtime resource limit. Node's [WASI documentation](https://nodejs.org/api/wasi.html#security) explicitly says its capability features do not form a security model in Node, and this experiment does not use WASI. The [Node permission model documentation](https://nodejs.org/api/permissions.html) likewise does not treat it as a malicious-code sandbox. Production hostile-adapter containment needs a separately isolated process or guest with enforceable execution limits, OS-level controls, authenticated communication, and broker-owned sink credentials.

The file sink is a one-record research fixture with a trusted local filesystem. It does not establish external service idempotency, all crash windows, multi-effect concurrency, adversarial disk rollback resistance, or an independent receipt authority. Production admission must bind the Wasm byte digest, ABI, host sink identity, signed effect policy, grant audience, and epoch under a versioned artifact contract. It also needs complete fault and replay campaigns, resource meters, process/guest isolation, and integration into the deployment profile. Nothing here closes V4-T2-04/G1 or G2.
