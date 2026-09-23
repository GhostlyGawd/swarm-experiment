# T1-04 bounded retrieval campaign

The runtime API is `HybridGraphIndex` plus `embeddingInputs`. The index stores canonical finite float32 embeddings and typed grouped-edge metadata in sidecars, preserving executable AST hashes. It publishes a generation only after every newly exposed input has an embedding. Existing graph nodes are explicitly backfilled. `intern` is the indexed creation path; directly calling the underlying CAS remains unindexed until backfill.

Profiles bind immutable model revision, artifact/tokenizer digests, runtime, dimensions, pooling, normalization, truncation policy and LSH parameters. A different model/profile requires a separate rebuild directory. Inputs additionally bind the exact node, scope root, symbol context, supplied specification context and versioned projection. Shared nodes in different contexts have distinct inputs. `backfill` atomically replaces the complete active scope set; queries explicitly supply the expected generation digest. Old generations and pinned source roots remain retained for audit.

Structural filters are exact predicates over **declared** AST metadata: kind, declared purity, return/type identities, capability declarations, local nominal type dependencies and grouped parent/child relations. They do not prove transitive purity or resolve unavailable external modules. Semantic results carry no admission authority. The native TypeScript query path needs no external vector database: deterministic Gaussian random-hyperplane LSH selects candidates, and exact cosine scores/ranks the structurally eligible candidates. Exact scan is the default; approximate LSH must be explicitly selected. This default was chosen after campaign02 demonstrated substantial recall loss for a small median latency saving. The historical campaign explicitly selected each mode, and its results are unchanged. Cold open rebuilds in-memory LSH buckets from validated durable vectors; storage metrics distinguish persistent files from process RSS.

## Fixed experiment

`preregistration-v1.json` was written before any model inference. `corpus.ts` fixes 28 authored AST utility functions, 24 labeled natural-language queries, three repetitions, and all scoring/measurement rules. Neither relevance labels nor the model/LSH configuration are tuned after viewing results. Full text-query measurements include fresh embedding inference and instrumentation. Vector-ready lookup time is recorded separately. First samples and misses are retained; no 100M-node or 2ms release qualification is implied.

Actual inference uses the Apache-2.0 [Xenova ONNX conversion](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9) of [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2). The [pinned model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2/blob/751bff37182d3f1213fa05d7196b954e230abad9/README.md) documents 384-dimensional mean-pooled normalized embeddings. The runner explicitly tokenizes to 256 tokens, invokes `AutoModel`, applies attention-mask mean pooling and L2 normalization, and retains tokenizer/model file checksums. The dependency package/version is pinned separately from the model.

Run from the repository root with isolated dependencies:

```sh
npm install --prefix /tmp/aether-t104-embedding-tools --save-exact @huggingface/transformers@4.3.0
node --experimental-strip-types roadmap/v4/research/retrieval/run-campaign.mjs /tmp/aether-t104-embedding-tools roadmap/v4/research/retrieval/results/NEW-UNUSED-DIRECTORY /tmp/aether-t104-model-cache
```

The runner refuses an existing output directory and checks the frozen corpus SHA-256 before inference. Each admission record pins current source hashes, Git state, dependencies and hardware. Runtime dependencies/model weights stay in the explicit external tool/cache directories. Results include raw embeddings/query outputs, model manifest, input/label records, actual durable index/CAS files and resource diagnostics.

## Retained attempts

- **campaign-01:** Actual pinned model initialization and full backfill completed. The first labeled query sequence failed when the native API attempted to canonicalize the fractional `minimumCosine: 0.85` threshold through an integer-only codec. Raw backfill/first query embeddings and the failure are retained. No completed labeled-query record was written, so this partial run supplies no aggregate recall claim. The fix uses explicit finite float64 threshold bytes at the query boundary; stored embeddings remain canonical float32. A regression exercises `0.85` in both vector and text queries. Later runners flush completed query stages before evaluating the threshold diagnostic.

Correctness tests use an explicitly synthetic provider to test identity, filters, crash recovery and encoding without downloads. They are separate from actual-model quality/performance evidence.

- **campaign-02:** Completed on 175 indexed AST inputs. Exact labeled recall@3 was **93.75%**; approximate LSH was **79.17%**, with **75%** overlap recall against exact top three. There were zero typed-filter violations. Some LSH queries returned no candidates; exact search also missed labeled answers. All 0.85-threshold queries returned no hits, so that illustrative PRD threshold is not calibrated for this model/corpus.

| Measured boundary | Median | Maximum |
| --- | ---: | ---: |
| Warm exact vector-ready lookup | 1.207 ms | 3.212 ms |
| Warm approximate LSH vector-ready lookup | 0.998 ms | 1.594 ms |
| Full text query, including fresh inference | 2.712 ms | 3.729 ms |

The 175-input backfill took 1,775 ms and a complete symbol-context rebuild took 1,727 ms, recomputing all 175 embeddings while preserving the renamed function's executable address. Cold index open took 62.308 ms. Persistent index files totaled 1,319,463 bytes; CAS files totaled 72,429 bytes; downloaded model files totaled 91,100,283 bytes. Final process RSS was 1,119,617,024 bytes, including model/runtime allocations and instrumentation. Full raw samples, first timings, labeled misses, truncation diagnostics and source hashes are retained. Exact admitted source bytes were captured after the run and verified against their pre-run SHA-256 values before any later API change.

The measured approximate quality loss is substantial: the small median lookup saving does not justify making it the default. Selecting LSH is an explicit approximation tradeoff; neither mode's small-corpus timings establish the release latency or corpus-scale targets.

## Review hardening after campaign02

The following API fixes were made after the captured campaign source; historical results and source snapshots remain unchanged:

- Vector normalization snapshots plain, dense finite component descriptors once and rejects proxy/accessor/sparse/extra-key arrays without evaluating getters. Scaling by maximum absolute component handles finite subnormal and maximum magnitudes. The final float32 encoding is validated before generation publication.
- Initialization writes a durable intent marker before profile/genesis publication, then a permanent completion receipt before clearing the marker. Recovery can finish interrupted empty initialization; established head deletion and replayed markers fail closed. Existing valid v1 indexes adopt the auxiliary receipt without rewriting their heads.
- `vectorFor` outputs carry indexed input provenance. Queries reject stale/substituted indexed-source vectors even when `expectedInput` is omitted. When supplied, `expectedInput` additionally binds the current entry ID, exact input digest and stored vector bytes. Independent text/analogy queries use their own query input identity and omit this indexed-source guard.
- The independent evidence verifier now binds every persisted backfill vector to its exact initial raw inference output and input-text hash. The recorded model outputs can differ by small float32 amounts across differently padded batches; the audit uses each query's actual captured vector rather than assuming bit-identical repeated inference.
