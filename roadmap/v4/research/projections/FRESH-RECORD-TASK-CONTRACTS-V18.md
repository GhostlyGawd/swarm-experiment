# Executable projection V18: fresh record task results with immediate field read

V18 admits one reference-valid Task value form left by V17:
`Field(Await(Spawn(RecordLit)), scalar-field)`. The record must be created
inside the new task; its declared fields and initializer expressions are
scalar, and the awaited record must be consumed by that direct field read.
An arbitrary task parameter, record capture, standalone awaited record or
record identity comparison is outside this profile. This makes the fresh
record's identity and aliasing unavailable to the surrounding contract
expression. The native task still creates a pending value, executes the
record constructor at `Await`, validates the result type and returns the
selected scalar field.

The `cc18` certificate binds the V18 profile, exact owner declaration and
lambda AST roots. The record constructor, task body and field choice are
inside that checked lambda root. The parser recomputes certificates from
visible source and exact linked imports; the matched runtime checks its
whitelist before contract application. The V18 static checker rejects task
bodies that can invoke ambient effects/callbacks or create nested task state.
Named V17 producers retain their previous bytes, checked by a pinned
[source/runtime hash fixture](../../../../test/projection/profile-v17-compat.test.ts)
in TypeScript, Python and Rust.

The [actual target fixture](../../../../test/projection/contract-record-task-v18.test.ts)
compares direct and passed-function record tasks with the reference runtime
in all three targets, checks an intentionally failed precondition, exact
AST roots and stale certificate refusals, and observes zero external-effect
callbacks despite a host sink being present. It proves the bounded scalar
field outcome. It does not prove general record identity/alias parity after
a task result escapes, nor checkpointed/reused task state.

## Generated audit and remaining G1 contexts

The [V18 corpus](corpus-valid-contract-contexts.ts) crosses fifteen body
forms with five closure carriers. The [audit runner](audit-valid-contexts-v18.ts)
and [independent verifier](verify-valid-contexts-v18.ts) retain raw model
strings, actual tokenizer counts, exact roots and target classifications.
The 75 reference-valid cases produce 225 native outcomes. Three body forms
remain outside the bounded V18 Task profile:

| Context | V18 result | Missing proof |
| --- | --- | --- |
| Compare identities of two new tasks without awaiting | Four carriers reject; passed closure lacks a certificate | Unjoined task lifetime, identity and retention |
| Await a new task returning a sequence, then read its length | Four carriers reject; passed closure lacks a certificate | Sequence result identity/ownership summary |
| Compare records returned by two newly awaited tasks | Four carriers reject; passed closure lacks a certificate | Record result identity/alias parity across task completion |

The precommit authored-corpus probe counts **9,119 / 31,522** legacy
TypeScript-review / AE2 model tokens with cl100k_base (**0.2893×**) and
**9,137 / 31,217** with o200k_base (**0.2927×**). The final exact-source
report supersedes this probe. This corpus is diagnostic, not a representative
changed-workload release campaign. FR-1.2's ≥4× target and V4-Q03 remain
unmet. G1 remains open on the listed valid Task contexts and other unaudited
AST combinations; the verified task count does not change.

The native source and runtime are trusted as a matched bundle. Same-process
code with access to the exported certificate constructor can reuse a known
certificate; V18 does not establish hostile-host containment or a signed
ProcessHost/Artifact execution subject. AE6's historical wire, measured
corpus and thresholds are unchanged.
