# Signed causal lineage verification

`V4-T1-03` passes its two gates at source `2cc2d27` (full commit in `manifest.json`), specification `0.1.0`.

The clean detached checkout passed **457 tests**, including 16 lineage-ledger tests and 30 promotion/deployment integration tests. Build, typechecking and both roadmap checks passed. Complete command logs are retained.

## G1: signed causes and evidence

Every artifact in the default strict production profile requires independently enrolled Ed25519 signatures over its exact intent, execution manifest, specification references and evidence-bundle digest. Admission revalidates F06 evidence. Signed specification revisions use an expected predecessor/revision; inherited intent and specification parents are resolved transitively. Shared nodes retain all recorded causal links and dependency bodies remain pinned in the durable AST store.

The strict coordinator requires a branded lineage adapter and signed admitted genesis. It holds coordinator → lineage → deployment → host → AST-store locks in that order and invokes a currentness checkpoint immediately before durable commit. Actual two-process ledger tests exercise signed promotion, rollback and unchanged effect counts.

New production and deployment journals persist version 2 and their admission profile. The earlier baseline behavior requires an explicit compatibility profile. V1 adoption is explicit, validates original history before mutation and preserves receipts. It does not reinterpret historical baseline artifacts as strict lineage artifacts.

## G2: invalidation and fences

Tests revise specifications and transitive parents, then verify all affected artifact contexts become stale. Signed reconciliation preserves prior causes while selecting new revisions and fresh evidence. Protected signatures, input preconditions, frames and required postconditions cannot be dropped or strengthened into a vacuous replacement. Unknown or stale proof/evidence bundles do not discharge fences.

Actual process termination is tested before and after promotion commit. Recovery follows the durable target even if a later specification revision blocks serving; a newly signed repair can replace the quiescent stale source. Live invalidation blocks later effect/commit boundaries, while separately authorized historical recovery invokes no live append. Stored readiness and `servingReady` are distinct.

Independent root review reproduced a malformed-author-list bug: a string could satisfy substring membership. Current policy responses now require an exact validated shape and unique author array. Review also identified historical receipt authority widening after capability removal; retrieval now requires the original capabilities and policy to remain covered. Denied receipts are unchanged and never redispatched. Corrupt metadata, invalid signatures and malformed authority responses remain genuine errors rather than ordinary invalidation statuses.

## Scope

This is bounded same-host governance with retained immutable lineage history. It does not establish 100M-node indexing, replicated consensus, the heterogeneous Byzantine quorum or release latency. Metadata remains separate from immutable v1 AST identity. Historical stale causes remain visible alongside current reconciled artifact contexts. Full v4 remains open.

Reproduce with the commands in `manifest.json` at its exact subject commit. The full suite rechecks the baseline, durable AST store and portable scalar certificate implementations.
