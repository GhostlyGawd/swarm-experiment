# FROST Ed25519 research prototype

This is an **unadmitted research profile**, not the production quorum wire format. It executes a real 4-participant, threshold-3 DKG and signing protocol with four Rust participant processes. There is no trusted-dealer key generation or secret reconstruction call.

## Pinned implementation and protocol

- `frost-ed25519 = 3.0.0`; all direct dependencies use exact versions, and `Cargo.lock` pins the complete dependency graph and registry checksums.
- DKG uses Zcash Foundation's `part1`, `part2`, `part3` flow. Its requirements include consistent authenticated broadcast and confidential, authenticated private deliveries. The harness supplies a trusted local simulation of these channels. [ZF DKG tutorial](https://frost.zfnd.org/tutorial/dkg.html), [versioned crate documentation](https://docs.rs/frost-ed25519/3.0.0/frost_ed25519/keys/dkg/index.html).
- Signing uses `round1::commit`, `round2::sign`, and `aggregate`, with ciphersuite `FROST-ED25519-SHA512-v1`. The whole message is signed, without substituting a prehash. RFC 9591 specifies the signing ciphersuite; it does **not** specify this distributed key-generation protocol. [ZF signing tutorial](https://frost.zfnd.org/tutorial/signing.html), [RFC 9591 §§5–6.1](https://www.rfc-editor.org/rfc/rfc9591.html).
- The independent verifier is Node 26.7.0 / OpenSSL 3.6.4 Ed25519, using the 32-byte group public key and the resulting 64-byte signature. Verification does not call FROST.

## Subject and participation evidence

The launcher obtains the exact vote body from the repository's actual `quorumVoteBody()` implementation. A separate envelope binds that unchanged body, a group public-key identity, DKG session, ciphersuite, threshold, and selected participant metadata under `aether.quorum-threshold-vote-prototype/1`. Rust-produced bytes must equal Aether's `encodeCanonical()` bytes exactly. The existing individual-vote verifier rejects every prototype group signature.

Each trial retains its public DKG round-one packages, public verifying-share package, selected signer IDs, fixture enrollment/family/role metadata, signing package, signature shares, final signature, and participant PIDs. The four possible 3-of-4 subsets are exercised with fresh nonce commitments. Every selected subset contains both fixture families and both roles.

**These are fixture mappings, not operator enrollment attestations.** A valid group signature alone does not establish who participated or their family. The public share transcript identifies the FROST verifying shares used, but these shares have not been authenticated against the enrolled validator identities through an approved ceremony. No threshold QC or promotion admission is implemented.

## Secret and nonce boundaries

Each participant holds its own DKG secret packages, resulting key package, and signing nonces in process memory. None is written to the evidence directory. The parent routes private round-two DKG packages through local pipes and can observe them. Thus this is **not confidential against the coordinator** and is not a secure network DKG deployment. Private packages are omitted from retained evidence.

The wrapper binds nonce IDs to the session, message and its own commitment. It consumes a nonce before parsing, validating, or signing a second-round request. Duplicate IDs, consumed nonces and failed-attempt nonce reuse reject. The library's borrowed nonce API alone is not a durable single-use guard. There is no key/nonce persistence: participant death aborts the session; restart cannot restore its signing authority. A production durable nonce journal and secure key custody remain open.

## Evidence

### Failed campaign 01

[campaign-01](results/campaign-01) retains source snapshots, public input, build log, attempted invocation and [failure record](results/campaign-01/failure.json). The first IPC `Part2` request failed before DKG completion: serde's internally tagged enum buffered numeric map keys as strings, which the default `u16` map decoder rejected. No group signature was produced or counted. An explicit canonical map-key decoder now rejects duplicate/noncanonical keys; a regression exercises the actual JSON boundary.

A preceding `cargo fmt` attempt also rejected a malformed Rust test declaration (`let wrong=...,good=...`). It was corrected before that test compiled. This was a source syntax error, not a failed cryptographic check.

### Successful campaign 02

[Manifest](results/campaign-02/manifest.json), [test log](results/campaign-02/rust-tests.log), [dependency tree](results/campaign-02/dependency-tree.txt).

- 10 fresh DKG ceremonies; four separate participant processes each.
- 40/40 threshold signatures passed independent OpenSSL verification.
- 190 expected rejection checks in the Rust campaign: incomplete threshold, stale shares, malformed scalar/package, stale session, nonce reuse and failed-attempt reuse.
- 440 subject/family mutation checks failed independent verification as expected; all 40 prototype signatures were refused by existing individual-vote admission.
- Seven Rust tests pass, including stale DKG private shares, malformed/missing round-one packages, changed message/commitment, insufficient signer set, JSON map ambiguity and restart refusal.

Measured on Apple M4 Pro, Darwin arm64, Rust/Cargo 1.97.1, release build:

| Boundary | Samples | Median | Maximum |
| --- | ---: | ---: | ---: |
| DKG including four process launches and local IPC | 10 | 15.071 ms | 17.234 ms |
| Signing including local IPC and FROST verification | 40 | 1.314 ms | 1.391 ms |
| Signature aggregation | 40 | 180.250 µs | 188.541 µs |
| Independent OpenSSL verification | 40 | 72.083 µs | 378.584 µs |

Per ceremony, cryptographic package payloads total 2,004 bytes for round-one delivery to all peers and 444 bytes for private round-two deliveries; these exclude JSON/hex framing and any real network security overhead. The public key package is 296 bytes. The first signing package is 1,890 bytes, with a 64-byte final signature. Raw timings include ambient load; no sample was trimmed, no warm-up run excluded, and no product latency or WAN gate is qualified.

## Reproduce

```sh
cargo test --release --locked --manifest-path roadmap/v4/research/frost/Cargo.toml
node --experimental-strip-types roadmap/v4/research/frost/run.mjs roadmap/v4/research/frost/results/new-campaign 10
```

The launcher refuses to overwrite an existing campaign and retains failed attempts. Successful manifests bind exact source snapshots, lockfile, binary hash, compiler versions, host, raw trial data and measurement boundaries. Build time is recorded separately from protocol times. The dependency cache/network, Rust compiler, OS RNG, crate implementation, coordinator and local IPC are trusted for this experiment.

Authenticated/confidential transport, reliable broadcast, enrolled-family ceremony transcripts, Byzantine ceremony orchestration, secure durable key/nonces, membership handoff, production threshold wire verification and admission remain open. This finite prototype is not a security audit, formal proof, or completion of V4-T2-06.
