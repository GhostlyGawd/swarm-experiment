# Opt-in isolated Wasm effect profile

`scoped-anchored-wasm-v6` is an opt-in ProcessDeployment profile for one signed, read-only `run(i32) -> i32` adapter per declared effect capability. It retains the existing `scoped-anchored-v5` default and the exact historical formats. V6 uses deployment `/6`, prepared `/4`, host configuration `/4`, effect plan `/4`, signed effect policy `/4`, and adapter artifact `/3` identities. A policy rule binds the exact admitted Wasm artifact, capability, fixed resource path, policy epoch, absolute deadline, clock domain, and read-only broker semantics. An independently provisioned signer anchor verifies the policy.

The guest runs in a disposable child process with no imports or WASI, at most 256 WebAssembly linear-memory pages, a 64 KiB byte artifact and a 5 s timeout. The trusted parent owns grants, broker state, and any sink credentials. The current ABI has one signed i32 input and result; it has no guest access to network, files or OS resources through WebAssembly imports. Its child Node/V8 runtime remains a trusted component, and the memory cap applies to Wasm linear memory, not total child RSS.

ProcessHost checks the signed policy, current scoped grant, argument shape, and exact broker router context. The router's operation ID, full execution-manifest digest, policy epoch, signed deadline and clock domain, capability, and host-derived static grant reference are attested through nonvirtual broker methods before dispatch. V6 rejects references, composite values, and integers outside signed i32 at the host boundary. The broker independently preflights the same payload before its dispatch marker. A factory that returns a missing, wrong-capability or unbranded adapter is refused at deployment admission and again when the actual generation and heap open; runtime rechecks remain mandatory.

The broker records each effect before running the child. A trapped or timed-out pure guest is reconciled as terminal noncommit when reconciliation authority is available. Authorized `isolated-replay` recovery checks the live broker record before replaying a pending ProcessHost call. The separate `abort-readonly-wasm` strategy is an explicitly authorized safe-state decision: it retains the exact pre-call heap when a V4 read-only call remains indeterminate, even if the guest returned a value before the coordinator failed. It is unavailable under older policies. Both paths leave an audit receipt in the host journal. ProcessDeployment carries these outcomes across reopen and promotion.

This profile has passed actual process-worker, broker, reopen, promotion, revocation, wrong-context, invalid-input, trap and recovery tests. It has **not** closed V4-T2-04, FR-2.4 or NFR-16. The reloadable parent factory, broker directory, broker clock callback, signer/epoch authority, local OS and Node/V8 implementation remain in the trusted computing base. The signed clock-domain label does not prove that the factory's clock advances correctly. Broker receipts use public digests and are not authenticated against a writer who controls broker storage. A factory may change after a readiness probe; the live boundary then fails closed, but readiness does not prove future factory behavior. This ABI also does not isolate general effectful JavaScript adapters, external writes, arbitrary Aether values or multiple guest calls.

## Operator recovery

For a pending V6 invocation, retain its exact operation ID and deployment directory. Supply an authorization callback that returns literal `true` for the chosen recovery strategy. Try `recoverOperation(id, { strategy: 'isolated-replay' })` when the broker can reconcile the original read-only request. If it remains indeterminate and preserving the pre-call heap is the intended safe result, use `recoverOperation(id, { strategy: 'abort-readonly-wasm' })`. A returned `aborted` receipt is terminal for that operation ID. Do not issue a fresh ID as an implicit retry before the original outcome is settled.

Focused verification:

```sh
node --test --experimental-strip-types test/tier2/adapter-artifact.test.ts test/tier2/isolated-wasm-adapter.test.ts test/tier4/process-wasm-effect.test.ts test/tier4/process-wasm-deployment.test.ts
node roadmap/v4/research/isolated-wasm-adapter/verify.mjs
npm run typecheck
```
