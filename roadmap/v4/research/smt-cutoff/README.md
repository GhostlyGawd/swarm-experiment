# V4 SMT hard-cutoff research profile

`proveWithHardCutoff` is an opt-in v4 path around the repository's existing QF_LIA solver. It validates and bounds an input formula, runs `prove` in a separate Node process, uses a `SIGKILL` timeout, and returns a measured `unknown/timeout` when the process cannot provide a checked answer within the requested deadline. It rechecks any returned counterexample in the parent. `verifyFunction(decl, { solverProfile: 'v4-hard/1' })` uses this path and caps its function-level budget at 1,500 ms; callers measuring the solver must disable proof-cache hits. The legacy `prove`/`verifyFunction` default remains 2,000 ms for v1 compatibility.

The 1,500 ms boundary includes input validation, serialization, child launch, solver work, process termination and parent result checking. The returned `elapsedMs` is measured from the parent's monotonic clock and can exceed 1,500 ms if the OS delays scheduling or termination; such a sample is a **miss**, not a fabricated pass. Node's `spawnSync` waits for the child to exit after its timeout signal, so the implementation uses `SIGKILL` and must be judged by raw wall-clock samples. [Node child-process documentation](https://nodejs.org/api/child_process.html) defines that behavior.

This initial profile covers the bundled solver only. It does not bound an external solver fallback, unbounded caller work before invocation, arbitrary malformed-input validation, or a production proof-checking pipeline. Formulas are limited to 20,000 nodes, depth 64, 1 MiB serialized input and 128-digit integer literals. Hard cases return `unknown`; no timeout is treated as a proof or counterexample.

Focused tests exercise a tautology, a validated counterexample, a real unsatisfiable pigeonhole query interrupted at a short deadline, and malformed/cyclic/accessor-backed inputs. `campaign.ts` preregisters an exact nine-into-eight pigeonhole workload, source hashes and target environment before one warmup and five measured 1,500 ms trials. Its verifier recomputes raw trial/summary arithmetic without rerunning timing:

```sh
node --experimental-strip-types roadmap/v4/research/smt-cutoff/campaign.ts --register roadmap/v4/research/smt-cutoff/results/NEW-CAMPAIGN
node --experimental-strip-types roadmap/v4/research/smt-cutoff/campaign.ts --run roadmap/v4/research/smt-cutoff/results/NEW-CAMPAIGN
node --experimental-strip-types roadmap/v4/research/smt-cutoff/campaign.ts --verify roadmap/v4/research/smt-cutoff/results/NEW-CAMPAIGN
```

A clean exact-source campaign on the target hardware is still required before V4-NFR-08 can be marked measured or passed in the release profile.
