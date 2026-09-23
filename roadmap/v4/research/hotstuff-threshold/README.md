# HotStuff + authenticated Ristretto custody — bounded integration research

This connects four real, separate honest-validator processes to four separate Rust custody/TLS workers. It exercises Basic HotStuff voting, locks and view changes with mandatory Ristretto threshold evidence, followed by one explicitly authorized membership-epoch transition. **No production coordinator or runtime admission is enabled.**

## Components and subjects

- Each JS validator uses the existing `DurableQuorumNode`: signed new-view reports, highest prepare QC selection, prepare/precommit/commit votes, locks and persistent outbox. Protocol choices remain those selected by D04; no existing quorum module is changed.
- Each Rust worker runs a copied/adapted research custody service with FROST(ristretto255, SHA-512), direct TLS 1.3 mutual-authenticated DKG deliveries, encrypted state, exclusive file locking, independent nonce-burn markers and cached share receipts. Dependencies are pinned in `Cargo.toml` and `Cargo.lock`.
- The JS peer requires an authorization in its durable honest-vote outbox before asking for a threshold nonce. The Rust worker independently verifies that signed Ed25519 vote against its own enrolled identity, exact roster/group/session/membership/policy context and common threshold subject. It durably refuses a second body for the same view/phase.
- The common `aether.hotstuff-custody-subject/1` carries the exact `QuorumVoteBodyV1`, custody context and group key. It does not include a signer-specific wrapper, so selected participants sign the same bytes.
- The coordinator assembles the original individual-signature QC and a matching `aether.hotstuff-ristretto-proof/1`. Every subsequent phase and certified new-view justification requires the matching Ristretto proof. Native verification checks **each** authorized share, the group signature and exact aggregate; the JS layer checks the exact original QC and enrolled signer set.

The original QC is retained alongside the threshold proof. This is not a new production QC encoding and makes no communication-complexity claim. The Rust public checker is the same pinned FROST implementation as the signer, not an independently implemented cryptographic verifier. The signing inputs are synthetic, explicitly shaped research proposals and manifest digests, not verified executable artifacts.

## One prescribed epoch handoff

The tested transition moves membership epoch **2 → 3**, replacing the fourth validator identity and generating a new TLS roster and FROST group. The first three enrollment identities are retained. Both committees have `n=4,f=1,t=3` and the fixture family/role diversity required by the existing roster verifier.

1. The old committee commits a descriptor binding its exact roster, previous decision block, new roster and new genesis manifest. Its proposal is a no-op on the synthetic application manifest; no heap or production application state is moved.
2. An old validator stops new voting as soon as its committed descriptor is known. Three old custody workers durably publish retirement markers and discard active key/nonce fields before returning signed retirement receipts. The remaining old worker is protocol-inactive; only a quorum, not all four custody stores, is retired in the campaign.
3. New validators validate the old commit proof against explicitly pinned old-roster and old-group anchors. They start staged, conduct a fresh DKG, and sign readiness acknowledgments for the exact new group/genesis/handoff.
4. New activation requires distinct heterogeneous old retirement and new readiness quorums. Activation is persisted before acknowledgment. The research coordinator then records epoch 3 as active.

Old-epoch proposals, proofs and reservations are refused. Retirement-marker and activation-publication crashes are exercised. Restart refuses missing committed transition metadata or missing highest-QC threshold sidecars; it cannot interpret absent metadata as an empty approval history.

This is a single controlled transition with an exact bundle, trusted bootstrap anchors and an explicit message schedule. General reconfiguration, concurrent transition proposals, arbitrary partition recovery, equivalent-proof reconciliation and production membership handoff remain open.

## Final retained evidence

Use **[campaign-04/manifest.json](results/campaign-04/manifest.json)** and **[campaign-04/result.json](results/campaign-04/result.json)** for the frozen implementation. Public certificates, threshold shares/authorizations, decision logs, retirement/readiness/activation receipts, actor statuses and source snapshots are retained. Private keys and custody directories are temporary and removed after the run.

