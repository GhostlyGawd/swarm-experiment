# Bounded research verification

Subject: `749ce8bbf437af4d1ee424261f4165413036632a`, specification `0.1.0`.
The detached checkout was clean before and after these runs. Fifteen JavaScript research tests, two Python tests and typechecking passed. Fresh native, certificate, private-proof and learning experiments completed successfully as research commands. Their performance misses remain visible.

## Gate analysis

- **R01/G1:** D04 v0.2.0 selects exact rational fractional positions, operation-set tree projection with cycle suppression, three-phase HotStuff and an explicit epoch/key handoff. Ten tests cover concurrent moves, deleted parents, equivocation descendants, stale membership, quorum phases and partition recovery. The bounded model enumerated 5,040 delivery schedules, 128 merge partitions, 16 quorum pairs and 27 equivocation schedules. These are finite model results, not production cryptography or the 1,000-agent convergence gate.
- **R02/G1:** D07 and its user-approved qualification profile bind ABI, target, fallback and boot scope. Actual Clang/LLD artifacts ran on an Apple M4 Pro under Hypervisor.framework. All 1,345 native/reference cases passed. The fresh-process prototype's guest-start bracket had a 0.524 ms median and **5.401 ms maximum**. It does not qualify repeated fresh guests on a running controller. The 60-byte guest has a fully initialized 65,536-byte mapped allocation bounding its resident memory, within the approved guest-only 2,000,000-byte scope. Full runtime and driver footprint remains open. The 50 ns maximum remains inconclusive because of timer granularity and the limited workload. Raw samples and executable artifacts are retained under `native/`.
- **R03/G1:** D06 defines the exact-integer Farkas fragment, independent checker, extraction limits and private artifact statement. Fifty fresh certificate generation/checking samples are retained. The real Groth16 circuit constrains private u8 slope and offset over all 16 inputs, binds public execution context and rejects 14 altered/false claims. Fresh verification took **6.699, 5.457 and 5.946 ms**, missing 5 ms in all samples. The independent public verifier accepted the retained proof using the reviewed key hash `3156dd6b80c8686ae3d86aa11e1e77d229a0470e1ffb428bafe0b433c00bf115` and context hash `079f0110c4b746fa42a69f1ed308b3cad22fb794eee52cf9efad3d2af0f62f0e`. The single-party research setup is not a production ceremony; the statement is not arbitrary module/native attestation. Private witnesses and ceremony/proving files are excluded from this evidence bundle.
- **R04/G1:** D08 and the pinned experiment profile define numerical semantics, supported gradient paths and actual model/adapter operations. The fresh SmolLM2-135M run performed 12 LoRA steps over 210 training tokens, preserved the base tensor fingerprint and saved/reloaded a 62,287-byte adapter with zero maximum logit error. Tiny held-out mean loss changed from 4.39725 to 4.36396. Finite-difference maximum error was 0.00009751; all three held-out fuzzing fixtures reached their target in 41, 67 and 89 iterations. These fixtures do not establish useful autonomous code synthesis or broader model efficacy.
- **R04/G2:** The profile was committed before this experiment and its hash matches the report. It fixes 2,000,000 materialized/evaluated boundary inputs per second in every trial and at most 99 gradient iterations. Boundary rates were **448,327–465,671/sec**, failing the throughput target. The profile, raw samples, corpus, adapter and environment are retained without threshold changes.

## Reproduction and provenance

Use the subject checkout, pinned npm lock and the research setup instructions in D04/D06/D07/D08. Commands executed:

```sh
node --test --experimental-strip-types test/research/replication-model.test.ts test/research/native.test.ts test/research/proof-model.test.ts
npm run typecheck
node --experimental-strip-types roadmap/v4/research/replication-model.ts
node --experimental-strip-types roadmap/v4/research/native/run.ts --output .aether-store/evidence/research/native-clean
node --experimental-strip-types roadmap/v4/research/proof-benchmark.ts .aether-store/evidence/research/certificate-clean.json
node roadmap/v4/research/private-artifact.mjs /tmp/aether-r03-tools .aether-store/evidence/research/private-clean
/tmp/aether-r04-venv/bin/python roadmap/v4/research/learning/test_experiment.py
/tmp/aether-r04-venv/bin/python roadmap/v4/research/learning/experiment.py --model-record /tmp/aether-r04-model.json --output .aether-store/evidence/research/learning-clean
```

Setup paths refer to the locally pinned compiler, Python environment and immutable downloaded model record. Source hashes, native artifact hashes, profile hash, experiment script hash, adapter hash and circuit/tool-lock hashes were checked against the subject checkout. `manifest.json` inventories preserved evidence. Prior historical results remain in the source tree.

Native, ZK and learning experiments ran concurrently on the same machine. Their raw timing samples include possible contention. None is presented as a controlled full-release qualification campaign. Passing these research gates authorizes dependent implementation; all stronger functional and performance gates remain open.
