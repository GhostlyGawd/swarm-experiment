/**
 * Project Aether — a unified, agent-native programming fabric.
 *
 * The public surface is organized by tier. Shared fabric and admission services
 * bind code, state, evidence and authority across those tiers.
 */

// --- Tier 1: storage and representation -------------------------------------
export * from './tier1/ast.ts';
export * from './tier1/ids.ts';
export { canonicalBytes, canonicalText, type Canonical } from './tier1/canonical.ts';
export { Blake3, blake3, blake3Hex, bytesToHex } from './tier1/blake3.ts';
export { GraphStore, alphaNormalize, hashNode, structuralKeyOf, type Step, type StoreStats } from './tier1/store.ts';
export { DurableGraphStore, type DurableGraphStoreOptions, type DurableStoreLimits, type DurableRootHead, type DurableRootState, type PendingAstPromotion, type DurableStoreFault, type DurableCollectionResult } from './tier1/durable-store.ts';
export { CausalLineageLedger, LineageAdmissionError, signSpecRevision, signIntent, specRevisionDigest, intentDigest, fenceRequirement, validateStrictLineageAdmission, type CausalLineageOptions, type LineageAuthority, type SpecReference, type FenceRequirement, type SpecRevisionBody, type SignedSpecRevision, type IntentBody, type SignedIntent, type ArtifactLineageRecord, type LineageInvalidation, type StrictLineageAdmission } from './tier1/causal-lineage.ts';
export { CognitiveBlackboard, type BlackboardItem, type BlackboardAcl, type BlackboardPolicy, type BlackboardEntry, type BlackboardView, type CognitiveBlackboardOptions } from './tier1/cognitive-blackboard.ts';
export { SemanticGarbageCollector, SEMANTIC_GC_PROFILE, SEMANTIC_GC_BRANCH_PROFILE, SEMANTIC_GC_SHIM_PROFILE, type SemanticGcProfile, type SemanticGcOptions, type SemanticGcPolicy, type SemanticGcProposal, type SemanticRetention, type SemanticRetentionKind } from './tier1/semantic-gc.ts';
export { DurableTreeWorkspace, type TreeWorkspaceOptions, type TreePlacement, type TreeMutation, type TreeFence, type TreeCheckpoint, type TreeCheckpointAck, type TreeCheckpointCertificate } from './tier1/tree-workspace.ts';
export { allocateFractionalPosition, compareFractionalPositions, parseFractionalPosition } from './tier1/fractional-position.ts';
export { projectOccurrences, occurrenceIdForInsert, type OccurrenceNode, type OccurrenceProjection, type TreeDiagnostic } from './tier1/occurrence-tree.ts';
export { materializeOccurrences, type TreeMaterialization, type MaterializationDiagnostic } from './tier1/tree-materialization.ts';
export { HybridGraphIndex, embeddingModelDigest, canonicalVector, decodeVector, type HybridIndexOptions, type HybridQuery, type HybridQueryResult, type EmbeddingModelProfile, type EmbeddingProvider, type QueryEmbedding, type CanonicalVector, type StructuralFilter } from './tier1/semantic-index.ts';
export { embeddingInputs, type IndexScope, type EmbeddingInput, type StructuralEdge } from './tier1/embedding-input.ts';
export { AetherRepository, type CommitOptions, type CommitRecord, type FsckIssue, type GarbageCollectionResult, type Packfile } from './tier1/repository.ts';
export { ModuleResolver, type ResolvedModule } from './tier1/modules.ts';
export { merge3, type MergeConflict, type MergeResult } from './tier1/merge.ts';
export { SymbolSpace } from './tier1/symbols.ts';
export * from './tier1/provenance.ts';
export { IrContext, decode, encode, type AgentIr } from './tier1/agent-ir.ts';
export * as build from './tier1/build.ts';

