# Ristretto255 threshold research

This separate prototype uses **FROST(ristretto255, SHA-512)**, the ciphersuite selected in D04. It does not replace the Ed25519 research artifacts and does not complete production threshold admission.

## Implementation

`Cargo.toml` pins `frost-ristretto255 = 3.0.0`, `frost-core = 3.0.0`, and `ed25519-dalek = 2.2.0`; `Cargo.lock` records the full dependency graph and registry checksums. Four independent participant processes execute Zcash Foundation's DKG `part1`, `part2`, and `part3`, then threshold signing with `commit`, `sign`, and `aggregate`. No trusted dealer or group-secret reconstruction function is used. [Pinned ciphersuite documentation](https://docs.rs/frost-ristretto255/3.0.0/frost_ristretto255/), [ZF DKG flow](https://frost.zfnd.org/tutorial/dkg.html), [RFC 9591 §6.2](https://www.rfc-editor.org/rfc/rfc9591.html#name-frostristretto255-sha-512).

Every participant holds its own private DKG state, long-lived FROST key package and single-use nonces in memory. A nonce is consumed before parsing or signing the second-round request. Process loss aborts that session; key and nonce restoration is not implemented.

The parent routes DKG round-two packages through **trusted plaintext local pipes**. It can observe enough private deliveries to reconstruct secret material. This is an execution of the distributed algorithm under trusted test transport, not a confidential network DKG deployment or secure custody system. Private deliveries and secret packages are not retained in evidence.

## Authenticated public transcript

The group signs the full, canonical `aether.quorum-ristretto-vote-prototype/1` envelope. It binds the actual repository `quorumVoteBody()` output, Ristretto group key, DKG session, threshold and selected fixture participant metadata. Existing individual-vote admission rejects this distinct profile.

Each worker authenticates its resulting public group enrollment with a separate Ed25519 fixture identity. After FROST signing, each selected worker verifies **every individual share**, the group signature and the aggregate transcript before authenticating the complete public transcript. It also checks that its own share and nonce/package correspond to what it actually emitted. This adds an explicit attestation exchange after FROST's two signing rounds.

The Node verifier checks current roster, `n=4,f=1,t=3`, exact parent/proposal/view/phase/policy/epoch, expiry, externally supplied expected group digest, every enrollment signature, the selected families/roles and every participation signature. It then checks the pinned Rust executable hash and starts a fresh public-only verifier process. That process deserializes the canonical Ristretto packages and calls `frost_core::verify_signature_share` for each signer, followed by group verification and exact aggregate comparison.

The fresh verifier uses the **same pinned FROST implementation** as the producer; it is process-separated, not an independent group-crypto implementation. Node/OpenSSL independently verifies the Ed25519 identity attestations. There is no handwritten Ristretto arithmetic.

Fixture identity seeds and family/role labels are public test configuration. The worker signatures demonstrate that the implemented processes authenticate their transcripts; they are not attestations of actual model families, independent operators or approved production custody. A group signature alone is insufficient.

## Campaign 01

[Manifest](results/campaign-01/manifest.json), [Rust tests](results/campaign-01/rust-tests.log), [dependency tree](results/campaign-01/dependency-tree.txt). Each trial retains public DKG packages, worker PIDs, worker-signed enrollments, full signing packages, all public shares, participant attestations, final signatures and assembled research certificates.

- 10 successful DKG ceremonies with four distinct participant processes each.
- All four possible 3-of-4 signer subsets exercised per group: **40/40 authenticated threshold certificates verified**.
- **840 adversarial certificate cases rejected**, covering subject and family/role changes, absent/duplicate/forged attestations, expiry, wrong expected group, wrong verifier hash, changed/cancelling shares, malformed Ristretto point and Ed25519 profile substitution.
- **190 expected protocol refusals**, including insufficient shares, stale shares/session, malformed scalar/package and nonce reuse.
- **8 Rust tests pass**, including stale private DKG deliveries and an actual participant refusing to authenticate invalid peer shares that cancel in the aggregate. The original group signature still verifies in that adversarial case, so checking only the aggregate would not establish each contribution.

Measurements on Apple M4 Pro / Darwin arm64, Rust and Cargo 1.97.1, Node 26.7.0, release build:

| Boundary | Samples | Median | Maximum |
| --- | ---: | ---: | ---: |
| DKG including four launches, local IPC and identity enrollment | 10 | 20.558 ms | 23.656 ms |
| Signing including IPC, share verification and worker attestations | 40 | 2.593 ms | 5.801 ms |
| Aggregation | 40 | 121.000 µs | 271.500 µs |
| Pinned full public share/group verifier, without process launch | 40 | 767.792 µs | 1.779 ms |
| Fresh verifier process, executable hash and OpenSSL identity checks | 40 | 9.906 ms | 14.782 ms |

These boundaries differ from the earlier Ed25519 campaign because this path includes enrollment authentication and the additional verified-transcript attestation exchange. They are not a direct ciphersuite speed comparison. All samples and ambient load are retained; no latency, throughput, WAN or other product gate is qualified.

## Reproduce

```sh
cargo test --release --locked --manifest-path roadmap/v4/research/frost-ristretto/Cargo.toml
node --experimental-strip-types roadmap/v4/research/frost-ristretto/run.mjs roadmap/v4/research/frost-ristretto/results/new-campaign 10
```

The launcher refuses to overwrite campaigns and records exact source snapshots, lockfile and binary hashes, toolchain, host, public input and attempted runs. The first complete campaign passed without a failed protocol run. One earlier build failed because the public package's `min_signers()` API returns `Option<u16>` rather than a reference; that source error was corrected before the campaign and is retained in [development-attempts.json](development-attempts.json).

## Remaining production requirements

Secure authenticated/confidential DKG transport and broadcast; independently approved enrollment ceremony; protected long-term keys; durable nonce and anti-replay state; membership handoff and revocation; integration with honest HotStuff voting/locks; production coordinator admission; and independent security review remain open. `verify.mjs` is stateless and its successful result explicitly carries `productionAdmission: false`. The filesystem, binary pin, compiler/dependencies, OS RNG and local coordinator are trusted by this experiment.
