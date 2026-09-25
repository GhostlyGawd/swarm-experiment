# Exact-source Artifact/4 witnessed source checkpoint

Source commit: `e88e366583c0cd37f89de8f29b617dfb2346f9fb`.
The worktree contained only these evidence directories during the exact-source
rerun; no source file changed after that commit.

| Command | Result | Raw output SHA-256 |
| --- | --- | --- |
| `npm run build` | pass; measured worker bundle 769,991 bytes, 70 resolved inputs, 25 native libraries | `fa0e477e9e95b7b2601c3773167f258a4f3704c322b9552ca4e99d11d3fd42a1` |
| `node --experimental-strip-types --test --test-concurrency=1 test/tier4/process-virtual-artifact-v4.test.ts test/tier4/process-virtual-deployment-journal.test.ts` | **24/24 pass, 0 skips** | `315d2410305d2c4db0d3575b4fff687bea92e7b311009faefd37d97c38d5d147` |
| Focused legacy ProcessDeployment refusals | **3/3 pass** | `0231f76398bfe9b704aa4d3d626cd01284815b08ec1399ed18f134d93ae757dd` |
| `npm run typecheck` | pass | `21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a` |
| `npm run roadmap:v4:check` | pass; 62 tasks, 71 obligations | `94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161` |

Legacy refusal command:

```sh
node --experimental-strip-types --test --test-name-pattern='live ProcessDeployment refuses Artifact/3|legacy ProcessDeployment factory cannot inject Artifact/4|legacy ProcessDeployment refuses a virtual-forward target under Artifact/1' test/tier4/process-deployment.test.ts
```

Config/18 launches the exact signed source through measured worker init/4
with no cross-unit/effect callbacks and its own operator-selected complete
host witness. The campaign checks real-worker source execution and snapshot
reopen; local mirror rollback, witness outage and same-revision equivocation;
and real controller SIGKILL before and after a source call commit. Actual
calls advance the witness, while clean source reopen retains its revision.

Governor migration plan `/2` and prepared record `/2` bind the source host
configuration, witness revision and complete journal digest, source plan,
signed source intent, snapshot/state head and full call inventory. The
source-host writer ticket spans the synchronous governor commit. A direct
source call after prepare changes the witnessed head and prevents candidate
commit; its unregistered operation ID then blocks deployment serving. Real
controller SIGKILL while prepared recovers the source, and SIGKILL after
governor commit activates the candidate. Historical config/16/17 tests and
Artifact/1–2/3 legacy deployment refusals remain passing. Prepared `/1`
cannot be adopted as the witnessed-source `/2` record.

This is a **bounded pure one-rewrite gate**, not full T1-05. Witness fixtures
run under the same UID; independent operator custody, whole-machine rollback,
effectful/general semantic rewrites, signed GC completion, native OS/dlopen
load custody and release performance remain unqualified. The full serial
suite was not run on this source. Tracker count remains **20/62**.
