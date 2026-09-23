# Integrated v4 checkpoint — `719f9d73fa3094aaf8307abf47ee7cdaa4b4998e`

The source tree was clean before this evidence directory was created. All checks below ran against that exact commit on `aether/v4-implementation`. This validates an implementation checkpoint, not full v4 completion.

| Check | Result |
| --- | --- |
| `npm ci` | Exit 0; lockfile install succeeds, npm reports zero known vulnerabilities. [Log](npm-ci.log). |
| `npm test` (includes build) | Exit 0; **774 tests, 773 pass, 1 skipped, 0 fail**; 296,298.871 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Both exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Opt-in FROST differential | Exit 0; 8 pass, including 200 pinned Rust public transcripts. [Log](frost-differential.log). |
| Ristretto research Rust tests | Exit 0; 8 pass. [Log](ristretto-tests.log). |
| Isolated signer, budget and effectful micro-world research | Exit 0; 19 tests pass. [Log](research-tests.log). |
| `npm run bench:v4:enforce` | Exit 1; **17 required targets failed or unmeasured**. Its [manifest](benchmark-manifest.json) binds this commit with `workingTreeDirty: false`; [samples](benchmark-samples.json) and [log](bench-enforce.log) are retained. |

Fresh ProcessDeployment histories now default to `scoped-anchored-v5`: an independently pinned signer, signed effect policy V3, and import-free adapter artifact V2. The loader parses the exact checked bytes before evaluation. Refused module imports produce no adapter or dependency top-level side effect in the focused tests. Deployment `/5`, prepared `/3`, effect-plan `/3` and host-config `/3` carry the new profile; the earlier anchored V4 and V1 artifact paths remain explicit, byte-preserved compatibility choices. See the [adapter profile](../../../../../roadmap/v4/research/adapter-artifacts/README.md).

An independent review found that a BrokerEffectRouter subclass could show the approved adapter identity and override `invoke()` to call an unapproved sink without a durable broker dispatch. The regression failed before repair and now passes. Signed V2/V3 hosts bind, inspect and invoke the base broker router through nonvirtual methods backed by JavaScript-private state. Trusted factory JavaScript, ambient Node privileges, external epoch rollback protection and signer rotation remain explicit open boundaries.

The tracker remains **20 of 62 tasks verified**. T1-02, T1-05, T2-04, T2-06, T3-03 and T3-07 remain in progress; T2-05 remains planned until T2-04 closes. The release benchmark retains 17 open required targets. No additional task gate is claimed by this run alone.

SHA-256 digests of every retained raw log and artifact are in [hashes.json](hashes.json).
