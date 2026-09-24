# Pure Artifact/3 worker protocol (experimental)

`ProcessChannel.startVirtual` opens one candidate unit with `aether.process-worker-init/2`.
The older `init` protocol is unchanged. The caller provides an Artifact/3 and an
operator-held `aether.process-virtual-worker-trust/1` anchor. The parent and child
independently reopen the durable signed lineage, validate the exact source and
candidate IR, D16 descriptor, archived wrapper dependency, evidence and measured
subject, and bind the artifact's measured bundle path to the actual launched file.
The parent canonicalizes the entire init request before admission, so caller
accessors, proxies or later changes cannot alter trust or guard options between
validation and the worker handshake.
Both sides repeat validation before a call. The worker compiles every candidate
function locally with `virtualForward`; the target cannot be remote. It registers
no effect handler or cross-unit call handler, and Artifact/3 rejects effectful and
dynamic modules. An optional cumulative `maxGuardChecks` can only tighten the
existing liveness guard; it permits comparison of source and candidate denial
order in tests.

This path is **not** a ProcessHost or ProcessDeployment promotion profile.
Artifact/3 currently permits a caller-supplied bounded source list. Rechecking
those files detects changes, but this worker protocol does not independently
prove that the list covers every transitive import and installed package byte.
The OS can also change a path between measurement and module loading. A complete
executable closure and launch-time custody are required before live deployment
admission. The worker has no durable journal or recovery authority by itself;
`kill` and `startVirtual` exercise a fresh process, not replay of committed state.
A focused integration test independently rebuilds and verifies the closed
single-file worker bundle, uses all measured input paths to create Artifact/3,
and launches that exact bundle through init/2. This demonstrates the bundled
path, but arbitrary Artifact/3 callers are not yet required to present a
verified closure manifest.

Focused verification:

```sh
node --test --experimental-strip-types test/tier4/process-virtual-artifact.test.ts test/tier4/process-channel.test.ts
npm run typecheck
npm run build
```

These tests cover separate source/candidate worker results, guard budgets 0–3,
parent and child rejection of altered source/descriptor/declared measurements,
and worker kill/reopen. They do not close T1-05 or any release gate.
