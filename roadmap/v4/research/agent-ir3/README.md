# AE3 token-density candidate

This is an optional versioned codec research slice for V4-T1-02/Q03. It preserves the existing grouped AST hashes, original SymbolIds, node-reference strings, metadata, Unicode strings and dependency roots. Existing AE1 and AE2 encoders/readers are unchanged. No shared package barrel, runtime admission policy or production encoding default is changed.

## Mechanism and explicit costs

`agentIr3Snapshot(roots)` accepts an **ordered list** of AST roots, validates/snapshots them through the existing binary schema, and returns an immutable branded snapshot with its original root references. The codec does not discover imports or decide which dependencies belong in that list. The measurement supplies the exact entry and every dependency from the pinned V7 archive; import completeness and authorization remain responsibilities of their existing link/admission layers.

A full frame contains a version/mode header, a digest of the ordered original root references, complete opaque-identity tables, a root count, byte-length framing and every root's opcode stream. Symbols are packed at their existing fixed 110-bit width; AST-reference values use 256 bits. The table is written as canonical decimal integers, which ordinary tokenizer digit tokens encode more efficiently than random base32/hex spellings. Leading zero bits are preserved by the explicit counts and widths. IDs are never regenerated from fixture names or omitted. Source names, strings, types, capabilities and all AE1 dictionaries remain in the message.

One disposable AE1 dictionary context is shared across the roots **within a single message**. It is not shared for free across independent cold workloads. Free atoms are escaped; placeholder-like strings and delimiter/control characters round-trip without becoming identities or code. The original `AE3` research header retains ordinary AE1 opcode spellings. `AE3C` additionally uses ordinary decimal integer literals and a fixed set of unused one-letter opcode spellings for small symbol uses. The symbol-to-identity mapping remains in the paid dictionary. This is a small grammar extension, not an external token-codebook or opaque compression of executable bodies.

An edit frame includes **both the base and target digests**, root slots, exact flattened-AST-child paths and complete replacement subtrees, including their own dictionaries/identity tables. The initial full snapshot is charged in session totals. Decoding requires the exact immutable base and reconstructs a new snapshot; it never mutates the caller's prior state. Grouped optional children and paired labels are preserved. Redundant/noncanonical edits, stale bases, invalid paths, mismatched targets and trailing data reject. Large edit sets or a changed root count fall back to a complete frame; no edits are dropped.

The default encoder chooses the shortest UTF-8 byte representation among the supported full/edit and ordinary/compact spellings. It does **not** query a tokenizer or select a different representation after inspecting benchmark token scores. Both research spellings remain readable. Typical use:

```ts
const initial = agentIr3Snapshot([entry, ...dependencies]);
const wire = encodeAgentIr3(initial);
const peer = decodeAgentIr3(wire);
const changed = agentIr3Snapshot([editedEntry, ...editedDependencies]);
const update = encodeAgentIr3(changed, initial);
const nextPeer = decodeAgentIr3(update, peer);
```

The APIs are in `src/tier1/agent-ir-v3.ts`. `encodeAgentIr3` also accepts explicit `AE3` or `AE3C` spelling as its third argument for reproduction. Snapshots and digests are integrity/binding objects, not verification evidence, signatures or execution capabilities.

## Bounds and conformance

The candidate is deliberately bounded: 1 MiB per snapshot/message, 64 roots, 1,024 delta replacements, depth 64, 1,295 entries per identity/dictionary pool, 20,000 opcode tokens and a conservative one-million-unit field-work limit. Before the legacy reader is entered, a separate preflight checks type grammar/depth, dictionary widths/counts, integer tokens and aggregate field work. These limits can reject otherwise-valid larger AE1/AE2 inputs; they never silently truncate them. Message framing counts UTF-8 bytes and requires canonical complete consumption.

The test suite covers all 45 AST kinds, all 30 root messages and nine dependency messages from the full V7 campaign, both spelling variants, grouped-link edits, leading-zero identities, delimiter/alias collisions, large integers, Unicode line separators, empty surface choices and AE1/AE2 compatibility. Failure cases cover truncation, stale or forged bases, redundant edits, bad paths, mismatched digests, excessive field counts/type depth, proxy/accessor inputs, extra fields and large-edit fallback. Branded snapshots are deeply frozen and unchanged after refusals.

The counts measure complete **wire messages** under the actual pinned `js-tiktoken` cl100k/o200k tables. They are not a model reasoning or rewrite-quality evaluation. A model/tooling consumer must know the versioned grammar; any additional explanatory prompt in an application would add tokens. Decoder implementation code is not charged as message data, just as the existing AE1/AE2 language implementations are not. No representative-production or release-density qualification is claimed.

## Pinned campaign and retained misses

All attempts use the unchanged binary ASTs and raw source/messages from `projections/results/campaign-11-generics`. No corpus is regenerated, shortened or selected after observing scores. The report and artifact hashes pin that input. Each independent workload pays its cold dictionary; imported workloads include all original dependencies. Each session pays the initial full message and both edits, including base/target bindings.

| Attempt | Change | cl100k cold | o200k cold | cl100k session | o200k session |
| --- | --- | ---: | ---: | ---: | ---: |
| AE2 pinned baseline | Existing complete messages | 6,532 | 6,493 | 19,627 | 19,516 |
| 01 | Shared dictionaries, packed identities, explicit edits | 5,135 | 5,141 | 7,055 | 7,061 |
| 02 | Compact literal/variable spellings | 5,036 | 5,042 | 6,978 | 6,984 |
| 03 | Byte-based choice; final Unicode/bounds/fallback checks | **5,034** | **5,040** | **6,954** | **6,960** |

Final cold reductions versus AE2 are **22.93% / 22.38%**; complete-session reductions are **64.57% / 64.34%** (cl100k / o200k). Improvements are uneven: imported closures benefit most from paying a dictionary once, while short programs still spend much of their message on identity and framing data.

The unchanged legacy TypeScript review baseline is 3,247 / 3,272 cold and 9,741 / 9,816 session tokens. Therefore the final legacy-to-candidate ratios are **0.645× / 0.649× cold** and **1.401× / 1.410× session**. **Neither reaches the required 4×. T1-02/Q03 remain open.** Session gains do not substitute for a cold-message gate. The legacy review source is a diagnostic baseline and contains less identity metadata; that limitation is retained rather than used to relax the target.

Every attempt directory retains its preregistration, exact baseline artifacts/report, raw full/edit messages, source snapshots and actual counts. The auditor independently re-decodes the archived binary roots and both candidate message chains, checks original root identities, recounts baseline/candidate text and recomputes aggregates. Attempt 01 remains readable with the final decoder; attempts are never overwritten.

```sh
node --experimental-strip-types --test test/tier1/agent-ir-v3.test.ts test/tier1/agent-ir-v2.test.ts test/tier1/agent-ir.test.ts
node --experimental-strip-types roadmap/v4/research/agent-ir3/measure.mjs roadmap/v4/research/agent-ir3/results/NEW-ATTEMPT
node --experimental-strip-types roadmap/v4/research/agent-ir3/verify.mjs roadmap/v4/research/agent-ir3/results/attempt-03
```

Validation at handoff: 15 focused codec tests passed; project typecheck/build passed. The final attempt is a material improvement over AE2's measured messages, with the 4× and model-quality gates explicitly unclosed.
