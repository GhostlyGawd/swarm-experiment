# D08 — Numerical semantics and bounded learning experiments

Decision version **0.1.0**, specification **0.1.0**, owner **V4-R04**, recorded **2026-09-22**. This decision guides T1-07, T3-06 and T3-11. It does not implement their production integrations or close their performance targets.

## Decisions and scope

Keep the existing exact integer language semantics unchanged. Introduce floating-point tensors through a separately versioned numerical interface, with dtype, shape, layout, operation semantics and backend/compiler identity bound into an execution profile. The first differentiable subset is pure, bounded arithmetic over finite `float32` values, fixed-size tensors and a finite list of shape-compatible pure AST candidates. It includes addition, subtraction, multiplication, finite nonzero-denominator division, reductions, softmax and branch-distance losses with a documented subgradient convention. Reject nonfinite inputs, outputs, gradients and parameter updates. No opaque host callback or unrecorded effect belongs in that subset.

Use Gumbel-Softmax to obtain gradients over candidate selection, then select a discrete AST and execute it under the ordinary integer/type/verification semantics before admission. The original estimator replaces a discrete sample with a differentiable distribution controlled by temperature; this does not make discrete program execution mathematically continuous. [Jang, Gu and Poole, primary paper](https://arxiv.org/abs/1611.01144).

For model adaptation, freeze the base transformer and train module-specific low-rank matrices, with `scale = alpha/rank`. This follows the original LoRA method; its reported large-model results do not establish Aether's token or synthesis targets. [Hu et al., primary LoRA paper](https://arxiv.org/abs/2106.09685).

The gradient-directed fuzzing baseline directly differentiates an explicitly supported scalar guard loss. Arbitrary programs require a separately trained surrogate or a supported differentiable lowering. Neural program smoothing is a research approach to approximating branch behavior, not a guarantee that real programs have useful gradients. [NEUZZ authors' paper and resources](https://www.cs.columbia.edu/~junfeng/papers/neuzz/). Comparative follow-up research found substantial limitations in prior performance claims, so Aether must retain matched random/coverage-guided baselines and all training overhead in later qualification. [Nicolae, Eisele and Zeller, primary evaluation](https://arxiv.org/abs/2309.16618).

## Numerical and gradient boundary

| Concern | Required contract |
|---|---|
| Executable integer values | Preserve arbitrary-precision v1 semantics. Never route bigint through a floating-point tensor silently. |
| Numerical transport | A new `aether.numeric/1` payload carries dtype, dimensions and canonical fixed-width tensor bytes; hashes bind raw bits. Float values are not added as JSON numbers to C1 tagged integers. |
| Casting | Integer-to-f32 lifting requires an exact representability check or an explicitly declared lossy conversion. The prototype's integer domain is `[-128,127]`, which is exactly representable. |
| Precision | MLX experiment uses float32 arithmetic/gradients and the model's loaded pretrained parameter dtype. No universal bitwise equality is promised across backends. Admission binds backend/version and a declared tolerance/conformance campaign. |
| Signed zero and nonfinite values | Preserve signed-zero bits in numerical identity. Reject NaN/Infinity at research/adapter entry and before accepting a candidate or update; do not hide them through clipping into a passing loss. |
| Nondifferentiable points | `abs` uses the backend's stated zero subgradient at equality. Integer rounding and discrete guards remain concrete checks outside the backward path. |
| Gumbel noise | Record seed, distribution, temperature and sampled execution context. The experiment clamps uniform samples to `[1e-6,1-1e-6]` before logarithms and checks finite gradients. |
| Unsupported operations | Hashes, bitwise parser behavior, arbitrary loops, heap aliasing, task schedules, remote effects and string operations require another search method or an explicit surrogate. They cannot receive invented gradients. |
| Runtime metrics | Wall-clock latency and memory churn are observed metrics. A learned differentiable predictor can guide search, but its gradient is a surrogate. Final candidates require concrete measurements; this experiment measures no gradient of physical wall-clock time. |

## Adapter interface for T1-07

The production API must expose capabilities rather than pretending all model providers can install or train arbitrary tensors:

```ts
interface ModelAdapterCapabilitiesV1 {
  inference: boolean;
  localWeights: boolean;
  differentiableTraining: boolean;
  loadAdapter: boolean;
  saveAdapter: boolean;
  deterministicSeed: boolean;
  supportedDtypes: readonly string[];
}
interface AdapterSubjectV1 {
  moduleRoot: string;
  baseModelDigest: string;
  tokenizerDigest: string;
  architectureVersion: string;
  numericProfileDigest: string;
  trainingCorpusDigest: string;
  acceptedPatchFrontier: string;
  optimizerConfigDigest: string;
  rank: number;
  alpha: number;
  targetLayers: readonly string[];
}
// All handles are content-bound references; unsupported operations fail explicitly.
// loadBase(subject) -> ModelHandle
// trainAdapter(base, verifiedExamples, budget, seed) -> AdapterArtifact + RunEvidence
// saveAdapter(artifact) -> Digest
// loadAdapter(base, artifact, expectedSubject) -> AdaptedModelHandle
// evaluate(handle, heldoutCorpus, fixedBudget) -> RawResults
```

Adapter artifacts are metadata sidecars linked to the module root. Changing an adapter changes the synthesis record, not immutable executable identity. Produced code must still receive a new AST identity and pass verification/admission. Validate base/tokenizer/layer/rank/dtype compatibility before loading; reject foreign shapes, missing tensors, changed bases and untrusted executable serialization. The prototype uses safetensors and known local MLX architecture code; it does not enable model-supplied remote Python execution.

Only verified accepted patches may feed the future background tuning queue. Pin their exact code/spec/dependency subjects, deduplicate examples, and keep rejected/speculative outputs out unless explicitly labeled as negative training data. Holdout membership is frozen before training. Neither loss inspection nor a holdout score can rewrite the corpus or select a different checkpoint in the same campaign. Adapter publication and rollback need their own budget/effect receipts; failed or cancelled billable training cannot be refunded merely by resetting a branch.

The concrete first backend is **MLX 0.32.1 / mlx-lm 0.31.3** on local Apple silicon. MLX-LM provides actual LoRA conversion, trainable parameters, adapter serialization and reload utilities. [Primary MLX-LM fine-tuning documentation](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md). External hosted inference is an inference-only capability until its connected API actually advertises training or adapter loading; this work calls no paid provider and claims no remote training success.

## Preregistered profiles

[profile.json](../../../../roadmap/v4/research/learning/profile.json) was written before the experiments. Its exact SHA-256 is included in the result artifact. The immutable thresholds remain unchanged after the observed miss.

- **“Millions of boundary permutations per second”:** at least **2,000,000 distinct fully materialized and concretely evaluated inputs/second in every measured trial**. The research fixture is a four-field JSON event (`order`, `sequence`, `allocation`, `checksum`), with unique sequence numbers per trial. Time includes generation, JSON serialization/deserialization, guard execution and coverage checksum. One warmup and five trials of 20,000 inputs each are fixed. Vector arithmetic that never constructs or executes an input does not count.
- **“Tens of iterations”:** at most **99 gradient updates**, with at most three concrete rounded-neighbor probes per update, and 100% success on the fixed heldout scalar guard fixtures. Targets `3,11,29` are development fixtures; `41,67,89` are held out. Each run starts at zero in `[-128,127]`, uses `abs(x-target)` and step size one, and checks nested range predicates and exact integer equality. These easy scalar guards do not represent arbitrary deep branches or corrupted protocol parsers.
- **Relaxed AST fixture:** choose among `x-1`, `x`, `x+1` using 40 updates, learning rate 0.15 and temperature 0.7. Evaluate the selected discrete expression on disjoint heldout inputs. Compare a fixed-noise automatic gradient against finite differences with tolerance 0.001.
- **Pretrained LoRA path:** 12 steps, rank four, alpha eight, final two transformer layers, query/value projections, batch one, learning rate 0.0001, no dropout, sequence cap 128 and at most 1,536 training tokens. Final checkpoint only. Twelve training examples and four heldout examples are fixed; success means finite nonzero gradients, changed adapter parameters, unchanged base parameters and save/reload logit error at most 0.0001. An improvement in heldout loss is reported but is not an acceptance criterion.

Later release qualification must preserve the boundary rate threshold and expand workloads to the source's real event reordering, races, memory pressure and corrupt frames inside live micro-worlds. The broad target remains unmeasured here. For meaningful fuzzing comparisons, use a predeclared corpus with branch identities, comparable starting inputs, CPU/GPU/time/probe budgets, multiple seeds, matched coverage-guided/random baselines and all surrogate-training costs. This experiment does not compare against “stochastic millions.”

## Actual run and artifacts

The run used an **Apple M4 Pro with 24 GiB unified memory**, macOS 26.7, Python 3.14.7, MLX 0.32.1 and mlx-lm 0.31.3. Exact package versions and raw measurements are preserved under [learning/](../../../../roadmap/v4/research/learning/).

The real pretrained model is **HuggingFaceTB/SmolLM2-135M-Instruct**, immutable revision **`12fd25f77366fa6b3b4b768ec3050bf629380bac`**. The model card specifies **Apache-2.0**. Downloaded data files total **272,036,780 bytes**; each file has a recorded SHA-256, including the model weights and tokenizer. [Model publisher and license](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/tree/12fd25f77366fa6b3b4b768ec3050bf629380bac).

| Experiment | Observed result | Interpretation |
|---|---|---|
| Automatic versus finite-difference gradient | Maximum absolute error **0.0000975132** | Passes the fixed 0.001 fixture check. |
| Relaxed AST selection | Selects **`x+1`**, all four heldout concrete outputs correct | Shows an actual backward path and discrete recheck on one arithmetic family. |
| Heldout guard search | **41, 67 and 89 updates**; 42, 68 and 90 concrete probes | Passes the scalar fixture's ≤99 threshold; no general search superiority claim. |
| Materialized boundary fixtures | **485,528–493,429 inputs/sec**, all five trials below 2,000,000 | **Fail**. Preserve the miss and raw trial samples. |
| Actual LoRA training | **15,360 trainable parameters**, 12 updates, **210 training tokens**, **0.669 seconds** in update loop | Real gradient updates in a pretrained transformer; tiny instruction-pattern fixture. |
| Frozen base | Full base tensor fingerprint unchanged | Adapter updates did not change pretrained weights. |
| Saved adapter | **62,287 bytes**, content hash recorded | Actual safetensors artifact, not a simulated provider handle. |
| Fresh model + adapter reload | Maximum heldout logit error **0.0**, **0.132 seconds** | Exact local reconstruction for the tested inputs and backend. |
| Heldout next-token loss | **4.397250 → 4.363964** | Small descriptive change on four examples; no code-synthesis quality conclusion. |
| Local model experiment | **1.952 seconds** total, MLX peak allocation **653,584,640 bytes** | Includes local load/fingerprints/train/save/reload; excludes install/download and is not total process RSS. |

The adapter learns only the textual pattern “return an Aether integer literal” from synthetic examples. These examples are not verified repository patches. The experiment therefore proves the load/train/save/reload capability path, not continuous in-repository learning, economic benefit, token reductions or autonomous code quality. Base weights stay in `/tmp`; the small adapter, corpus and hash-bound results are retained in the repository as bounded research evidence.

## Reproduction

```sh
python3 -m venv /tmp/aether-r04-reproduce
/tmp/aether-r04-reproduce/bin/python -m pip install -r roadmap/v4/research/learning/environment-requirements.txt
/tmp/aether-r04-reproduce/bin/python roadmap/v4/research/learning/prepare_model.py
/tmp/aether-r04-reproduce/bin/python roadmap/v4/research/learning/experiment.py --model-record /tmp/aether-r04-model.json --output /tmp/aether-r04-rerun
/tmp/aether-r04-reproduce/bin/python -m unittest discover -s roadmap/v4/research/learning -p 'test_*.py'
```

Reproduction requires an MLX-compatible Apple silicon environment; unsupported hardware is an explicit backend limitation. Compare rerun measurements without overwriting the recorded campaign. The test command rechecks numerical gradients and the stored artifact/profile/script bindings. Repository task evidence must additionally bind this decision and experiment to the exact tested commit.
