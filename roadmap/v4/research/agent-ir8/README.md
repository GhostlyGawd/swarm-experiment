# AE8 receiver graph-slice exchange: exact-source result

Implementation source: `6256c9e689cb5439474c4f88949d3d5a50112089`.
The [registration](REGISTRATION.md) fixed the eight authored modules and the
nine-message changed-session boundary before measurement. The
[report](results/source-6256c9e/report.json) and
[raw strings](results/source-6256c9e/samples.json) retain the complete source
load, selection, retrieval, failed attempt, repair, feedback and response on
both sides. Source hashes and the pinned `js-tiktoken@1.0.21` lockfile are
included. This is an offline deterministic transcript, not a model call.

| Boundary, eight modules | cl100k TypeScript / AE8 | Ratio | o200k TypeScript / AE8 | Ratio |
| --- | ---: | ---: | ---: | ---: |
| Complete cold graph/source load | 1,563 / 1,716 | 0.911× | 1,577 / 1,724 | 0.915× |
| Selection command | 25 / 248 | 0.101× | 25 / 248 | 0.101× |
| Retrieved declaration slice | 651 / 1,035 | 0.629× | 660 / 1,035 | 0.638× |
| Repaired declaration/edit | 651 / 554 | 1.175× | 660 / 554 | 1.191× |
| **All nine framed messages** | **5,333 / 5,272** | **1.012×** | **5,378 / 5,272** | **1.020×** |

The **unchanged ≥4× requirement fails** on both tokenizers. The selection
command pays a full base root; retrieval pays declaration, contract and
dependency commitments plus the declaration body. Framed cl100k selection is
121/344 and retrieval is 825/1,160. The smaller checked failed attempt
(817/352) and changed declaration (809/650) nearly cancel that overhead;
complete source loading remains slightly larger in AE8. Removing any of these
costs from the candidate side would misstate the full session.

AE8 loads the exact AE7 module into `GraphStore`, derives a selected function
and transitive local-call closure, and verifies declaration, contract,
dependency and effect commitments against stored roots. It reconstructs the
**complete** edited module with AE7/AE6's one-literal, contract-preserving
edit semantics. A stale base, altered retrieval, unselected response or
missing imported module is refused. The existing exhaustive 45-kind fixture
passes the AE8 slice path; the ledger repair executes with the same result.
This exchange changes no TypeScript, Python or Rust target projection semantics.

The next density experiment needs a genuinely shared repository graph across
many independent changes and a shorter, verified model-facing view. Both
TypeScript and Agent-IR sides must receive the same repository-cache and tool
retrieval opportunity, with initial graph loading counted once, all changed
sessions preregistered, and full retrieval/setup/retry costs retained. This
AE8 diagnostic uses authored modules and one edit per module. It does not
qualify a representative production corpus, autonomous Q03 behavior, or
V4-T1-02/FR-1.2 completion. It also selects top-level functions only; nested
declaration selection and broader edits remain outside this profile.

At the pinned clean source, independently verify the complete raw strings:

```sh
node --experimental-strip-types roadmap/v4/research/agent-ir8/verify.mjs roadmap/v4/research/agent-ir8/results/source-6256c9e
```

The verifier regenerates the registered fixtures, exact source projections,
selection/retrieval/edit wires and complete module roots, checks each framed
message and source hash, then recounts both tokenizer tables directly.
AE6/AE7/AE8 focused tests passed 14/14; typecheck, build and roadmap check
passed at the implementation source. The full release gate remains open.
