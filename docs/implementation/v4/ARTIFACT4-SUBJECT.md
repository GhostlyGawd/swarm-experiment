# Artifact/4: measured process-worker closure

Artifact/4 is a versioned process-worker admission subject for the pure D16
virtual-forward rewrite. `ProcessChannel` admits it through explicit
`startVirtualV4` and worker `init/3`. An opt-in `ProcessHost`
config/16 admits the same one-unit pure candidate and durable journal.
An explicit `aether.process-host-virtual/2` selects host config/17 and the
operator-held complete host-journal CAS witness. Config/16 retains its local
journal identity and behavior.
Legacy `ProcessDeployment` still does not register or promote Artifact/4. A
separate `PureVirtualProcessDeployment` now drives one signed source to its
exact Artifact/4 rewrite under a strict-lineage governor. It does not reinterpret
the Artifact/1–2 wire or add an effectful deployment profile.

The separate pure promotion contract validates a governor binding against
the exact signed source/candidate evidence, rebuilt worker subject, archived
wrapper, live source snapshot/generation, complete one-unit no-effects plan,
operator lineage trust, and independently held host/deployment witnesses. Its
prepared record is content addressed, preserves logical references while
rebinding their ownership epoch, and has an immutable local file schema. A
separate `/1` virtual deployment journal uses an operator-supplied monotone CAS
as authority and repairs a stale local mirror after a controller death between
CAS and file write. It does not reuse the legacy `/9–12` deployment witness or
Artifact/1–2 records. The live driver consumes that record, launches the
candidate in witnessed ProcessHost config/17 during preparation, repeats the
full signed proof and source snapshot check inside its synchronous commit
fence, and serves only the governor-committed generation. Its `/2` deployment
journal adds witnessed operation IDs and exact pending/settled receipts. A
same-ID retry across promotion checks current invocation authority and returns
the original settled result without candidate execution.

## Signed binding

The candidate V3 evidence manifest sets `target.artifactDigest` to the
`aether.measured-executable-subject/2` digest. That subject contains the exact
`aether.process-worker-bundle/2` manifest. The digest is computed before the
candidate evidence or Artifact/4 envelope exists, so neither is an input to its
own hash. The worker bundle's closed input graph includes the shared proof
core, but excludes the Artifact/4 host validator and bundle producer. The
source V2 evidence remains rooted in its own executable identity. Candidate
evidence, archived wrapper, D16 descriptor, exact source/candidate Agent-IR,
and directly parented signed intents are checked at admission and in the child.

The V2 bundle manifest includes the worker entry and bundle bytes, resolved
JS/TS inputs, pinned esbuild/TypeScript files and recipes, Node binary,
external Node builtin names, and the macOS static Mach-O link closure. The
native closure includes non-system library bytes, static link edges, OS
identity, and dyld shared-cache header/map identities. The input count is
observed by the verifier, not accepted from the caller. Omitted inputs and
substituted manifests fail the fresh rebuild.

The host invokes the V2 producer in a fresh Node process. It rebuilds the
bundle twice, checks the closed import graph, and remeasures tool, input,
bundle, Node, and native identities. Esbuild and TypeScript are excluded from
the worker bundle. The host requires build-tool dependencies for this path;
separately packaged verifier tools remain future work. It refuses `DYLD_`
runtime overrides.

`assertProcessVirtualArtifactV4Launch` repeats full host admission and checks
the selected worker path and bytes once before spawn. The versioned
[launch custody V1](ARTIFACT4-LAUNCH-CUSTODY.md) then acquires exact signed JS
bytes into memory and sends them over Node's anonymous ESM stdin pipe,
closing the same-UID top-level JS pathname-swap window. The parent then rechecks
the signed proof and current measured bytes after spawn and before each call,
without rebuilding the graph again. The child opens operator-held signed
lineage independently and uses the same proof core to validate source,
candidate, descriptor, evidence, and direct ancestry before compiling the
candidate. It rehashes its launched bundle, Node, declared inputs, tool files,
static native libraries, and dyld-cache header/map. It does not execute a
recipe from the artifact. A real-worker test executes the candidate, imports
its snapshot after restart, and refuses tampered proof, trust, and bundle
bytes. Legacy Artifact/3 `init/2` remains supported.

## One-way governor operation

Provision a strict-lineage `PromotionCoordinator`, a pure source plan and
candidate plan, operator-held Artifact/4 lineage trust, a host witness catalog,
and the separate virtual deployment witness. The process-external witness
service accepts `host-scope` and `virtual-deployment` namespaces. Open
`PureVirtualProcessDeployment` with the same exact artifact and authority on
every controller restart. Its directory contains `artifact4.json`, the
recoverable `virtual-deployment.json` mirror, immutable `prepared/` records,
and separate `source-host/` and `candidate-host/` journals.

