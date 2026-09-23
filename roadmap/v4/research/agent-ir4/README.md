# AE4 closed-bundle identity derivation probe

This is a bounded, opt-in research candidate for V4-T1-02 and V4-Q03. It changes no production codec, language default, corpus, threshold or admission policy.

## Mechanism

An AST import address is a content hash. If the complete cold message already contains the exact imported root, its address can be reconstructed from that root. AE4 replaces only those imported addresses with small root-position surrogates in the paid message. Its decoder restores each dependency in dependency order, computes the original `ast:b3` addresses with `GraphStore`, checks the complete original snapshot digest carried in the message, and rejects missing, cyclic, malformed or noncanonical bundles. The original opaque symbol identities, all root bodies, dependency order, shared AE1 dictionary, string values, executable syntax and digest remain in the wire. No external dictionary, fixture seed or free preloaded state is assumed.

AE4 is accepted only for a **closed bundle** in which every AST-address value refers to an included root. The measured candidate chooses AE4 only when its UTF-8 byte message is shorter than AE3's. Otherwise it uses the original AE3 complete message. Edits remain AE3's base-bound frames. This selection rule does not look at tokenizer scores.

## Pinned measurement

The source corpus is the unchanged V7 `projections/results/campaign-11-generics` archive. Ten independent workloads contribute 30 versioned root messages and nine dependency messages. Each cold message pays for the entry and all its dependencies; each complete session pays for the first full message and both edits. Both actual `js-tiktoken` tables were used. [Attempt 01](results/attempt-01/report.json) retains registration, original binary ASTs and baseline report, exact full/session wire text, source snapshots and independently audited counts.

| Tokenizer | Legacy TS cold | AE3 cold | AE4 candidate cold | Legacy / candidate cold | Candidate session | Legacy / candidate session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cl100k_base | 3,247 | 5,034 | **4,984** | **0.651×** | 6,904 | 1.411× |
| o200k_base | 3,272 | 5,040 | **4,990** | **0.656×** | 6,910 | 1.421× |

Six full messages, representing all three versions of the two imported workloads, selected AE4. Each first cold message saved 25 tokens with either tokenizer. All other cold messages stayed AE3. Both 4× gates **fail**. This improvement is 0.99% of AE3 cold tokens. It does not qualify representative production density or model editing quality.

Opaque symbols remain a major cost. The ten first versions contain 115 sorted symbol identities of 110 bits each. For arbitrary independent identifiers, even an ideal encoding of each sorted set needs about 12,341 bits. At the full cl100k vocabulary size, that is roughly 743 tokens before any code, names, contracts, framing, import identity or protocol guidance. This is a capacity calculation for the required identity space, **not** a proof about compressibility of these particular seeded fixture values or a replacement for measured counts. The 4× cold target would permit only 812 tokens across these ten workloads against the current legacy source baseline. Reaching it with complete random identities and model-readable semantics appears to require a different task/corpus comparison, identity-generation contract or model interface; none is changed here.

## Reproduction

```sh
node --experimental-strip-types --test roadmap/v4/research/agent-ir4/test.mjs
node --experimental-strip-types roadmap/v4/research/agent-ir4/verify.mjs roadmap/v4/research/agent-ir4/results/attempt-01
```

`measure.mjs` refuses to overwrite an existing attempt. To run another registered campaign, pass a new output directory. The retained verifier re-decodes original binary ASTs and candidate messages, recounts both tokenizers and checks the hashes of archived source snapshots. The separate negative tests also check both AE4 spellings over all imported versions, byte-exact term restoration, unshipped dependencies, an unvalidated snapshot, target substitution, truncation and trailing data.
