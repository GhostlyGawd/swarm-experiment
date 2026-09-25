# Exact-source three-UID witnessed external campaign

Clean integrated source `615060415eba7aa231dce98229dafff073d00cd3`,
specification 0.1.0. The versioned [UID custody runner](../../../../../roadmap/v4/research/microworld-external/uid-custody/README.md)
ran inside the Colima Linux VM from this committed source. The
[report](raw/report.json) pins task source hashes, Node runtime image digest,
builder image ID, compiled native `witness-peer` SHA-256, Linux kernel and
runtime UID/GID observations. The image was
`node@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32`;
the native gateway binary SHA-256 was
`558950d5b3486b123fa491e3b3658e0578a009e0e804028ec77951e8477fced4`.

| Observed boundary | Result |
| --- | ---: |
| Candidate / sink / witness Linux UIDs | **10001 / 10002 / 10003** |
| Signed cases generated / executed / passed / filtered | **15 / 15 / 15 / 0** |
| Candidate attempts across real `SIGKILL` and retry | **17** |
| Independently witnessed signed sink decisions | **9** |
| Lost reply unknown / signed rejoin reconciliation | **1 / 1** |
| Cross-service private-file reads | **4 `EACCES`** |
| Wrong-UID witness / sink gateway closure | **1.553 / 1.344 ms**; both live sockets |
| Correct-UID gateway probes | both connected and remained open for 700 ms |
| Complete signed execution interval | **7.834 s; 1.915 final cases/s** |

The candidate's lost reply occurred after one signed sink commitment. It was
then killed with `SIGKILL`; a new candidate process refused to infer status
during the gateway outage and reconciled the exact signed decision after
rejoin. Linux `SO_PEERCRED` gateways checked the caller UID/GID before
forwarding and the upstream service UID after connecting. The witness head
remained at revision 0 through wrong-peer probes and advanced only when the
authorized sink effect committed. Service-owned state/key directories were
`0700`, private files `0600`, and another service's direct reads returned
`EACCES`. The repository mount and container root filesystems were read-only.

The [independent offline audit](verify.log) and repeat audit after
[copying the raw files](copied-verify.log) passed. Both audits rejected a
changed signed sink receipt and a changed witness revision. [Hashes](hashes.sha256)
and [hash verification](hash-check.log) bind the raw observations and logs.
[Build](build.log), [typecheck](typecheck.log) and [roadmap](roadmap.log)
passed on this source.

This is a **same-VM, root-controller** research profile. The root Docker
controller can inspect every container and volume, and candidate/sink hold
protocol-required copies of the witness transport HMAC key. Thus it does not
establish independently operated custody, cross-machine partitions, hostile
root containment or full T3-03/G1. The signed campaign's **1.915 cases/s** is
reported separately from D21's unchanged **2M/s R04 generator/evaluator**
target. The task count stays **20/62**.
