# T1-04 exact-source acceptance audit

**V4-T1-04/G1 and G2 pass at `e71627bbb17764727bdbcd4d627d5162f0867b7e`, specification 0.1.0.** This conclusion covers the stated feature gates and bounded workload. It does not close production-scale storage or latency qualification.

The audit used a clean detached checkout. The T1-04 source, tests and research harness are unchanged between that commit and the main checkout's `8f4d9cd58c24a09e02be4bea5de2bc97e8a539a6` at audit start; `source-diff.log` is empty. The clean checkout passed **21 focused tests**, build and typecheck. No implementation or historical campaign files were edited for this audit.

A new actual-model campaign was run on the exact committed source, using the original preregistered corpus, labels, model and LSH settings. It therefore verifies the hardened source directly instead of attributing earlier dirty-source measurements to it. The original failed campaign01 and completed campaign02 remain intact. Both the historical and new completed campaigns passed the separate raw-evidence verifier.

## G1 — Compare recall with labeled data and exact search

**Pass.** The unchanged preregistration specifies 28 authored utility functions, 175 reachable AST inputs, 24 labeled natural-language queries and three repetitions per query. All newly exposed AST inputs are embedded before an index generation becomes visible. The comparison uses exact cosine ranking over eligible declared-pure FunctionDecl entries and explicit approximate LSH over the same eligible population. The query API is exported through the root and tier1 package entry points.

The actual local model is `Xenova/all-MiniLM-L6-v2`, pinned to revision `751bff37182d3f1213fa05d7196b954e230abad9`, using CPU ONNX inference, 384-dimensional attention-mask mean pooling, L2 normalization and a 256-token bound. Model initialization and every inference batch are recorded. Four inputs were truncated under the declared bound across backfill/update work.

The audit checked all 91,100,283 cached model/config/tokenizer bytes against the campaign manifest. It also independently fetched the [pinned repository metadata](https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2/revision/751bff37182d3f1213fa05d7196b954e230abad9?blobs=true) and verified every cached file against its Git blob or LFS identity. The ONNX weights are 90,387,606 bytes with SHA-256 `759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e`. The remote response and identity audit are retained locally.

| Quality measure | Exact | Explicit LSH |
| --- | ---: | ---: |
| Labeled recall@3 | 93.75% | 79.17% |
| Mean reciprocal rank within returned top three | 0.756944 | 0.652778 |
| Overlap recall against exact top three | 100% by definition | 75% |
| Typed-filter violations | 0 | 0 |

These values reproduced the earlier completed campaign; no model, label, threshold or LSH tuning was performed. The verifier independently reconstructs the exact rankings from each query's captured vector and the persisted float32 vectors. It also checks all **175 persisted backfill vectors against their exact initial raw inference inputs and outputs**, recomputes recall and timing summaries for all 72 query trials, and verifies artifact hashes and the eight admitted source snapshots.

The quality loss is substantial: LSH returns no candidates for some queries and misses labeled answers that exact search retrieves. Exact search also has labeled misses. All 72 queries at the illustrative cosine threshold 0.85 return zero hits. Consequently **exact search remains the default**, approximate mode is explicit, and the 0.85 threshold is not presented as calibrated for this model. G1 asks for an actual comparison; it does not specify a recall threshold that this audit could silently invent or relax.

## G2 — Staleness rejection and actual cost accounting

**Pass.** Focused tests verify:

- Node/context/model/input bindings, changed specification context, separate model-profile rebuilds, stale generation rejection and preservation of executable AST hashes.
- Automatic rejection of stale indexed-source query vectors, plus exact entry/input/vector binding when `expectedInput` is supplied. Independently embedded text queries use a separate input identity.
- Declared purity, type, capability, local nominal dependency and grouped parent/child filters, including shared-node parent edges. These predicates do not claim proof of transitive purity or external dependency resolution.
- Complete-generation publication, interrupted inference, concurrent stale-writer refusal, corrupt sidecars, finite float32 encoding, accessor/proxy/sparse-array rejection and finite subnormal/maximum normalization.
- Actual SIGKILL at three update boundaries and eight initialization boundaries, including termination immediately before the first head-file rename. Recovery preserves either the old complete generation or the new complete generation. Permanent completion receipts prevent established-head deletion or replayed initialization markers from resetting the index.

