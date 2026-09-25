# Initial exact-source source-witness integration attempt

Source commit: `9239485bcdc221af0549d2300b96d22b986c532c`.
The worktree contained only this evidence directory during the run.

| Command | Result | Raw output SHA-256 |
| --- | --- | --- |
| `npm run build` | pass; 769,991-byte measured bundle, 70 inputs, 25 measured native libraries | `fa0e477e9e95b7b2601c3773167f258a4f3704c322b9552ca4e99d11d3fd42a1` |
| `node --experimental-strip-types --test --test-concurrency=1 test/tier4/process-virtual-artifact-v4.test.ts test/tier4/process-virtual-deployment-journal.test.ts` | **23/24 pass, 1 fail** | `828d489cf9211f87fe8d2c42c72b9f0fc85cb43f56ab5381707be53e1769b823` |
| Focused legacy ProcessDeployment refusals | 3/3 pass | `b2aeac1eb1d52c3a7b9a1c5620fdbc32bb73c012adbc521d2e2961fb682ac1a9` |
| `npm run typecheck` | pass | `21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a` |
| `npm run roadmap:v4:check` | pass; 62 tasks, 71 obligations | `94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161` |

Legacy refusal command:

```sh
node --experimental-strip-types --test --test-name-pattern='live ProcessDeployment refuses Artifact/3|legacy ProcessDeployment factory cannot inject Artifact/4|legacy ProcessDeployment refuses a virtual-forward target under Artifact/1' test/tier4/process-deployment.test.ts
```

The sole failure was the superseded-source-spec test fixture. Its host witness
catalog threw `candidate witness must not be selected` for **every** host ID,
including the newly required deterministic source ID. Config/18 correctly
refused to open without a source witness. The test-only `e88e366` fix supplies
that exact source witness while still refusing candidate witness selection.
The isolated fixed case passed, and the clean full rerun is recorded in
[`e88e366`](../artifact4-source-witness-e88e366/REVIEW.md). This failed attempt
is retained and is not acceptance evidence for the full focused campaign.
