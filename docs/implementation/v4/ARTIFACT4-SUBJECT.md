# Artifact/4: measured process-worker closure

Artifact/4 is a versioned process-worker admission subject for the pure D16
virtual-forward rewrite. `ProcessChannel` admits it through explicit
`startVirtualV4` and worker `init/3`. Existing live ProcessDeployment and
ProcessHost paths do not accept or dispatch it.

## Signed binding

The candidate V3 evidence manifest sets `target.artifactDigest` to the
`aether.measured-executable-subject/2` digest. That subject contains the exact
`aether.process-worker-bundle/2` manifest. The digest is computed before the
candidate evidence or Artifact/4 envelope exists, so neither is an input to its
own hash. The worker bundle's closed input graph includes the shared proof
core, but excludes the Artifact/4 host validator and bundle producer. The
source V2 evidence remains rooted in its own executable identity. Candidate
evidence, archived wrapper, D16 descriptor, exact source/candidate Agent-IR,
and directly parented signed intents are checked at admission and in the child.

The V2 bundle manifest includes the worker entry and bundle bytes, resolved
JS/TS inputs, pinned esbuild/TypeScript files and recipes, Node binary,
external Node builtin names, and the macOS static Mach-O link closure. The
native closure includes non-system library bytes, static link edges, OS
identity, and dyld shared-cache header/map identities. The input count is
observed by the verifier, not accepted from the caller. Omitted inputs and
substituted manifests fail the fresh rebuild.

The host invokes the V2 producer in a fresh Node process. It rebuilds the
bundle twice, checks the closed import graph, and remeasures tool, input,
bundle, Node, and native identities. Esbuild and TypeScript are excluded from
the worker bundle. The host requires build-tool dependencies for this path;
separately packaged verifier tools remain future work. It refuses `DYLD_`
runtime overrides.

`assertProcessVirtualArtifactV4Launch` repeats full host admission and checks
the selected worker path and bytes once before spawn. The parent then rechecks
the signed proof and current measured bytes after spawn and before each call,
without rebuilding the graph again. The child opens operator-held signed
lineage independently and uses the same proof core to validate source,
candidate, descriptor, evidence, and direct ancestry before compiling the
candidate. It rehashes its launched bundle, Node, declared inputs, tool files,
static native libraries, and dyld-cache header/map. It does not execute a
recipe from the artifact. A real-worker test executes the candidate, imports
its snapshot after restart, and refuses tampered proof, trust, and bundle
bytes. Legacy Artifact/3 `init/2` remains supported.

## Boundaries still open

The child rehash cannot independently rebuild the input graph or resolve the
native static-link closure; those are parent admission responsibilities. The
static Mach-O closure does not cover `dlopen` outcomes, raw bytes of every
system dyld-cache member, or launch-time custody after the last measurement.
The checks before and after spawn reduce stale-file exposure but cannot prove
the bytes loaded by the OS at the intervening instant. Per-call rehashing is
also too expensive to qualify the v4 latency target; a separately measured
custody and fast-path profile is still needed.
There is no Artifact/4 ProcessHost deployment, effect-broker dispatch,
integrated checkpoint recovery, or signed GC promotion. A one-worker snapshot
restart does not prove ProcessHost recovery. This slice does not close
V4-T1-05 or a release target.

Focused branch verification: Artifact/4 tests 8/8 and Artifact/3 plus bundle
tests 13/13; `npm run typecheck`, `npm run build`, and
`npm run roadmap:v4:check` passed. An exact-source integration checkpoint is
still required after merge.
