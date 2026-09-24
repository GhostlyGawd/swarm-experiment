# D20 — Opt-in witnessed ProcessHost active-task release

Status: bounded V4-T1-05/G2 integration slice. G2 remains open.

`semanticActiveReleaseProfile: 'witnessed-active-task-release-v1'` gives a
ProcessHost a distinct `aether.process-host-config/15` identity. It requires
an existing host-witnessed signed policy profile, the same operator-held
`HostJournalWitness` used by ProcessHost, and a same-program
`ProcessCheckpointActiveReleaseAuthority` inside `ProcessSemanticRetention`.
The old V13 and other host configurations are unchanged; an old journal
cannot be reopened under config/15 or silently adopt a release authority.

For a completed checkpoint, ProcessHost first publishes its receipt, effect
audit and state head to the host witness. While still holding its host journal
lock, it asks the retention authority to independently re-read that witness,
the retained checkpoint, effect audit and semantic marker, then append the
GC's V2 active-task release and retire those physical leases. Replay leases
remain mandatory. The lock order is host journal, GC retention, AST store.

If the controller stops after the durable host commit but before release,
`ProcessHost.open()` checks the witnessed journal and reconciles each
committed lease. A prior release is checked idempotently; an active lease
still requires both active-task and replay pins. A committed lease with a
verified release requires its immutable V1 active-task history and complete
live replay pins. Missing witness, rolled-back/equivocating witness, changed
receipt, marker or replay pin fails before serving. The release proof is
versioned and includes exact collector/store directories to prevent pin
substitution.

The focused integration test uses an actual host-witnessed V9 signed policy,
commits a real checkpoint, then reopens ProcessHost with a fresh store and
retention authority. It kills the controller process at both boundaries:
after the witnessed host commit but before release, and after release but
before the commit call returns. Fresh ProcessHost reopen reconciles both.
Adversarial reopen tests cover witness outage and rollback, a changed receipt,
and marker loss. The profile is not yet qualified under the V13 signed-sink
policy with external effects. Audit expiration, replay deletion,
unstable-replication release and full G2 retention lifecycles remain open.
