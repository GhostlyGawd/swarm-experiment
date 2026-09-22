# Durable candidate occurrence workspace

Implements the Tree-CRDT candidate semantics selected in [D04](D04-replication-quorum.md), using authenticated F05 operations and `DurableGraphStore`. This is the T1-06 implementation boundary; it does not supply a production promotion quorum or the 1,000-agent convergence measurement.

## Identity and merge

`DurableTreeWorkspace` owns one enrolled replica journal per projection/membership epoch. Every inserted occurrence derives its ID from its allocated signed operation ID. Identical immutable AST content can therefore have independent editable occurrences. `DurableReplica.authorMutation(builder)` allocates the operation ID and Lamport clock under the durable admission lock; builder failure publishes no operation and consumes no sequence. Existing `author` callers retain their API and default epoch clock behavior.

Replication unions complete authenticated immutable operation variants. Projection sorts accepted operations by numeric Lamport clock, then bytewise operation ID. Replaying the complete accepted set handles arrival reorder and late equivocation without preserving a first-arrival winner. Conflicting signed variants and causal descendants are quarantined; missing predecessors remain pending. Invalid tree semantics remain inspectable diagnostics. The configured occurrence limit is part of this projection policy: excess insertions are suppressed in the same total operation order at every replica, with explicit diagnostics and all signed frames retained. Unresolved overflow makes materialization explicitly invalid/incomplete even if the truncated AST would typecheck; it cannot masquerade as a complete merge. Concurrent insertions cannot make inspection, deletion or checkpoint repair unavailable merely by exceeding the local limit. The repair path deletes unwanted retained occurrences and unanimously certifies the exact bounded projection; the new epoch clears those resolved diagnostics and permits new insertion identities. Suppressed insertions may become relevant when the old-epoch accepted set changes, but a certified epoch boundary records the exact projection and prevents obsolete suppressed insertions from replaying into the new epoch.

Insert establishes a node, replacement changes its immutable content prototype, and move changes parent/field/position. A move that creates a cycle is suppressed with the previous edge retained. Delete moves the occurrence to trash; its descendants and replacement register survive until collection. A later valid move can restore it. Concurrent operations follow the same deterministic ordered replay, including delete/replace/move combinations.

Child positions use D04's exact bounded rational vectors. Neighbor IDs are scoped to the same parent and grouped field. Allocation uses the operation-derived suffix; malformed, equal or exhausted intervals reject before operation publication. A checkpoint reindexes sibling groups deterministically while retaining occurrence IDs.

## AST projection

`seed(term)` creates editable occurrences for every grouped AST child, including independent repeated subtrees. It is a sequence of durable candidate operations: interruption may leave an incomplete candidate, and the API makes no atomic whole-module seed claim.

`insert`, `move`, `replace` and `delete` operate on occurrence IDs. Content prototypes are immutable v1 AST nodes; their original child references are **not** a fallback for absent editable children. Scalar prototype metadata stays on the parent. In particular, paired child labels such as record fields remain parent metadata and must be changed consistently with their grouped children. Unsupported/mismatched shapes are rejected by materialization.

`materialize({leaseId})` rebuilds grouped children, validates field roles and cardinality, checks supported scalar/type serialization and typed literals, then runs the existing type checker on the composed root. The designated document field is `root` and must contain exactly one root occurrence. The result distinguishes structural failure from a materialized root whose `typecheck.ok` is false. Both are candidates, and `productionAuthorized` is always false. Structural or replication diagnostics force the top-level `root` to null; partial CAS addresses remain only in diagnostic `occurrenceRoots`. Pending/quarantined/unsupported or capacity-suppressed operations add materialization diagnostics and prevent a complete/typechecked result; cycle suppression alone is the selected resolved conflict policy. The caller explicitly owns the candidate lease and decides its retention lifetime.

The workspace never invokes `DurableGraphStore.commit`, production promotion, or runtime execution. The executable test separately runs a valid returned root to establish real AST compatibility. Existing production heads remain unchanged for valid and invalid merges. Contracts, proofs, lineage and effect policy still require the normal production admission path.

