# Native worker measurement and witnessed active release checkpoint

Date: 2026-09-24. Specification: v4 `0.1.0`. Exact tested source commit: `085b587db62ec45ae73f20eede4dc59296b9ccb2` on `aether/v4-implementation`. Retained logs and raw-result hashes are in [hashes.sha256](hashes.sha256). T1-05/G1 and G2 remain open.

| Command | Result | Retained output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types` over six files below | **28 passed, 0 failed, 1 intentionally skipped child driver** | [focused.log](focused.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run build` | pass; emits V2 worker manifest | [build.log](build.log) |
| `npm run roadmap:v4:check` | 62 tasks, 71 obligations valid | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |
| `npm run worker:bundle:measure -- <raw file>` | five rebuilds; static native and JS closure; authenticated child pre-init refusal | [worker-raw.json](worker-raw.json), [worker-measure.log](worker-measure.log) |
| `npm run worker:bundle:verify` | current bundle and measured inputs match rebuilt V2 manifest | [worker-verify.log](worker-verify.log) |

Focused files: `test/tier4/macos-native-runtime.test.ts`, `test/tier4/process-worker-bundle.test.ts`, `test/tier4/process-virtual-artifact.test.ts`, `test/tier4/process-active-release-host.test.ts`, `test/tier4/process-checkpoint-active-release.test.ts`, and `test/tier4/process-semantic-retention.test.ts`.

The bundle is **752,830 bytes** (SHA-256 `eaa0a7f0911bf5a3e23c86b1331c5f7cbcdcc9beb23559a68a4d7c24ced559e2`) from **68 JS/TS inputs**. The native static-link profile measures **25 non-system libraries**, totaling **124,449,328 bytes**, across **95 links**, and retains macOS build plus dyld header/map identity. Five bundle builds took 1549.336, 1469.655, 1464.829, 2262.451 and 2273.184 ms; verification took 2180.382 ms. One authenticated pre-init child response took 41.099 ms. None is a v4 guest cold-boot or release latency measurement.

The opt-in V9 witnessed ProcessHost config `/15` commits a terminal checkpoint before releasing active-task role pins, keeps replay pins, and reconciles controller death before and after release. Tests refuse witness outage/rollback, forged receipt, changed marker and unqualified profile substitution. Earlier host/deployment evidence remains historical; this focused run does not qualify V13 signed-sink effects or every G2 lifecycle.

**Limits:** The Mach-O profile covers static non-system links only. A `libnode` dynamic-load site and raw macOS system-cache member bytes remain outside the measured subject. Artifact/3 does not yet require this V2 build manifest, and live ProcessHost/Deployment still reject its virtual-forward profile. There was no serial full-suite or release benchmark run on this commit. Prior release enforcement had 17 failed or unmeasured required targets; the tracker remains **20/62**.
