# Artifact/4 launch custody V1

## Threat and contract

The old Artifact/4 path measured `bundle.path`, spawned `node bundle.path`,
then rehashed the pathname before `init/3`. A same-UID actor able to rename the
bundle between the first check and Node's open could run arbitrary top-level JS
before `init/3` refused it. Rechecking the pathname after spawn did not cover
that execution.

`aether.process-worker-launch-custody/1` now makes the parent acquire the
signed bundle bytes into a private memory buffer after full Artifact/4
admission. It checks the opened file's size, identity, change times, and
SHA-256 against the signed manifest. The parent launches Node's ESM stdin
mode and sends precisely that buffer through its anonymous stdin pipe. The
authenticated worker protocol moves to a separate FD5 pipe. `init/3` binds
the launch hash argument and bundle pathname back to the signed Artifact/4
manifest. The existing child proof and current-file checks still run before
candidate execution and on each call. There is no intermediate launch file
or executable bootstrap JS to find, rename, or modify.

Within the path-swap threat model, changing `bundle.path` after acquisition
can cause a later admission or call to fail, but cannot change the JS bytes
Node imports. A simultaneous change during acquisition must yield the signed
hash or admission fails before spawn. The trusted parent owns the private
buffer and pipe. The child cannot independently rehash already executed ESM
from stdin, so this custody claim depends on that parent and Node's stdin
loader, not on a post-execution child hash.

## Reproduction

`test/tier4/process-worker-launch-custody.test.ts` uses a separate attacker
process to atomically rename a malicious `.mjs` over the checked pathname in
the exact post-acquisition/pre-spawn interval. A direct Node pathname launch
runs the attacker and writes its sentinel. Custodied launch executes only the
pre-acquired trusted bytes. The Artifact/4 `ProcessChannel` test executes a
signed pure candidate in a real child and
restarts from its snapshot through this launch path.

## Remaining boundary

This closes the mutable **top-level JS pathname** interval for the trusted
parent and same-UID path-swap actor. It does not prove that `process.execPath`
itself was loaded from the measured Node binary, that macOS dyld loaded every
measured native byte, that `dlopen` is closed, or that a same-UID actor with
debugger/process-memory injection is excluded. It also does not sign the
Node stdin launch mode and FD5 protocol profile into Artifact/4 candidate
evidence. Closing that broader
subject requires a new signed launch profile plus independent OS enforcement
for Node/native image identity (for example, an isolated service identity and
enforced code-signing/library policy). Node's stdin ESM loader changes
`import.meta.url` semantics for any code path that uses it; the current pure
candidate test exercises the admitted path, not arbitrary future solver
paths. This profile has no v4 boot-latency or 2 MB resident-memory evidence.

Artifact/4 remains a bounded pure ProcessHost profile. It does not authorize
ProcessDeployment promotion, effects, full recovery, or T1-05 verification.
