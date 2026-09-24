# Pure virtual ProcessArtifact/3 validation checkpoint

Date: 2026-09-24. Specification: v4 `0.1.0`. Exact tested source commit: `2c9aa41d420a30fb245de6d1b33a4cf13b514596` on `aether/v4-implementation`. Log hashes are in [hashes.sha256](hashes.sha256). This checkpoint does not qualify ProcessHost or V4-T1-05.

| Command | Result | Retained output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types test/tier4/process-virtual-artifact.test.ts test/tier4/process-deployment.test.ts` | **28 passed, 0 failed** | [focused.log](focused.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run roadmap:v4:check` | 62 tasks, 71 obligations valid | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

The separate Artifact/3 validator redecodes and rehashes source/candidate IR, the D16 descriptor, archived wrapper declaration, exact V2/V3 evidence and manifest closure. It requires the candidate signed intent to directly descend from the exact source intent. It remeasures the current Node binary, one selected bundle and the caller-declared source files, refusing altered bytes. Tests reject tampered IR, descriptor, wrapper, target profile, evidence, measured files, forged lineage object and effectful/dynamic modules. The live deployment test confirms Artifact/3 is rejected before worker or effect dispatch; historical Artifact/1-/2 deployment tests remain passing.

**Open:** The declared files are not proof of the complete transitive worker executable, and no ProcessHost worker launches the measured bundle yet. Deployment state, migration/effect plans, host config, worker init and checkpoint compiler lack versioned Artifact/3 transport. The broker remains refused. The serial full suite and release benchmarks were **not** rerun on this source. V4-T1-05/G1/G2 remain open at **20/62**, with 17 required release targets failed or unmeasured in the preceding release record.
