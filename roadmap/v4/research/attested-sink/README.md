# Operator process attested sink fixture

This is a bounded V4-T2-04 experiment for an **actual external effect boundary**.
The effect is an append to an operator process's private ledger, whose tagged
result is the submitted tagged payload. The service owns its Ed25519 private
key and a separate HMAC transport key. A broker/client supplies a pinned public
anchor independently of the wire response. The sink's signature binds the
exact request digest, repository, deployment, execution/effect IDs, adapter
artifact, grant, policy epoch, result digest, sink identity and key epoch.

The client API is synchronous for `EffectAdapter` use:

```ts
const sink = createAttestedSinkClient({
  socketPath, authKey, anchor, adapterArtifactDigest,
  repositoryId, deploymentId,
});
sink.execute(effectRequest); // committed value and signed receipt, or throws
sink.status(effectRequest);  // committed, signed not_committed, or unknown
```

The service runs separately with
`node --experimental-strip-types src/fabric/attested-sink-service-cli.ts --config /absolute/private/config.json`.
The canonical JSON config contains `socketPath`, `storageDir`, `authKeyFile`,
`signingKeyFile`, `anchor` and `adapterArtifactDigest`. Configuration and both
key files must be regular 0600 files owned by the service UID. The socket parent
must be service-owned and not group/other writable; storage is 0700 and the
socket is 0600. Secrets are file bytes, never argv or environment values.

The logical decision key is exactly `(repositoryId, executionId, effectId)`
across deployment generations. A different deployment or full request digest
on the same key is refused; recovery must use the original deployment-bound
receipt. The
service stores each decision's exact request, result and signed receipt in one
canonical state replacement, using a private temporary file, `fsync(file)`,
atomic rename and `fsync(directory)` before replying. Repeated execution or
status of a committed key returns the identical stored receipt. `status` on a
missing key durably writes a signed terminal `not_committed` fence; a later
`execute` of that key is refused. Transport or validation failure is `unknown`
for status and must never be interpreted as noncommit. The state has a 1024
decision / 8 MiB bound; capacity failure is uncertain to callers until they
obtain an authenticated decision.

Receipts and their request/value expectations are bounded to 64 KiB, 256
objects and depth 16. The outer authenticated wire allows 192 KiB so JSON
escaping and the signed receipt cannot strand an otherwise accepted committed
value. Requests outside the receipt domain refuse before a decision is stored.

## Evidence and limits

`node --test --experimental-strip-types test/fabric/attested-sink-service.test.ts`
launches the real CLI as another process. It tests exact replay after SIGKILL
and restart, a crash/response-loss-style client disconnect after complete
request transmission, the signed noncommit fence, conflicting payloads, wrong
transport secret, cross-deployment reuse refusal, a near-limit recoverable
response, and startup refusal after stored signature tampering.

This fixture proves append-once behavior **inside its own private ledger** for
the tested process crashes. It does not establish a production external
database/payment write, machine-restore anti-rollback, distinct-UID custody,
full trusted clock/grant validation at the sink, or protection from a hostile
controller running as the service UID. The service's HMAC key grants both
execute and status authority. Operators must keep the signing key, transport
secret, storage and socket custody separate from untrusted runtimes. For a
production sink, the external system itself must atomically store the effect
and signed decision, or the sink must be its trusted executor. A signed broker
claim alone is not evidence that another system committed.
