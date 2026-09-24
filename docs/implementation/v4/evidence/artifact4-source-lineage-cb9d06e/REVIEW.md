# Active-source signed-lineage refusal checkpoint

Source commit: `cb9d06ee207bfbc97ac5fa03da524298459dae1d`.
Only this evidence directory was untracked during the exact-source rerun.

| Command | Result | Raw output SHA-256 |
| --- | --- | --- |
| `npm run build` | pass; same 769,325-byte measured worker bundle as the parent checkpoint | `cb59a3f1dd3998661e641c0ab0a435d01af3252e55aa6bee99dd876ab1165888` |
| `node --experimental-strip-types --test --test-name-pattern='pure Artifact/4 deployment refuses superseded source spec' test/tier4/process-virtual-artifact-v4.test.ts` | 1/1 pass, 0 skips | `f90e17e3095536b26c5f346b242173ce2302e08d73baa9efd1ced08db2a932ac` |
| `npm run typecheck` | pass | `21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a` |
| `npm run roadmap:v4:check` | pass | `94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161` |

After opening the live pure source deployment, the test publishes a newer
signed revision of its behavior spec. Token issuance, a call with already
issued tokens, snapshot, and operation recovery all refuse through the
strict governor's current-lineage check. The source host journal has zero
calls and the witnessed deployment journal has zero invocation IDs; reopening
under the stale Artifact/4 also fails. The broader 19/19 Artifact/4 focused
campaign is recorded at its unchanged production-source parent
[`567979c`](../artifact4-live-deployment-567979c/REVIEW.md). This follow-up
changes only a regression test and documentation, not the runtime.

This does not close the local source-host custody, distinct-UID witness,
effectful deployment, general semantic GC, OS native-load, or release gates.
T1-05 and the tracker remain open at 20/62.
