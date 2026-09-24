# D18 — Signed evidence closure for an archived virtual forwarder

Status: bounded prerequisite for V4-T1-05/G1, 2026-09-24. It does not lift D14's promotion block or admit the virtual profile to ProcessHost or an effect broker. Specification 0.1.0 and the task gates remain unchanged.

## Decision

Evidence policy `aether.evidence-policy/3` requires a D16 exact-source descriptor and the D17 resumable target profile. Its checker rederives the one-wrapper candidate before proof work, then treats each checked rewritten call site as an edge to the archived wrapper for **dependency closure**. The candidate AST still contains direct target calls. The archived wrapper and target declarations therefore both appear in the signed execution manifest's exact dependency set. A target profile digest commits to the descriptor ID, source/candidate roots and lowering profile without including the candidate manifest digest in its own preimage.

The ordinary local verifier continues to check the candidate's typed contracts and the archived wrapper's declaration. It does not prove trace/fuel equivalence by value-only SMT: the exact D16 structural checker and D17 bytecode differential remain separate prerequisites. The V3 evidence envelope records checker version `3`; V1/V2 evidence retains its historical closure and version rules. Missing descriptor context, a non-V3 policy, wrong target profile, changed source/candidate AST, changed dependency set or altered descriptor is rejected.

`CausalLineageLedger.admitArtifact()` now resolves the archived wrapper from the checked source context, verifies its declaration hash against the descriptor and manifest, stores/pins that dependency, and then applies the existing signed intent/specification checks. A test creates a signed source artifact and a causally linked signed candidate, rejects descriptor substitution, admits the candidate, collects after dropping draft leases, reopens lineage and hydrates the archived wrapper.

## Remaining admission boundary

`SemanticGarbageCollector` still produces legacy `/1` proposals that may combine multiple rewrites, and D14 rejects every fresh collapsed-wrapper promotion. A separate versioned one-wrapper GC proposal must bind the exact candidate manifest and descriptor, then use strict-lineage governor admission and recheck the subject on prepare, commit, activation and recovery. Process artifacts and worker bootstrap must carry and recheck the same subject before effect dispatch. Until those paths exist, V3 evidence proves a signed dependency closure for local resumable code, **not** an authorized production rewrite or T1-05/G1 completion.
