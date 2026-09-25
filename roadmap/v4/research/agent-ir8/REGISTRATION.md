# AE8 receiver graph-slice campaign registration

Freeze this corpus and accounting before measuring the new implementation.
Use the same eight authored modules and fixed seeds, in the same order, as the
AE7 registration: ledger, scalar-math, loop-contract, external-effect,
fixed-lazy, composite-alias-collections, continuation-capture-task and
scalar-five-kind-completion. Choose the first function with a bigint body
literal, then its first such literal in depth-first child order; change it by
+1 while retaining every other AST field. Do not remove unfavorable modules.

Compare TypeScript source and the AE8 graph-slice exchange in a **nine-message
JSONL session per module**:

1. identical system instructions;
2. complete TypeScript module versus complete AE7 graph load, including seed,
   symbol/provenance dictionaries and full root;
3. identical change request;
4. baseline named-declaration selection request versus AE8 root-bound selection;
5. complete TypeScript original declaration retrieval versus AE8 retrieved
   declaration slice, including member, contract and dependency commitments;
6. original declaration as a failed attempt versus checked AE8 reference;
7. identical failure feedback;
8. complete changed TypeScript declaration versus checked AE8 literal edit;
9. identical validation response.

Count every message on both sides: initial graph/source loading, selection,
retrieval, dictionary state, role/purpose framing, failed attempt, feedback,
repair and response. Retain raw strings and both actual pinned tokenizers
(`js-tiktoken@1.0.21`: `cl100k_base`, `o200k_base`). Verify the raw strings
independently against source hashes, exact AST/module roots and 4× totals.
Report per-module and aggregate cold, retrieval, edited declaration and full
session costs. Compare the complete session with the unchanged ≥4× target on
**both** vocabularies. A miss on either is a miss. No model call or billed-token
claim is made.

The receiver must load an exact complete module into GraphStore, reconstruct
the selected declaration and transitive local-call dependencies, check its
contract root and effect/capability summary, and refuse stale/missing base,
selected slice or imported dependency roots. The candidate response may alter
only one integer literal under AE6's contract-preserving rule. The slice
grammar must operate on arbitrary Term children (all 45 kinds), not silently
normalize or drop unsupported syntax. Native target projectors are unchanged.

This existing authored corpus is a source-comparable diagnostic and is not a
representative production codebase or autonomous Q03 campaign. Passing it
alone would not qualify FR-1.2/V4-T1-02; failure remains explicit.
