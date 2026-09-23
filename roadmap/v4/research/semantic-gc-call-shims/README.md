# Closed call-bearing scalar shim profile (V4-T1-05 candidate)

`aether.semantic-gc-closed-scalar-shims/2` extends the opt-in V1 call-free profile. It can propose retiring a same-signature, nonexported Int/Bool shim whose return expression calls closed pure scalar helpers. It retains the original call-site arguments and their evaluation order; only the callee identity changes. The proposal remains a candidate until exact signed lineage, proof evidence and the governor commit it.

Before comparing results, the V2 profile checks every helper reachable from the two expressions: no capabilities, surfaces, type parameters, nonempty contract frames, recursion, imports or opaque continuations. Each body is a single scalar return. Call arguments and helper bodies must be syntactically total under unbounded Int/Bool semantics; in particular division and modulo are excluded. This condition matters because expanding a helper can duplicate or discard its argument. Without it, a proof of the expanded value could erase an argument that faults in the executable program.

The bounded call graph is expanded into scalar expressions, then the independent portable AST certificate checker proves total return and equality for all typed scalar inputs. Selection identities bind the original declarations, source and target roots, proof profile and exact rewrite. Reopening and rollback use the same proof and causal-fence checks as the V1 profile. Historical V1 bytes and call-free behavior are unchanged.

Focused regressions in `test/tier1/semantic-gc.test.ts` execute an equivalent helper-bearing shim through proposal, signed promotion and rollback. They also reject a helper with a runtime contract, a partial arithmetic helper, and a helper that ignores an evaluated division-by-zero argument. The V1 test continues to reject call-bearing shims. Run:

```sh
node --test --experimental-strip-types test/tier1/semantic-gc.test.ts
npm run typecheck
```

This slice does not close V4-T1-05. General/non-scalar shims, effectful helpers, imports, dynamic calls, broader path reasoning, production adapter retirement and task/replay retention release policies remain open. The totality rule is intentionally conservative; it does not prove a general program transformation engine.