The driver freezes deployment calls while preparing, reads the live source
snapshot, verifies the approved migration and no-effects plans, and starts the
candidate without invoking its functions. The commit fence rereads the source
snapshot and complete signed Artifact/4 closure under the held deployment
gate. After the governor commit, activation closes the source host before the
deployment witness publishes the candidate as ready. `open()` first asks the
governor to reconcile an interrupted decision; a precommit death aborts the
prepared candidate, while a postcommit death finishes activation. The
candidate host and deployment journal are separate witnessed domains.
The serving gate asks the strict governor to recheck current signed lineage
for the active manifest on token issuance, call, snapshot and recovery. A
superseding signed source specification after open refuses these operations
before a host call intent and prevents reopening under the stale artifact.

Every call writes a deployment-wide operation ID before host dispatch. A
completed call is retained in the witnessed journal and checked against the
active host receipt. A pending call with an indeterminate host result requires
`recoverOperation()` and the operator recovery authorization; another source
snapshot cannot be promoted while it is pending. Reusing an old ID after
promotion requires current invocation tokens and returns its original settled
receipt. Altering the request for the same ID is refused.
Promotion refuses a recorded source operation whose symbol is absent from the
candidate, so removal of a directly called wrapper cannot strand its ID.

## Boundaries still open

The child rehash cannot independently rebuild the input graph or resolve the
native static-link closure; those are parent admission responsibilities. The
static Mach-O closure does not cover `dlopen` outcomes, raw bytes of every
system dyld-cache member, or launch-time custody after the last measurement.
The trusted parent hashes top-level JS before sending it to Node's stdin
loader, but does not prove the bytes loaded for Node or native libraries by
the OS. Per-call rehashing is
also too expensive to qualify the v4 latency target; a separately measured
custody and fast-path profile is still needed.
ProcessHost config/16 pins the Artifact/4 and operator trust digest, verifies
one pure unit, and refuses effect services and legacy profiles. It reopens its
exact durable snapshot and head after a fresh worker launch; a real controller
SIGKILL before the call commit becomes an indeterminate intent and is resolved
through explicit authorized isolated pure replay. Signed-spec invalidation
refuses new calls before an intent is written. This qualifies a bounded pure
host profile, not governor-promoted deployment or arbitrary checkpoint recovery.
Its durable host journal is local and has no independent monotone witness
custody; rollback resistance at that boundary is still unproved.

Config/17 binds the Artifact/4 digest, trust digest and witness identity into
the host configuration. It requires the witness repository to match signed
lineage, publishes the complete canonical `/4` host journal before its local
mirror, and reads the witness as authority for snapshots, calls and state
heads. An older local mirror more than one revision behind is rejected; an
exactly one-revision lag is treated as a possible controller crash between
CAS and local write and restored from the witness. Same-revision divergence
and witness outage fail closed. A separate witness-service process was used
for pure calls, local-mirror deletion, service outage/restart and real controller SIGKILL before and
after commit. Fresh reopening leaves a precommit call indeterminate until
authorized isolated replay and preserves a postcommit result without replay.
The service is same-UID in this campaign; the profile does not prove distinct
custody or whole-machine rollback protection. Its `/4` journal envelope is
the existing complete witnessed format; config/17 is a separate identity and
cannot reopen config/16 bytes.

Focused [integration evidence](evidence/integration-d9be39e/REVIEW.md):
Artifact/4 tests 8/8 and Artifact/3 plus bundle tests 13/13 passed at
`719e5ca`. The later `d9be39e` source passed build, typecheck, roadmap,
worker-bundle verification and 99/99 projection tests with the same measured
worker bundle bytes. These are separate tested commits, as the record states.

`ProcessDeployment` still registers only Artifact/1–2 and retains its legacy
same-schema migration guard. Legacy artifact registration/read and a legacy
`ProcessHost` refuse the virtual-forward target profile; a legacy factory
cannot inject `virtualArtifactV4` into `ProcessHost`. The new one-way pure
deployment has a versioned registry and real governor driver. Process-external
deployment and candidate-host witnesses were exercised with real controller
SIGKILL while prepared and after the governor commit. Reopening follows the
governor decision; the old generation is never served after commit. The source
host is still a local, unwitnessed pure ProcessHost, so independent custody of
its pre-promotion state and rollback resistance remain unproved. Its original
resumable executable identity is signed in source evidence but is not the
Artifact/4 measured candidate bundle. The witness
service test runs under the same UID and does not prove separate operator
custody. The path handles one D16 rewrite and does not support chained virtual
promotions. There is no Artifact/4 effect-broker dispatch,
integrated checkpoint recovery, or signed GC promotion. This slice does not
close V4-T1-05 or a release target.

The config/16 direct host campaign is tested separately from the earlier
worker and projection checkpoints. The tracker remains 20/62 until the
complete gate passes.
