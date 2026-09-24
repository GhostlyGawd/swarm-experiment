# Agent-IR density search state

Status: active, incomplete research. This file records a bounded experiment; it is not a completed invention-search review or a product gate.

## Problem and constraints

FR-1.2 requires at least 4× token compression. The fixed v4 benchmark also requires 4× on complete warm declaration messages per workload and aggregate. Cold modules, changed declarations, complete sessions, exact AST identity, receiver context and both pinned tokenizers must remain visible. A receiver cannot infer code from an uncharged hidden base. Historical wire formats must remain readable.

## Current causal account

The AE4 ten-workload audit measures 4,984 cl100k cold tokens against 3,247 legacy TypeScript tokens (0.651×), and 6,904 complete-session tokens against 9,741 (1.411×). Its cold cost decomposes into 319 header/digest, 1,349 identity table, 20 counts and 3,296 root payload tokens. This rules out a small opcode-only improvement as a credible route to a 4× cold result on that corpus. It is not an impossibility proof for other dictionaries or interfaces.

AE5R tests the narrower hypothesis that exact, unchanged declarations can be referenced after their complete base module has been paid and decoded. Four ledger warm messages reach 4.716× cl100k and 4.903× o200k. The cold and changed-session rows still miss. The protocol rejects changed declarations. See [measurement](results/warm-b799b38/report.json) and [readme](README.md).

## Search coverage and next tests

Reframes considered so far: message body compression, cross-message amortization, exact-root reference handles, and model/tool boundary accounting. Prior-art leads for further review include [Git pack deltas](https://git-scm.com/docs/pack-format), [incremental subtree edits](https://arxiv.org/abs/2101.12087), [grammar-based tree compression](https://arxiv.org/abs/1802.05490), and [Parquet dictionary encoding](https://parquet.apache.org/docs/file-format/data-pages/encodings/). These are analogies, not novelty or patentability claims.

The broader invention-search phases remain incomplete. Next, test an exact-root sparse AST edit on a changed declaration and count its base, schema/tool context, wire, outputs and repair attempts. Then test a paid motif dictionary or a scoped identity-handle interface against the unchanged cold and full-session corpora. Reject a candidate that silently moves bytes outside the counted model boundary or cannot reconstruct the exact AST in a fresh receiver.
