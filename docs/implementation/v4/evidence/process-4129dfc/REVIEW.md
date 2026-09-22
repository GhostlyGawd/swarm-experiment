# Durable process and admission verification

Subject: `4129dfc` (full commit and tree identities in `manifest.json`), specification `0.1.0`. The detached checkout was clean throughout verification.

## Verification results

- `npm test`: **357 passed**, zero failures, skipped or cancelled tests. Its pretest build passed.
- Typechecking and both roadmap checks passed.
- `npm pack` built the package; a separate extracted installation with production dependencies launched an actual child worker and returned 42 from a path containing spaces. Public ProcessHost/ProcessDeployment exports and the packaged worker entry were present. The package, inventory, smoke script and logs are retained.
- Benchmark measurement exited 0. Release enforcement exited **1**, retaining 17 unsatisfied required targets. Warm-message density remains 698/375 = 1.861× against the 4× target. This is a baseline correctness checkpoint, not a v4 performance release.

## F07 gate analysis

**G1 — real processes and state preservation.** The ledger tests use real Node child processes and preserve balances, aliases, cycles, allocation identity and current heap state through nested A→B→A calls, movement and restart. Actual parent termination covers requested, prepared, before-commit, committed and finalized migration boundaries. Same-ID retry respects the recorded abort/commit decision without adding state heads or restarting a committed worker set. Separate tests terminate a worker during a synchronous loop and terminate the parent while workers are active.

**G2 — ownership and admission.** One durable canonical generation controls writes under a process-shared ticket lock. Concurrent host instances and separate parent processes serialize state transitions. HMAC frames bind session, roles, ordered sequence, manifest and epoch; incorrect authentication, scope, framing and stale references are rejected. Direct and nested calls check capability grants, revocation and expiry. Typed boundaries reject wrong arity/types, out-of-range integers, incompatible records and unsupported opaque values. Independent review found stale recovery authorization across awaits; the implementation rechecks it before state publication.

**G3 — identity and effect disposition.** Logical references bind heap, object and owner epoch. Stable, domain-separated execution/boundary IDs prevent a caller's operation ID from colliding with a nested path. A real sink commit followed by parent termination becomes indeterminate; original receipt reconciliation and isolated replay restore state without another append. Unresolved operations block migration. Snapshot heads bind retained states to allocation/call/migration receipts, rejecting substitution of an earlier valid snapshot. A timeout never fabricates an abort.

## F08 gate analysis

**G1 — composed root and current authorization.** Independently acceptable edits are rejected when their composed root violates the invariant. Proposal approval binds the exact parent, candidate manifest, evidence bundle, migration snapshot/artifact and effect factory/policy. Signature, membership, policy and expiry checks run again after preparation. Driver tests reject stale snapshots, changed schemas, cached-receipt access after revocation and malformed typed calls/allocations before they can leave blocking outer intents. Historical activation cannot change the current deployment when the same manifest recurs at a later generation.

**G2 — durable decision and restart.** Core and actual deployment-driver tests terminate the coordinator at all six durable promotion phases. Fresh instances reload artifacts and recover the committed target or abort the precommit preparation. A committed target with unfinished activation blocks serving the predecessor. Shared execution leases freeze state across preparation and drain prior writes; a changed source snapshot invalidates its old approval. Recovery authorization is frozen to the requested strategy and rechecked after worker/replay awaits before receipt publication. Journal file renames and newly created directory entries are synced; tests exercise process termination, not physical power removal.

**G3 — integrated ledger flow.** Eleven actual ProcessDeployment tests cover a two-process ledger, recorded effect, topology/body change, rejected composition, approved promotion, rollback and preserved balances/aliases. Invocation and allocation receipts survive code-version changes and retries. Loss of an outer receipt after an inner durable commit recovers the original invocation without another append. A pre-execution outer intent requires an authorized no-effect abort. The rollback is a new approved generation carrying current state.

## Scope and remaining work

The complete suite rechecks F01–F06 regressions, including record fields named `__proto__`/`constructor`, durable broker behavior, replication and exact-subject evidence admission. Original evidence remains intact.

This implementation uses one serialized, bounded full-snapshot state domain on a local host. It does not implement arbitrary suspended-frame transfer, cross-machine ownership, hostile-code containment, schema-changing state lenses, heterogeneous BFT or full evolutionary shadow execution. Local solver evidence is not a portable certificate. Those requirements retain their own open tasks. The four bounded research gates have separate evidence under `research-749ce8b`; their numerical misses remain open.

Reproduce with the commands in `manifest.json` at its exact subject commit. After packing and extracting the retained package into a directory named `package`, install its declared production dependencies and run the retained `package-smoke.mjs` from the directory above it. All command output and benchmark manifests are retained alongside this review.
