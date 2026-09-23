# T2-05 durable resource budget foundation

`src/tier2/resource-budget.ts` implements an isolated runtime ledger. This is a
bounded foundation for FR-2.5 and SPEC C3. **T2-05 delivery remains open; the tracker keeps it planned until T2-04 closes:** static
linear economic types, declared exhaustion branches, real metering, and complete
broker/compiler/runtime integration are not implemented by this slice.

## Units, authority and conservation

`ResourceAmounts` contains exact integer decimal strings for four independent
units: USD millionths (`usdMicros`), tokens, nanoseconds and memory bytes. Spendable
amounts are nonnegative unsigned 128-bit values. There are no floating-point
amounts, exchange rates, implicit conversion or overdrafts. `memoryBytes` means
cumulative allocation consumption in this profile; reusable resident-memory
leases need a distinct future contract. The ledger does not itself observe
physical elapsed time, provider billing, tokenizer counts or actual memory use.

The immutable profile declares initial balances, owner, policy epoch and operation
bound. Opening a new ledger with initial funding is a trusted issuer operation,
not a client funding API. An Ed25519 issuer key signs handles and ordered journal
transitions. Handles bind ledger identity, owner, immutable amount vector, phase,
and optional exact effect binding. The ledger identity also binds its canonical
authority directory, so copying the directory cannot silently create a usable
second authority. Directory rehoming/key rotation/funding changes require a
separate explicit migration profile; none is provided here.

The authenticated host supplies `actor` and the synchronous `authorize` decision.
An untrusted request body cannot self-assert a principal. Possession of another
owner's signed handle alone is insufficient. Current authority is checked under
the journal mutex and again immediately before publication. Returning a Promise
or any value other than Boolean `true` is denial. Exact retries still require
current authority.

Every transition preserves, independently for all four dimensions:

```
funded = available + reserved + inflight + permanently spent
```

The cumulative `refunded` statistic records returned unused amounts. It is not
additional funding, is not added to the conservation equation, and may exceed the
initial balance through repeated reserve/refund cycles. It is retained as an
exact decimal history total. No public operation burns or creates an input handle
without accounting for all of its amounts.

## API and linear transitions

`new ResourceBudgetLedger({ directory, profile, key, authorize,
verifySettlement, fault? })` opens or recovers a ledger. `genesisHandle(actor)`
returns the original signed handle; once transformed, further copies are stale.
`snapshot(actor)` gives the authorized initial owner derived balances and live
handles. `apply(request)` accepts versioned operations with an exact `operationId`
and authenticated actor:

| Operation | Input | Atomic result |
| --- | --- | --- |
| `split` | One available handle, exact nonempty parts | Invalidates input; issues disjoint handles whose per-unit sum equals input |
| `merge` | Distinct available handles belonging to actor | Invalidates all inputs; issues their sum |
| `transfer` | Available handle and new owner | Invalidates old handle; issues same amounts for new owner |
| `reserve` | Available handle, upper-bound amount, exact effect binding, `start` flag | Issues change plus reserved/inflight handle, or durable exhaustion with no debit |
| `start` | Reserved handle | Invalidates held handle; issues inflight handle before dispatch |
| `consume` | Inflight handle, actual charge and trusted committed evidence | Permanently charges at most reservation; returns only unused remainder |
| `refund` | Reserved handle or inflight handle plus terminal noncommit evidence | Returns unused/uncommitted reservation; cannot refund spent charges |

Reservations bind execution ID, effect ID, execution manifest, payload digest and
policy epoch. Effect identity is domain-hashed structured data, avoiding path
concatenation collisions. Once an effect has received a reservation, its identity
cannot acquire another reservation even after cancellation/settlement. Correct
retries use the same immutable operation ID and exact original bytes. Reusing an
ID with changed payload, handles, actor, price or policy is a conflict.

Split handles can be distributed to concurrent branches. Copying a handle does
not copy its spendable balance: the same durable authority serializes all uses,
and only one distinct operation consumes it. Equivalent retries return the exact
original receipt without applying another transition. An exhausted request also
has a durable receipt; adjusting its amount requires a new intent ID. Invalid,
unauthorized or stale requests that never execute do not get success receipts.

## Dispatch, settlement and the broker integration contract

