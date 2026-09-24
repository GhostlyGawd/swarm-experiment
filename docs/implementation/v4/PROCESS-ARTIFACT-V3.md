# Pure virtual-forward ProcessArtifact/3 boundary

`aether.process-artifact/3` is a separate codec for the current D16/D17
one-wrapper, pure, closed virtual-forward profile. It carries canonical Agent-IR
for both exact source and candidate modules, the independently derived D16
descriptor, the archived wrapper declaration as an external dependency, source
EvidencePolicy/2 evidence, candidate EvidencePolicy/3 evidence, and a measured
executable subject. The candidate manifest's target profile commits to the
descriptor; its target artifact digest commits to the measured subject.

`makeProcessVirtualArtifactV3` and `decodeProcessVirtualArtifactV3` run the same
validator. It decodes and re-encodes both IR streams; re-hashes the ASTs and
wrapper; reconstructs the one-wrapper rewrite, profile, manifest dependency
closure and local verifier evidence; rejects effects, imports and dynamic calls;
and checks that both manifests remain admitted by a real signed causal-lineage
ledger. The artifact pins the exact source and candidate intent digests; the
candidate's current signed intent must have that source intent as a direct
parent. A structural object with no-op lineage methods is rejected.

The measured subject hashes the current Node binary, a caller-selected bundle,
and a caller-declared nonempty source-file list of at most 128 files. The validator re-reads those
paths and compares actual bytes on every read. Those paths **do not yet prove**
the complete transitive worker source closure, how the bundle was built, or that
ProcessHost launches these measured bytes. The subject is suitable for a later
versioned process transport binding, not a deployment admission claim.
The current independent worker build verifies a closed import graph and can
supply its measured bundle and input list to Artifact/3 in a real-worker test;
that builder's manifest is not yet a mandatory Artifact/3 admission field.

The live `ProcessDeployment` state, factories, references, migration plan and
worker transport continue to accept Artifact/1 or Artifact/2 only. Artifact/3
is deliberately rejected there until a new deployment state and worker wire
format carry and recheck this subject across the actual process boundary. This
does not close T1-05 or authorize general GC, effectful code, replay, or remote
execution.

Focused check: `node --test --experimental-strip-types test/tier4/process-virtual-artifact.test.ts`.
