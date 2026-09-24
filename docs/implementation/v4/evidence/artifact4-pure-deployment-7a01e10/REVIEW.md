# Pure Artifact/4 deployment contract checkpoint

Source commit: `7a01e105b2df36cca76000f51283ea0389faa434`
(`agent/artifact4-deployment`, includes earlier witnessed host commit `cf9540c`).
The working tree contained only this evidence directory during the rerun;
no source file changed after the source commit.

| Command | Result | Raw output SHA-256 |
| --- | --- | --- |
| `node --experimental-strip-types --test test/tier4/process-virtual-artifact-v4.test.ts test/tier4/process-virtual-deployment-journal.test.ts` | 14/14 pass, 0 skips | `ef28494e75467f3d1ec81ec21b1c015f41336c98e232f23c680aeebdc4283211` |
| `npm run build` | pass; 767,552-byte worker bundle, 70 resolved inputs, 25 native libraries | `383d0ab99995c6a3255578cf784785393d7d9fbe38cd9c12058baa281365ea67` |
| `npm run typecheck` | pass | `21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a` |
| `npm run roadmap:v4:check` | pass; 62 tasks, 71 obligations | `94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161` |

The new pure promotion contract validates exact signed Artifact/4 source and
candidate evidence, archived wrapper, measured bundle, approval-bound source
snapshot and no-effects one-unit plan, schema equivalence after wrapper
removal, source generation, and operator trust/witness identities. A fixture
with a self-reference verifies snapshot ownership rebinding. Forged source
parent, cross-unit plan, changed prepared bytes, and stale signed spec fail.
The separate virtual deployment witness rejects rollback and restores its
local mirror after an external CAS succeeds without a local write.

This is **not a live ProcessDeployment promotion**. No Artifact/4 governor
driver yet persists a registry, launches a candidate ProcessHost from this
prepared record, repeats the check under the commit fence, or reconciles a
real controller SIGKILL on both sides of the governor commit. The witness
interface depends on the operator supplying a durable independent CAS; this
same-UID test uses an in-process fixture and does not prove separate custody.
Effectful calls and cross-unit calls are refused. The tracker remains 20/62.
