# Typed cognitive blackboard acceptance

`V4-T1-09` passes its two task gates at clean source commit `870b438559df87f3dbd641b0452bf29a0e66e929`, specification `0.1.0`. A detached checkout installed locked dependencies and passed **540 tests**, build, typecheck and both roadmap checks. The source commit predates this evidence record; the detached worktree was clean.

## G1 — Structured, recoverable task state

`CognitiveBlackboard` stores typed claim, hypothesis, decision, delegation and evidence entries as a causal graph of entry IDs. Claims and hypotheses carry integer uncertainty scores. Evidence must cite a retained claim or hypothesis as a parent and pass a trusted host verifier bound to the execution manifest and AST subject. A digest supplied by an agent cannot mark a claim verified. Views recheck the verifier and current signed lineage; revoked evidence and superseded specification versions yield no current verified-evidence IDs. Historical entries remain inspectable as stale context.

The restart test discovers the board from its AST node and manifest after reopening, then recovers all five item kinds, their causal links and the verified-evidence set. A second integration test uses a real signed `CausalLineageLedger` admission, attaches a board to a child AST node, then revises the governing specification: further writes are denied, and a reopened historical view reports `current: false` with no current verified evidence.

## G2 — Executable identity, access and retention

Boards are versioned sidecars bound to an exact admitted manifest and AST node. The executable AST address and persisted node content remain unchanged when entries are appended. `assertNodeCurrent` checks membership in that manifest's admitted closure, including dependencies, avoiding false authority from another artifact that shares the root. The root and tier1 package entry points export the board API.

The trusted host supplies the actor, creation authorization, evidence verifier and clock. ACLs distinguish owner, readers and writers. The node lookup returns only boards the current actor may read, excludes expired boards and has a bounded board-count profile. The owner alone can change ACL membership and narrow retention settings; compare-and-swap revisions prevent stale updates. Retention caps entry count and expiry to a host-configured maximum of 30 days by default. Expired boards deny reads/writes and can be removed by the owner; tests cover rejected creation, unauthorized reads/writes and discovery, stale updates, pruning and expiry. Records are bounded, checksummed, written via flush-and-rename, and serialized under the durable journal lock.

## Declared boundary

This is same-host, process-level authorization backed by trusted host callbacks and filesystem permissions. It does not claim protection from a hostile host or filesystem administrator, secure physical erasure after deletion, cross-host replication, or autonomous validation of arbitrary proof digests. A specification change can race a board append, but every later view rechecks current lineage and downgrades stale evidence; scratchpad entries never authorize production promotion by themselves. The full v4 release remains open.

Commands, source identity and log hashes are recorded in `manifest.json`.
