# Native runtime measurement for the bundled worker

Base source: `d4abb3d` plus the task-owned native probe in this branch. [Raw measurements](raw.json) retain every resolved static link, canonical file path, byte count and SHA-256. [Dynamic load probe](dynamic-load-probe.txt) records the remaining runtime load uncertainty.

## Reproduce

```sh
npm ci
npm run build
npm run worker:bundle:verify
node --test --experimental-strip-types test/tier4/macos-native-runtime.test.ts test/tier4/process-worker-bundle.test.ts
npm run worker:bundle:measure -- docs/implementation/v4/evidence/native-runtime-d4abb3d/raw.json
dyld_info -dlopens "$(node -p 'process.execPath')" /opt/homebrew/opt/node/lib/libnode.147.dylib
```

The `/2` worker manifest now distinguishes the JavaScript bundle closure from **macOS Mach-O static link closure**. It reads `otool -L` and `LC_RPATH` for the Node executable and each non-system dylib, resolves `@rpath`, `@loader_path`, `@executable_path` and absolute install names, and rejects missing or ambiguous resolution. It hashes every resolved non-system library and repeats those hashes after traversal. It also checks the Node binary against the bundle manifest, measures the `otool` probe before and after traversal, and rejects any `DYLD_*` environment override. Verification reconstructs the whole graph and compares it with the saved manifest. On other operating systems, the manifest explicitly records an unmeasured native runtime profile.

For system library install names under `/usr/lib` and `/System/Library`, the manifest records macOS product **26.7**, build **25G229**, Darwin kernel **25.6.0**, and the **573,440-byte** arm64e dyld shared-cache header SHA-256 `afb2af0c6b15a3da8d2fc70ecfb450b4c627de6ae410f186c47a7fe04b73ba59`. It also hashes the **1,337,844-byte** cache map (SHA-256 `dbbd6b7a4b6e946771cfff411f7d86947ff2cf61fc41516b59204583f80b0876`) and confirms that every recorded system install name appears there. These values identify this local system context; the profile does **not** hash raw system dylib code or all split shared-cache members.

On this host, the bundled worker at this exact source is **751,545 bytes** (SHA-256 `d501a784f3744402be82427f405d2ef1c6926050901c59c416c2126ae3418943`). The Node executable file is **50,320 bytes**; its static closure adds **25 non-system dylibs totaling 124,449,328 bytes**, including the **75,237,376-byte** `libnode.147.dylib`, through **95** resolved links. Six system install names are recorded by the OS/cache identity. These are installed file sizes, not guest resident memory. Five local build samples ranged from **1,552.719 to 2,331.242 ms**; a fresh verification took **2,280.100 ms**. Those costs include repeated compilation, file hashing and `otool` traversal.

The separate `dyld_info -dlopens` probe reports an **unknown `dlopen` site** in `libnode`. This measurement therefore proves only the static Mach-O link graph that `otool` exposes; it does not prove every library that Node might load later, all operating-system bytes, runtime library custody, or the worker's release memory/boot gates. Artifact/3 and ProcessHost still require their own launch and admission binding. This checkpoint does not close T1-05.

Focused native and bundle tests cover real transitive links, `@rpath` resolution, missing/ambiguous libraries, changed file hashes, tampered native-library and cache identity rows, and a `DYLD_*` override: **5/5 pass**. Build, typecheck, bundle verification and roadmap checks pass on this branch. A full serial suite and release-profile benchmark are outside this focused evidence.
