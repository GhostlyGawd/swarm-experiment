# D17 — Descriptor-bound resumable virtual forwarding

Status: bounded V4-T1-05/G1 implementation slice, 2026-09-24. It does not authorize semantic-GC promotion, effect-broker dispatch, or ProcessHost use. Specification 0.1.0 and all gates remain unchanged.

## Decision

The opt-in resumable profile `aether.resumable-virtual-forward-profile/1` binds the checked D16 descriptor, source root and candidate root in `ExecutionManifestV1.target.profileDigest`. The manifest dependency closure must include the exact archived wrapper declaration and its target. The compiler independently checks the descriptor against source and candidate ASTs, then lowers only the rewritten candidate call sites to the archived wrapper's bytecode. It restores source instruction references for the affected candidate subtree, so the bounded program code sequence matches the source. Other direct target calls stay direct.

This is a compatibility route for the resumable machine. It removes the wrapper from the current candidate AST, but **executes the archived wrapper bytecode and frame**. It preserves the source's bytecode step budget and resumable frame shape in the admitted one-wrapper grammar; it does not remove runtime work or establish a memory/latency improvement. The reference runtime's AST-step quota remains a separate model.

The profile requires exactly one archived wrapper dependency in this initial slice. Missing, extra, changed or conflicting dependencies, profile digests, descriptors and AST roots fail before execution. A program with the virtual profile but no descriptor is refused. The runtime refuses an effect broker, and `ProcessResumableSession` refuses begin/reopen before host mutation. These refusals remain until the signed execution subject binds the source, descriptor, effect IDs and checkpoint transition policy end to end.

## Evidence and limits

Focused tests compare source/candidate code bytes and 140 tight quota cases over the wrapper caller and unaffected direct calls, checkpoint and restore a frame inside the archived wrapper, and complete that restore in a fresh process. A combined direct-journal test pins the candidate module and archived wrapper/target dependency roots, drops the draft lease, collects, reopens and resumes from inside the wrapper. Tests also reject tampered profile/dependency/descriptor input, accessors and proxies, and unadmitted broker/ProcessHost paths. The current manifest profile digest provides local binding; it is not by itself strict-lineage governor admission for semantic GC.

The D14 promotion block stays in force. General wrapper chains, multiple archived dependencies, broader values/contracts, physical bypass in the resumable machine, effects across the broker boundary, ProcessHost crash recovery, Agent-IR transport and full G2 retention remain open. This slice is not T1-05 acceptance evidence.
