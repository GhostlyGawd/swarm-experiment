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

## Durable broker noncommit and its limit

The broker now publishes a terminal `rejected` or `aborted` event before it asks
the budget service to refund. Its locked journal records the exact effect request,
the prior dispatch marker and a final `dispatchStarted: false` decision. That
terminal event cannot later become a dispatch. If refund fails or the process
dies, an exact retry or authorized reconciliation repeats the idempotent release
against the saved noncommit event.

The bounded nontransactional fixture has no `prepare` callback. Its trusted
observer reads the broker's canonical durable journal and returns a versioned
`aether.budget-broker-noncommit/1` digest only when the exact request has a
terminal, no-dispatch outcome and no sink row. The ledger's independent
`verifySettlement` callback reads that broker journal again and binds the event,
request, zero charge and inner evidence before refunding. Missing sink data
**without** the broker decision remains unknown and keeps funds inflight.
Transactional adapters still require their terminal sink tombstone, and an
uncertain dispatch is never refunded from a broker event alone.

This is one trusted local broker/ledger composition. A production budget service
must independently authenticate its broker journal or receive a separately
checkable terminal certificate, enforce cleanup authority and bind every
spending capability to a required reservation. The local event is not a proof
against privileged replacement of all broker metadata.

## Actual broker tests and remaining work

`test/tier2/resource-budget-bridge.test.ts` exercises the actual
`DurableEffectBroker`, ledger and durable local transactional sink. The fixture
checks that ledger funds are inflight before committing its sink row. Tests cover:

- Live commit, exact retry and restart without a second sink commit or charge.
- Unused refund handles and refusal to reuse terminal grants.
- Actual `budget_exhausted` selection of an explicitly declared **host** fallback.
- Revocation after transactional prepare, terminal abort and verified refund.
- Nontransactional predispatch refusal refunded only after a durable terminal
  broker decision; missing terminal evidence stays encumbered.
- Real process death after refund intent, ledger application and receipt
  retention, each after the broker's terminal decision, followed by exact
  idempotent recovery.
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

The expanded focused bridge suite has **11 cases**, including the six-window
process-crash matrix and three terminal-refund crash windows. Tests use a durable
local sink with a fixed fixture tariff, not paid APIs or a production billing
provider.

Remaining T2-05 work includes static linear resource types, compiler-checked
exhaustion branches, trusted production token/time/memory/cost meters, complete
effect policy coverage, externally checkable production release evidence,
controlled grant renewal, and production end-to-end authority/replay integration.
The host fallback test is runtime outcome evidence; it is not a claim that static
economic typing passes.
