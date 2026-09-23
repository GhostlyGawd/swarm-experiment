# Native packed candidate handoff profile

`ResumableRuntime.commitPackedCandidate` is a versioned correction boundary for a native packed heap candidate. It accepts an authenticated `PackedResumableCheckpoint`, the candidate `PackedHeapImage`, the exact current snapshot digest and the admitted layout digest. The source checkpoint must unpack to the runtime's current complete snapshot. The candidate must pass packed image/layout/UTF-8/reference validation and retain the source heap ID, layouts and every row's identity, type, version and bit span. Only field values may change.

The method computes `aether.packed-candidate-correction/1` over the source snapshot and image digests, candidate image digest, layout, program, manifest and exact changed-field digest. Two trusted host callbacks must return literal `true`: ordinary `authorizeCorrection` and the candidate-specific `authorizePackedCandidate(snapshot, subject)`. The latter must decide on the exact subject; the host must also bind any native executable/admission policy it relies on. A blocked effect must be reconciled before this handoff. Callback execution is synchronous; the source snapshot digest is rechecked afterward.

All changed fields enter the logical runtime in **one** host event. Each touched record version advances once. The event records the subject digest in its operation identity and only changes the `records` section; checkpoint validation independently checks row identity, field identity and version progression when replaying the inverse event chain. The runtime repacks its corrected logical records and compares the candidate's packed bytes and string dictionary before publishing. Any failure inside the mutation rolls back the entire batch. Repeating an already committed candidate against its old source digest fails as stale. A zero-change candidate adds no event.

The native candidate image is never installed directly as a checkpoint. Its source event head still names the pre-correction logical state. The newly committed snapshot receives its own event head and checkpoint digest, can be restored and rewound, and may then be packed for migration. This profile does not prove the native executable, grant effects, authorize caller identity, or replace ProcessHost publication/lease checks; those remain host admission and deployment responsibilities. The research C bridge authenticates a binary and produces candidates, but full native lowering, guest execution, complete value coverage, crash-safe external publication and release performance remain open under V4-T3-10/T4-05.

Focused verification:

```sh
node --test --experimental-strip-types test/tier3/packed-candidate-handoff.test.ts
npm run typecheck
```
