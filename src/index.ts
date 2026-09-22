/**
 * Project Aether — a unified, agent-native programming fabric.
 *
 * The public surface is organized by tier. Tier N depends only on the tiers
 * below it, which is what lets the topology engine move code between processes
 * without the semantics tier noticing.
 */

// --- Tier 1: storage and representation -------------------------------------
export * from './tier1/ast.ts';
export * from './tier1/ids.ts';
export { canonicalBytes, canonicalText, type Canonical } from './tier1/canonical.ts';
export { Blake3, blake3, blake3Hex, bytesToHex } from './tier1/blake3.ts';
export { GraphStore, alphaNormalize, hashNode, structuralKeyOf, type Step, type StoreStats } from './tier1/store.ts';
export { AetherRepository, type CommitOptions, type CommitRecord, type FsckIssue, type GarbageCollectionResult, type Packfile } from './tier1/repository.ts';
export { ModuleResolver, type ResolvedModule } from './tier1/modules.ts';
export { merge3, type MergeConflict, type MergeResult } from './tier1/merge.ts';
export { SymbolSpace } from './tier1/symbols.ts';
export * from './tier1/provenance.ts';
export { IrContext, decode, encode, type AgentIr } from './tier1/agent-ir.ts';
export * as build from './tier1/build.ts';

// --- Tier 2: semantics, security, contracts ---------------------------------
export * from './tier2/ocap.ts';
export { ProofCache, type ProofCacheStats } from './tier2/proof-cache.ts';
export { verifyIncremental, type IncrementalVerificationResult } from './tier2/incremental.ts';
export { TypeChecker, typecheck, tyEqual, tyToString, underlying, type CheckResult, type Diagnostic } from './tier2/typecheck.ts';
export * as smt from './tier2/smt.ts';
export { DEFAULT_TIMEOUT_MS, checkSat, prove, type SolverResult, type SolverStatus } from './tier2/solver.ts';
export { SMT_SOLVER_PROCESS, proveWithExternalFallback, type ExternalSolverOptions } from './tier2/external-solver.ts';
export { dischargeProof, formatReport, verifyFunction, type Obligation, type VerificationDependency, type VerificationReport, type Verdict } from './tier2/verify.ts';
export { compileSpec, parseSpec, type CompiledSpec, type Layer, type ProductSpec, type SpecRule } from './tier2/spec.ts';

// --- Tier 3: execution and simulation ---------------------------------------
export { AetherFault, Runtime, type Checkpoint, type ExecutionResult, type Fault, type FaultKind, type TraceEvent } from './tier3/runtime.ts';
export { formatValue, isClosureValue, isRef, isResultValue, isSeqValue, isTaskValue, type ClosureValue, type Ref, type ResultValue, type SeqValue, type TaskValue, type Value } from './tier3/values.ts';
export { ProductionRuntime, formatCompilation, type ClauseDecision, type CompilationReport, type CompileOptions, type ElisionPolicy, type ProductionSampling, type TelemetrySample } from './tier3/compile.ts';
export { MicroWorld, exploreSchedules, formatMicroWorld, materializeCounterexample, simulateModule, type Counterexample, type MicroWorldReport, type PersistedCounterexample, type PropertyName, type ScheduleOutcome, type ScheduleStep } from './tier3/microworld.ts';
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
