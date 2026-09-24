# Executable projection V15: checked closure values in contracts

V15 extends the bounded V14 profile to two reference-valid contexts: a
capability-free function value passed as a parameter to a contract, and a
pure factory whose straight-line block binds scalar locals before returning
a lambda. An inline lambda stored in a local function variable is also
supported. Actual TypeScript, Python and Rust execute these forms with the
same precondition/postcondition outcomes as the reference runtime.

## Certificate and admission boundary

The projector derives a `cc15` certificate from the V15 profile identifier,
the complete immutable owner `FunctionDecl` root and the `Lambda` root. It
issues a certificate only for a closure with no capabilities, scalar
parameters/result, scalar visible captures and a body limited to checked
scalar expression kinds. The analysis follows lexical `Let` order, so a
lambda initializer does not capture its own unbound slot. Record, sequence,
function and task captures cannot receive this certificate. Direct calls in
the lambda body remain outside this bounded summary.

The native source contains the certificate at the visible lambda creation
site. The parser reconstructs the AST, independently recomputes the sorted
certificate set and rejects altered headers, certificates and scaffolding.
The matching native runtime embeds that same allowed set and retains the
identity of each closure issued through its checked constructor. Contract
`Apply` checks that identity and the current scalar capture/argument shape
before invoking the body. It also compares the retained body, metadata and
capture snapshot; actual TypeScript and Python tests mutate a certified
capture and observe refusal. Rust exposes no safe mutable access to the
shared certified closure after issuance. An ordinary host-created
`ae_lambda` value and a record-capturing Aether closure fail before their
bodies run. A visible
source edit changing the owner or lambda needs a newly generated bundle and
runtime; the fixture checks both an owner-only edit and a lambda edit.
Changing only the source text is refused.

This is a checked **native source** profile, not a hostile-host sandbox. The
source and runtime are trusted as a matched bundle. Same-process code that
can call the exported certificate constructor and reuse a known certificate
is outside this profile; ProcessHost/Artifact admission must provide a
separate custody boundary before a containment claim. The certificate is
not a user-provided `pure` assertion, a signed artifact by itself, or proof
that arbitrary external closures are safe.

## Evidence and remaining G1 work

The [V15 execution fixture](../../../../test/projection/contract-closure-values.test.ts)
compares reference results to actual TypeScript, Python and Rust. It covers
an exact returned lambda, a straight-line scalar local capture, a passed
function value, a local function binding, preconditions and postconditions,
an exact-address imported factory, edited-source regeneration, raw host
closure refusal and mutable capture
refusal. The [valid-context audit](../../../../test/projection/contract-context-audit.test.ts)
keeps three further reference-valid counterexamples visible:

| Source shape | Captures/body | V15 behavior |
| --- | --- | --- |
| Inline or direct-return factory | Scalar/literal | Native reference match, inherited V14 |
| Straight-line block factory | Scalar local | Native reference match |
| `If` factory with direct lambda returns | Scalar/literal in both arms | Native reference match |
| Function parameter from direct lambda | Scalar/literal | Native reference match with certificate |
| Function parameter from local binding | Scalar/literal | Native reference match with lexical certificate |
| Function parameter from a host-created closure | Unchecked body | Denied before callback |
| Function parameter from a record-capturing lambda | Mutable record | Denied before body |

| Context | Current V15 result | Next implementation proof |
| --- | --- | --- |
| Factory chooses between blocks that each bind a local before returning a lambda | Explicitly rejected | Path-sensitive local capture summary |
| Quantifier binder inside lambda body | Explicitly rejected | Binder-aware scalar closure proof |
| Passed lambda calls a direct pure helper | Round-trips, but receives no certificate and is refused at contract execution | Exact transitive helper-closure summary |

The profile does not close V4-T1-02/G1. Other valid cross-feature contexts
still require differential enumeration. G2's named arithmetic/effect target
fixtures remain available; this slice does not produce current V15 corpus
token costs. Historical AE6 warm-only results and failed cold/changed-session
ratios are unchanged. FR-1.2's ≥4× requirement and V4-Q03 remain open. The
tracker count must not change from this bounded slice.
