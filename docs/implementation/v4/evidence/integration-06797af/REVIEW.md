# Integrated v4 checkpoint — `06797af285212111e2190d99665f169b6f3f48fd`

The source tree was clean before this evidence directory was created. All checks below ran against that exact commit on `aether/v4-implementation`. This validates an implementation checkpoint, not full v4 completion.

| Check | Result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **766 tests, 765 pass, 1 skipped, 0 fail**; 295,624.171 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Both exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Opt-in FROST differential | Exit 0; 8 pass, including 200 pinned Rust public transcripts. [Log](frost-differential.log). |
| Ristretto research Rust tests | Exit 0; 8 pass. [Log](ristretto-tests.log). |
| New isolated signer, budget and effectful micro-world research | Exit 0; **19 tests pass**. [Log](research-tests.log). |
| `npm run bench:v4:enforce` | Exit 1; **17 required targets failed or unmeasured**. Its [manifest](benchmark-manifest.json) binds this commit with `workingTreeDirty: false`; [samples](benchmark-samples.json) and [log](bench-enforce.log) are retained. |

Fresh ProcessDeployment histories now default to `scoped-anchored-v4`. The signer key, repository and stable epoch-authority identity come from trusted deployment options outside the reloadable artifact factory. Deployment `/4`, prepared `/2`, effect-plan `/2` and host-config `/2` bind that anchor. An actual old-host reopen attack is retained in [research](../../../../../roadmap/v4/research/effect-signer-anchor/README.md); the new anchored path rejects replacement keys at reopen, candidate registration, promotion and effect dispatch. Earlier histories remain byte-preserved under explicit compatibility profiles. An external rollback-protected epoch source and a controlled signer-rotation ceremony are still required for production governance.

The separate [linear-budget experiment](../../../../../roadmap/v4/research/linear-budget-types/README.md) checks one fixed-charge Aether AST shape but is not production lowering. The [effectful micro-world campaign](../../../../../roadmap/v4/research/microworld-broker/README.md) finds and shrinks a duplicate-write fault through a real Aether runtime and broker, but does not qualify distributed throughput. The [SMT campaign 02](../../../../../roadmap/v4/research/smt-cutoff/README.md) is pinned to clean source `22a1374`, not this integration commit; its 30/30 local calls and 1,483.466 ms maximum remain research evidence, not a release admission.

The tracker remains **20 of 62 tasks verified**. T1-02, T1-05, T2-04, T2-06, T3-03 and T3-07 remain in progress; T2-05 remains planned until T2-04 closes. The release benchmark retains 17 open required targets. No additional task gate is claimed by this run alone.

SHA-256 digests of every retained raw log and artifact are in [hashes.json](hashes.json).
