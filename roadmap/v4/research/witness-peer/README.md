# Native witness peer gateway research slice

This is a bounded transport component for V4-T2-04, not task verification.
`native/witness-peer/witness-peer.c` accepts one AF_UNIX stream request, checks
the connecting process's kernel-reported UID (and optionally GID), then
forwards one exact length-framed request to a private upstream Node witness
service. It verifies the upstream UID before sending request bytes. It returns
one complete upstream response to the admitted client. The proxy contains no
witness HMAC key and does not parse or endorse signed JSON. The existing
client/service MAC and nonce checks remain necessary.

## Build and launch

```sh
cc -std=c11 -Wall -Wextra -Werror -O2 \
  native/witness-peer/witness-peer.c -o /private/bin/witness-peer
/private/bin/witness-peer \
  --listen /operator/run/public-witness.sock \
  --upstream /operator/private/witness.sock \
  --uid 501 --gid 20 --upstream-uid 502 --mode 0660 --timeout-ms 5000
```

`--uid` is required. `--gid` is optional. `--upstream-uid` defaults to the
proxy's effective UID. `--mode` is `0600` by default or `0660` for an
operator-provisioned shared group. The listener's immediate parent must be a
directory owned by the proxy UID and not group/world writable. The listener
path must be unused; the program never silently unlinks an existing path.
After SIGKILL, the operator must verify the stale socket and remove it before
restart. The private upstream path should be in a directory that the broker
UID cannot modify or traverse. Put witness storage and the service key under
the witness UID, outside broker-writable paths. Give the broker only the
permissions needed to connect to the gateway listener. The executable should
run under the witness/operator UID and should be protected from broker writes.

Point `createProcessWitnessClient({ socketPath, key })` at the gateway listener.
The broker-side client still needs its HMAC key. The proxy adds a kernel peer
identity check; it does not remove the need to distribute and protect that
client key. Provision separate UIDs and the actual socket/group layout before
claiming independent custody.

The wire contract is exactly one nonempty 32-bit big-endian length prefix and
body, with a maximum body of 36 MiB, followed by EOF in each direction. Extra
bytes, truncation, oversized lengths, timeouts, upstream failures, and wrong
credentials close the client socket without a success response. A single
monotonic deadline covers request read, upstream connect/write/read and client
reply. On an uncertain advance, the existing witness client must reread the
head and reconcile before retrying. The process serves one exchange at a
time, so an admitted or stalled client can delay other clients for at most the
configured timeout per accepted connection. This is not a production
availability profile.

On macOS, `getpeereid(3)` reports effective UID/GID. On Linux,
`SO_PEERCRED` reports the peer credentials held at connection time; its UID/GID
are Linux real IDs. Exact UID matching is the primary admission contract.
The optional GID check is platform specific under setuid/setgid programs.
See the [Apple getpeereid manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html)
and [Linux unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html).
Socket file permissions alone are not the identity check; Linux's manual
explicitly notes that portable programs must not rely on them for security.

## Focused evidence

```sh
node --test --experimental-strip-types \
  roadmap/v4/research/witness-peer/witness-peer.test.mjs
```

The test compiles the C source, forwards a frame through a real same-UID Unix
socket pair, rejects an intentionally mismatched UID and GID before sending
request bytes, rejects a wrong upstream UID before forwarding, rejects an
oversized, truncated or trailing-byte frames, bounds a missing request EOF and
a hung upstream, and SIGKILLs a real upstream process after it receives a
request. A second test sends signed deployment-witness reads and an actual
durable CAS through the proxy to the existing Node witness service. Both
tests ran on macOS under one UID.
Configuring an unreachable numeric UID is a negative admission test; it is
**not** a distinct-UID custody demonstration. No actual external effect sink
or cross-process broker path is covered here.

The component does not yet solve independent epoch/time custody, external
sink commitment authentication, witness storage rollback, authenticated
service deployment, complete grant-path containment, or availability under
concurrent hostile clients. It must not advance V4-T2-04/G1/G2 or NFR-16 by
itself.
