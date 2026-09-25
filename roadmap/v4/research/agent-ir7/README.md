# AE7 checked-seed exchange: exact-source result

Implementation source: `2a53bc24e63c8b8d076dfebbd768e25e3c2cce6c`.
The [registration](REGISTRATION.md) fixed eight existing authored modules,
one changed integer per module and complete seven-message transcripts before
the final measurement. The [report](results/source-2a53bc2/report.json) and
[raw strings](results/source-2a53bc2/samples.json) include all source hashes,
complete TypeScript projections, AE6 control messages, AE7 wires, seed/setup,
framing, failed attempts, repair and responses. No model was called.

| Actual-token boundary | cl100k TypeScript | AE6 control | AE7 | TypeScript / AE7 | o200k TypeScript | AE6 control | AE7 | TypeScript / AE7 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Eight complete cold modules | 1,563 | 2,228 | 1,716 | 0.911× | 1,577 | 2,219 | 1,724 | 0.915× |
| Eight complete seven-message sessions | 4,331 | 4,216 | 3,712 | 1.167× | 4,371 | 4,207 | 3,720 | 1.175× |
| Eight changed declarations alone | 651 | — | 554 | 1.175× | 660 | — | 554 | 1.191× |

AE7 lowers the AE6 cold total by 23.0% (cl100k) and 22.3% (o200k), and the
complete session total by 12.0% and 11.6%. The **unchanged 4× gate fails**
on both tokenizers at both cold and session boundaries. The tiny
`external-effect` fixture grows from 97 AE6 to 108 AE7 cl100k cold tokens;
the root and seed overhead outweigh its small symbol dictionary. That fixture
remains in the aggregate.

The cause is visible in the retained ledger wire. Its AE6 symbol-dictionary
line costs 305 cl100k tokens. AE7 regenerates the exact IDs from the paid
seed plus explicit generation indexes; that line costs 40. Decimal provenance
costs 56 rather than 79. AE7 also pays 29 tokens for a full 256-bit root and
6 for the seed line. Root checking prevents a changed seed from silently
changing every binding identity. The module, all contracts and all 45 AST
kinds round-trip exactly. R7/E7 retain AE6's full base and result root checks;
the executed ledger repair returns the same 5-unit result. Arbitrary modules
without a reconstructible seed use the explicit-identity mode, which is
lossless but may be larger. Native TS/Python/Rust projection behavior is not
changed by this exchange.

The next architectural path toward a genuine 4× changed-session result is a
task-conditioned semantic slice addressed into an exact receiver-side graph:
send only the edit-relevant closure and its commitments, then reconstruct and
validate the complete module at the receiver. A fair campaign must count
initial repository loading, slice selection, tool retrieval, dictionary state,
retries and complete responses on **both** sides, and include production-sized
codebases and independently selected change tasks. The present eight authored
fixtures establish a real savings against AE6 but do not qualify a
representative production corpus, an autonomous Q03 session, or V4-T1-02.

At the pinned clean source, rerun the independent raw-sample verifier:

```sh
node --experimental-strip-types roadmap/v4/research/agent-ir7/verify.mjs roadmap/v4/research/agent-ir7/results/source-2a53bc2
```

It reconstructs exact AE7/AE6 roots and source projections, checks every raw
JSONL message and source hash, and recounts both BPE vocabularies directly
from `js-tiktoken@1.0.21`. Changing one stored token count was rejected.
Focused AE1/AE6/AE7 tests passed 11/11; typecheck, build and roadmap check
passed at this source. These checks do not assert FR-1.2 or Q03 completion.
