# D05 — Independent certificates and private module attestation

Status: research decision with executable prototypes; production integration belongs to V4-T2-10 and V4-T2-09. Date: 2026-09-22. Owner: V4-R03. This decision preserves all v4 requirements.

## Decision

Use an explicit, versioned LF-style judgment `holds(assumption_environment, goal)` with a small whitelist of independently checked inference rules. Start T2-10 with exact integer linear arithmetic and a propositional/Hoare composition layer. Proof search, solver heuristics and proof generation remain outside the trusted kernel. The checker must reconstruct the goal and its assumption environment from the admitted AST, specification and pinned dependency closure; accepting a proof of an arbitrary formula merely carrying an AST hash is insufficient.

Use a fixed public checker program to verify a complete private certificate bundle for module attestation. The eventual ZK execution proves that this checker accepted that bundle, with commitments to the private artifact and the exact target. It must not merely execute the private module on a convenient input. The intended general backend is a pinned RISC Zero checker guest with its receipt/image identity and recursion policy; the concrete research pilot uses an explicit Circom/Groth16 circuit for a bounded private artifact. The guest, target loader and full certificate derivation are subsequent implementation work.

No portable certificate or private proof is admitted through F06's local-report path. F06 retains its distinction between locally trusted solver evidence, reverified peer reports and the future independent kernel.

## Certificate calculus and extraction

The research implementation is [proof-model.ts](../../../../roadmap/v4/research/proof-model.ts). It proves an integer linear implication by refuting the assumptions together with the integer complement of the goal. For a goal `a·x <= b`, that complement is `-a·x <= -b-1`; this conversion applies to integer variables, not real variables.

A certificate contains one nonnegative integer multiplier per premise. The checker multiplies and sums each coefficient and bound using bounded `bigint` arithmetic, then requires all variable coefficients to cancel and the resulting bound to be negative. This establishes an impossible inequality `0 <= negative`. No solver is invoked by the checker. A Fourier–Motzkin producer retains its multiplier vector during elimination; failure to find a certificate returns unknown. It is incomplete for general integer arithmetic.

The fixture derives `x <= 7` from `x+y <= 10`, `x >= 4`, and `y >= 3`. Its extracted multipliers are `[1,0,1,1]`, including the negated goal. Tests reject negative multipliers, all-zero fake proofs, added trust rules, changed subjects, excessive integer sizes and the false strengthened claim `x <= 6`. Another fixture uses exact 90-digit integers. The bounds are 16 variables, 128 premises, 256 decimal digits, 4,096 elimination rows, 50,000 elimination combinations, and a 256 KiB encoded certificate/claim limit.

