# T3-07 bounded pure fallback tree

`src/tier3/fallback-tree.ts` implements the opt-in
`aether.pure-fallback-tree/1` profile. **T3-07 remains in progress.** No <=50 ns
native switch qualification, in-frame/native continuation, or complete production
fallback coverage is claimed.

## Supported cascade

The profile accepts a closed, well-typed Aether module with two distinct pure
function declarations. Their parameter symbols/types, return type and explicit
contract/frame must be identical. This initial restriction makes contract identity
checkable without binder-renaming or weaker-contract assumptions. Tier 2 cannot
silently replace the Tier 1 contract with a weaker one.

Here “pure” means capability-free: local record mutations are permitted by the
declared frame. Supported boundary/state types are scalar values and logical
record references, including aliased/cyclic record graphs representable by the
existing snapshot contract. Effects, imports, closures/tasks, generic types,
adaptive surfaces, sequences and Result values are rejected in this initial
profile. The module is detached from caller-owned AST objects before use. Signature checks
preserve nominal labels; the existing logical-heap boundary validator checks
representational field/value structure and does not add nominal allocation
provenance attestation.

For each exact-ID call:

1. Validate argument types and the current Tier 1 invocation grant, then durably
   record the input and complete pre-call heap.
2. Run actual Tier 1 code against that heap with contracts enforced. Successful
   execution may publish its result only after a fresh authorization check.
3. On a runtime fault, persist its repair event. Tier 2 gets a fresh runtime
   restored from the same pre-call snapshot, so failed writes, allocations and
   allocator advances cannot leak into fallback. Shared logical record identity
   is preserved.
4. Verify a separate current Tier 2 invocation grant. If permitted, run actual
   Tier 2 code with the same contract and a restored argument graph.
5. If Tier 2 fails, publish a deterministic Tier 3 `fallback_exhausted` abort with
   exactly the pre-call heap. Missing/revoked authority produces an
   `authority_denied` static abort and never restores capability authority.

`maxGuardChecks` bounds compiler entry/loop-backedge checks. It is not a machine
instruction, physical memory, arbitrary-precision arithmetic, or wall-clock quota.
Module AST size is bounded. A recoverable runtime exception is recorded as
`runtime_exception` and follows the same pure fallback path; process death is
handled by the durable recovery rule below. Out-of-memory process termination
cannot be caught as an ordinary runtime exception.

The implementation enforces types/contracts dynamically and validates exact
contract identity. It does **not** supply independent portable Tier 2 correctness
or termination proof; F06 evidence admission remains required for production.
The returned result has `productionAuthorized: false`.

An optional closed scalar Tier 2 proof profile now accepts an independently
checked portable AST certificate. The proof module must contain exactly the
executed Tier 2 declaration, with no dependencies; its manifest must match the
full fallback execution context except for the standalone proof root. The
proof digest is bound into the fallback profile, so reopening with a changed
certificate cannot silently inherit prior state. Focused tests run the actual
fallback and reject edited Tier 2 bodies, missing obligations and changed
execution context. This profile proves source-level Int/Bool total return and
formal contract obligations under checked entry preconditions. The record
fallback fixture, effectful ProcessHost supervisor and native switch do not
yet carry this proof, and compiler/OS resource behavior remains outside it.

## Invocation authority

The host supplies a `ScopedGrantAuthority`. Every tier requires
`cap:fallback:invoke`, bound to its function audience and exact profile/tier path.
The profile binds execution manifest, source functions, issuer repository, guard
bound, journal signer and canonical directory. `issueTokens()` is a trusted issuer
convenience, not an unauthenticated client mint endpoint.

Current grant validity is checked at entry, compiler guard boundaries, after
execution, before trying the next tier, and immediately before successful state
publication. A fault does not restore an expired or revoked grant. Cached success
receipts still require current authority for both the invocation and the tier
that supplied the result. Different inputs cannot reuse an exact operation ID.

`allocateRecord()` and `snapshot()` are administrative host APIs. Only the
grant-checked `call()` boundary is intended for untrusted program requests.

## State, crashes and replay

The complete journal is authenticated with Ed25519 and bound to the exact profile.
Atomic replacement flushes bytes and the directory. Initialization uses an atomic
completion marker. Missing established state, an altered signature or a
noncanonical spelling of otherwise valid signature bytes fails closed.
There is no mutable unauthenticated balance/state cache.

An interrupted pure invocation has no external commit to reconcile. On reopening
or the next authorized/admin operation, its durable intent restores the pre-call
heap and becomes a deterministic `interrupted_pure_call` static abort. The runtime
does not pretend to resume an arbitrary JavaScript frame or reconstruct a
successful execution from caller-provided snapshots. A result already durably
committed before an acknowledgment failure is returned on exact retry without
executing either tier again.

The authority assumes a trusted local filesystem and private signer key. Restoring
all metadata to an old valid signed same-directory backup requires an external
monotonic anchor to detect and is outside this profile. Journal operations are
bounded at 1,000 call/allocation entries and 32 MiB. Compaction/key rotation/directory
rehoming require an explicit future migration profile.

## Asynchronous repair outbox

Faults append versioned repair events with stable content identities, exact
operation/tier/fault, execution manifest and pre-call state digest. These events
are durable before trying the next tier. Recording or consuming an event grants
no authority to publish a repaired program.

`pendingRepairs()` exposes pending events. `drainRepairs(async consumer)` runs the
consumer asynchronously under a separate delivery mutex; it does not hold the
serving state mutex while awaiting the consumer. Calls therefore continue while
repair delivery is delayed. Acknowledgment is persisted after successful delivery.

Delivery is **at least once**. Consumers must deduplicate by `event.id`. A process
death after delivery but before acknowledgment redelivers the same ID. Failed
delivery retains the event. The consumer is a trusted host integration; this slice
does not contact repair agents, perform synthesis, or approve deployment changes.

## Focused verification

```sh
node --experimental-strip-types --test test/tier3/fallback-tree.test.ts
npm run typecheck
```

The tests exercise actual Tier 1/Tier 2 bodies, primary success, both-tier failure,
record alias and allocator preservation, current/missing grants, revocation after
fault and before commit, cached-result authority, malformed arguments, exact-ID
conflicts, contract/task rejection, journal tampering, loop guard exhaustion,
asynchronous delivery with concurrent serving, and real SIGKILL before/after call
publication and after repair delivery before acknowledgment.

The native fallback threshold remains **<=50 ns**. This durable whole-heap
implementation is not the PRD's active-frame native mechanism, and no performance
number from these functional tests is treated as release evidence. External-effect
reconciliation, portable Tier 2 proof admission, wider state/type coverage, native
lowering and full production integration remain outstanding.
