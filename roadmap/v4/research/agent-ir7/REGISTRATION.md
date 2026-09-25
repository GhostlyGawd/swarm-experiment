# AE7 token campaign registration

Freeze this plan before implementation measurements. The candidate is a
versioned, canonical AE1 exchange: a checked deterministic symbol-generation
seed replaces the cold symbol dictionary, provenance digests use canonical
decimal, and warm R7/E7 messages retain AE6's full base/result root checks.
The decoder must reconstruct the complete AE1 stream and exact GraphStore root;
an unavailable or incorrect seed must fail or use the explicit-identity mode.

## Corpus and comparable source boundary

Use these eight existing authored modules, in this order, from their unmodified
fixture builders at the pinned source: `buildLedgerExample()`; the four entries
of `projectionCorpus()` (`scalar-math`, `loop-contract`, `external-effect`,
`fixed-lazy`); and one entry each from `compositeProjectionCorpus()`,
`continuationProjectionCorpus()`, and `completionProjectionCorpus()`.
The known SymbolSpace seed for each is the literal seed in its builder. Include
all module members, contracts, symbol tables, effects, provenance and surfaces.
Do not omit a fixture because its token ratio is unfavorable. A native source
projection failure is reported as a coverage miss, not silently removed.

For each module compare a complete, unmodified TypeScript projection with the
complete AE7 cold wire. Pick the first `FunctionDecl` in member order whose
body contains a bigint literal; choose the first such literal in depth-first
child order. Construct one edit changing its value to value + 1, preserving all
other AST fields. In a seven-message JSONL transcript count the same system
instruction, complete cold context, user request, original declaration as a
failed attempt, tool feedback, changed declaration as a repair, and success
response on both sides. Baseline attempts contain complete TypeScript
declarations; candidate attempts contain checked R7/E7 wires. Count every
literal byte, seed, dictionary, role/purpose framing, setup, failed attempt,
repair and response. Use the exact `sessionWire` framing defined in
`bench/v4/tokens.ts`. Also report cold and changed-repair messages separately.

Count actual tokens with pinned `js-tiktoken@1.0.21` `cl100k_base` and
`o200k_base`, across all eight full sessions and individually. Retain raw
strings, source hashes, commit, lockfile hash and per-message counts. A second
verifier must recount the raw strings, check source hashes and exact roots,
and reject a tampered report. No model call or billed-token claim is made.

The unchanged density target is **at least 4.0× on both tokenizers** for the
aggregate cold and complete changed sessions. Report a miss if either misses.
This existing authored test corpus is broader than the single-ledger AE6
diagnostic but is not a representative production-codebase sample or V4-Q03
autonomous campaign. It cannot alone qualify FR-1.2 or close V4-T1-02.

## Transparent control amendment

After the first local preview, add a direct AE6 control with the same eight
fixtures and seven message positions. This does not change the preregistered
TypeScript versus AE7 4× verdict. The AE6 control uses its complete AE1 cold
wire and the same checked R6/E6 declarations. Report AE6-to-AE7 cold and
full-session savings separately as a development diagnostic.