This arithmetic rule is consistent with the explicit positive-scaling and sum-of-upper-bounds rules documented by cvc5. Production extraction can translate recognized solver arithmetic steps into this kernel while preserving exact rational/integer arithmetic and every premise. Unrecognized rules produce unsupported results. [cvc5 proof rules](https://cvc5.github.io/docs/latest/api/java/io/github/cvc5/ProofRule.html)

cvc5 can emit LFSC proofs, but its documentation explicitly identifies outputs containing unjustified trust steps. Therefore an LFSC file passing a permissive signature is not automatically acceptable. Pin the checker and signature digests, reject every `trust` or unrecognized rule, and reconstruct rewrites through checked rules. The prototype's closed rule set has no trust operation. Full LFSC parsing and cvc5 extraction are not implemented here. [cvc5 LFSC documentation](https://cvc5.github.io/docs/cvc5-1.3.4/proofs/output_lfsc.html)

T2-10 must next add structural rules, checked substitutions, propositional case coverage, induction/termination obligations, frame/separation rules, and independent AST-to-obligation derivation. Existing F06 regressions demonstrate that nested record aliasing can invalidate the old verifier's conclusions; wrapping those conclusions in a certificate would preserve the bug. Until a semantic fragment is independently covered, its portable result remains unsupported. A complete bundle must enumerate every required obligation, not merely every certificate the producer happened to supply.

## Exact private statement

For public statement `S` and private witness `W`, the intended relation is:

```text
W = artifact bytes, fresh commitment randomness, private typed AST,
    lowering evidence (or explicitly declared compiler TCB),
    complete certificates for every derived obligation

S = salted artifact commitment, specification root, dependency closure,
    language semantics, target profile/ABI, compiler identity,
    effect policy, obligation-set digest, checker image/key identity,
    bounds profile, application nonce and policy epoch

Check(S,W):
  validate canonical schemas and bounds;
  recompute artifact commitment and every identity;
  establish AST/artifact/lowering correspondence for this target;
  derive the complete obligations from the AST/spec/closure/policy;
  independently check exactly one valid result per required obligation;
  reject any trust step, undeclared assumption, missing frame check,
    exhausted budget, unsupported rule or unsatisfied target binding;
  expose only the approved public statement and acceptance bit.
```

The quantifier is determined by the derived obligations and the explicit semantic profile. An inductive safety certificate can cover all executions admitted by its semantics and environmental assumptions. Exhaustive constraints over a stated finite input/state domain establish that bounded property. A receipt for one module execution establishes only that execution. These statements are not interchangeable.

The public checker image/key must be allowlisted independently of the proof. A prover-supplied verification key for a different program is not authority. Deployment must load bytes whose commitment matches the admitted artifact, bind the loaded target/ABI/compiler policy, and enforce the capability/effect assumptions used by the proof. A language-level proof does not establish native compiler correctness. Private witnesses are available to the local prover and authorized target loader; they are not sent to an external proving service by this workflow.

RISC Zero receipts bind a guest image and its journal. Its documented security model separates the execution prover, recursion prover and optional STARK-to-Groth16 compression. It also documents privacy qualifications and execution-length leakage before recursion. Pin those component identities and security assumptions, disallow development/fake receipts, and qualify the actual chosen privacy pipeline before T2-09 acceptance. This research has not implemented or validated a RISC Zero guest. [Receipts](https://dev.risczero.com/api/zkvm/receipts), [security model](https://dev.risczero.com/api/security-model)

## Actual private artifact prototype

[private-artifact.circom](../../../../roadmap/v4/research/private-artifact.circom) proves the following bounded universal assertion:

```text
There exist private u8 coefficients slope and offset and private salt such that
  Poseidon(slope, offset, salt, publicContext) = artifactCommitment
and, for every integer x in [0,15],
  0 <= slope*x + offset <= 255.
```

The artifact is exactly the two coefficients of a fixed affine program interpreted by the public circuit. Sixteen explicitly constrained outputs cover the entire declared input domain. This is an actual private artifact assertion, not an arbitrary native/AST module proof. The sample uses a safe affine artifact and separately rejects an unsafe artifact even after recomputing its valid commitment. No secret coefficients, salt or witness are included in the delivered public proof record.

Ten public 128-bit limbs encode five complete 256-bit context identities: specification, target interpreter, compiler profile, pure-effect policy and bounded-domain profile. These descriptors include hashes of the actual circuit, R1CS, compiler executable, library circuits and pinned npm lock. The commitment includes every limb. Circuit key pinning establishes the actual public checker, while these inputs bind its approved application context. The circuit uses `Num2Bits` constraints for integer ranges and constrained Poseidon equality. All relevant arithmetic stays below the field modulus; the property cannot be obtained through modular wraparound. Circom distinguishes R1CS constraints from witness-only assertions, so the prototype uses `<==` and `===`, not a witness-only `assert`. [Constraint generation](https://docs.circom.io/circom-language/constraint-generation/), [assertion behavior](https://docs.circom.io/circom-language/code-quality/code-assertion/)

[private-artifact.mjs](../../../../roadmap/v4/research/private-artifact.mjs) compiles the circuit, generates and verifies local setup material, generates three real Groth16 proofs, verifies them, alters every public input individually, corrupts a proof, attempts the unsafe artifact, and corrupts a witness before checking its R1CS constraints. The public result includes the proof, verification key, tool identities, source hashes, raw timings and every negative check.

Groth16 supplies a zero-knowledge arithmetic-circuit argument under its pairing-based assumptions. The snarkjs implementation provides Groth16 proving/checking and the two setup phases used here. The local one-party research ceremony is not a production ceremony; T2-09 must supply an approved setup, transcript/key validation, independent contributions and an explicit toxic-waste assumption if using this backend. The pilot's BN254/Groth16 route is not claimed quantum-safe. A fresh random commitment salt prevents revealing this small private artifact through a simple unblinded hash dictionary. [Groth's paper](https://eprint.iacr.org/2016/260), [snarkjs](https://github.com/iden3/snarkjs)

## Evidence and reproduction

The certificate prototype has three tests in [proof-model.test.ts](../../../../test/research/proof-model.test.ts). Fifty measured samples and source identity are in [proof-model-results.json](../../../../roadmap/v4/research/proof-model-results.json). Median generation/check times were 0.114/0.056 ms, and its certificate was 287 JSON bytes. [proof-benchmark.ts](../../../../roadmap/v4/research/proof-benchmark.ts) reproduces the measurement. These are fixture measurements, not a general proof SLA.

The private proof's final measured results and public proof/key are in [private-artifact-results.json](../../../../roadmap/v4/research/private-artifact-results.json). Generation took 231.06, 119.77 and 119.75 ms; checking took 6.84, 5.85 and 5.38 ms. **All three checks miss the source's 5 ms verification target.** Setup, compilation and transcript checks totaled 18.69 seconds and are recorded separately. The circuit has 3,274 constraints, 11 public inputs and three private inputs. Fourteen negative checks cover every public input, invalid proof, unsafe committed artifact and invalid witness. These measurements establish the bounded research gate; they do not establish full T2-09 or the release performance gates.

An independent consumer process also verified the recorded proof using [verify-private-artifact.mjs](../../../../roadmap/v4/research/verify-private-artifact.mjs), without the private witness, proving key or compiler. It requires externally pinned key and context digests rather than trusting those supplied by the proof. The recorded research key SHA-256 is `04334a302f3ab0d49a84b6b9797a83dab1bae66f3ce3faa1d0b2dedfafe5d297`; the public context descriptor SHA-256 is `079f0110c4b746fa42a69f1ed308b3cad22fb794eee52cf9efad3d2af0f62f0e`.

Tools are isolated from the project dependency graph: official Circom 2.2.3 at tag commit `ad44e915`, snarkjs 0.7.6, circomlib 2.0.5 and circomlibjs 0.1.7. The npm resolution and integrity hashes for all 96 packages are retained in [proof-tools-lock.json](../../../../roadmap/v4/research/proof-tools-lock.json), alongside [proof-tools-package.json](../../../../roadmap/v4/research/proof-tools-package.json). The Circom build follows the [official tagged source](https://github.com/iden3/circom/releases/tag/v2.2.3). No new runtime dependency, paid resource or external prover is required for these prototypes.

```sh
node --test --experimental-strip-types test/research/proof-model.test.ts
node --experimental-strip-types roadmap/v4/research/proof-benchmark.ts

# Set TOOL_ROOT and OUTPUT_DIR to separate temporary directories.
mkdir -p "$TOOL_ROOT" "$OUTPUT_DIR"
cp roadmap/v4/research/proof-tools-package.json "$TOOL_ROOT/package.json"
cp roadmap/v4/research/proof-tools-lock.json "$TOOL_ROOT/package-lock.json"
(cd "$TOOL_ROOT" && npm ci --ignore-scripts --no-audit --no-fund)
cargo install --git https://github.com/iden3/circom.git --tag v2.2.3 --locked --root "$TOOL_ROOT/circom"
node roadmap/v4/research/private-artifact.mjs "$TOOL_ROOT" "$OUTPUT_DIR"
node roadmap/v4/research/verify-private-artifact.mjs "$TOOL_ROOT" \
  roadmap/v4/research/private-artifact-results.json \
  04334a302f3ab0d49a84b6b9797a83dab1bae66f3ce3faa1d0b2dedfafe5d297 \
  079f0110c4b746fa42a69f1ed308b3cad22fb794eee52cf9efad3d2af0f62f0e
```

Fresh setup randomness and proof randomness change keys and proof bytes on rerun; correctness checks and the circuit/source identities remain reproducible. The checked-in key is only the public verifier key for the recorded research run. It is not an approved production key.
