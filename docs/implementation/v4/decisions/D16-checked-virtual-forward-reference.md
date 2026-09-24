# D16 — Checked virtual forwarding in the reference runtime

Status: bounded implementation slice for V4-T1-05/G1, 2026-09-24. No semantic-GC promotion permission is added. T1-05/G1 and G2 remain open, and specification 0.1.0 thresholds are unchanged.

## Decision

An opt-in `aether.gc-virtual-forward-descriptor/1` binds one source module, one candidate module, an archived pure scalar tail forwarder, its target, and each exact rewritten `Call` site. The independent checker reconstructs the only admitted candidate: remove that wrapper declaration and redirect its source body call sites to the target without changing anything else. It recomputes AST roots, declaration and call-site references, site paths, the ordered event script and the descriptor digest. Unsupported dynamic calls, nonempty contracts, ambiguous shared candidate `Call` objects, and altered candidates fail closed.

`Runtime.load()` checks the descriptor against both modules, clones the checked ASTs and binds the candidate's actual `Call` objects. Only those sites execute a virtual wrapper frame. The runtime retains the source's call event, wrapper parameter binding, four ordered `Block`/`Return`/`Call`/`Var` ticks, target call depth, fault placement and wrapper return event. Other direct calls to the same target remain direct. The checked snapshot prevents later mutation of caller-owned AST objects from changing a loaded virtual call.

The retained source AST is execution material for this profile. Its root and descriptor must travel with the candidate and stay available for replay. A descriptor is not a promotion authorization; a governor, strict lineage and exact execution manifest are still necessary.

## Evidence and limits

The checked runtime test compares the source and candidate across three inputs and every `maxSteps` value from 1 through 64, including full traces, `onStep` inspection snapshots, faults, results and sink effects. A separate target-fault campaign compares budgets 1–32, and adversarial tests mutate descriptor fields, AST shape and call-object aliasing. These are bounded tests of the reference runtime and exact one-argument Int forwarder grammar.

The existing `SemanticGarbageCollector.assertFuelSafePromotion()` still rejects all newly collapsed-wrapper proposals. The current proposal format does not carry this descriptor or bind it to a candidate execution manifest. `ProductionRuntime` has no AST-step quota/trace model; the resumable machine has a different bytecode fuel, checkpoint and effect-identity model. Neither path consumes the descriptor. Agent-IR, ProcessHost, controller restart, wrapper chains, broader contracts and general values remain unqualified. Do not count this slice as T1-05/G1 or G2 acceptance.

## Next executable work

Add a versioned admitted artifact/profile that carries the checked descriptor through source and candidate manifests without weakening D14's promotion block. Specify resumable lowering with source-equivalent frame/instruction ordering and check checkpoint/replay identity at each virtual transition. Then test compiled and ProcessHost paths, signed promotion/recovery, effect and contract behavior, and G2 retention lifecycles before reopening the task count.
