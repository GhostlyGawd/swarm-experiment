# Aether

A unified, agent-native programming fabric and runtime substrate.

Aether replaces flat text files with a content-addressed AST graph, replaces
implementations-as-ground-truth with contract-first invariants and disposable
bodies, gives execution reversible checkpoints and structured feedback instead
of a byte stream, bounds all authority with object-capabilities, and decides
deployment topology from measured traffic rather than from an architecture
diagram.

**[docs/PRD.md](docs/PRD.md)** is the specification. This repository is its
reference implementation: every requirement it states is implemented, and every
bound in its non-functional section is measured rather than asserted.

```bash
npm install
npm test          # 160 tests
npm run typecheck # src, tests, bench and roadmap
npm run bench     # the §6 measurements
npm run demo      # an end-to-end walkthrough of all four tiers
```

Requires Node 22.6+ (for native TypeScript type-stripping). No runtime
dependencies.

---

## The idea in one example

This is the `TransferFunds` contract from the PRD, as the Auditor sees it —
projected out of the graph, not stored as text:

```ts
/**
 * Move funds between two accounts, atomically.
 * @provenance prov:b3:70841ec96c9ae2bcf8ed01475bff395099276514faa73a6cbaf088b7c1b60267
 * @origin agent_session sess-4417
 * @capability cap:db:ledger_append
 * @requires [sufficient_funds] sender.balance >= amount
 * @requires [positive_amount] amount > (0n as Cents)
 * @requires [distinct_accounts] sender.id !== receiver.id
 * @ensures [debit_exact] sender.balance === old(sender.balance) - amount
 * @ensures [credit_exact] receiver.balance === old(receiver.balance) + amount
 * @ensures [conservation] sender.balance + receiver.balance === old(sender.balance) + old(receiver.balance)
 * @modifies sender.balance, receiver.balance
 */
function transfer(sender: Account, receiver: Account, amount: Cents): void {
  sender.balance = sender.balance - amount;
  receiver.balance = receiver.balance + amount;
  invoke("cap:db:ledger_append", sender.id, receiver.id, amount);
  return undefined;
}
```

Four things are true of that text that are not true of an ordinary source file.

1. **It is a view.** Editing it edits the graph: `parse(project(x))` returns the
   *identical content address*, so a human's edit lands as a node mutation.
2. **The contract is executable.** Those `@requires` and `@ensures` clauses are
   discharged by an SMT solver at compile time, and re-checked by the runtime.
3. **`invoke` is the only door out.** There is no ambient filesystem, network or
   clock. A function that has not been handed `cap:db:ledger_append` cannot name
   it in a way that compiles.
4. **Renaming `amount` rewrites one node.** Names live in a symbol table; every
   expression hash — and every cached proof downstream of it — is untouched.

And here is what the agent sees for the same declaration:

```
v0 F3 v1 >= Q00 v1 j00 > Q10 v0 F2 v2 F2 != Q20 v0 F3 v0 F3 @ v1 - == Q30 …
```

77 tokens instead of 315. Names appear once per session, in a dictionary, so
every *use* is one token — which is what makes descriptive naming free.

---

## The four tiers

### Tier 1 — Storage and representation

Code is an immutable DAG of AST nodes addressed by BLAKE3 of their normalized
structure. Two identities per node: a **content address**, which never mentions
an identifier spelling, and a **structural key** over the alpha-normalized
subtree, which is what makes two functions differing only in local names
recognisably the same shape.

The consequences are mostly things that stop being possible:

- Renaming cannot invalidate a downstream hash — names are only in the symbol
  table.
- Editing one statement in a 200-statement block writes a single-digit number
  of nodes; every sibling keeps its address.
- Merging is a fold over the DAG. "Did this side change?" is a pointer
  comparison, so an untouched subtree of any size compares in constant time,
  a reformat-only change is invisible, and a conflict is reported as a node and
  a path rather than as `<<<<<<< HEAD`.
- Every node carries provenance back to the prompt, issue or spec clause that
  justified it. Changing a spec clause flags every subtree derived from it.
- A subtree guarded by an architectural invariant can only be modified by
  presenting a `DischargeProof` from the verifier. Prose is not accepted,
  because an agent can always produce prose.

