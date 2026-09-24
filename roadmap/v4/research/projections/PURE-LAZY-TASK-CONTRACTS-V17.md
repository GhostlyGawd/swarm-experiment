# Executable projection V17: direct pure lazy tasks in contracts

V17 admits `Await(Spawn(scalar-expression))` inside a checked contract
lambda. It closes the effect-free lazy-task case retained by V16 without
admitting an arbitrary `Task` parameter, an unjoined task value, or a task
that captures/returns a mutable object. The task body is limited to scalar
expression nodes without direct calls, nested task operations, closure
application or `Invoke`. The checker requires each `Spawn` occurrence to be
the direct child of its own `Await` occurrence, including when AST subtrees
are shared. The lambda itself remains capability-free with scalar captures.

The V17 `cc17` certificate binds the checked profile, complete owner
declaration root and exact lambda root; the task body is inside that root.
The parser rechecks the source/header certificate set and the matching
native runtime whitelist. Existing `ae_spawn` creates a pending task with
the closure's attenuated empty capability frame; `ae_await` executes its
body, binds its scalar result and retains the completed result under the
existing native task semantics. This V17 contract form creates and awaits a
fresh task in one expression. It does not claim checkpointable task state,
effect reconciliation or authority for a previously created task value.

The [actual target fixture](../../../../test/projection/contract-closure-values.test.ts)
compares TypeScript, Python and Rust to the reference runtime for inline
and passed-function lazy tasks, including a division-by-zero fault inside
the task that fails the contract before its body runs. It counts actual external-effect callbacks
and observes zero despite a host callback being present. Raw host closures,
record captures and edited certificate/source bytes remain refused. A
versioned [V16 compatibility fixture](../../../../test/projection/profile-v16-compat.test.ts)
pins source and runtime SHA-256 bytes in all three targets.

## Generated audit and limits

The V17 [fixed corpus](corpus-valid-contract-contexts.ts) crosses thirteen
body forms with five closure carriers. The [audit runner](audit-valid-contexts-v17.ts)
and [independent verifier](verify-valid-contexts-v17.ts) retain raw model
strings, actual tokenizer counts, exact roots and three target outcomes per
case. The 65 reference-valid cases produce 195 native classifications.
Two new valid Task contexts remain outside the bounded V17 profile:

| Context | V17 result | Missing proof |
| --- | --- | --- |
| Await a newly spawned task returning a fresh record, then read its field | Four carriers explicitly rejected; passed closure lacks a certificate | Task-result identity, allocation and ownership summary |
| Compare identities of two new tasks without awaiting them | Four carriers explicitly rejected; passed closure lacks a certificate | Unjoined task lifetime and equality/retention summary |

The precommit authored-corpus probe counts **7,780 / 27,233** legacy
TypeScript-review / AE2 model tokens with cl100k_base (**0.2857×**) and
**7,792 / 26,974** with o200k_base (**0.2889×**). The final exact-source
report supersedes this probe. This corpus is diagnostic; it is not a
representative changed-workload release campaign. FR-1.2's ≥4× requirement
and V4-Q03 remain unmet. G1 also remains open on the two Task contexts
and other unaudited AST combinations. No task count changes.

The native source and runtime are trusted as a matched bundle. Code with
same-process access to the exported certificate constructor can reuse a
known certificate; V17 does not establish hostile-host containment or a
signed ProcessHost/Artifact execution subject. The AE6 historical wire,
tokenizer corpus and thresholds are unchanged.
