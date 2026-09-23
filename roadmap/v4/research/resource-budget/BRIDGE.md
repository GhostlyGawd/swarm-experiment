# Bounded real-broker budget bridge

`src/tier2/resource-budget-bridge.ts` implements the existing `EffectBudget`
interface using `ResourceBudgetLedger`. No shared broker, compiler or barrel API
changes are included. The supported release path is a transactional sink with
durable terminal abort/reconciliation evidence. **T2-05 remains in progress.**

## Grant and retry contract

The versioned `aether.resource-budget-bridge/1` profile binds a bridge identity,
budget-service actor, canonical broker authority, and up to 256 grants. Each
grant contains a distinct pre-split available ledger handle, allowed execution
manifest and policy epoch. One grant funds one logical effect; its entire amount
is the hard reservation ceiling. Refunded unused amounts become new ledger
handles for explicit host-controlled grant issuance. The original grant never
silently refills or authorizes a second effect.

The host must attach a bridge to **one canonical live broker journal**, provide
the actual broker mode, and authenticate all `authorize` decisions. Reusing a
bridge's hooks behind independent broker journals is outside this profile. The
broker remains responsible for exact dispatch identity, serialized execution,
selected-branch authority and supported sink idempotency/reconciliation. The
bridge is a native trusted component, not an externally callable authorization
service. Its read-only `records()` view is audit data, not dispatch authority.

The host's effect policy must require a non-null, approved `budgetReservationId`
for every spending operation. The current broker deliberately skips budget hooks
when that field is null; a bridge cannot enforce a hook that is never called.
Static economic typing and complete boundary policy wiring must close this scope
before claiming universal resource enforcement.

All ledger operation IDs domain-hash the bridge namespace, full effect request
digest and phase. The request digest includes execution/effect identity, branch,
execution manifest, policy, capability grant, deadline, payload and budget grant.
Changed bytes conflict. A grant claimed by another logical effect produces
`false` from `reserve`; the actual broker persists `budget_exhausted`. A terminal
grant also refuses renewed dispatch authority. Missing/incorrect manifest or
policy context cannot acquire a reservation.

## Durable handoff and settlement

For reservation, the bridge first persists the exact ledger command. It then
calls `reserve` with `start: true`, atomically entering **inflight** before the
broker may dispatch. Finally it retains the ledger receipt. A process death at
any of these boundaries is recovered using the exact original command. No
uncertain reservation is inferred to be uncommitted from time or lack of an ACK.

For settlement, a trusted **read-only** observer queries actual sink/meter state:

- Committed: exact returned value, measured charge and independent evidence.
- Definitively not committed: evidence of a terminal abort/tombstone that rules
  out later commit of that logical effect.
- Unknown: funds remain encumbered.

The bridge binds these observations to the full request in an
`aether.resource-budget-settlement/1` witness. `decodeBudgetSettlementWitness`
validates the versioned wrapper. The ledger's `verifySettlement` implementation
must additionally bind the request, result, disposition and charge to its own
settlement context and independently verify the inner evidence. Accepting a
caller-authored witness or claimed receipt digest alone is unsound.

The exact settlement command is durable before the ledger applies it. A crash
after the sink commits but before ledger settlement retains the full inflight
reservation. A crash after ledger settlement returns the prior receipt on retry,
preserving the permanent charge. A stored settlement intent cannot be changed
into a different result or resolution. Invalid/inconsistent evidence stays
blocked; this profile does not implement a privileged correction protocol for
bad pending meter observations.

The bridge journal is authenticated with Ed25519 and bound to its canonical
directory and ledger identity. Atomic journal replacement flushes contents and
the directory. Initialization publishes the seal atomically, avoiding an empty
marker window. Existing signed history must be retained; this local authority
does not detect privileged rollback of all metadata to a prior valid backup.
The ledger remains the balance authority. Current mode/authorization is checked
before mutation, between durable intent and ledger application, and before
returning success. The ledger independently verifies current owner authority and
settlement evidence at its own commit boundary.

## Why generic release still fails closed

The existing `EffectBudget.release(request)` hook carries no versioned broker
noncommit certificate. A transactional adapter can supply a durable terminal
tombstone through `abort`/`reconcile`; the bridge verifies it and refunds. Merely
finding no nontransactional sink record does not establish terminal noncommit.
The tested generic predispatch rejection therefore leaves funds inflight and
reconciliation indeterminate, even though the fixture's sink was not called.
There is no guessed refund or automatic retry of a potentially irreversible call.

The next shared integration step is an optional **versioned release-context
hook**, minted inside the broker's locked state machine. It must bind the exact
request and authoritative durable event/terminal decision and establish that no
dispatch can later commit. It needs current cleanup authority and a checkable
certificate or trusted host capability; an unverified `neverDispatched: true`
Boolean is insufficient. This proposal is documented only—no shared hook or
broker transition has been added in this slice.

## Actual broker tests and remaining work

`test/tier2/resource-budget-bridge.test.ts` exercises the actual
`DurableEffectBroker`, ledger and durable local transactional sink. The fixture
checks that ledger funds are inflight before committing its sink row. Tests cover:

- Live commit, exact retry and restart without a second sink commit or charge.
- Unused refund handles and refusal to reuse terminal grants.
- Actual `budget_exhausted` selection of an explicitly declared **host** fallback.
- Revocation after transactional prepare, terminal abort and verified refund.
- Nontransactional release with missing evidence staying encumbered.
- Sink-committed uncertainty and exact reconciliation.
- Actual replay, shadow and speculative brokers avoiding live budget hooks;
  direct isolated bridge mutation is rejected.
- Changed request/result and forged journal refusal.
- Noncanonical base64 spelling of an otherwise valid journal signature refusal.
- Six actual SIGKILL windows: reservation and consumption, each after durable
  intent, after ledger application, and after receipt retention. Broker dead-owner
  recovery is explicit. Reservation crashes recover aborted; consumption crashes
  recover committed; all retained sink and charge counts remain exact.

Run:

```sh
node --experimental-strip-types --test test/tier2/resource-budget-bridge.test.ts
npm run typecheck
```

The focused result after independent review is **9/9 tests passing**, including the six-window
process-crash matrix. Tests use a durable local sink with a fixed fixture tariff,
not paid APIs or a production billing provider.

Remaining T2-05 work includes static linear resource types, compiler-checked
exhaustion branches, trusted production token/time/memory/cost meters, complete
effect policy coverage, general release evidence, controlled grant renewal, and
production end-to-end authority/replay integration. The host fallback test is
runtime outcome evidence; it is not a claim that static economic typing passes.
