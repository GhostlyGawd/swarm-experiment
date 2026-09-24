# One-way pure Artifact/4 governor deployment checkpoint

Source commit: `567979c45db651ddb2d84e6cbebb34a06a41cd77`.
The worktree contained only this evidence directory during the rerun; no
source file changed after that commit.

| Command | Result | Raw output SHA-256 |
| --- | --- | --- |
| `npm run build` | pass; worker bundle 769,325 bytes, 70 resolved inputs, 25 measured native libraries | `cb59a3f1dd3998661e641c0ab0a435d01af3252e55aa6bee99dd876ab1165888` |
| `node --experimental-strip-types --test test/tier4/process-virtual-artifact-v4.test.ts test/tier4/process-virtual-deployment-journal.test.ts` | 19/19 pass, 0 skips | `0142d4418d58d4926f368068a1a8be7d430c23e37ba0b48ac3e6799fd7d67679` |
| `npm run typecheck` | pass | `21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a` |
| `npm run roadmap:v4:check` | pass; 62 tasks, 71 obligations | `94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161` |

The full focused run covers exact Artifact/4 proof and bundle tamper checks,
real worker execution/snapshot restart, direct config/16 and witnessed
config/17 host operation, and a strict-lineage one-way governor promotion.
The new deployment campaign checks predispatch type/token refusal, changed
bundle and approved plan refusal, source-host local rollback detection against
the witnessed deployment receipt, same-ID replay across the promotion, and
reopen. Separate real controller SIGKILL cases use a process-external witness
service: death while prepared recovers the source and aborts; death after the
governor commit activates the candidate. Old source grants cannot invoke the
candidate. A direct call to the removed wrapper prevents promotion from
stranding its historical operation ID. The `/2` journal test rejects duplicate
IDs and forged result generation.

This evidence is bounded to one pure D16 rewrite. The source host journal
remains local and does not have independent monotone custody; active settled
receipts detect ordinary local rollback but do not prove same-UID forgery or
whole-machine rollback resistance. The external witness fixture runs under
the same UID, and OS native/dlopen load custody remains incomplete. This is
not an effectful deployment, a chained virtual promotion, complete semantic
GC, a full serial-suite result, or a release-performance qualification.
T1-05 and the tracker remain open at 20/62.
