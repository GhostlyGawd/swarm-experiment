# Process-worker executable closure experiment

Base source: `5caa40d` plus the task-owned bundle builder in this branch. Raw local results: [raw.json](raw.json).

## Reproduce

On a checkout with Node 26.7.0 and the lockfile dependencies installed:

```sh
npm ci
npm run build
npm run worker:bundle:verify
node --test --experimental-strip-types test/tier4/process-worker-bundle.test.ts
npm run worker:bundle:measure -- docs/implementation/v4/evidence/worker-bundle-5caa40d/raw.json
```

`npm run build` now emits `dist/process-worker.bundle.mjs` and its manifest. The measured executable is a single ESM file built with exactly pinned esbuild 0.28.2. The builder checks every esbuild input edge, rejects missing or unapproved external imports, and parses **every measured TS/JS source input and the emitted executable** to reject dynamic `import()` and `require()` syntax. It records the full resolved build input list, the Node binary file, selected native esbuild package/binary, esbuild API, TypeScript scanner, recipe, package manifest and lockfile. `ESBUILD_BINARY_PATH` overrides fail closed. `worker:bundle:verify` recompiles twice from current source and compares the full manifest and bundle bytes. The raw result records relative input paths and hashes for portability; the local build manifest records canonical absolute paths for file verification.

On this arm64 macOS host, the bundle is **577,721 bytes**, SHA-256 `b6d9bc76ff3ec4fb2450dd2d06c2265d7b8c5cd9fc52ff343425977fa1dcae01`, from **62** executable inputs. Its output imports only eight Node builtins. The resolved Node 26.7.0 binary file is **50,320 bytes**, SHA-256 `1ef99ea25fe70c9b67e7efe768ef8ee22148d3cabc703db6131b57aeb617d040`; this file measurement does not include shared system libraries. Five builder samples were 363.316, 272.453, 280.138, 309.491 and 279.012 ms. A fresh verification took 266.229 ms. Each builder sample includes two fresh compiles with graph and byte comparison. These are local tool costs, not release boot or memory measurements.

The real bundled child process accepted a private bootstrap and authenticated request, then returned the expected signed `worker is not initialized` response in 40.443 ms from spawn to response. EOF exited code 1. This establishes executable launch and initial protocol behavior, not successful worker initialization or host replay. Tests also reject altered bundle bytes, changed and omitted input hashes, missing import graph edges, a tree-shaken dynamic import, and an unapproved native binary override. Focused worker/admission/effect tests: **17/17 pass**. Typecheck, build and roadmap v4 check pass on this branch.

The adapter admission WeakMaps and identity accessors moved to a small static module, with the `adapter-artifact.ts` exports preserved. This removes the trusted dynamic JavaScript admission loader from the worker's source graph. Dynamic JavaScript admission remains a separate, explicit host path; this bundle does not execute it. Existing adapter admission tests passed after the extraction.

## Remaining integration gap

Artifact/3 still accepts a caller-supplied bundle path and source list. ProcessChannel and ProcessHost do not launch this measured bundle or compare its manifest to Artifact/3 before dispatch. The manifest is local build evidence, not an independently signed executable admission. No broker effect, checkpoint, crash recovery, or full T1-05 gate is established by this experiment. The next integration must bind the manifest to the artifact and the exact launched bytes, then exercise initialization, effects and replay across real processes.
