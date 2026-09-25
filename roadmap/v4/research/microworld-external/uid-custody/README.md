# External living campaign, Linux UID custody profile `/1`

This is a **bounded same-VM custody qualification** for the existing signed V4 external living campaign. It does not change the candidate, signed effect authority, generated seeds, sink decision format, or witness protocol. The candidate, attested sink, and witness run in separate containers as Linux UID 10001, 10002, and 10003, respectively. A root Docker controller provisions a shared named volume and supervises the containers. Each service has its own `0700` state/key directory and `0600` private files. The repo is mounted read-only, containers have no network, and the service containers have a read-only root filesystem, no Linux capabilities, and no-new-privileges.

The native `witness-peer` gateways listen in service-owned `0750` directories with `0660` sockets. They check Linux `SO_PEERCRED` for the caller UID/GID before reading a request or connecting upstream, and check the upstream service UID after connecting. Two witness gateways admit only the candidate or sink; the sink gateway admits only the candidate. The candidate's local reply-drop gateway creates the lost-reply fault after a signed sink decision. The candidate is then killed with `SIGKILL`, restarted under the same UID, refuses to guess while the gateway is absent, and reconciles from signed sink status after rejoin.

Run on a Colima/Docker Linux VM with `node:26.7.0-bookworm-slim` and the locally built `aether-uid-custody-builder:node26` image:

```sh
docker build -t aether-uid-custody-builder:node26 -f roadmap/v4/research/microworld-external/uid-custody/Dockerfile.builder .
node --experimental-strip-types roadmap/v4/research/microworld-external/uid-custody/campaign.ts
node --experimental-strip-types roadmap/v4/research/microworld-external/uid-custody/verify.ts
```

The runner refuses to overwrite an evidence directory. Pass another output path or move the existing directory for a new trial. It removes its transient service containers, private setup material, and named volume. Public evidence retains the signed registration, pipeline phases, preheal unknown journal and witnessed sink head, final broker/sink/witness journals, and `report.json`. No service private key is retained there.

## Clean trial on 2026-09-24

The clean trial's [raw report](evidence/uid-custody-v1/report.json) pins the base commit plus SHA-256 of every task executable/source file, Node image digest, builder image ID, compiled native gateway binary hash, Linux VM kernel, Node/GCC versions, seven runtime UID/GID observations, owner/mode observations, and peer-close timings. The independent [verifier](verify.ts) checks those source hashes and the signed V4 authorization, audits retained pipeline/broker/sink/witness bytes, then confirms refusal of a tampered sink receipt and a tampered witness revision.

| Observed result | Value |
| --- | ---: |
| Generated / executed / filtered signed cases | 15 / 15 / 0 |
| Execution attempts across restart | 17 |
| Passing final cases | 15 |
| Witnessed sink decisions | 9 |
| Partition unknown / signed rejoin reconciliation | 1 / 1 |
| Cross-service private file checks | 4 `EACCES` |
| Wrong-UID witness and sink gateway probes | Both closed in about 1–2 ms |
| Correct-UID gateway probes | Both remained open for the 700 ms probe |

The report measures registration and the complete signed execution interval separately. That interval includes Docker-mediated commands, a real process kill/restart, lost reply, and reconciliation. It yielded about **1.9 completed cases/s** on this VM. This is neither the fixed R04 JSON generator kernel rate nor evidence of two million complete signed/effectful campaigns per second. The accepted D21 generator boundary remains separate; this trial does not close the broader T3-03 G1/G2 source scope.

## Trust limit and diagnostics

All three UIDs share one Linux VM, volume, kernel, and root Docker controller. The controller can read or replace every private file and launch privileged containers. Candidate and sink also hold separate copies of the witness transport HMAC key required by the current protocol, so this profile does not prove independent operators or cross-machine custody. The native gateway checks peer credentials and file modes establish an OS process boundary only within that trusted VM/controller.

Before the clean trial, one setup attempt created the public registration file with mode `0600`, so the candidate correctly failed to read it. A subsequent attempt hit the signed lost-reply fault but the **task-owned controller client** waited for the long-lived worker socket to close after a complete result frame and timed out. The client now returns on the newline-framed result. These attempts are diagnostics only; neither qualifies campaign behavior or contributes to the clean timing/counts above.

## Integrated exact-source repeat

The [clean committed-source repeat](../../../../../docs/implementation/v4/evidence/t303-uid-custody-6150604/REVIEW.md)
ran from `6150604` after the runner itself was checked in. It again executed
15/15 signed cases with zero filters, 17 attempts, a real candidate `SIGKILL`,
unknown refusal during partition and signed recovery. Four cross-service
private-file reads returned `EACCES`, both wrong-UID live gateway probes
closed, and the copied raw evidence passed the independent tamper-aware audit.
The root Docker controller and shared VM remain trusted in that result.