## Conservative causal stability protocol

This implementation uses a unanimous enrolled-member checkpoint. It is an availability-conservative stability protocol, not HotStuff, FROST or a Byzantine threshold quorum.

1. Each member durably fences local authoring and signs an immutable inventory of all locally observed old-epoch frames. A separate immutable fence receipt survives replay of older mutable workspace metadata. A fence cannot be released by timeout.
2. A proposal contains the exact sorted union of all signed inventories, complete authenticated frames, previous certified base, deterministic projection/collection/reindex result, next epoch and Lamport floor. The roster stays unchanged and the epoch advances by one.
3. Every ACK checks signatures, exact inventory coverage, causal readiness, projection/reindex result, epoch/floor and complete canonical AST archive. Archive roots must equal all base prototypes plus every insert/replace prototype in the cut, including quarantined and trashed audit content. `DurableGraphStore.validateArchive` shares the import parser and performs no writes, leases or mutation-ticket allocation. A digest assertion alone cannot authorize an empty or incomplete archive.
4. Locally known valid old-epoch frames outside the signed fence union prevent a new proposal or ACK, with the conflicting frame digests reported and bytes retained. They indicate a violated inventory/fence assumption. A previously fully certified cut remains an immutable decision: historical validation and installation replay exactly that cut, independently of later deliveries.
5. All active members sign the same checkpoint digest. A replica durably stores the certificate/archive, prepares the new epoch profile and live prototype lease, then atomically advances its authoritative workspace metadata. Before this commit, recovery keeps the old fenced epoch; after commit, recovery uses the certified new epoch and completes idempotent lease cleanup.
6. The new journal persists a Lamport floor at least as high as every frame in the certified cut. Sequences restart in the new epoch namespace. Old envelopes fail epoch validation, and collected occurrence IDs cannot be reintroduced by replaying an obsolete move or insert. A new insertion necessarily has a different identity.

Old immutable journals, full checkpoint archives and reindex mappings remain audit evidence. Collection removes live trash occurrences and retires the old live lease; it does not promise deletion of every historical object. A surviving immutable parent prototype can still reference old child CAS objects. There is no automatic disk-space reclamation claim for retained history.

No dynamic replica retirement is provided here. Missing members block this unanimous checkpoint until they recover; a separately verified membership/BFT protocol is required for safe retirement. Ordinary unfenced editing remains available, subject to explicit capacity and fractional-position limits.

## Durability and bounds

The local workspace serializes authoring, ingestion, fencing and checkpoint installation with the shared process-safe journal lock. CAS state changes use the store's own durable lock. Metadata is checksummed, and installed base/epoch/floor is validated against the complete signed checkpoint chain from trusted genesis. Missing initialized metadata fails closed. The local filesystem and enrolled private keys remain trusted; this is not protection against an attacker deleting all independent durable evidence or compromising every signer.

Default workspace limits are 2,048 live-plus-trash occurrences (configurable up to 4,096), 10,000 retained operations per epoch, 64 MiB checkpoint encoding (configurable up to 128 MiB), and materialization/seed depth 64. F05 and durable CAS have their own framing, archive and journal limits. Histories and leases intentionally retain evidence. Full projection and subtree rebuilding favor bounded correctness and inspectability; no incremental performance or release-scale latency guarantee is claimed.

## Verification

Focused tests cover actual CAS executable roots, independent shared-content occurrences, overlapping partitioned edits, reordered/duplicated deliveries, pending predecessors, late signed equivocation, concurrent cycle suppression, grouped While fields, structural and semantic invalidity, archive/ACK forgery, missing-member refusal, repeated certified epochs, obsolete-edit rejection, and restart.

Actual child processes receive SIGKILL at durable fencing, checkpoint preparation, committed epoch publication and completed collection. Reopening checks the authoritative epoch, preserved fence, same-certificate retry, candidate equality and post-GC materialization. Existing F05 tests additionally cover concurrent process author builders and stable identities after restart. These are bounded correctness tests, not the separate Q01 production-scale convergence campaign.
