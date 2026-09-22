# Project Aether

**A Unified, Agent-Native Programming Fabric and Runtime Substrate**

| | |
|---|---|
| **Status** | Draft for review — reference implementation complete for Phases 1–3 |
| **Document owner** | Platform Architecture |
| **Primary consumer** | Autonomous synthesis agents |
| **Secondary consumers** | Human platform architects; product managers |
| **Evidence** | Every bound in §6 and every mitigation in §7 is measured by `npm run bench` and `npm test` against the reference implementation in this repository |

---

## 0. How this document was written

Ten proposed innovations were turned into a specification through four passes,
and the document's shape is a consequence of them.

1. **Architectural tiering.** The innovations are grouped into a four-tier
   vertical stack — substrate, semantics, execution, topology — so that the
   document reads as one computing platform rather than a feature list. Each
   tier consumes only the tier below it, and that constraint is load-bearing:
   it is why the topology engine can move code between processes without the
   semantics tier noticing, and why the verifier and the runtime can be made to
   agree about arithmetic rather than agreeing by coincidence.

2. **Dual-audience formalism.** Every interface is specified twice: once for
   the agent that will drive it (semantic bytecode, graph mutation APIs,
   execution hooks) and once for the human who will audit it (projected source,
   causal provenance, executable specifications). Where the two views can
   diverge, the document says what keeps them honest.

3. **Rigorous technical specification.** Concepts are pinned to schemas,
   grammars, operational contracts and state machines. A requirement that
   cannot be stated precisely enough to test is a requirement that will be
   satisfied on paper only.

4. **Failure-mode and trade-off engineering.** The hard problems — solver
   explosion, telemetry overhead, projection drift, agent loops — are isolated
   in §7 with concrete mitigations and stated bounds. §6 records what those
   bounds actually measured, including the two that needed a caveat.

Where building the reference implementation changed the specification, the
document says so in a **Finding** callout rather than quietly adopting the new
position. Those callouts are the most useful part of this document.

---

## 1. Executive summary and vision

Software engineering conventions — flat ASCII files, spatial directory trees,
manual version-control diffs, ambient operating-system access — were engineered
around human ocular and cognitive limits. They are extraordinarily good at that
job. They are a poor fit for a consumer that reads a million tokens a second,
holds no visual memory between sessions, and can fabricate a plausible
`rm -rf` as easily as a plausible function.

When autonomous agents operate in these environments, the failure modes are
structural rather than incidental:

- a large share of context is consumed by typographical ceremony rather than
  meaning;
- feedback loops run in minutes because the unit of execution is a process, not
  an expression;
- safety depends on post-hoc review of text, which is the weakest possible
  place to put a safety property.

Project Aether is a ground-up reconsideration of how code is represented,
compiled, executed and deployed. It replaces flat text with a content-addressed,
graph-native AST substrate; replaces implementations-as-ground-truth with
contract-first invariants and disposable bodies; integrates telemetric,
reversible execution at the runtime layer; bounds all authority with native
object-capabilities; and decouples business logic from deployment topology.

The intended outcome is that software can be synthesized, verified, deployed and
continuously tuned by autonomous agents in milliseconds, with complete causal
auditability and a lossless human-readable projection at every point.

### What the reference implementation establishes

This is not a paper design. The repository contains a working implementation of
all four tiers, and the claims below are measurements, not estimates.

| Claim | Result |
|---|---|
| Renaming a binding invalidates no downstream hash | Holds by construction; names exist only in the `SymbolTable` node |
| Editing one statement in a 200-statement block | Writes a single-digit number of nodes |
| Agent-IR reduces tokens per unit change | **4.25×** aggregate against the TypeScript projection of the same code |
| `parse(project(x)) ≡ x` | Identical content address, for the worked example and 300 generated expressions |
| Ungranted capability use | Rejected at compile time, and again at the point of use |
| The PRD's own `TransferFunds` contract | Discharged formally by the built-in SMT solver in single-digit milliseconds |
| Reversible checkpoint rollback | 0.31 ms worst case over 250 transfers (bound: 15 ms) |
| Micro-world harness | 70 ms worst declaration (bound: 250 ms) |
| Deduplication over 200 versions | **94.6%** against storing each version independently |
| 1,000 concurrent writers on disjoint subtrees | All edits survive, zero conflicts, no lock |
| A body synthesized from a contract alone | Found and formally proved in one attempt |

---

## 2. Problem statement and core drivers

