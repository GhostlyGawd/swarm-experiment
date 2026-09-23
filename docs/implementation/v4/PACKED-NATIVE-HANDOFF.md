# Native packed candidate handoff profile

`ResumableRuntime.commitPackedCandidate` is a versioned correction boundary for a native packed heap candidate. It accepts an authenticated `PackedResumableCheckpoint`, the candidate `PackedHeapImage`, the exact current snapshot digest and the admitted layout digest. The source checkpoint must unpack to the runtime's current complete snapshot. The candidate must pass packed image/layout/UTF-8/reference validation and retain the source heap ID, layouts and every row's identity, type, version and bit span. Only field values may change.

The method computes `aether.packed-candidate-correction/1` over the source snapshot and image digests, candidate image digest, layout, program, manifest and exact changed-field digest. Two trusted host callbacks must return literal `true`: ordinary `authorizeCorrection` and the candidate-specific `authorizePackedCandidate(snapshot, subject)`. The latter must decide on the exact subject; the host must also bind any native executable/admission policy it relies on. A blocked effect must be reconciled before this handoff. Callback execution is synchronous; the source snapshot digest is rechecked afterward.

All changed fields enter the logical runtime in **one** host event. Each touched record version advances once. The event records the subject digest in its operation identity and only changes the `records` section; checkpoint validation independently checks row identity, field identity and version progression when replaying the inverse event chain. The runtime repacks its corrected logical records and compares the candidate's packed bytes and string dictionary before publishing. Any failure inside the mutation rolls back the entire batch. Repeating an already committed candidate against its old source digest fails as stale. A zero-change candidate adds no event.

The native candidate image is never installed directly as a checkpoint. Its source event head still names the pre-correction logical state. The newly committed snapshot receives its own event head and checkpoint digest, can be restored and rewound, and may then be packed for migration. The standalone runtime method does not prove the native executable or grant caller authority; the ProcessHost control below supplies durable admission and publication checks. The research C bridge authenticates a binary and produces candidates, but full native lowering, guest execution, complete value coverage, externally attested native provenance and release performance remain open under V4-T3-10/T4-05.

## Durable ProcessHost control

`ProcessResumableSession.correctPacked` now admits `aether.process-packed-control/2` as an audited checkpoint control. The earlier `/1` request remains readable for historical journal validation and same-ID receipt recovery, but cannot start a new control. A `/2` request binds the operation ID, exact leased checkpoint, layout/source/candidate image digests, manifest artifact digest, native executable SHA-256 and native operation-list digest. The layout table is stored once in an fsynced, content-addressed sidecar; the journal retains its digest. The candidate image is reconstructed independently from the corrected logical state, with the source row versions restored for the candidate comparison. A new `packed-correction-v2` event subject also binds the operation, artifact, executable and operation-plan identities. The reopen validator compares the reconstruction with the request digest and recomputes that full event subject. It rejects missing or altered sidecars, relabeled operation plans and unaudited packed host events.

The host holds an exclusive checkpoint lease, rechecks invocation grants and `authorizeCheckpoint({action:'packed', ...})` at entry and before the journal decision, and refuses unresolved effects and replay debt. `PackedNativeProcessRunner` reads a bounded regular executable through one file descriptor, checks its SHA-256 and binary header, copies those exact bytes into a private executable file, and runs that copy with time/output limits. Its nonvirtual static entry point returns a privately branded in-process run proof bound to the operation and all request identities. `ProcessHost.finishControl` requires that proof, so an arbitrary callback or a direct public `withCheckpoint` caller cannot publish a forged `/2` candidate. The integration test kills the controller before and after the durable decision and verifies same-ID retry, reopen, worker publication and no duplicate native run after commit.

The journal records the request and independently reconstructs the candidate after restart; the private proof is checked at the original commit boundary and is not a portable hardware attestation. Authorized native code still runs with ordinary host-process authority. An external signer or hardware attestation, a sandboxed guest, full AST lowering and release qualification remain open.

Touched records now pass the declared runtime record type check before the batch event. In particular, a live relative reference to the wrong record type is refused even when its offset, ID and epoch are valid. The general typed boundary also checks record-name identity, matching the language type relation.

Focused verification:

```sh
node --test --experimental-strip-types test/tier3/packed-candidate-handoff.test.ts
node --test --experimental-strip-types test/tier4/process-resumable.test.ts
node --test --experimental-strip-types test/tier4/packed-native-process.test.ts
npm run typecheck
```
