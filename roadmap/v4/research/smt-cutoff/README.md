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

## Clean-source campaign 01

[Registration](results/campaign-01/registration.json) and [raw results](results/campaign-01/results.json) bind committed source `9f6caec49a36eea7d4720d6b04f442cfbf821060`, six exact source/package pins, an empty Git status and the Apple M4 Pro / Darwin arm64 / Node 26.7.0 environment. The experiment used an isolated detached worktree while other development files were changing. All raw warmup and five measured trial files are retained and verified without rerunning timing.

| Measured hard-query trial | Complete wall time | Result |
| --- | ---: | --- |
| 0 | 1,483.808 ms | `unknown/timeout` |
| 1 | 1,484.199 ms | `unknown/timeout` |
| 2 | 1,483.035 ms | `unknown/timeout` |
| 3 | 1,483.971 ms | `unknown/timeout` |
| 4 | 1,483.133 ms | `unknown/timeout` |

The local fixed-query cutoff profile passed all five trials; maximum observed complete wall time was **1,484.199 ms** against the unchanged 1,500 ms limit. This is one hard unsatisfiable Boolean workload on one same-host target. The result has not been integrated into the release-profile measurement inventory, and it does not qualify arbitrary proof construction, external solvers, different hardware or every query shape. V4-NFR-08 therefore remains **unmeasured in release enforcement**.
