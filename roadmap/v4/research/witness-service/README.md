# Process witness service research slice

This slice supplies durable, authenticated journal heads from an operator-run
Node process. The controller obtains the existing V2 effect, V1 host, and V1
deployment witness objects through `createProcessWitnessClient` in
`src/fabric/witness-service.ts`. The witness service and controller are separate
OS processes. It is an integration building block for V9 host/deployment
recovery, **not** completion of V4-T2-04 or authenticated external sink results.

## Launch

Provision a random key of at least 32 bytes in a file owned by the service UID
with mode `0600`. Supply a canonical JSON configuration file with exactly these
fields: `socketPath`, `storageDir`, `keyFile`, `namespaces`. Both paths and the key
file path must be absolute. The key bytes travel neither in argv nor env. The
storage directory is created mode `0700`, must not be a symlink, and must remain
outside any runtime-writable directory.

Run:

```sh
node --experimental-strip-types src/fabric/witness-service-cli.ts --config /absolute/private/config.json
```

The CLI writes `witness service ready` after the Unix socket is listening.
The Node API `startWitnessService({socketPath, storageDir, key, namespaces})`
provides a `close()` method for controlled shutdown. Run this API in a separate
process from the synchronous client: the client's transport subprocess blocks
its calling event loop, so a service started in that same event loop cannot
answer it. A service-lifetime
`JournalLock` ticket serializes access to one storage directory, including
across process restarts. A second live server using that directory is rejected.
After SIGKILL, dead-ticket recovery and stale-socket removal allow restart.
The immutable service ticket log is bounded to 10,000 launches and currently
requires a separately coordinated quiescent maintenance procedure afterward.

The namespace allowlist accepts exact `{kind:'effect', authorityId,
repositoryId, catalogDeploymentId, operationId, clockDomain}` and
`{kind:'host', authorityId, repositoryId, deploymentId, hostId}` records, plus
an exact `{kind:'deployment', authorityId, repositoryId, deploymentId}` record.
For runtime-generated IDs, configure `effect-scope` without `operationId` or
`host-scope` without `hostId`, keeping all other fields fixed. The service
checks the full request identity against the configured scope. The broker key
holder is authorized to select IDs within that scope.

Controller API:

```ts
const remote = createProcessWitnessClient({ socketPath, key });
const effectJournalWitnessCatalog = remote.effectCatalog({
  authorityId, repositoryId, deploymentId, clockDomain,
});
const hostJournalWitnessCatalog = remote.hostCatalog({ authorityId, repositoryId, deploymentId });
const deploymentJournalWitness = remote.deploymentWitness({ authorityId, repositoryId, deploymentId });
```

Each synchronous callback launches a short-lived Node transport subprocess.
It carries only a canonical length-framed signed request; the key stays in the
controller and service processes. Both directions use HMAC-SHA256 over exact
canonical payloads, and responses echo a random 256-bit request nonce. The
36 MiB outer frame bound accommodates JSON escaping of a canonical 16 MiB
journal. Wrong MAC,
noncanonical framing, wrong namespace, stale revision, and oversized frames
fail closed. After a response failure or timeout, the client throws
`uncertain witness response`; callers must read the head and reconcile before
retrying an advance. A service error after rename is likewise reported as
uncertain because the write may already have committed.

For each advance, the service writes a fresh private file, fsyncs it, renames
it over the head, fsyncs the directory, then rereads the exact head before
returning success. The journal identity and revision bindings are checked by
the service. It also refuses removal of previously witnessed broker records,
host effects/calls and deployment invocations/allocations, and changes to
terminal inventory. This retention check does not prove the program semantics
or authenticate an external sink. The existing witness wrappers and
ProcessHost/ProcessDeployment validate richer journal semantics.

## Evidence and limits

Run the focused test with:

```sh
node --test --experimental-strip-types roadmap/v4/research/witness-service/witness-service.test.ts
```

It launches a real separate service process, selects generated effect/host
IDs twice without swapping branded objects, advances all three head types,
rejects a second server on the same directory, stale revisions, wrong
namespace/key/MAC, malformed and oversized frames, then SIGKILLs the service
and verifies exact heads after restart. The test runs under one UID. Node's
public Unix socket API does not provide portable macOS peer credentials, and
these tests establish no distinct-UID custody boundary. A process with the
same UID and access to the key or storage can impersonate or tamper; production
custody requires separate OS ownership, operator controls, and an appropriate
cross-UID transport/authentication design. HMAC and journal custody do not
authenticate whether an external effect sink committed its result.

The [V9 real host/deployment integration test](../../../../test/tier4/process-wasm-external-witness.test.ts)
routes real workers through the [native peer gateway](../witness-peer/README.md), kills and restarts the service,
reconstructs fresh controller witness objects, and verifies cached calls do
not redispatch. It sends correctly authenticated omission attempts against all
three actual committed heads; the service refuses each without advancing. The
[controller crash test](../../../../test/tier4/process-wasm-controller-crash-witness.test.ts)
SIGKILLs a real controller while the service stays up, then reopens and
reconciles the exact read-only Wasm effect in a fresh controller without another
guest dispatch. Neither test proves independent UID custody or external sink
commitment.
