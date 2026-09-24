# Artifact/4 top-level JS launch custody

Tested source commit: `6e0698eb73aebb7063e06c43cc8c5e69784a6d9c`
(`agent/measured-launch-custody`, macOS arm64, Node v26.7.0). The evidence
files were added afterward; their content does not enter the measured worker
bundle.

| Check | Result | Raw record |
| --- | --- | --- |
| Build and bundle production | pass | [build.log](build.log) |
| Full Artifact/4 suite, including direct ProcessHost config/16 reopen and controller SIGKILL | 11/11 pass | [artifact4.log](artifact4.log) |
| Separate-process atomic pathname swap and pre-acquisition tamper | 2/2 pass | [path-swap.log](path-swap.log) |
| Legacy Artifact/3 real-worker init/2 compatibility | 1/1 pass | [artifact3-compat.log](artifact3-compat.log) |
| Typecheck | pass | [typecheck.log](typecheck.log) |
| Worker bundle verification | pass | [bundle-verify.log](bundle-verify.log) |
| v4 roadmap check | pass, 62 tasks/71 obligations | [roadmap.log](roadmap.log) |

The path-swap test acquires the signed original JS into private memory, then
uses a **separate same-UID process** to atomically rename attacker JS onto the
original pathname before spawn. A direct pathname launch executes the attacker
and writes its sentinel. The custodied stdin launch executes the acquired JS
and does not write that sentinel. The second test alters the source before
acquisition and observes refusal. The real Artifact/4 suite exercises the
same `ProcessChannel.startVirtualV4` launch code with signed proof and a
snapshot restart.

The rebuilt bundle was 768,222 bytes, SHA-256
`f7322327b96352257ea0ca753125d5e4143baf9c83b03e9f53ba53768c6a44ca`,
from 70 observed JS/TS inputs. Native scope remains the measured macOS
static-link closure; this record does not measure raw dyld-cache members,
`dlopen`, Node binary load-time bytes, or same-UID debugger/process-memory
injection. The stdin mode and FD5 protocol are versioned locally but are not
yet bound into the Artifact/4 signed executable subject. No v4 1 ms boot or
2 MB guest resident-memory claim follows from these checks. ProcessDeployment
promotion and full T1-05 remain unverified.

Reproduce from the source commit with `npm ci --ignore-scripts`, `npm run build`,
`node --test --experimental-strip-types test/tier4/process-virtual-artifact-v4.test.ts`,
`node --test --experimental-strip-types test/tier4/process-worker-launch-custody.test.ts`,
`node --test --experimental-strip-types --test-name-pattern='Artifact/3 init/2 executes' test/tier4/process-virtual-artifact.test.ts`,
`npm run typecheck`, `npm run worker:bundle:verify`, and
`npm run roadmap:v4:check`. Run source-mutating Artifact/4 tamper tests
serially with other bundle/source checks.
