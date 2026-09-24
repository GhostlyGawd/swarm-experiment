# Pure Artifact/4 deployment configuration identity checkpoint

Source commit: `61b2bb0dda4f895605f9ad52e970bd32045b0370`.
Only this evidence directory was untracked during the exact-source rerun.

| Command | Result | Raw output SHA-256 |
| --- | --- | --- |
| `npm run build` | pass; measured worker bundle 769,325 bytes, 70 resolved inputs, 25 measured native libraries | `cb59a3f1dd3998661e641c0ab0a435d01af3252e55aa6bee99dd876ab1165888` |
| `node --experimental-strip-types --test test/tier4/process-virtual-artifact-v4.test.ts test/tier4/process-virtual-deployment-journal.test.ts` | 21/21 pass, 0 skips | `0997fb52e5bf172efdb06f514f5d747b5bca06a40a721ac12873880a298c80d4` |
| `npm run typecheck` | pass | `21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a` |
| `npm run roadmap:v4:check` | pass; 62 tasks, 71 obligations | `94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161` |

The new adversarial case swaps every caller-owned top-level option slot after
open: directory, governor, artifact, lineage trust, source/candidate plans,
sealer, host/deployment witnesses, recovery callback and recovery authority ID.
It also mutates the original nested plan, artifact IR and trust epoch, then
restores them. The open driver continues under its captured selections. A
fresh reopen with a changed source plan while the source is still active is
refused by the witnessed `/3` configuration identity. Later reopen attempts
with a different sealer key or recovery authority ID are also refused. The
separate `/3` journal test rejects attempts to change pinned plan/authority
fields before invoking a permissive witness CAS. Existing `/1–2` journal tests
remain passing; the live driver explicitly refuses `/2` pending a reviewed
migration. Both real controller SIGKILL promotion boundaries still pass with
the process-external witness service.

This verifies one pure D16 rewrite and its declared configuration identity.
The recovery authority ID does **not** authenticate or freeze the callback's
implementation; it is a stable operator-selected identity for a policy that
may consult live revocation/epoch state. The source host journal remains local
and unwitnessed. The witness fixture runs under the same UID; separate custody,
OS native-load/dlopen bytes, effectful promotion, chained rewrites, semantic GC
completion and release performance remain open. This is a focused campaign,
not a full serial-suite result. T1-05 and the tracker remain open at 20/62.
