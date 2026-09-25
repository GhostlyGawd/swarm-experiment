# Signed living campaign on macOS and Linux UID 10001

Clean source commit `76ea95c3127e006cc6badb0c6e67f1af6dab96bc`,
specification 0.1.0. The resident-pressure controller now reads kernel
`VmRSS` from `/proc/<pid>/status` on Linux and preserves the existing macOS
`ps` path. Both return KiB converted to bytes; the signed case, 64 MiB
page-touch protocol, 48 MiB minimum rise and independent controller/worker
checks are unchanged. The exact modified source file SHA-256 is
`39462372b5efdb8aa3d0536ef984ccc06113f5d6aa0105a72e4fd521e04460ec`.

| Environment and command scope | Result |
| --- | ---: |
| macOS host, full integrated `fixture.test.ts` | **7/7 pass** |
| Colima Linux VM, read-only repository mount, Node container UID:GID `10001:10001`, six selected integrated cases including resident pressure and forged-key refusal | **6/6 pass** |
| Same Linux UID, witnessed external-sink lost-reply/recovery test | **1/1 pass** |
| Host build, typecheck and v4 roadmap | pass |

The Linux runtime was Ubuntu 24.04.4 LTS arm64 under Docker Engine 29.5.2,
using `node@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32`.
The image reported Node v26.7.0. The six-case Linux command excluded only
the campaign CLI tamper-audit test because this minimal Node image lacks
Git; that audit passed on macOS. The repository mount was read-only, while
each worker used its container's temporary directory for signed journals.
[macOS](macos-tests.log), [Linux integrated](linux-integrated-tests.log),
[Linux external](linux-external-test.log), [build](build.log),
[typecheck](typecheck.log), [roadmap](roadmap.log), [hashes](hashes.sha256) and
[hash verification](hash-check.log) are retained.

The container and all its child services ran under the **same Linux UID**.
This proves that the signed campaign and kernel RSS reader work in a second OS
environment with a non-root process. It does not prove candidate/sink/witness
UID separation, independent operators, cross-machine partitions, real OS
allocation failure or full T3-03/G1. The [prior exact-source pressure
campaign](../t303-rss-497da3a/REVIEW.md) remains the quantitative macOS RSS
sample; this check does not replace it or the R04 2M/s generator evidence.
The tracker stays **20/62**.