| Human-centric paradigm | The agentic bottleneck | Aether paradigm shift |
|---|---|---|
| Flat text files (`.py`, `.ts`) | Parsing overhead, indentation and syntax errors, context bloat, brittle line diffs | **Content-addressed AST graph.** Deterministic node mutation, no syntax errors by construction, structural merges |
| Imperative code as ground truth | Refactoring risks breaking implicit, undocumented edge cases (Chesterton's Fence) | **Contract-first, ephemeral code.** Invariants are permanent; implementations are synthesized and disposable |
| Ambient OS access | A hallucinated destructive command reaches a real filesystem | **Object-capability tokens.** Explicit, fine-grained authority per declaration, checked at compile time |
| Asynchronous CI/CD | Multi-minute runs make iterative debugging impossible | **Telemetric time-travel runtime.** In-memory micro-forks, reversible checkpoints, sub-millisecond traces |
| Rigid deployment topologies | Agents spend tokens on service plumbing rather than logic | **Fluid topology engine.** Monolith versus distributed decided at compile time from measured traffic |

The through-line: in each row, a property that is *conventionally maintained by
discipline* becomes a property that is *structurally impossible to violate*.
That substitution is the whole thesis. Discipline does not survive contact with
an agent that will happily write anything that type-checks.

---

## 3. User personas and interactions

### 3.1 Primary — Autonomous Synthesis Agent ("the Operator")

- **Role.** Synthesizes subtrees, optimizes performance, resolves behavioural
  failures.
- **Interface.** Agent-IR, direct graph mutation APIs, structured memory hooks.
  Never a flat file, never a terminal, never a byte stream to parse.
- **Design consequence.** Every failure the platform can produce must be a
  *value* carrying the failing clause, the bindings and the step index — not a
  message. §4.3 specifies the fault taxonomy this implies.

### 3.2 Secondary — Human Platform Architect ("the Auditor")

- **Role.** Defines architectural invariants, audits causal lineage, reviews
  system structure.
- **Interface.** The Projection Engine: dynamically decompiled, human-readable
  code in a syntax of choice, with inline causal annotations.
- **Design consequence.** The projection must be *lossless in both directions*,
  or the Auditor is reviewing a summary of the code rather than the code. §7
  treats projection drift as a first-class risk with a formal obligation.

### 3.3 Tertiary — Product Manager ("the Specifier")

- **Role.** Establishes product requirements, business rules, access policy.
- **Interface.** The Executable Specification Suite: structured domain
  requirements compiled directly into runtime invariants.
- **Design consequence.** A rule must compile once and enforce everywhere it
  applies, because three hand-maintained copies of a rule are three rules.

---

## 4. System architecture and functional requirements

```
┌────────────────────────────────────────────────────────────────────────┐
│  Tier 4: Dynamic Topology & Optimization Engine                        │
│  - Fluid Architectural Topology       - Differentiable Search Surfaces │
├────────────────────────────────────────────────────────────────────────┤
│  Tier 3: Execution, Introspection & Verification Engine                │
│  - Telemetric Time-Travel Runtime     - Living Micro-World Simulators  │
├────────────────────────────────────────────────────────────────────────┤
│  Tier 2: Semantics, Security & Contract Specification                  │
│  - Executable Product Specs           - Contract-First Invariants      │
│  - Native Object-Capability (OCap) Security Envelope                   │
├────────────────────────────────────────────────────────────────────────┤
│  Tier 1: Storage & Representation Substrate                            │
│  - Content-Addressed AST DAG          - Agent Intermediate Rep (IR)    │
│  - Causal Lineage & Intent Provenance                                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Tier 1 — Storage and representation substrate

#### FR-1.1 Content-addressed, graph-native AST

Code is not stored as text. It is an immutable directed acyclic graph of AST
nodes indexed by the BLAKE3 hash of each node's normalized semantic structure.

**Node schema.** Every function, expression, type declaration and module is an
independently addressed node. Children are addresses, not inlined structures.

```json
{
  "node_id": "ast:b3:8f4c2e1b…",
  "kind": "FunctionDecl",
  "symbol": "sym:dmseeqo6cejqvuxomete4b",
  "params":  [{ "symbol": "sym:bcz4hmc4vvsirbf2wqgtn7",
                "ty": { "t": "Nominal", "name": "type:currency:cents",
                        "repr": { "t": "Int" } } }],
  "returns": { "t": "Unit" },
  "capabilities": ["cap:db:ledger_append"],
  "purity": "effectful",
  "contract":   "ast:b3:1a9e8f…",
  "body":       "ast:b3:9021da…",
  "surfaces":   [],
  "provenance": "prov:b3:4301be…"
}
```

**Two identities, and the distinction is the design.**

| | Derivation | Property it buys |
|---|---|---|
| `NodeRef` — `ast:b3:…` | BLAKE3 over the node's scalar payload plus its children's *addresses* | The node's identity. Never mentions an identifier spelling |
| `StructuralKey` — `struct:b3:…` | BLAKE3 over the alpha-normalized hydrated subtree, locally bound symbols replaced by binding-relative indices | Deduplication and alpha-equivalence: two functions differing only in local names share a key |

**Requirements.**

- **R1.1.1** Identifier spellings live in exactly one place — a `SymbolTable`
  node. A `Var` commits to an opaque `SymbolId`, never a name. Renaming a
  binding therefore rewrites one node and invalidates no expression hash, no
  cached verification result and no compiled artifact.
- **R1.1.2** Structural mutation is a hash-tree update. `replaceAt(root, path,
  node)` rewrites only the spine — `path.length` new nodes — regardless of tree
  size. Every sibling subtree keeps its address.
- **R1.1.3** Concurrent edits merge by three-way graph unification. A conflict
  is reported as a node and a path with all three candidate addresses, never as
  a marker spliced into a file. Because nodes are content-addressed, "did this
  side change?" is a pointer comparison, so an untouched subtree of any size
  compares in constant time and a reformat-only change is invisible.
- **R1.1.4** The canonical encoding used for hashing must be tagged and
  length-prefixed. JSON is not admissible: key order is arbitrary and `"1"`,
  `1` and `[1]` are indistinguishable once concatenated.
- **R1.1.5** Children must be hashed *grouped by field*. A flat child list is
  ambiguous — a `While` with one invariant and no variant, and a `While` with no
  invariant and a variant, flatten to the same three children.

> **Finding — grouped hashing is not optional.** R1.1.5 was added during
> implementation after a collision was found between two semantically distinct
> `While` shapes. A content-addressed store with a hash collision is not a store
> with a bug; it is a store that silently returns the wrong program.

#### FR-1.2 High-density Agent-IR

A lossless linearization of an AST subtree, designed for a consumer with a
finite context window.

**Design.** Three properties do the work:

1. **Post-order, arity-driven.** Operand counts are known, so the stream needs
   no brackets, terminators or indentation.
2. **Names appear once per session.** Identifiers live in a dictionary; each
   *use* is a fixed-width index. Token cost stops scaling with how descriptively
   code is named, which is what makes verbose naming free.
3. **One opcode, one token.** Opcodes and operands are packed into a single
   alphanumeric run using fixed-width base-36 fields, declared once per message.

**Grammar.**

```
stream   := header "\n" token*
header   := "AE1" "\n" "§w " width ( "\n" section )*
section  := "§" tag " " item ( "|" item )*
token    := fixed | opcode field* trailing?
field    := <width> base-36 digits
```

An optional index field uses `0` for "absent" and `i + 1` otherwise. Sections
are ordered, because type-pool entries refer to name-pool indices.

**Requirements.**

- **R1.2.1** ≥ 4× token reduction per unit change against the equivalent
  TypeScript projection.
- **R1.2.2** Lossless: `decode(encode(t)) ≡ t` for every node kind the substrate
  can represent.
- **R1.2.3** A session dictionary, so a peer that already holds a module's
  identifiers pays only for the body of each subsequent edit.
- **R1.2.4** An on-demand Projection Decompiler reconstituting human-readable,
  formatted source in real time.

> **Finding — the 4× target is a *marginal* property, not a cold one.**
> Measured against the TypeScript projection of the same code: **4.25×**
> aggregate per unit change (per declaration 3.64×–5.47×), but only **1.60×**
> for a cold, self-contained encoding that ships the whole dictionary. The
> difference is the opaque symbol identifiers, which are long and which a cold
> stream must carry. This is the right number to quote *because it is the one a
> context budget feels*: agents load a module once and then rewrite subtrees of
> it many times. The specification is amended to state the metric as tokens per
> unit change, with the cold figure recorded rather than hidden.
>
> A second, smaller finding: the first encoding used comma-separated fields
> (`C3,2`) and reached only 2.2×. Separators cost a token each, and a stream is
> mostly opcodes. Packing fields into one alphanumeric run was worth ~1.9×.

#### FR-1.3 Causal lineage and intent provenance

Every node carries a pointer to the reason it exists.

**Provenance record.** Content-addressed and immutable, so the audit trail can
be appended to but not rewritten.

```json
{
  "id": "prov:b3:70841e…",
  "intent": "Move funds between two accounts, atomically.",
  "origin": { "kind": "agent_session", "ref": "sess-4417", "actor": "synthesis-agent" },
  "parents": ["prov:b3:79437a…"],
  "specClauses": ["inv:b3:c0c0…"],
  "reasoning": ["Guarded the debit with an explicit balance precondition…"],
  "guard": { "invariant": "inv:b3:c0c0…", "priority": "architectural",
             "rationale": "Double-entry conservation. Removing the balance checks
                           silently converts an overdraft bug into an audited
                           accounting discrepancy." },
  "timestamp": 1700000000001
}
```

**Requirements.**

- **R1.3.1** Nodes are tagged with a `provenance_id` linking them to the
  initiating agent session, human prompt, issue, or specification clause.
- **R1.3.2** Modifying an upstream specification marks every dependent subtree
  `InvalidatedSpec` and queues the affected *declarations* for agent
  reconciliation. Propagation runs upward through the graph as well as
  downward: if a leaf expression is invalidated, the function containing it may
  no longer satisfy its contract.
- **R1.3.3 — Chesterton's Fence.** An agent may not delete or rewrite a subtree
  guarded by a high-priority architectural invariant merely because it cannot
  see why the guard is there. It must present a `DischargeProof` — evidence from
  the verifier that the requirement still holds after the change. A prose
  justification is not accepted, because an agent can always produce prose. An
  `architectural` guard additionally requires `verdict: "proved"`; property
  testing is not sufficient to open it.

---

### Tier 2 — Semantics, security and contract specification

#### FR-2.1 Executable product specifications

A structured DSL in which the Specifier writes a business rule once, and it
compiles into contract clauses, per-layer enforcement, and provenance.

```
spec ledger {
  rule "A transfer may not overdraw the sender" on transfer {
    given sender.balance >= amount;
    given amount > 0n;
    then  sender.balance >= 0n;
    changes sender.balance, receiver.balance;
    enforce client, gateway, persistence;
    because "An overdraft becomes an audited accounting discrepancy, not an error.";
    guard architectural;
  }
}
```

**Requirements.**

- **R2.1.1** Business statements compile to mathematical relations, verifiable
  by Tier 2 rather than merely documented.
- **R2.1.2** One rule propagates simultaneously to client state machines, API
  gateways and persistence constraints — the *same* predicate, rendered in each
  layer's idiom. The client refuses to dispatch, the gateway rejects with a
  stable code, the store refuses to persist.
- **R2.1.3** Rule expressions use the same grammar as the projection. There is
  one expression language in the platform, not a product dialect and an
  engineering dialect that drift.

#### FR-2.2 Contract-first invariants and ephemeral implementations

The specification of *what* code does is decoupled from the imperative body that
executes it. Bodies are disposable artifacts synthesized on demand.

```
contract TransferFunds(sender: Account, receiver: Account, amount: Cents) {
    requires sender.balance >= amount;
    requires amount > 0;
    requires sender.id != receiver.id;
    ensures  sender.balance   == old(sender.balance) - amount;
    ensures  receiver.balance == old(receiver.balance) + amount;
    ensures  sender.balance + receiver.balance
             == old(sender.balance) + old(receiver.balance);
    modifies [sender.balance, receiver.balance];
}
```

**Requirements.**

- **R2.2.1** Pre-conditions, post-conditions and frame conditions are stated in
  first-order logic, emitted as SMT-LIB 2 so any query can be handed to Z3 or
  CVC5 unchanged.
- **R2.2.2** Verification conditions come from symbolic execution with the
  standard loop rule — havoc what the body writes, assume the invariant, prove
  it again — so cost does not depend on trip count. Callee contracts are used
  modularly at call sites; a callee's body is never re-examined.
- **R2.2.3** Writes outside `modifies` are reported as frame violations.
- **R2.2.4** If an implementation fails a contract check in development or
  production, the runtime purges the body node — leaving the contract standing
  and the function marked for re-synthesis — and triggers the agent. The
  contract is the asset; the body was only ever a way of meeting it.
- **R2.2.5 — Solver answer contract.** The three answers mean precisely:
  `unsat` is a proof (rational infeasibility implies integer infeasibility);
  `sat` is a counterexample *validated by evaluation* before it is returned;
  anything else is honestly `unknown`, with a reason (`timeout`, `too_large`,
  `nonlinear`, `no_integer_model`). A model that does not reproduce is worse
  than no model, because it sends an agent chasing a failure that does not exist.

> **Finding — a proof is only as good as its modelling assumptions, so state
> them.** The verifier gives every `root.field` its own logical variable, which
> assumes two record parameters are not the same object. For `transfer(a, a, n)`
> that assumption is false and the debit/credit postconditions genuinely do not
> hold. The specification now requires that such assumptions be *reported on the
> verification result*, and that an unreported assumption downgrade the evidence
> from `proved` to `property_checked` — which is not strong enough to open an
> architectural fence. The worked example carries an explicit
> `sender.id != receiver.id` precondition as a result, and the micro-world
> generates the aliased case deliberately.

> **Finding — the verifier and the runtime must agree about arithmetic, and
> agreement has to be engineered.** Two bugs found by building both:
> a call site substituted only the *root* of a record argument, so callee
> obligations spoke about variables the caller had never heard of and were
> trivially refutable; and the division axioms (`a = q·b + r`, `|r| < |b|`) did
> not pin the remainder's sign, so `1 / 100 = 1` satisfied them and the solver
> invented counterexamples the runtime could not reproduce. Both are fixed.
> The general lesson: any abstraction the verifier makes is a place where the
> two tiers can silently disagree, and the micro-worlds are what catch it.

#### FR-2.3 Native object-capability security

Functions have zero ambient authority. There is no global filesystem, no process
environment, no clock reachable from an expression.

**Capability primitives.**

| Primitive | Meaning |
|---|---|
| `cap:<domain>:<operation>` | A named authority, e.g. `cap:db:ledger_append` |
| `CapabilityEnvelope` | The set in scope at a point in the call graph. **Only ever narrows** — there is no operation that adds authority |
| `attenuate(caps)` | Narrow an envelope; capabilities not already held are silently dropped |
| `CapabilityEnvelope.sandboxed()` | `{cap:pure:compute}` and nothing else — the envelope adopted third-party subtrees receive |
| `RevocationList` | Operator-held; consulted at the point of use, so revocation needs no rebuild |

**Requirements.**

- **R2.3.1** Security envelopes are validated at compile time by the AST type
  checker. An `Invoke` type-checks only inside a function that declares the
  capability.
- **R2.3.2** Authority flows downward only. A `Call` type-checks only if the
  callee's capabilities are a subset of the caller's, so an agent cannot reach
  privileged code through an innocent-looking wrapper.
- **R2.3.3** A function declared `pure` may hold no capabilities at all.
- **R2.3.4 — Sandboxed dependency adoption.** Third-party subtrees can be
  integrated with `cap:pure:compute` only, making supply-chain effects
  structurally impossible rather than merely audited.
- **R2.3.5** Nominal types do not coerce. `Cents` is not an alias for `Int`;
  scaling by a scalar is allowed, multiplying two dimensioned values is not.

The consequence worth stating plainly: a hallucinated destructive command is not
*caught*, it fails to compile, because the agent has no name it could write that
would reach a resource it was not handed.

---

### Tier 3 — Execution, introspection and verification

#### FR-3.1 Telemetric-native runtime with reversible checkpoints

**State machine.** The engine is built around one decision: *every state change
is journaled with its inverse*. That single property yields time travel,
micro-forking and structured feedback together.

```
                    ┌──────────┐
   call ───────────►│  frame   │  push env + capability envelope + pre-heap
                    └────┬─────┘
                         │ requires clauses evaluated
              fail ◄─────┤
                         ▼
                    ┌──────────┐   every mutation appends a Δ with its inverse
                    │ executing│──────────────► journal
                    └────┬─────┘
                         │ ensures clauses evaluated against pre-heap
              fail ◄─────┤
                         ▼
                    ┌──────────┐
                    │ returned │
                    └──────────┘

   checkpoint()  = journal length + step index
   restore(cp)   = apply inverses back to cp.mark        — O(changes since cp)
   rewind(n)     = apply inverses back past n steps      — O(changes in n steps)
   fork()        = copy heap, empty journal, shared code — explores forwards
```

**Fault taxonomy.** Failures are values, not exceptions to be pattern-matched
out of a log. Each carries the failing clause label, the bindings in scope and
the step index.

| Kind | Meaning |
|---|---|
| `precondition` / `postcondition` | A contract clause did not hold |
| `assertion` | An in-body assertion failed |
| `capability_denied` / `capability_revoked` | Authority absent, or withdrawn by an operator |
| `division_by_zero`, `type_error`, `unbound` | Internal faults — never an acceptable outcome |
| `step_budget` | A bounded execution ran out, rather than hanging |
| `effect_failed` | An effect handler refused; injected by micro-worlds to model an outage |

**Requirements.**

- **R3.1.1** Agents interact through memory hooks and structured `inspect()`
  state, never STDOUT/STDERR.
- **R3.1.2** On invariant or assertion failure, the runtime pauses, produces an
  execution delta, and permits rewinding N steps prior to the failure point.
- **R3.1.3** Instantaneous micro-forking, so an agent can run ~50 candidate
  repairs against the exact heap state where a bug occurred.
- **R3.1.4** Capabilities are enforced *again* at the point of use, and
  revocation is consulted there, so an operator can disable a capability
  globally without rebuilding or redeploying.

#### FR-3.2 Embedded living micro-world simulators

Every module carries a deterministic, property-based simulator instead of a set
of mocks. A mock encodes what the author expected a collaborator to do; a
micro-world encodes what must remain true whatever it does, and then attacks it.

**Properties are read off the code, not written by hand.**

| Property | Claim | Blocking? |
|---|---|---|
| `contract` | Preconditions filter inputs; postconditions must hold | Yes |
| `frame` | Nothing outside `modifies` changes | Yes |
| `determinism` | Same inputs ⇒ same outputs and same effects | Yes |
| `no_internal_fault` | No type error or division by zero, whatever the input | Yes |
| `effect_outage` | Every capability failed in turn; failure must surface cleanly | Yes |
| `concurrent_schedule` | Two invocations reading the same initial state must not lose an update | **Advisory** |

**Requirements.**

- **R3.2.1** Generative property fuzzers replace static mocks, running against
  candidate subtrees inside a sub-100 ms budget.
- **R3.2.2** Generation is boundary-biased, not uniform. Uniformly sampling a
  64-bit integer essentially never produces 0, 1, −1 or an overflow boundary,
  which is where the bugs are.
- **R3.2.3** Aliasing is generated deliberately — two parameters of the same
  record type sometimes receive the same reference.
- **R3.2.4** Cases are plain data, not live heap values, so they replay, shrink
  and race identically in a fresh runtime.
- **R3.2.5** Counterexamples are shrunk. `amount = -1` names a bug;
  `amount = -8443113199` merely reports one.
- **R3.2.6** A candidate patch is rejected below 100% compliance on blocking
  properties.
- **R3.2.7** Generation *yield* is reported. A suite that filters 95% of its
  inputs is mostly testing its own generator, and should say so.

> **Finding — a concurrency hazard belongs to the topology, not the body.**
> `concurrent_schedule` is advisory rather than blocking, and the reason is
> architectural. Whether two invocations can interleave at all is a property of
> the deployment topology: the Tier-4 slicer may place them in a single-writer
> domain, in which case the race cannot occur, or it may not, in which case it
> can. The micro-world reports the hazard; the tier that actually knows decides.
>
> Run against the PRD's own example, the micro-world found exactly this: a
> lost-update race in `transfer`. It also found a runaway loop in `accrue` for
> large period counts — a liveness hazard the solver cannot see, because the
> loop is perfectly correct and simply does not finish. That one was fixed with
> a `periods <= 1200` precondition, and a test keeps the detection honest by
> removing it again.

---

### Tier 4 — Dynamic topology and optimization

#### FR-4.1 Fluid architectural topology

Agents author one semantic graph of capability-gated functions. Where those
functions run is a compilation decision taken from measured traffic.

**The slicer.**

1. **Seed.** One unit per function. Placement constraints derive from
   capabilities, not annotations: something holding `cap:db:*` cannot be an edge
   worker; something holding only `cap:pure:compute` can go anywhere.
2. **Agglomerate.** Repeatedly merge the pair of units with the heaviest
   interconnect, while merging is legal and pays for itself.
3. **Cost.** Price the result. A cross-unit call pays serialization and a
   network hop; an in-process call pays neither.

**Operational contract.**

- **R4.1.1** The call graph is read out of the module, never out of
  configuration.
- **R4.1.2** Two services exchanging heavy interconnect traffic are recombined
  into one zero-copy, in-process shared-memory domain **without any refactor** —
  because there was never any transport in the source to remove.
- **R4.1.3** Every plan is priced, so "monolith or microservices?" is answered
  by a number rather than by taste.
- **R4.1.4** A merge blocked by a footprint limit or an isolation constraint is
  *reported* with the traffic it costs, not silently applied.
- **R4.1.5** Generated transport forwards the caller's capability envelope.
  Crossing a process boundary must not widen authority.

> **Clarification adopted during implementation.** "Placement" and "shares
> memory" are different questions and were initially conflated. Every unit is a
> single in-process shared-memory domain by construction; `placement`
> (`linked` / `container` / `edge`) says only where that domain runs.

#### FR-4.2 Differentiable code optimization surfaces

A `Surface` node is a hole a background agent may fill: a cache policy, a buffer
size, a pool width, an index strategy. The author states the *shape* of the
decision and declines to state the answer, because the answer depends on
production traffic nobody had when the code was written.

```json
{ "kind": "Surface",
  "symbol": "sym:kgzttpudbhgcvydmcwoxnv",
  "domain": { "d": "range", "min": 1, "max": 64, "step": 1 },
  "current": 8,
  "objective": "minimize_latency" }
```

**Requirements.**

- **R4.2.1** Background tuning agents ingest production telemetry and descend a
  *measured* objective. "Differentiable" needs an honest gloss: the objective is
  a measurement, not an analytic function, so the tuner estimates a gradient by
  finite differences on range surfaces and does coordinate descent on discrete
  ones. That is gradient machinery applied to a black box.
- **R4.2.2** Evaluations are hard-capped, because each one costs real traffic.
- **R4.2.3** A tuner may rewrite `Surface` nodes and nothing else. Because a
  surface is its own content-addressed node, "only parameters changed" is
  *verifiable by comparing addresses*, not trusted by convention.
- **R4.2.4** A tuned module is re-verified and re-simulated before adoption. A
  configuration that is faster and wrong is not an improvement.

---

## 5. Developer experience and human-in-the-loop projection

```
       ┌────────────────────────┐
       │   Human Developer      │
       │   IDE / Code Review    │
       └───────────▲────────────┘
                   │ Reads TypeScript / Rust; writes intent and invariants
       ┌───────────▼────────────┐
       │   Projection Engine    │
       └───────────▲────────────┘
                   │ Compiles to / decompiles from
       ┌───────────▼────────────┐
       │   Content-Addressed    │
       │   AST Graph Substrate  │
       └────────────────────────┘
```

- **Lossless bidirectional projections.** Humans edit through a virtual
  filesystem or a projectional editor. Editing the projected text *is* editing
  the graph: the text parses directly into node mutations. Binding resolution is
  what makes the round trip exact rather than merely equivalent — an identifier
  naming an existing binding resolves to that binding's `SymbolId`, not to a
  fresh one with the same spelling. Only genuinely new names mint new symbols,
  which is precisely the case where a human has added something.
- **Everything beyond ordinary source is carried in structured doc comments** —
  contracts, capabilities, tunable surfaces, provenance — so the projection
  stays readable by people and by ordinary language tooling while losing nothing
  on the way back.
- **Explainability.** Hovering over any block shows its causal lineage: the
  prompt, issue or invariant that authorized it, plus a summary of the agent's
  reasoning.
- **Emergency capability revocation.** A master administrative capability allows
  instantaneous global revocation — for example invalidating `cap:network` for a
  module — without rebuilding or redeploying, because revocation is a predicate
  the runtime evaluates rather than a property baked into an artifact.

> **Scope decision.** TypeScript is bidirectional; Rust projection is
> **read-only**. One verified parser is enough to establish the round-trip
> property, and a second doubles the surface on which drift can occur without
> adding new information. This is a deliberate narrowing of the original scope,
> recorded rather than quietly dropped.

---

## 6. Non-functional requirements

Measurements from `npm run bench` on the reference implementation.

### 6.1 Performance and latency

| Requirement | Bound | Measured | Status |
|---|---|---|---|
| AST node resolution | < 5 ms @ 10M nodes | p99.9 **0.017 ms** @ 762k nodes | Met, qualified |
| Micro-world harness, local module | ≤ 250 ms | **70 ms** worst declaration | Met |
| Reversible checkpoint rollback | < 15 ms | **0.31 ms** worst over 250 transfers | Met |

*Qualification.* Node resolution was measured at 762k nodes, not 10M. The store
is an in-memory hash index, so lookup is O(1) and 10M would measure the same,
but materialising it needs multi-GB heap. The honest position is to name the
number actually taken.

### 6.2 Determinism and verification

| Requirement | Bound | Measured | Status |
|---|---|---|---|
| Reproducible execution | Identical heap and trace | Identical across 3 runs | Met |
| SMT solver budget | ≤ 2,000 ms per function | **9 ms** worst | Met |

Functions exceeding the budget fall back to property-based fuzzing with an
attached `UnprovenFormalContract` warning. The warning is explicit rather than
implied by absence: a clause the solver could not settle is *reported*, never
silently downgraded.

### 6.3 Storage and scalability

| Requirement | Bound | Measured | Status |
|---|---|---|---|
| Deduplication over version history | ≥ 40% vs Git | **94.6%** over 200 versions | Met |
| Structural sharing within one snapshot | (no stated bound) | 36.3% | Reported |
| Concurrent writers, disjoint subtrees | 1,000, no lock contention | 1,000/1,000 survive, 0 conflicts | Met |

*On the two deduplication figures.* The NFR asks for a saving "over standard Git
history", so the measurement that matters is a repository *with a past*: Git
stores a fresh compressed blob per version of each changed file, while a
content-addressed graph stores only the nodes an edit created. Measured across
200 versions that is 94.6%. The within-snapshot figure is reported separately
and is deliberately not dressed up as the NFR: a four-function module has little
repeated structure, and sharing pays off across history and across a repository.

### 6.4 Agent efficiency

| Requirement | Bound | Measured | Status |
|---|---|---|---|
| Agent-IR token reduction | ≥ 4× vs TypeScript | **4.25×** per unit change | Met |
| — cold, dictionary included | (not specified) | 1.60× | Reported |

---

## 7. Technical risks and mitigation

| # | Risk | Impact | Likelihood | Mitigation | Status |
|---|---|---|---|---|---|
| R1 | SMT state-space explosion | High | High | **Tiered rigor.** Core state and financial transitions require strict formal proof; complex workflow logic relies on micro-world fuzzing. A `property` clause never reaches the solver; a `formal` clause the solver cannot settle is reported as `UnprovenFormalContract` and delegated | Implemented and measured |
| R2 | Telemetry overhead bloat | High | Medium | **Dual-runtime model.** The development runtime journals every delta for time travel; the production runtime emits stripped native artifacts with no trace overhead | Journaling is opt-in per runtime; production stripping is Phase 3 |
| R3 | Projection drift | Medium | Medium | **Formally verify the projection.** `Decompile(Compile(x)) ≡ x` must be structurally invariant | Implemented; holds by content address for the worked example and 300 generated expressions |
| R4 | Agent hallucination loops | High | Medium | **Hard budget gates.** After 5 failed synthesis iterations the system raises `SynthesisStall` and escalates with the full failure trace | Implemented and tested |

### Notes on each mitigation, as built

**R1 — tiered rigor is a real division of labour, not a fallback.** Nonlinear
subterms are abstracted congruently, which keeps `unsat` sound while making
`sat` only a candidate. The consequence is visible in synthesis: a body that
multiplies by a conditional leaves the linear fragment and can only be
property-checked. The loop therefore *holds such a candidate as a fallback and
keeps searching for a provable one*, returning the unproven body only if nothing
better turns up inside budget — because a search that stops at the first passing
candidate will never find the better one.

**R3 — the round-trip property found a real defect.** Negative literals and
negation-applied-to-a-literal projected identically, so they round-tripped to
the wrong node. The projection now distinguishes them (`-5n` versus `-(5n)`).
This is exactly the class of bug the obligation exists to catch, and it was
invisible to every example-based test.

**R4 — the gate is deliberately hard.** An agent that cannot satisfy an
invariant in five attempts will not satisfy it in five hundred, and the failure
trace is worth more to a human than another thousand candidates. The escalation
names each attempt, the stage it failed at, and the counterexample — and ends
with the two possibilities a human should weigh: the contract is unsatisfiable
as written, or it is missing a precondition that puts the counterexamples out of
scope.

### Risks this document did not originally carry

| # | Risk | Mitigation adopted |
|---|---|---|
| R5 | **Verifier/runtime semantic drift.** Any abstraction the verifier makes is a place the two tiers can silently disagree | The micro-worlds execute the real runtime against the real contract, so a disagreement surfaces as a property failure. Two instances were found and fixed this way |
| R6 | **Unstated modelling assumptions laundering into proofs.** A proof that quietly assumes non-aliasing is not a proof of the code that ships | Assumptions are attached to the verification result, and an unreported assumption downgrades the evidence below what an architectural fence will accept |
| R7 | **Metrics measured against the wrong baseline.** Deduplication against a snapshot rather than a history; token counts against a cold stream rather than a session | Both figures are reported, with the one the requirement actually asks for named as the headline |

---

## 8. Phased implementation roadmap

```
2027                     2027–2028                 2028+
Phase 1: Substrate       Phase 2: Verification     Phase 3: Autonomous
& OCap Foundations       & Telemetric Runtime      Topology & Tuning
┌──────────────────┐     ┌──────────────────┐      ┌──────────────────┐
│ - Graph AST Store│ ──► │ - Time-Travel Run│ ───► │ - Fluid Topology │
│ - OCap Model     │     │ - SMT Solver Loop│      │ - Differentiable │
│ - Basic Agent-IR │     │ - Micro-Worlds   │      │   Tuning Surfaces│
└──────────────────┘     └──────────────────┘      └──────────────────┘
```

**Phase 1 — Substrate and security foundations (months 1–6).**
Content-addressed AST graph store; OCap type system and capability-checking
compiler; bidirectional TypeScript projection.
*Reference implementation: complete.*

**Phase 2 — Verification and telemetric runtime (months 7–12).**
Reversible checkpointing engine with micro-forks; SMT invariant solver in the
compilation cycle; Agent-IR specification and memory-hook protocol.
*Reference implementation: complete.*

**Phase 3 — Dynamic topology and autonomous optimization (months 13–18).**
Fluid topology engine; differentiable optimization surfaces and continuous
tuning agents; enterprise provenance and audit tooling.
*Reference implementation: topology slicer and tuner complete; production
runtime stripping and enterprise audit tooling outstanding.*

---

## 9. Key performance indicators

| KPI | Target | Instrumentation |
|---|---|---|
| **Agent synthesis velocity** | 80% reduction in MTTR and MTTI versus agents on text/Git workflows | Synthesis loop records attempts, stage, and elapsed time per attempt |
| **Context efficiency** | 75% reduction in tokens per successful unit change | Agent-IR reports `bodyTokens` per edit; currently **4.25×**, i.e. a 76% reduction |
| **Safety and containment** | Zero unauthorized resource-access incidents | Capability checks at compile time and point of use; revocation list keeps an audit trail |
| **First-pass verification rate** | > 95% of synthesized bodies pass all production invariants on initial deployment | Synthesis outcome records `provenFormally` and the micro-world compliance ratio |

---

## 10. Appendix — reference implementation map

| Specification | Module |
|---|---|
| FR-1.1 content addressing | `src/tier1/{blake3,canonical,store,merge}.ts` |
| FR-1.1 symbol table | `src/tier1/symbols.ts` |
| FR-1.2 Agent-IR | `src/tier1/agent-ir.ts` |
| FR-1.3 provenance, Chesterton's Fence | `src/tier1/provenance.ts` |
| FR-2.1 executable specifications | `src/tier2/spec.ts` |
| FR-2.2 contracts, solver, verification | `src/tier2/{smt,solver,verify}.ts` |
| FR-2.3 object capabilities | `src/tier2/{ocap,typecheck}.ts` |
| FR-3.1 telemetric runtime | `src/tier3/{runtime,values}.ts` |
| FR-3.2 micro-worlds | `src/tier3/{microworld,generate}.ts` |
| FR-4.1 topology | `src/tier4/topology.ts` |
| FR-4.2 surfaces and tuning | `src/tier4/surfaces.ts` |
| §5 projection | `src/projection/{typescript,parse,lexer,names}.ts` |
| Synthesis loop and stall gate | `src/synthesis/{loop,enumerative}.ts` |
| §6 measurements | `bench/nfr.bench.ts` |

### Open questions for review

1. **Production runtime stripping (R2).** The dual-runtime model is specified
   but only the journaling runtime is built. What is the acceptable ceiling on
   production overhead before journaling must be compiled out entirely?
2. **Structural keys at repository scale.** Alpha-normalization is O(subtree),
   so a repository-wide alpha-equivalence index is O(n · depth). Is that a
   background job, or does the index need an incremental formulation?
3. **Aliasing in the general case.** The current model reports the assumption.
   Should the type system carry separation information instead, so non-aliasing
   becomes checkable rather than assumed?
4. **Advisory concurrency findings.** `concurrent_schedule` is advisory because
   the topology decides. Should the Tier-4 slicer consume these findings as a
   *constraint* — refusing a placement that makes a reported race reachable?