### Tier 2 — Semantics, security, contracts

**Object-capabilities.** Zero ambient authority. `Invoke` type-checks only
inside a function that declares the capability, and `Call` type-checks only if
the callee's capabilities are a subset of the caller's — so authority flows
downward and cannot be reached through an innocent-looking wrapper. Third-party
subtrees are adopted with `cap:pure:compute` and nothing else.

**Contracts.** Pre-, post- and frame conditions in QF_LIA, emitted as SMT-LIB 2
so any query can go to Z3 unchanged. The bundled solver is a lazy DPLL(T):
canonical linear atoms with integer tightening, Tseitin CNF, DPLL with unit
propagation, and Fourier–Motzkin with model back-substitution. Its three answers
mean exactly one thing each:

| Answer | Meaning |
|---|---|
| `unsat` | A proof. Rational infeasibility implies integer infeasibility |
| `sat` | A counterexample, **validated by evaluation** before it is returned |
| `unknown` | Out of budget or outside the fragment, with a reason |

A model that does not reproduce is worse than no model, so one is never
returned.

**Executable product specifications.** A product manager writes a rule once; it
compiles into contract clauses, a client guard, a gateway check and a SQL
constraint — the same predicate in three idioms, with no opportunity to drift.

### Tier 3 — Execution and simulation

**The runtime journals every state change with its inverse.** That one decision
buys three things at once: rewinding N steps costs what the *changes* cost
rather than what the program cost; a micro-fork is a heap copy with a fresh
journal, so fifty candidate repairs can run against the exact state where a bug
occurred; and failures are values carrying the failing clause, the bindings and
the step index, rather than messages to parse.

**Production is a different artifact.** The journaling runtime is for agents to
debug in; `ProductionRuntime.compile` emits a stripped one — no journal, no
interpreter loop, names resolved to frame slots — that runs **12.7× faster**
with an identical heap. It also drops every contract clause the solver already
proved, on the reasoning that a discharged clause cannot fail, while keeping the
ones that rest on property evidence. Preconditions are kept by default, because
they are the API boundary and are discharged at call sites rather than in the
body. Every decision is recorded with its reason, so "what does production not
check?" has an answer you can read.

**Micro-worlds replace mocks.** A mock encodes what the author expected a
collaborator to do; a micro-world encodes what must remain true whatever it
does, then attacks it. The properties are read off the code — contract, frame,
determinism, absence of internal faults, effect outages, adversarial schedules.
Generation is boundary-biased (uniform sampling never produces `0`, `1` or an
overflow edge) and deliberately produces *aliased* arguments, which is the case
the verifier assumes away. Counterexamples shrink: `amount = -1` names a bug,
`amount = -8443113199` merely reports one.

### Tier 4 — Topology and optimization

**The slicer** reads the call graph out of the module, seeds one unit per
function, and merges by measured interconnect. Two functions exchanging
8,000 ms/s of transport are recombined into one shared-memory domain with no
refactor — because there was never any transport in the source to remove.
Placement follows from capabilities, not annotations: a database capability
cannot run at the edge. Every plan is priced, so monolith-versus-services is
answered by a number.

**Surfaces** are holes a background agent may fill — a cache policy, a buffer
size. The author states the domain and the objective and declines to state the
answer, because the answer depends on traffic nobody had yet. The tuner descends
a *measured* objective by finite differences, under a hard evaluation cap, and
may rewrite `Surface` nodes and nothing else — which is verifiable by comparing
addresses rather than trusted by convention.

---

## Synthesis

Putting it together: a contract with no body goes in, and a verified
implementation comes out.

```
propose → type & capability check → SMT verification → micro-worlds
```

Each failure returns *structured* feedback — a counterexample is a binding the
next attempt is checked against, a capability error names the exact missing
grant. After five failed attempts the loop raises `SynthesisStall` and escalates
with the full trace, because an agent that cannot satisfy an invariant in five
tries will not satisfy it in five hundred.

```
$ npm run demo
max: synthesized in 1 attempt(s), 27ms
  verification: proved (3 obligations)
  micro-world: 60/60 cases

pure function max(a: bigint, b: bigint): bigint {
  return a < b ? b : a;
}
```

