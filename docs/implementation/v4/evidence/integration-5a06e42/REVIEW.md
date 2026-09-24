# V10 nested-old and all-kind projection checkpoint

Exact tested source: `5a06e42e15a2f69d3e6da825d35167d6229b194d`, specification 0.1.0, clean `aether/v4-implementation` worktree for the full run. This is strong representative G1/G2 evidence for **in-progress T1-02**, not a gate-pass manifest or a 4× claim.

| Check | Result | Retained output |
| --- | --- | --- |
| `npm test` (includes build) | 875 tests, 874 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| Projection suite | 78/78 pass, including V10 and kind audit | [projection.log](projection.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | 62 tasks, 71 obligations valid; 20 tasks verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |
| Representative kind matrix | 12 modules, 45/45 AST kinds, 36 exact-root target bundles, no missing kinds | [kind-matrix.json](kind-matrix.json) |

V10 evaluates nested `ForAll` and `MatchResult` under `old(…)` with outer variables from pre-state and bound names local. A reference-runtime fixture mutates the outer inputs after entry; actual TS/Python/Rust output matches the reference. The five AST kinds absent from prior projection corpora (`Cond`, `ForAll`, `Surface`, `Un`, `Yield`) have an executing target-language fixture. Unbound type variables are explicitly refused. A detached pre-V10 `8ef1392` checkout and source `5a06e42` emitted byte-identical V9 local/imported declaration source, runtime and dependency hashes for all three targets: [before](v9-before.json), [after](v9-after.json).

The matrix gives one or more valid examples per AST kind; it does not prove all possible contexts. Some type-valid shapes, including pure calls inside contracts and bindings without an explicit block, still need review. More importantly, [PRD FR-1.2](../../../../PRD-v4.0.md) requires **≥4× token compression**. The existing comparable campaign measures only **0.483× cl100k / 0.489× o200k cold**. T1-02 and Q03 therefore remain unverified. Neither target nor baseline was weakened.

SHA-256 retained artifact digests:

```text
c340d69c6bedc8327624bb412f8bb37775e5b6c13560376c00159f66982d19e0  full-test.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc8b23864844a02f0548f3a892b61  roadmap.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
a2ed8aa4a1b0fa311d088f770ae22babfb8f6dfea5e92415115eb8ba50ac3ab5  projection.log
aec5630717f607ed0246009ccea5233dd571db3c3a01f8b70a6547bf0ed9a845  kind-matrix.json
98d74ba67b6c96790ba9fd29153c3bb2fef3eb38eb50e61aed8a065ec863b74c  v9-before.json
98d74ba67b6c96790ba9fd29153c3bb2fef3eb38eb50e61aed8a065ec863b74c  v9-after.json
```