// --- Tier 2: semantics, security, contracts ---------------------------------
export { checkPortableCertificate, encodePortableCertificate, decodePortableCertificate, validateCheckedPortableCertificate, type PortableCertificateV1, type CheckedPortableCertificate, type PortableDerivationOptions } from './tier2/portable-proof-checker.ts';
export { generatePortableCertificate } from './tier2/portable-proof-producer.ts';
export * from './tier2/ocap.ts';
export { ScopedGrantAuthority, validateScopedGrant, type ScopedGrantV2, type GrantBodyV2, type GrantRequestV2, type GrantAuthorityOptions } from './tier2/scoped-grants.ts';
export { DurableGrantEpochs, type GrantEpochOptions } from './tier2/grant-epochs.ts';
export { validateEffectResourcePolicyBody, effectResourcePolicyDigest, signEffectResourcePolicy, assertSignedEffectResourcePolicy, effectResourcePath, assertEffectResourceAdapter, type EffectResourceRuleV1, type EffectResourcePolicyBodyV1, type SignedEffectResourcePolicyV1 } from './tier2/effect-resource-policy.ts';
export { ProofCache, type ProofCacheStats } from './tier2/proof-cache.ts';
export { verifyIncremental, type IncrementalVerificationResult } from './tier2/incremental.ts';
export { TypeChecker, typecheck, tyEqual, tyToString, underlying, type CheckResult, type Diagnostic } from './tier2/typecheck.ts';
export * as smt from './tier2/smt.ts';
export { DEFAULT_TIMEOUT_MS, checkSat, prove, type SolverResult, type SolverStatus } from './tier2/solver.ts';
export { SMT_SOLVER_PROCESS, proveWithExternalFallback, type ExternalSolverOptions } from './tier2/external-solver.ts';
export { dischargeProof, formatReport, verifyFunction, type Obligation, type VerificationDependency, type VerificationReport, type Verdict } from './tier2/verify.ts';
export { compileSpec, parseSpec, type CompiledSpec, type Layer, type ProductSpec, type SpecRule } from './tier2/spec.ts';

// --- Tier 3: execution and simulation ---------------------------------------
export { ResumableRuntime, type ResumableRuntimeOptions, type ResumableRunResult, type ResumableRef, type ResumableEffects } from './tier3/resumable-runtime.ts';
export { ResumableCheckpointStore, type ResumableCheckpointOptions, type CheckpointHead, type CheckpointPersistenceFault } from './tier3/resumable-checkpoint.ts';
export { compileResumableProgram, type ResumableProgram, type ResumableCode } from './tier3/resumable-program.ts';
export { checkpointDigest, type ResumableSnapshot, type MachineCore, type MachineEvent, type MachineValue } from './tier3/resumable-state.ts';
export { AetherFault, Runtime, type Checkpoint, type ExecutionResult, type Fault, type FaultKind, type TraceEvent } from './tier3/runtime.ts';
export { formatValue, isClosureValue, isRef, isResultValue, isSeqValue, isTaskValue, type ClosureValue, type Ref, type ResultValue, type SeqValue, type TaskValue, type Value } from './tier3/values.ts';
export { ProductionRuntime, formatCompilation, type ClauseDecision, type CompilationReport, type CompileOptions, type ElisionPolicy, type ProductionSampling, type TelemetrySample } from './tier3/compile.ts';
export { MicroWorld, exploreSchedules, formatMicroWorld, materializeCounterexample, simulateModule, type Counterexample, type MicroWorldReport, type PersistedCounterexample, type PropertyName, type ScheduleOutcome, type ScheduleStep } from './tier3/microworld.ts';
export { LivingCampaign, LIVING_CAMPAIGN_PROFILE, measureR04JsonEvents, type CampaignScalar, type CampaignInput, type CampaignEvent, type CampaignStep, type CampaignScenario, type LivingCampaignManifest, type LivingCase, type LivingCaseResult, type LivingCounterexample, type LivingCampaignReport, type R04JsonObservation } from './tier3/living-campaign.ts';
export { generateCase, materialise, shrinkPlain, type Plain } from './tier3/generate.ts';

// --- Tier 4: topology and optimization --------------------------------------
export {
  DEFAULT_COST_MODEL, callGraph, compareShapes, formatPlan, generateGlue, slice,
  type ConcurrencyFinding, type CostModel, type CrossUnitEdge, type EdgeTelemetry, type FunctionTelemetry,
  type Placement, type SliceOptions, type TargetShape, type Telemetry, type TopologyPlan,
  type Unit,
} from './tier4/topology.ts';
export { applyTuning, domainValues, findSurfaces, tune, verifyOnlyParametersChanged, type Assignment, type Objective, type TuningResult } from './tier4/surfaces.ts';
export { TelemetryCollector, TopologyHost, type DistributedFault, type DistributedFaultKind, type DistributedResult, type TopologyHostOptions, type WireRequest } from './tier4/host.ts';