An irreversible effect **must never dispatch before `start` is durable**. The
`reserve` operation's `start: true` atomically encumbers the funds as inflight for
integrations that cannot expose a separate before-dispatch hook. There is no
timeout, cancellation guess or heap rollback operation that releases inflight
funds. A charge larger than the reservation leaves the reservation encumbered;
the trusted meter/adapter must enforce a correct upper bound before dispatch.

`verifySettlement` is a trusted synchronous verifier of actual broker/sink/meter
evidence. It receives the exact ledger, owner, binding, disposition, charge and
tagged evidence. Both current authorization and settlement evidence are checked
again after journal preparation and before commit. A caller's desired balance,
unverified receipt digest, timeout or assertion of noncommit is insufficient.
The journal retains the exact supplied evidence and issuer attestation; historical
charges are replayed from signed transitions without restoring revoked authority.
External evidence records must be retained by the provider if independent later
inspection requires them.

Existing `EffectBudget` exposes only `reserve`, `consume`, and `release`. This
slice does not change those shared interfaces. A future adapter must:

1. Persist the exact ledger operation requests and effect-to-handle association
   before dispatch. Derive retry IDs from ledger namespace plus the full exact
   logical effect identity and phase.
2. In `reserve`, atomically reserve with `start: true`, or coordinate a new durable
   before-dispatch hook. A `reserved` handle alone is insufficient to authorize
   irreversible dispatch because its owner can still cancel it.
3. In `consume`, verify the actual committed sink/meter observation and actual
   charge against the reservation, then persist settlement. A crash after sink
   commit but before ledger settlement leaves funds inflight; reconcile the same
   effect rather than dispatch again.
4. In `release`, prove unused-before-dispatch or definitive terminal noncommit.
   The existing hook does not pass that evidence, so its wrapper must query the
   authoritative broker/sink state or receive a coordinated interface extension.
   Unknown outcomes stay encumbered.
5. Reject live charges from shadow/speculative/replay branches. Route immutable
   receipts into replay without minting new balances. Selecting a branch transfers
   disjoint authority through the canonical ledger.
6. Wire exhaustion to the statically declared safe fallback. That fallback must
   neither recover revoked capability authority nor retry an indeterminate effect.

## Durability and threat boundary

An existing same-host `JournalLock` ticket mutex serializes processes. Dead writer
tickets are recovered by exact PID/sequence identity; no age-based takeover is
used. Each journal record binds sequence, previous record, exact request and
receipt under Ed25519. Reads independently derive all state and conservation from
signed history, rejecting tampered receipts, duplicate operation IDs or reordered
transitions. No mutable cached balance is authoritative.

Journal replacement uses flushed temporary bytes, atomic rename and directory
fsync. A retry after interruption between rename and directory sync flushes the
directory before acknowledging the retained receipt. Initialization uses an
immutable genesis, empty journal and completion seal; interruption can complete
initialization, while a missing established journal fails closed. Temporary files
left by killed writers do not authorize transactions.

This is a trusted local-filesystem authority, not Byzantine distributed storage.
Deleting/replacing all local metadata with an older valid same-directory signed
backup cannot be detected without an external monotonic anchor. Filesystem rollback
or possession of the issuer private key is outside the adversarial client model.
There is no authority-directory fork/restore API. Aether heap rollback leaves the
separate durable budget journal intact, as tested.

The bounded profile replays and rewrites the whole journal on each operation;
it caps the journal at 10,000 operations and 32 MiB, and uses the shared finite
ticket history. No production throughput claim or automatic compaction is made.
Explicit maintenance is required at capacity; it cannot discard retained charges
or reuse operation/handle identities.

## Focused verification

```sh
node --experimental-strip-types --test test/tier2/resource-budget.test.ts
npm run typecheck
```

Tests cover all units, exact large integers, stale/copied/forged/wrong-owner handles,
split conservation, duplicate merge inputs, retry conflicts, durable exhaustion,
overcharge refusal, current revocation/evidence rechecks, terminal noncommit
verification, committed charge preservation across actual Aether heap restoration,
initialization and mutation SIGKILL windows, sink-committed settlement interruption,
four-process contention and exact retries, disjoint branches, dispatch/cancel races,
signature tampering and rejected authority-directory copies. The sink witness in
tests is a durable local fixture; no paid provider API is used or claimed.
