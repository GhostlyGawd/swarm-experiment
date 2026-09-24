# Artifact/4: measured process-worker closure

Artifact/4 is a host-side admission subject for the pure D16 virtual-forward
rewrite. It is a separate version from Artifact/1–3. Existing live
ProcessDeployment and ProcessHost paths do not accept or dispatch it.

## Signed binding

The candidate V3 evidence manifest sets `target.artifactDigest` to the
`aether.measured-executable-subject/2` digest. That subject contains the exact
`aether.process-worker-bundle/2` manifest. The digest is computed before the
candidate evidence or Artifact/4 envelope exists, so neither is an input to its
own hash. The worker bundle's closed input graph does not include the Artifact/4
host validator. The source V2 evidence remains rooted in its own executable
identity; the candidate V3 evidence, archived wrapper declaration, D16
forwarding descriptor, exact source/candidate Agent-IR, and directly parented
signed intents are independently checked again on every Artifact/4 make and
decode.

The V2 bundle manifest includes the worker entry and bundle bytes, the 68
resolved JS/TS inputs, the pinned esbuild/TypeScript tool files and build
recipes, Node binary, external Node builtin names, and the macOS static Mach-O
link closure. The native closure includes non-system library bytes, static link
edges, operating-system identity, and dyld shared-cache header/map identities.
The current input count is observed by the verifier; it is not accepted as a
caller-supplied list. An omitted input or substituted manifest fails the fresh
rebuild.

The host validator invokes the independent V2 producer in a fresh Node
process. That producer rebuilds the bundle twice, checks the closed import
graph, and remeasures tool, input, bundle, Node, and native identities against
the embedded manifest. Esbuild and TypeScript are not imported into the worker
bundle. The host requires the build-tool dependencies for this admission path;
a production consumer with separately packaged verifier tools remains future
work. Current-byte checks run before the rebuild and reject changed bundle,
input, Node, or non-system library files. The validator refuses `DYLD_` runtime
overrides.

`assertProcessVirtualArtifactV4Launch` repeats full admission and requires the
selected worker path and bytes to match the signed bundle. A focused test then
launches that exact bundle in a separate process and receives an authenticated
pre-initialization refusal. The worker still only understands Artifact/3
`init-virtual`; the Artifact/4 test does not execute a candidate or grant live
deployment.

## Boundaries still open

The static Mach-O closure does not cover `dlopen` outcomes, raw bytes of every
system dyld-cache member, or launch-time custody after the last measurement.
There is no versioned Artifact/4 worker initialization, ProcessHost deployment,
effect-broker dispatch, checkpoint recovery, or signed GC promotion. This
artifact alone does not close V4-T1-05 or a release target.

Focused verification: `node --test --test-concurrency=1 --experimental-strip-types
test/tier4/process-virtual-artifact-v4.test.ts`; then `npm run typecheck`,
`npm run build`, and `npm run roadmap:v4:check`. The exact run and tested commit
are recorded by the integration checkpoint, not inferred from this document.
