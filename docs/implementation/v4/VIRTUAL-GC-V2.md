# One-wrapper virtual forwarding promotion V2

This is a bounded local admission profile for a pure, closed, one-argument
tail forwarder. It does not change the legacy semantic-GC promotion guard.
That guard still rejects step-changing wrapper collapse. The V2 path uses the
checked virtual-forward descriptor and the V3 evidence policy instead.

## Required sequence

1. Admit a current signed source artifact with the V2 evidence policy and base
   resumable target profile. Its complete module and dependency closure must be
   present in the durable AST store.
2. Build the exact one-wrapper candidate with `buildVirtualForwardCandidate`.
   Admit a new signed descendant intent and its V3 evidence. The candidate
   target profile commits to the descriptor ID and both AST roots. Its manifest
   contains the exact archived wrapper and target dependency declarations.
3. Call `SemanticVirtualGcPromotionV2.propose`. It independently rebuilds the
   rewrite, rederives the V2 and V3 manifests, checks the current signed source
   and candidate, checks trusted exports and protected/fenced symbols, compiles
   the in-process resumable program, and writes an immutable proposal. A store
   lease retains both modules and the wrapper/target declarations.
4. Use `promotionPlans` verbatim in the governor-signed promotion proposal.
   Both tagged plans bind the V2 proposal ID, descriptor ID, AST roots, and
   source/candidate manifest digests. The effect plan explicitly says
   `no-effects`. Submit current V3 evidence and governor approval through
   `promote`. The strict-lineage `PromotionCoordinator` remains the sole durable
   decision authority.
5. The built-in local driver stages the exact candidate root. At the commit
   fence, the proposal, signed lineage, and retention snapshot are rechecked
   while the same retention ledger's lock is held. Activation commits the local
   AST head. `recover` loads the exact immutable proposal selected by the
   persisted plan; a different ID fails before activation.

The retention ledger is checked for the same repository, store, lineage,
registry, and export/protection policy. Constructor options and the trusted
export/protection policy are copied so later caller mutation cannot redirect
the store or remove an export fence. Recovery rechecks the current local head
and generation even when the store reports an already finalized promotion;
it refuses to confirm a candidate after another writer moved that head. The proposal's source and candidate
remain physically pinned after promotion. Later retention records do not
invalidate historical recovery, but they invalidate a new commit based on the
old snapshot.

The commit fence observes only pins written through this exact collector.
Active-task and replication authorities may use other collector directories;
this local test does not establish complete G2 retention-race coverage or
safe migration of old tasks. Those paths need one shared retention authority
and their own crash/concurrency evidence before broader promotion.
The coordinator and public AST store do not share one lock after activation.
A later independent writer can still change the local head; callers must not
equate the coordinator's serving manifest with an externally mutable store head
without a serving-time head check or exclusive write authority. The bounded
`execute()` entrypoint now checks the strict-lineage serving manifest and
candidate head/generation before and after a pure local resumable call. It
refuses to return the result if the head moved during execution. This is a
local pure-serving guard, not an atomic lock against every later writer.

## Boundary and remaining work

This version rejects all nondefault capability registrations, `Invoke`,
concurrency, imports, dynamic calls, effectful declarations, and exported,
protected, or signed-fenced wrappers. It uses only a local in-process
resumable compiler and DurableGraphStore head. There is no descriptor-bearing
artifact envelope for ProcessHost or the effect broker yet, so this profile
does not authorize either. It also does not establish general semantic GC,
multi-wrapper rewriting, process deployment, or the full V4-T1-05 gate.
The signed target artifact digest is not yet tied to emitted resumable bytes;
this local profile cannot be promoted to a fetched executable artifact by
relabeling that digest.

Focused verification:

```sh
npm run typecheck
node --experimental-strip-types --test test/tier1/semantic-gc-virtual-promotion.test.ts
npm run build
```

The focused test covers signed promotion, exact dependency/profile checks,
descriptor and plan substitution, source revocation, retention changes, caller
options mutation, a postcommit crash with exact-ID recovery, wrong-head retry
refusal, serving-time head refusal, and retained predecessor AST roots.
