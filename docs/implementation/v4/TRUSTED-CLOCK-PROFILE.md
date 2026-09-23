# Independently clocked isolated Wasm profile

`scoped-anchored-wasm-v7` is opt-in. It retains the V6 signed read-only i32 Wasm effect policy and adds an operator-provisioned `aether.trusted-clock-anchor/1` outside the reloadable services factory. Fresh V7 histories use deployment `/7`, prepared `/5`, host configuration `/5` and effect plan `/5` identities. These bind the clock anchor digest alongside the existing signer anchor and signed policy. V6 histories retain their original bytes and trusted-factory-clock assumption.

The anchor identifies an authority and the exact signed `clockDomain`. Its synchronous provider returns integer milliseconds and a decimal monotonic revision. It refuses malformed, unavailable, asynchronous or backward readings. The clock domain in every signed V4 rule must match the independently supplied domain. Factory services cannot supply or replace the anchor. A changed clock identity fails before an existing V7 deployment record is rewritten.

ProcessHost checks the independent interval when issuing and verifying every scoped grant, including direct entry, nested worker calls and effect targets. It checks the signed deadline before constructing a live effect router. The host pins the independent anchor and exact verified grant windows into the nonvirtual broker router. The router and broker recheck grant expiry and deadline immediately before the irreversible sink, including **after** factory authorization callbacks. A denial before adapter entry publishes a terminal no-dispatch transition; if the controller dies while only the durable dispatch marker exists, recovery treats the outcome as uncertain. Historical reconciliation remains a separately authorized operation and does not turn an expired grant into a new live sink call.

The [real V7 ProcessHost/ProcessDeployment test](../../../test/tier4/process-wasm-clock.test.ts) holds factory grant and broker clocks at 100 while independent time advances. Short grants and the signed deadline then refuse new calls without a broker router or guest launch. Genesis, promotion, reopen, wrong-anchor refusal and rollback refusal are exercised. The [broker test](../../../test/fabric/trusted-broker-clock.test.ts) advances independent time inside the factory authorization callback and confirms zero sink calls, including after the dispatch marker.

The test's clock provider is an in-memory stand-in for operator infrastructure. The anchor detects rollback only during its own lifetime; **the external provider must preserve monotonic time and revision across process restarts and whole-directory restores**. A provider that simply freezes both callbacks cannot be distinguished from time that has not advanced. The guest remains a bounded read-only i32 profile; the parent factory, broker storage, Node runtime and local OS remain trusted. General JavaScript adapter isolation, authenticated broker receipts, external clock custody and all-path containment remain open. This does not close V4-T2-04 or NFR-16.

Focused verification:

```sh
node --test --experimental-strip-types test/tier2/trusted-clock-anchor.test.ts test/fabric/trusted-broker-clock.test.ts
node --test --experimental-strip-types test/tier4/process-wasm-clock.test.ts test/tier4/process-wasm-effect.test.ts test/tier4/process-wasm-deployment.test.ts
npm run typecheck
```
