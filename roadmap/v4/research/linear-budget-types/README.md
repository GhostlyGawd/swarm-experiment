# FR-2.5 static linear budget typing experiment

Status: **research only; not production authorized; V4-T2-05 remains open**.

The PRD asks for four first-class resource dimensions, hard limits in function signatures, and a compile-time declared exhaustion path. The versioned specification says the compiler must require the path and the broker chooses it when a reservation or charge is denied. The current `ResourceBudgetLedger` already provides durable signed split, reserve, consume and refund transitions, but the Aether type checker does not yet track those handles across AST control flow.

This experiment checks a deliberately closed slice of **actual Aether AST**. It first runs the normal Aether type checker, then checks four exact function identities in a companion budget contract:

```text
entry(Budget) -> Result<Unit, Owned<Budget>>
  = match reserve(Budget) {
      ok(Reserved)  => ok(consume(Reserved))
      err(Budget)   => err(fallback(Budget))
    }
reserve(Owned<Budget>) -> Result<Reserved, Budget>
consume(Owned<Reserved>) -> Unit
fallback(Owned<Budget>) -> Owned<Budget>  // pure, returns same handle
```

The checker requires exactly one use of each owned handle in its branch, four canonical unsigned 128-bit fixed-unit amounts, equal maximum/reservation/committed charge in every dimension, an explicit pure fallback, and no recursion, unrecognized call, fork, loop, closure, or unmodeled effect in this slice. Denial returns the same available budget handle; the successful fixed-charge path consumes the entire reservation. This is a useful **compiler shape experiment**, not a full economic type system. There is no hidden conversion rate between `usdMicros`, `tokens`, `nanoseconds`, and cumulative `memoryBytes`.

The test suite uses Aether builder nodes and runs the existing type checker. It rejects duplicate success-handle use, undeclared spending, a missing fallback, a spending fallback, recursion without an enforced bound, malformed dimensions, and an unmodeled fork. One integration test separately uses the real durable resource ledger: an exhausted reservation preserves the original handle, while an authorized fixed charge survives ledger reopen and invalidates the consumed handle. The test **does not execute the AST through a compiler-generated budget adapter**. It uses a local test meter witness, not independent production sink evidence.

Run:

```sh
node --test --experimental-strip-types roadmap/v4/research/linear-budget-types/checker.test.ts
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --types node --strict --allowImportingTsExtensions --skipLibCheck roadmap/v4/research/linear-budget-types/checker.ts roadmap/v4/research/linear-budget-types/checker.test.ts
```

## Production work remaining

1. Add versioned economic annotations to Aether function signatures and `Owned` handles to the AST, canonical store, Agent IR, projection and verifier. The companion object here is not signed or bound to an admitted AST root.
2. Extend the main type checker with flow-sensitive move/borrow rules across arbitrary branches, loops, closures, tasks, imports and recursive calls. Introduce statically checked decreasing loop/fuel budgets for bounded recursion rather than this experiment's blanket recursion rejection.
3. Support partial reserves, split/merge/transfer/refund and variable actual charges. Successful calls must return or account for every unspent handle; cancellation and an indeterminate external effect cannot turn into a refund.
4. Lower checked AST operations into the durable ledger and broker bridge. Bind the static signature and exact call site to the execution manifest, policy epoch, principal, effect identity, reservation and independently verified charge/noncommit evidence.
5. Prove runtime selection of the compiled exhaustion arm for broker denial, charge overrun and retries; test concurrent forks, crash windows, heap rollback, revocation and real effects through the production process host.

No release gate or tracker task is closed by this experiment.
