# Implementation specification changelog

## Capability deployment profile implementation — 2026-09-22

- ProcessDeployment now persists capability authority as `aether.process-deployment/3`. Fresh effectful deployments default to signed resource/adapter-artifact policy v2 with scoped grants; signed descriptor-only v3, unsigned scoped-v2 and legacy sealed authority require explicit profiles.
- The default artifact profile now also requires `aether.evidence-policy/2`: process-isolated v4 SMT checking is part of the approved execution manifest. V1 evidence/checker behavior remains available in explicit compatibility profiles.
- Existing v1/v2 records require an explicit adoption choice. The active factory and existing host configuration are checked before the record is rewritten, retaining old bytes on mismatch or crash.
- This implements the existing V4-T2-04 containment contract; acceptance gates and specification version 0.1.0 are unchanged. Signed adapter code admission and complete path coverage remain open.

## Target-profile decision — 2026-09-22

- The user selected fresh guest startup on an already-running hypervisor and guest resident memory for the unchanged 1 ms / 2 MB limits.
- Added `decisions/D07-native-qualification-profile.json` version 1.0.0. Historical measurements remain intact; controller startup and RSS are diagnostics. The current guest-startup maximum still misses 1 ms.
- This fills a previously open target-profile parameter; functional contracts and specification version 0.1.0 remain unchanged.

## 0.1.0 — 2026-09-22

- Established the implementation specification against code commit `3c3c8ebe63078f104f1ab7d8182b088124e9b1c6` and the preserved v4.0 PRD.
- Defined state preservation, canonical identities, effect/replay behavior, candidate replication, proof validation, promotion recovery and benchmark evidence contracts.
- Added a separate v4 dependency tracker covering all 40 functional requirements, 16 NFR obligations, three governance obligations and 12 KPI statements.
- Prioritized the state-loss repair and real-tokenizer benchmark correction in an eight-task first slice.
- Recorded four research gates for replication/quorum, native targets, certificates/ZK and numerical/learning interfaces.
- Kept runtime implementation tasks planned; existing v1 completion records are unchanged.