The new exact-source campaign measured the following on an Apple M4 Pro, 12 reported CPU cores, 24 GiB RAM, macOS/Darwin 25.6.0 arm64 and Node v26.7.0. Ambient load is retained; this was not a controlled production-load qualification.

| Measured boundary | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Warm exact vector-ready query | 1.186542 ms | 1.342417 ms | 1.816500 ms |
| Warm explicit-LSH vector-ready query | 1.053959 ms | 1.297834 ms | 1.456542 ms |
| Explicit-LSH full text query, including fresh embedding inference | 2.647000 ms | 3.025375 ms | 4.768875 ms |

All 72 trials, including the first, are retained. The fixed campaign’s full text-query stage explicitly selects LSH; exact vector-ready timings are measured separately. The first exact vector lookup was 1.816500 ms; the first explicit-LSH full text query was 2.982250 ms.

A separately preregistered supplemental audit measures the **public default exact text-query path**, omitting the `mode` option. It imports the same clean e71627b implementation, uses the same frozen 24 queries and three repetitions, and performs a fresh pinned local-model inference on every query. Median latency was **3.149792 ms**, p95 **4.490084 ms**, and maximum **14.684250 ms**. The maximum was the first query and is retained. All **72/72** exceeded 2 ms. Every result identified its mode as exact and reproduced the exact baseline rankings and 93.75% labeled recall. Provider instrumentation differs from the primary campaign, so these are separately labeled cost measurements, not a controlled head-to-head timing experiment.

The supplemental driver’s first bootstrap failed before any inference because its offline repository-ID lookup did not load the tokenizer configuration. Its source, preregistration and failure log remain in `*.failed01*` artifacts. Attempt2 used the same tested pinned cache/revision loader as the main campaign, without changing the model, labels, algorithm or count. All measured query samples belong to the fully retained successful attempt. `default-exact-aggregation-audit.json` independently verifies count, fresh-inference coverage, default mode, rankings and all timing summaries.

Other measured costs:

- Model initialization: 320.485792 ms with an existing pinned cache.
- New index-instance open and bucket reconstruction: 61.697750 ms; this does not mean cold disk/page caches.
- Backfill: 1,754.019708 ms for 175 newly embedded inputs.
- Symbol-context update: 1,732.908042 ms, recomputing all 175 embeddings and reusing none. The function's executable address was preserved, the scope root changed, and old generation/input identities were rejected.
- Persistent index files: 1,319,737 bytes, including retained generation artifacts and initialization/locking metadata. CAS files: 72,429 bytes. Downloaded model/config/tokenizer files: 91,100,283 bytes. These categories are not interchangeable.
- Final process RSS: 1,123,844,096 bytes, including the model/runtime and instrumentation; this is a final RSS observation, not a peak or guest-memory claim.

## Release limits remain open

**This audit does not pass a 2 ms release gate.** The explicit-LSH full text-query path exceeded 2 ms in **55 of 72 trials**, with a 4.768875 ms maximum. The public default exact text-query path exceeded 2 ms in **all 72 trials**, with a 14.684250 ms first/maximum observation. Historical campaign02 also retained an exact vector-ready maximum of 3.211708 ms and a full text-query maximum of 3.729167 ms; those observations are not replaced by this faster exact-vector sample.

The PRD's literal release NFR is **content-addressed AST hash retrieval at 100 million DAG nodes within 2 ms**. That is a different workload from semantic/vector/text search. This 175-input campaign neither measures nor qualifies the 100M-node hash-retrieval requirement, which remains unmeasured/unmet. The separate release target is not relabeled, weakened, or closed by the G1/G2 decision.

The implementation retains bounded profiles, historical generations and source leases; cold index open reconstructs in-memory LSH buckets. It does not establish 100M-node capacity, constant-time semantic retrieval, an ANN recall guarantee, production admission authority or calibrated similarity thresholds.

## Reproduction and evidence

Commands and artifact hashes are in `manifest.json`. `campaign-exact-e71627b/admission.json` records the clean exact commit, dependency lock, hardware and pre-run source hashes; `source-capture.json` supplies matching source bytes. The runner and corpus are the committed versions, and `sourceChangesDuringRun` is empty. `exact-campaign-audit.json` and `historical-campaign-audit.json` contain the independent raw-data checks. The gate record is `V4-T1-04.json`.