---

## What the measurements say

From `npm run bench`:

| Requirement | Bound | Measured |
|---|---|---|
| AST node resolution | < 5 ms @ 10M nodes | p99.9 **0.017 ms** @ 762k nodes † |
| Reversible checkpoint rollback | < 15 ms | **0.31 ms** worst |
| Micro-world harness | ≤ 250 ms per module | **70 ms** worst declaration |
| SMT budget per function | ≤ 2,000 ms | **9 ms** worst |
| Deduplication over history | ≥ 40% vs Git | **94.6%** over 200 versions |
| Concurrent writers | 1,000, no lock | 1,000/1,000 survive, 0 conflicts |
| Agent-IR token reduction | ≥ 4× | **4.25×** per unit change ‡ |
| Reproducible execution | identical heap + trace | identical across 3 runs |
| Production artifact overhead | strips telemetry | **12.7×** faster, identical heap |

† Measured at 762k nodes, not 10M: the store is a hash index so lookup is O(1),
but materialising 10M needs multi-GB heap. The honest thing is to name the
number actually taken.

‡ Marginal, within a session. A cold encoding that ships the whole dictionary
is 1.60×. The marginal figure is the one a context budget feels, because agents
load a module once and rewrite subtrees of it many times.

---

## What building it changed

The specification is not what it was when the build started. The substantive
revisions are recorded as **Findings** in the PRD; the short version:

- **Agent-IR's 4× is a marginal property.** A cold, self-contained stream
  reaches 1.60×. The metric is now stated as tokens per unit change.
- **Hashing children as a flat list collides.** A `While` with one invariant and
  no variant, and one with no invariant and a variant, flatten identically.
  Children are hashed grouped by field.
- **A proof is only as good as its modelling assumptions.** The verifier gives
  each `root.field` its own variable, which assumes two record parameters do not
  alias. Assumptions are now reported on the result, and an unreported one is
  not strong enough to open an architectural fence.
- **Verifier and runtime must be made to agree about arithmetic.** Division
  axioms that did not pin the remainder's sign let the solver invent
  counterexamples the runtime could not reproduce.
- **A concurrency hazard belongs to the topology, not the body.** Whether two
  invocations can interleave is a placement question, so `concurrent_schedule`
  is advisory. Run against the PRD's own example, it found a real lost-update
  race in `transfer`.
- **Round-tripping found a bug no example-based test would have.** `-5n` and
  `-(5n)` projected identically and parsed back to different nodes.

---

## Command line

```
aether demo                 End-to-end walkthrough across all four tiers
aether project [file.ts]    Project the graph into readable TypeScript
aether ir [--body]          Show the Agent-IR encoding and its token cost
aether check [file.ts]      Type-check, capability-check and verify
aether run                  Execute the worked example and show the trace
aether compile [--policy p] Compile the stripped production artifact
aether simulate             Run the micro-world suites
aether topology [--shape s] Compile deployment topologies from telemetry
aether tune                 Run the tuning agent over the surfaces
aether synth                Synthesize a body from a contract alone
aether spec <file.spec>     Compile an executable product specification
aether provenance           Show the causal lineage of the example
aether merge                Demonstrate a three-way structural merge
```

With no file argument, commands operate on the built-in worked example. With
one, they parse a projected TypeScript file back into the graph first — which
is the round-trip property in everyday use.

## Layout

```
docs/PRD.md          The specification
docs/ROADMAP.md      Gap-closing roadmap, generated from and checked against roadmap/
src/tier1/           Content addressing, merge, Agent-IR, provenance
src/tier2/           Capabilities, type checking, SMT, verification, spec DSL
src/tier3/           Runtime, production compiler, micro-worlds, generators
src/tier4/           Topology slicer, optimization surfaces
src/projection/      TypeScript projection and its parser
src/synthesis/       The synthesis loop and a reference synthesizer
src/examples/        The worked ledger example used throughout
bench/nfr.bench.ts   The §6 measurements
roadmap/             The roadmap as data, plus its graph analysis and renderer
test/                160 tests, organized by tier
```

## Licence

Apache-2.0.
