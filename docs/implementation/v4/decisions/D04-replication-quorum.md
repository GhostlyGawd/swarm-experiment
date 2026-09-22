# D04 — Candidate occurrence trees and production quorum

Decision version: **0.1.0**. Specification: **0.1.0**. Research owner: **V4-R01**. Date: **2026-09-22**.

This decision selects algorithms for V4-T1-06 and V4-T2-06. The executable artifact is a bounded research model, not their production implementation. Existing F05 authenticated journals remain candidate operation stores; they do not acquire production authority through this decision.

## Selected approach

Use a union of immutable authenticated operation variants, followed by deterministic sequential projection. The move rule follows Kleppmann, Mulligan, Gomes and Beresford: apply operations in a total order, retain one parent per occurrence, suppress a move if the destination is inside the moved subtree, and represent deletion by moving to a separate trash root. Their paper proves its own tree algorithm and describes reversible insertion of older operations. Aether initially recomputes the sorted operation set; it does not claim to inherit the paper's machine-checked proof for Aether's additional rules. [Primary paper, §§3–4](https://martin.kleppmann.com/papers/move-op.pdf), [authors' implementation and proof](https://github.com/trvedata/move-op).

The operation-set representation is consistent with the sequential-specification approach in **OpSets**. The union contains conflicting signed variants as evidence; validation derives an eligible subset. Eligibility can shrink when equivocation appears, so an arrival-time materialization must be recomputed. The immutable union itself remains associative, commutative and idempotent. [OpSets, authors' extended paper](https://arxiv.org/abs/1805.04263).

For sibling order, use retained insertion anchors inspired by **RGA**, whose growable sequence preserves deleted positions for concurrent operations. Aether's placement-entry adaptation below is an original composition with the selected move rule. [Roh, Jeon, Kim and Lee, original publication record](https://scholarx.skku.edu/item/1bfbdcc7-877f-4bf3-b60d-edb3f21bd577).

For production decisions, select **Basic HotStuff**, the three-phase protocol in Algorithm 2 of the 2019 paper. Prepare certificates precede precommit certificates; a precommit certificate establishes a lock before a commit vote. A commit certificate permits a decision. A new leader collects quorum reports and selects the highest prepare certificate. A prepare vote requires extension of the lock or a strictly higher certified justification. These are the published protocol rules, with quorum votes and certificates abstracted in the research model. [Primary HotStuff paper, §§4.1–4.3](https://reitermk.github.io/papers/2019/PODC.pdf).

## Aether occurrence projection contract

The following are Aether choices. T1-06 must implement and test them against actual F05 envelopes and AST materialization.

1. **Identities and order.** An operation ID binds repository, membership epoch, replica and sequence. A new occurrence is derived from its insert operation ID; one occurrence can reference the same AST content as another without sharing location. Sort eligible operations by numeric Lamport clock and then bytewise operation ID. Never use locale collation or wall-clock time. Replacements change content; moves preserve the occurrence ID.
2. **Eligibility.** Reuse F05 authentication, bounded decoding and membership checks. Missing causal predecessors remain pending. Every dependency must precede the operation in the declared logical order. If one operation ID has multiple authenticated bodies, quarantine every variant and its causal dependents. Retain evidence. Recompute eligibility and projection whenever the union changes. Arbitrary missing-parent edits cannot manufacture an occurrence; retain a diagnostic and the prior valid edge.
3. **Create and move.** Insert creates a fresh occurrence and a placement. A move selects a new parent, field and placement for an existing occurrence. Before applying an edge, walk the current parent chain; suppress self-links and cycles. A suppressed operation stays visible in diagnostics. A later operation can still move the occurrence validly.
4. **Delete and replace.** Delete is a move to `trash`. It hides the subtree from the executable root without destroying its descendants or content. Concurrent delete/move uses the same total operation order and cycle rule; a later valid move can restore the occurrence. Replace changes a separate content register in total order, including when its occurrence is hidden. Restoration exposes that content. This is explicitly **not** irreversible remove-wins deletion. A user-visible permanent deletion would require a separate schema and lifecycle.
5. **Sibling order.** Each successful insert/move creates an immutable placement whose ID is the operation ID. `positionId` selects the preceding placement: `rga1:head` or `rga1:<full operation digest>`. Scope anchors by parent occurrence **and field**. The anchor must be causally known and belong to that scope. Traverse placement children in descending total operation order, depth first. Emit an occurrence only at its current selected placement. Old placements remain traversal anchors after movement/deletion. Concurrent placements sharing an anchor are distinct and deterministic.
6. **Bounds and compaction.** Anchor IDs have fixed digest length; fractional keys and position rebalancing are unnecessary. Placement history and operation history still grow. Enforce declared journal/object/depth limits and report `capacity_exceeded`. Do not delete old anchors opportunistically. Compaction requires a certified checkpoint with an explicit mapping of retained occurrence/placement IDs and replay evidence. Every active candidate replica must acknowledge the frontier, or be retired through the membership protocol. Timeout alone establishes neither causal stability nor retirement. Unknown older input after a checkpoint must trigger checkpoint synchronization or a stale-epoch rejection; it cannot resurrect collected anchors.
7. **Projection and admission.** Materialize only the tree reachable from the designated root. Trash, suppressed operations, invalid field cardinality, malformed AST shape, missing objects and conflicting edits stay inspectable. A candidate root may be invalid. Run whole-root language, contract, dependency and capability checks before proposing production admission. Convergence never substitutes for verification.

F05 currently accepts an opaque `positionId`; existing signed bytes must remain readable. T1-06 adds the `rga1:` interpretation under an explicit occurrence-projection semantics version. Unsupported old position strings remain diagnostic candidates until deliberately translated. No stored envelope or v1 AST address is silently rewritten.

The finite model uses one child field, short symbolic IDs and explicit dependency lists. Production uses full digest IDs, decimal clocks, the actual causal frontier and parent/field scopes. Model occurrence names such as `a` stand for IDs derived from insert operations; they are not a proposed wire grammar.

## Aether production protocol profile

- **Committee:** an enrolled voting roster of exactly `n = 3f + 1`, initially `n = 4, f = 1`; additional agents can remain nonvoting workers. Quorum is `2f + 1` distinct enrolled identities. Every QC must include at least two enrolled model families. Enrollment must keep each family below the cryptographic threshold. Families are governance attestations attached to operator-controlled model endpoints; agents cannot self-assert a family. Family diversity does not prove independent errors or expand the fault bound.
- **Signed subject:** domain/version, repository, membership epoch, policy epoch, view, phase, parent block, full promotion proposal digest and signer identity. The proposal already binds the execution manifest, evidence, state migration and effect plan. Votes for another target, policy, parent, phase or view cannot be combined.
- **Durable validator state:** persist current view, highest prepare QC, highest locked QC, highest executed checkpoint and the vote/nonces spent for each phase/view before sending a vote. Restart cannot repeat a vote for a competing subject. Equivocation evidence is retained. Retired keys can verify historical evidence but cannot authorize new-epoch work.
- **Leader changes:** use deterministic round-robin leaders and an increasing timeout pacemaker. Collect a quorum of authenticated new-view reports before a new leader proposes. Validate each reported QC and select the highest prepare QC. Do not invent a higher view certificate to bypass a lock. Timeout causes a view change; it never commits a root or releases state ownership.
- **Synchrony:** safety assumes at most `f` Byzantine validators, valid authentication and durable honest vote state. Progress additionally requires eventual bounded message delays, enough available eligible families and a sufficiently long view with an honest leader. A persistent partition can stop production commits. Candidate workers may continue disconnected editing. These different availability claims are deliberate.
- **Admission execution:** after a commit QC, perform the exact-parent and policy-epoch comparison at the runtime admission boundary. A block records a decision to admit a precise subject; the runtime must durably prepare and complete its prescribed ownership/effect changes. A stale runtime precondition yields an explicit failed admission command, never an implicit admission of another root.

Quorum intersection is a safety prerequisite: with the selected roster, two quorums overlap in at least `f + 1` identities, including an honest identity under the fault assumption. The model checks this combinatorially for `n=4` and `n=7`. It also models validator phase state; intersection alone would not prevent unsafe behavior after an incorrectly implemented view change.

## Epoch handoff and key lifecycle

Membership changes use a **terminal checkpoint handoff**, an Aether protocol extension with its own verification obligation. This is not a claim that the HotStuff paper proves our reconfiguration protocol.

1. The old committee agrees, through all consensus phases, on a terminal checkpoint binding the final production root, state/ownership generation, effect frontier, candidate frontier, next membership and policy, and the next group public key. The next configuration must satisfy the same roster, threshold and family rules.
2. Old validators never vote for an old-epoch descendant of a reconfiguration block. Validators locked on the checkpoint reject conflicting branches under the ordinary lock rule. A committed reconfiguration can therefore leave an unavailable system while transfer finishes; it cannot fall back to an overlapping old writer.
3. New validators install and verify the checkpoint, execution/state evidence and membership transcript. A quorum of new-epoch `READY` attestations binds that exact checkpoint and key. Activation requires both the old commit QC and this new quorum. The new epoch begins with the checkpoint as its trusted genesis. No cross-committee signer overlap is assumed.
4. Old-epoch live votes are rejected after activation. New-epoch shares cannot certify old-epoch messages. A failed or partitioned handoff waits for the same committed checkpoint; administrators cannot substitute an alternate root while preserving the original certificate.

Select **FROST(ristretto255, SHA-512)** for threshold signatures, while retaining authenticated participant transcripts so family eligibility and equivocation remain independently checkable. RFC 9591 defines two-round FROST signing, requires one-use nonce material, and leaves distributed key generation outside its signing specification. [RFC 9591](https://www.rfc-editor.org/rfc/rfc9591.html).

Use the ZF FROST implementation's documented FROST KeyGen variant (Pedersen DKG with knowledge proofs), fresh for each epoch. It requires consistent public broadcasts and confidential authenticated share delivery. The forthcoming implementation must pin a reviewed crate release/commit, retain public setup commitments, validate participant identifiers and reject inconsistent transcripts. A dealer-generated full secret is acceptable only for a labeled local test fixture. [ZF FROST DKG documentation](https://frost.zfnd.org/tutorial/dkg.html), [primary library DKG definition](https://docs.rs/frost-core/3.0.0/frost_core/keys/dkg/index.html).

Nonce commitments, selected participant sets and spend markers must survive crashes without nonce reuse. Abort/retry allocates fresh nonce material; it does not re-sign a different payload with old commitments. Reconfiguration creates a new group key rather than relying on removed participants to forget old shares. Private shares stay outside graph/heap snapshots. Historical public keys and revocation checkpoints remain available for audit. These are implementation requirements, not cryptographic claims established by the TypeScript model.

## Rejected alternatives and remaining work

| Alternative | Reason rejected for this profile |
|---|---|
| Arrival-order parent assignment or independent parent LWW registers | Equal operation sets can produce different local decisions or a parent cycle; cycle handling must be part of the deterministic projection. |
| Delete-and-recreate for move | Duplicates the editable occurrence and breaks identity through concurrent movement. |
| Fractional positions without a bound/compaction protocol | Hides growth and rebalance dependencies; retained placement anchors give a concrete ordering rule. |
| First-arrival-wins equivocation | Different peers can keep different variants permanently. |
| A signed majority or one prepare QC as production approval | Omits the fault threshold, locks and cross-view safety rules. |
| Chained/optimistic two-phase variants for the first implementation | Adds pipeline and recovery obligations before a durable three-phase reference exists. This is a complexity decision, not a performance comparison. |
| Timeout-based membership replacement | Does not establish an authoritative root, causal stability, key retirement or exclusive ownership. |

Unfinished production obligations belong to T1-06/T2-06: authenticated wire integration, durable HotStuff vote/lock state, real threshold signatures and DKG, signer-family attestations, checkpoint transfer, reconfiguration refinement, stable-frontier/anchor collection and recovery under actual crashes. The finite model does not select deployment operators or buy independent model endpoints. Those release resources may require user authorization later.

## Reproducible bounded evidence

```sh
node --experimental-strip-types roadmap/v4/research/replication-model.ts
node --test --experimental-strip-types test/research/replication-model.test.ts
npm run typecheck
```

The model campaign reports **5,040 permutations of seven tree operations**, checking all delivery prefixes for parent acyclicity, unique placement and retained occurrences; **128 two-replica partition splits**, including merge algebra and recovery; **16 pairs of three-of-four quorums**; and **27 allocations of three honest prepare voters** to two conflicting proposals or abstention while the fourth identity equivocates. Nine research tests additionally exercise concurrent movement, trash/restore/replace, RGA anchors, missing parents, equivocation dependency taint, all five-of-seven quorum intersections, three-phase progression, selective lock delivery, view recovery and membership handoff with only one old validator receiving the decision.

This is finite, manually bounded evidence. It does not exhaust all multi-view message schedules, Byzantine strategies, memberships, tree shapes or keys. Votes are symbolic authenticated tokens; no threshold cryptography is executed. Event delivery is explicit; no network latency, scheduler fairness or persistence timing is measured. The model therefore establishes neither full protocol correctness nor a 1,000-agent/50 ms claim. Actual scale qualification remains V4-Q01. The root task's evidence manifest must bind these commands to the exact committed artifact version before closing R01.