// --- Projection (§5) ---------------------------------------------------------
export { TypeScriptProjector, projectTypeScript, type ProjectOptions } from './projection/typescript.ts';
export { ParseError, Parser, parseExpression, parseTypeScript, type ParseOptions } from './projection/parse.ts';
export { TypeNames } from './projection/names.ts';
export { PythonProjector, projectPython } from './projection/python.ts';
export { RustProjector, projectRust } from './projection/rust.ts';
export { projectDiff, structuralDiff, type ProjectionDiffEntry } from './projection/diff.ts';
export { LspStreamDecoder, ProjectionLanguageServer, encodeLspMessage, type JsonRpcRequest, type JsonRpcResponse, type ProjectionDiagnostic, type ProjectionDocument } from './projection/lsp.ts';
export { PROJECTION_COVERAGE, unsupportedProjectionKinds, type ProjectionSupport, type ProjectionTarget } from './projection/coverage.ts';

// --- Synthesis ---------------------------------------------------------------
export { DEFAULT_MAX_ITERATIONS, formatOutcome, purgeBody, synthesize, type Attempt, type Feedback, type SynthesisOutcome, type Synthesizer } from './synthesis/loop.ts';
export { EnumerativeSynthesizer } from './synthesis/enumerative.ts';

// --- Utilities ---------------------------------------------------------------
export { rng, type Rng } from './util/rng.ts';
export { countTokens, estimateTokens, measure, measureWithTokenizer, type SizeReport } from './util/tokens.ts';

// --- Agent wire protocol ----------------------------------------------------
export { AgentSession, FrameDecoder, LeaseManager, encodeFrame, type AgentRequest, type AgentResponse, type Lease } from './agent/protocol.ts';

// --- The worked example ------------------------------------------------------
export { buildLedgerExample, ledgerCapabilities, ledgerTelemetry, ACCOUNT, CENTS } from './examples/ledger.ts';

// Versioned execution envelopes; kept namespaced to preserve the v1 API.
export * as fabric from './fabric/index.ts';
export { BrokerEffectRouter, EffectInvocationError, type RuntimeEffectRouter, type RuntimeEffectRouterOptions } from './tier3/effects.ts';
export { ProcessHost, PROCESS_INVOKE, processExecutionId, type ProcessHostOptions, type ProcessHostCallResult, type ProcessEffectContext, type ProcessCheckpointAccess, type ProcessInvocationGrant } from './tier4/process-host.ts';
export { ProcessResumableSession, type ProcessResumableOptions, type ProcessResumableEffectsContext } from './tier4/process-resumable.ts';
export { seedProcessCheckpoint, seededProcessReference, type ProcessCheckpointBinding, type ProcessCheckpointLease, type ProcessCheckpointReceipt, type ProcessCheckpointSeed, type ProcessCheckpointAuthorization, type ProcessCheckpointAction, type ProcessCheckpointControlRequest, type ProcessCheckpointControl } from './tier4/process-checkpoint-contract.ts';
export { ProcessDeployment, processArtifactContext, processArtifactDigest, processMigrationPlan, processEffectPlan, type ProcessArtifactInput, type ProcessDeploymentOptions } from './tier4/process-deployment.ts';
export { encodeAgentIrBinary, decodeAgentIrBinary, encodeAgentIrModel, decodeAgentIrModel, AGENT_IR_V2_LIMITS } from './tier1/agent-ir-v2.ts';
export { EXECUTABLE_PROJECTION_PROFILE, COMPOSITE_PROJECTION_PROFILE, CONTINUATION_PROJECTION_PROFILE, projectExecutable, parseExecutable, executableBundle, executableRuntime, projectTypeScriptV2, parseTypeScriptV2, projectPythonV2, parsePythonV2, projectRustV2, parseRustV2, projectTypeScriptV3, projectPythonV3, projectRustV3, projectTypeScriptV4, projectPythonV4, projectRustV4, RUST_PROJECTION_CARGO, type ExecutableTarget, type ExecutableBundle } from './projection/executable.ts';