The final campaign passed in **16.648 seconds**:

- **9 threshold-backed phase proofs:** prepare, precommit and commit for the normal old-epoch decision, the old-epoch handoff decision, and the new-epoch decision.
- **32 checks:** 29 expected refusals and 3 positive recovery assertions.
- **7 managed validator restarts**, including a withheld reserved nonce, a persisted lock, a native retirement-marker SIGKILL, activation-publication SIGKILL and metadata-loss recovery.
- A leader's conflicting signed proposal cannot change an honest vote. Two split prepare cohorts cannot form a QC; timeout rotates to a new leader and consensus proceeds.
- An ordinary QC alone cannot advance a phase. An invalid group signature cannot authorize a decide message. Withheld threshold shares prevent aggregation; a restarted worker recovers its reserved nonce and completes the same authorized round.
- Direct native-controller tests bypass the JS wrapper and still reject a correctly signed conflicting phase vote, another voter's authorization and all post-retirement reservations.
- Changed next-roster descriptors, insufficient/duplicate old retirement receipts, duplicate/changed new readiness and stale epoch inputs reject.
- The final state reports all old validators protocol-inactive, exactly three old custody workers retired, and all four new validators active in epoch 3.

### Development campaigns retained

| Campaign | Proofs | Checks | Restarts | Notes |
| --- | ---: | ---: | ---: | --- |
| 01 | 9 | 23 | 5 | Voting gates worked; review found that `active` status incorrectly reflected bootstrap configuration after retirement. Superseded. |
| 02 | 9 | 28 | 6 | Corrected status and added activation-crash/tampered-handoff checks. |
| 03 | 9 | 29 | 7 | Added fail-closed restart validation for missing committed sidecars. |
| 04 | 9 | 32 | 7 | Added direct native custody trust-boundary tests; final frozen evidence. |

No failed protocol campaign was hidden. Earlier successful campaigns are not evidence for source changes made afterward. Each manifest retains its own exact source hashes. The first campaign's status-reporting defect is visible in its retained results.

## Verify and reproduce

```sh
cargo build --release --locked --manifest-path roadmap/v4/research/hotstuff-threshold/Cargo.toml
node --experimental-strip-types roadmap/v4/research/hotstuff-threshold/run.mjs roadmap/v4/research/hotstuff-threshold/results/new-campaign
```

The runner refuses to overwrite a campaign. It asserts protocol and cryptographic results, captures source/lock/binary hashes, and stops all managed processes before deleting temporary private state. Source hashes cover both this research project and the existing quorum/encoding modules it imports.

Verify the final recorded source and binary hashes from the repository root:

```sh
python3 - <<'PY'
import hashlib, json, pathlib
base = pathlib.Path('roadmap/v4/research/hotstuff-threshold')
m = json.loads((base / 'results/campaign-04/manifest.json').read_text())
for path, expected in m['sourceHashes'].items():
    assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() == expected, path
assert hashlib.sha256((base / 'Cargo.lock').read_bytes()).hexdigest() == m['cargoLockSha256']
assert hashlib.sha256((base / 'target/release/aether-hotstuff-threshold-research').read_bytes()).hexdigest() == m['binarySha256']
print('Recorded hashes match.')
PY
```

## Limits

This is same-host research with supervisor-driven clocks and delivery schedules, not a WAN liveness campaign. Separate processes/certificates do not establish independent operators or adversarial OS fault isolation. The supervisor, local filesystem, master-key provisioning, test enrollment and compiler/dependencies are trusted. The copied custody path does not prevent whole-directory/key rollback, provide an HSM, prove physical key erasure or qualify production key custody.

Library audit history does not constitute an independent review of this composition. Actual executable evidence policies, production state/effect migration, durable production anti-rollback, independent operator identities, general membership handoff, end-to-end production HotStuff admission and independent security review remain unfinished. Every research result explicitly reports `productionAdmission: false`; no v4 performance gate or full V4-T2-06 completion is claimed.
