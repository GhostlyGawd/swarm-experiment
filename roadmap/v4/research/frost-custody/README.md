# Durable nonce custody and authenticated peer channels — research

This bounded, same-host experiment combines Ristretto255 FROST with encrypted persistent state and direct mutually authenticated TLS channels. It remains separate from production quorum, membership and promotion admission.

## Pinned components and audit scope

`Cargo.toml` pins FROST core/ristretto255 3.0.0, Rustls 0.23.45, ring 0.17.14, rcgen 0.14.7 and the other direct dependencies. `Cargo.lock` records the complete resolution and registry checksums. TLS and storage cryptography use library primitives; no custom TLS, AEAD or elliptic-curve implementation is introduced.

Rustls, ring and WebPKI have published independent audit history. Cure53's report describes work performed in May–June **2020**, including Rustls and its supporting libraries. That historical assessment is not an audit of these exact current releases, this custody code or its composition. An independent security review of this work remains required. [Primary Cure53 report](https://cure53.de/pentest-report_rustls.pdf), [Rustls project history](https://rustls.dev/blog/2026-09-08-a-decade-of-rustls/), [pinned ring AEAD API](https://docs.rs/ring/0.17.14/ring/aead/index.html).

## Direct peer transport

Four actual worker processes use separate certificate/private-key identities. Rustls requires TLS 1.3, validates the test CA chain and checks the exact enrolled leaf-certificate fingerprint. The client also validates the destination name. Client authentication is mandatory; session resumption, tickets and 0-RTT are disabled. The local worker identity must match its custody participant.

Private DKG round-two packages are read from the sender's custody store and sent **directly to the recipient over TLS**. They do not travel through the coordinator's control pipe. The coordinator supplies addresses and receives acknowledgments/digests. Every delivery binds the group, ceremony/session, roster, repository, membership/policy epochs, sender, recipient and phase. A repeated identical delivery gets an idempotent acknowledgment without changing state; a conflicting reuse of that slot rejects.

Before DKG part two, every worker sends its complete round-one digest vector to every peer. A worker requires all four authenticated views to match its own. Inconsistent views and withheld agreement messages prevent progress. This is an all-participant research ceremony that can abort under withholding, not a robust production Byzantine ceremony with membership changes.

The transport accepts bounded length-prefixed records and has read/write timeouts. The test service is limited to 256 incoming connections per process. These are experimental bounds, not a production network-availability claim.

## Durable custody and replay boundaries

The custody state contains FROST DKG/key material and pending nonces encrypted with ring ChaCha20-Poly1305. AAD binds the context, participant and revision. Master keys are separate files with owner-only permissions; the custody directory is owner-only. Writes fsync the encrypted temporary file, atomically rename it, and fsync the directory. A same-host OS file lock serializes competing controllers. Established state cannot be silently recreated when its encrypted file is missing.

Nonce reservation is durable before public commitments are returned. A signing attempt creates and fsyncs an independent burn marker, removes the nonce from durable state, and only then computes the share. The share receipt is persisted before being returned. Restart can resend an exact cached receipt but cannot sign a different package using that nonce. A crash after consumption but before the receipt leaves the nonce unavailable; callers must use a fresh signing round. Even malformed signing requests consume the reserved nonce once an attempt begins.

The independent burn marker also blocks reuse if only `custody.enc` is replaced with its older reserved-nonce snapshot. **This is not whole-directory anti-rollback protection.** Restoring/deleting both encrypted state and burn markers, compromising the master key, or subverting the host remains outside the guarantee. There is no HSM, external monotonic anchor or secure multi-host key vault. AEAD nonces use OS randomness, with probabilistic uniqueness; FROST nonce single-use is enforced separately by the durable markers and receipts.

All workers run under the same host/user in this experiment. Separate cryptographic identities and processes do not establish independent adversarial fault domains. The test supervisor provisions and can access the TLS/master keys. Network relays cannot read the protected records, but the trusted host/operator can access endpoint secrets.

## Exact signing subject

The fixture contains the repository's actual canonical `QuorumVoteBodyV1` from the prior Ristretto campaign. The service is configured for one exact vote digest and signs a distinct `aether.custody-vote/1` envelope containing that vote, the full custody context and the resulting FROST group public key. Altered group, session, membership, policy, vote or noncanonical message bytes reject before nonce reservation changes.

This fixed-subject service is not a HotStuff voting state machine. It does not authorize new views, enforce consensus locks, decide membership handoff or activate a runtime.

## Retained campaign 01

[Manifest](results/campaign-01/manifest.json), [test log](results/campaign-01/tests.log), [public evidence](results/campaign-01/evidence.json), [dependency tree](results/campaign-01/dependency-tree.txt).

**9/9 integration tests pass**, exercising:

1. Four-process DKG over direct mutual TLS, encrypted nonce restoration and a valid threshold signature with every share verified.
2. Two real controllers racing different commitment sets for one nonce: one share succeeds, the competing package rejects, and exact retry uses the cached receipt.
3. Actual SIGKILL after burn-marker persistence, after encrypted burn-state persistence, after share computation and after receipt persistence.
4. Stale encrypted-state-file restoration, wrong master key, wrong context, ciphertext corruption and missing established state.
5. Exact sender, recipient, session/group and epoch checks; an unrostered but CA-signed client and the wrong server are refused.
6. Withheld/malformed private DKG packages and inconsistent authenticated round-one agreement.
7. Atomic subject refusal and durable burning of an invalid signing attempt.
8. An actual forwarding relay capture containing neither the known probe plaintext nor its hex encoding.

The retained run took approximately **9.196 seconds** including Cargo dispatch and all tests. Its single positive ceremony took **903.352 ms**, including test PKI setup, process launch, TLS exchanges, authenticated round-one agreement and durable state writes. These are one-run integration observations, not a latency distribution or a product benchmark. SIGKILL tests do not simulate hardware power loss; filesystem fsync/rename and OS lock semantics are assumed.

Only public evidence is retained. Tests create keys and custody files in temporary directories, then remove them. Source snapshots, source/lock/binary hashes, toolchain, host and the exact public vote fixture are bound in the manifest. One initial formatting attempt failed on a comma-separated Rust `let` declaration; it was fixed before compilation. No protocol campaign failure was hidden or excluded.

## Reproduce

```sh
cargo test --release --locked --manifest-path roadmap/v4/research/frost-custody/Cargo.toml -- --test-threads=1
node --experimental-strip-types roadmap/v4/research/frost-custody/run.mjs roadmap/v4/research/frost-custody/results/new-campaign
```

The runner refuses to overwrite retained evidence. Production custody and isolation, whole-store rollback resistance, membership handoff, quorum protocol integration, end-to-end HotStuff admission and independent security review remain open.
