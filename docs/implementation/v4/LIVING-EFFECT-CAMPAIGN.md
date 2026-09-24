# Signed effectful living campaign `/2`

`LivingCampaign` has an opt-in effectful execution path. The v1 cooperative
campaign remains a denying effect sandbox with its original manifest, case,
report and admission bytes. The `/2` path accepts an arbitrary statically typed
Aether module within the existing scalar/record campaign boundary and runs its
effect calls through a separate durable broker and deterministic local sink for
each generated case. No ambient or caller-provided live adapter enters this
profile.

## Exact subject and authority

The caller supplies the complete Aether module and v1 scenario manifest, an
`ExecutionManifestV1`, a signed resource policy `/1`, signed response table and
an independently chosen Ed25519 trust key. The `/2` campaign authorization signs
the exact execution manifest, campaign digest, effect policy, response table,
fault mode and signer. Construction rehashes the module, typechecks it, verifies
both signatures, requires the execution root and specification root to equal
the actual module and campaign, checks local reference semantics, and requires
the signed policy capability set to equal every `Invoke` in the module. The
policy pins each sandbox adapter ID and semantics digest. The signed response
table pins each adapter return value. Unsupported opaque/authority return values
and undeclared capabilities fail closed.

Each case gets a fresh Aether runtime and a durable broker journal keyed by its
case digest. The broker checks execution manifest, epoch, grant reference and
signed resource path at dispatch. The sink records the exact request and signed
response through atomic publication and fsync. The report includes per-case
broker/sink digests, event counts and unknown outcomes. The admission method
rereads the durable report, cases, journals and sinks, requires every declared
case to pass with zero filters and complete coverage, and rejects any unresolved
effect. A signed `unknown-after-dispatch` fault demonstrates that a durable sink
write without a trustworthy receipt cannot be called a successful case.

An interrupted run cannot be reopened as an admitted in-memory report. Fresh
runs refuse existing effect activity. Seeded failures persist `/2`
counterexamples that replay after reopening under the same signed subject.
Local admission returns `productionAuthorized: false`; it does not replace
ProcessDeployment proof, governor or quorum promotion.

## Current limits

The interpreter and local synthetic sink are part of the trusted implementation;
this profile signs their declared semantics but does not bind a measured runtime
binary or an independently attested external sink. It supports the v1 scenario
boundary, not arbitrary opaque values or full production module dependencies.
The earlier fixed process/socket companion remains separate. V3 exercises a
signed candidate in an independent research worker, but has not reached
production ProcessHost, a host-level partition or an external sink. The complete campaign rate must
meet the fixed R04 2,000,000/s threshold before T3-03 G2 can close.

## V3 independent-process crash profile

Authorization `/3` keeps the V2 exact module, policy and response bindings but
uses a separate signature and campaign-manifest domain. Its sole fault mode is
`sigkill-once-after-dispatch`. The trusted test worker fsyncs its local sink,
durably records a one-time crash marker, then sends itself `SIGKILL` before the
broker receipt is committed. A fresh worker calls `recoverEffectCase` to
release only the dead owner and reconcile the exact generated case from the
local sink before it retries. V2 fault modes and signatures remain unchanged.
The V3 executor refuses direct execution unless the host explicitly opts its
isolated worker in with `AETHER_LIVING_CRASH_WORKER=1`; the signed authorization
alone cannot make an ordinary controller kill itself.

The V3 crash profile cannot call `runEffectful` or `admitEffectful`: a process
that dies mid-case has no local complete-run report to mint. The independent
campaign retains every worker observation, raw sink and broker record, and
checks all declared cases after recovery. Its result is research evidence with
`productionAuthorized: false`. The marker and sink share one UID and local
filesystem, so they do not establish independent external sink custody or a
production noncommit/commit proof.

## V4 witnessed external sink profile

Authorization `/4` has a separate signing domain and binds the same Aether
module/campaign roots to signed resource policy `/2`, an approved adapter
artifact digest, a preselected Ed25519 sink anchor, deployment ID, sink-state
witness identity and effect-journal witness catalog identity. It has no
synthetic response table. Construction requires independently supplied,
branded witness objects and a synchronous attested sink client that match
those signed identities. The executor's exact case uses a broker V4 journal,
an `AttestedSinkAdapterV1`, signed receipts and both external witnesses.
Unknown transport/status results stay indeterminate. `recoverEffectCase`
accepts only an exact generated case and may reconcile only through the
original adapter's signed status; a missing response never implies noncommit.

V4 returns a versioned `externalEffects` summary with exact journal and signed
receipt digests. Its `execute` path is available to an independent process
campaign, while `runEffectful` and `admitEffectful` refuse to mint a V2 local
admission receipt. The [external campaign](../../../roadmap/v4/research/microworld-external/README.md)
uses separate sink, witness, gateway and candidate processes. It drops one
response after the sink's witnessed append, observes unknown during a real
gateway outage, rejoins, verifies the signed commit and then executes every
declared case. The service processes and local private stores still share one
UID in this fixture; distinct operator custody and production ProcessHost
admission remain open.
