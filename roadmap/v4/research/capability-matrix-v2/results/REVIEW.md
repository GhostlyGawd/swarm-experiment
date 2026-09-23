# Campaign 1 review

- Exact measured source commit: `c07e4aa488045218d60b3e3dc9270f0d229d90d5`
- Runtime: Node `v26.7.0` on `darwin`
- Raw result: [campaign-01.json](campaign-01.json), SHA-256
  `44ae2a1cc135a8e4ac5be67603e4d9578f5bcdf67c0f826de0afcedd446c036f`
- Source status at measurement: clean worktree; all 134 pinned source paths matched
  their bytes in the source commit and stayed unchanged through the run.
- Independent verifier:
  `node roadmap/v4/research/capability-matrix-v2/verify.mjs --exact-source`
  returned `verified: 59`.

## Observed outcomes

The campaign ran 59 cases: 15 TopologyHost, 28 ProcessHost, and 16
ProcessDeployment. All 57 denial cases had zero additional sink calls and no
change to the authoritative heap digest. Two positive controls showed that
the guarded paths were reachable: a valid nested cross-process call committed
one broker sink action and changed heap state; a valid pure deployment call
changed heap state.

The ProcessHost effect-grant narrowing case passed the entry check and
returned a completed call receipt whose `execution.ok` was false with an
`authority_denied` fault. The broker made no sink call and the heap stayed
unchanged. Revocation at effect request, nested worker boundary, and final
publication produced indeterminate receipts without publishing heap state.
Those receipts remain visible for recovery; this campaign did not classify
them as safely completed or automatically retryable.

The verifier was challenged with six one-field report mutations: removing a
case, flipping a denial flag, adding a sink call, changing the heap digest,
changing a source hash, and replacing a raw authority result with
`completed`. It rejected all six. The original bytes were restored, and
exact-source verification passed again.

## Coverage limits and next actions

No authority leak or implementation bug was reproduced in these cases. This
campaign is research evidence, not V4-T2-04 gate completion.

- Deployment used the historical `scoped-v2` profile and a pure function.
  Its valid path reached real ProcessHost workers, but its cases did not run
  an external effect. The ProcessHost cases exercised a real DurableEffectBroker.
- The current process runtime rejects live closure/task transfer. Local
  closure/task continuation was exercised through TopologyHost only.
- The campaign did not exercise V5/V6 signed adapter profiles, an isolated
  Wasm adapter, simultaneous network partition, a revocation inside an
  adapter syscall, or the full distributed schedule space.
- The next T2-04 campaign should combine an independently signed policy,
  admitted adapter bytes, a concrete effect resource path, and worker death or
  revocation at the adapter handoff. Formal noninterference remains unproved.
