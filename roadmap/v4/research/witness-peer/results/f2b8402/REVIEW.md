# Native witness peer focused result

Exact source commit: `f2b8402c6a5378847061d4b7c2f0ca2f723811c7`.
The test ran from a clean detached worktree at that commit on
`Darwin 25.6.0 arm64`, Node `v26.7.0`, Apple clang `21.0.0`.

Commands and exit status:

```text
cc -std=c11 -Wall -Wextra -Werror -pedantic -O2 native/witness-peer/witness-peer.c -o /tmp/aether-witness-peer-f2b8402    0
node --test --experimental-strip-types roadmap/v4/research/witness-peer/witness-peer.test.mjs                    0
```

[Raw TAP output](test.log) has SHA-256
`fde9879b998c0252c3fb1d050651f5856c328b4f864ba197d8c9ae79de0a636e`:
two tests, two passed, zero failed. The tests cover same-UID admission, a real
signed deployment witness read and durable CAS through the native gateway,
UID/GID and upstream-UID denial, malformed framing, missing EOF, upstream
timeout, and a killed upstream process. This is single-UID macOS evidence.
It does not demonstrate distinct-UID custody, Linux runtime behavior,
concurrent-client availability, or the complete V4-T2-04 gates.
