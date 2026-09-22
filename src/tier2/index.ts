export * from './ocap.ts';
export { ProofCache, type ProofCacheStats } from './proof-cache.ts';
export { TypeChecker, typecheck, tyEqual, tyToString, underlying, type CheckResult, type Diagnostic } from './typecheck.ts';
export * as smt from './smt.ts';
export { DEFAULT_TIMEOUT_MS, checkSat, prove, type SolverResult, type SolverStatus } from './solver.ts';
export {
  dischargeProof, formatReport, verifyFunction,
  type Obligation, type VerificationDependency, type VerificationReport, type Verdict,
} from './verify.ts';
export { compileSpec, parseSpec, type CompiledSpec, type Layer, type ProductSpec, type SpecRule } from './spec.ts';
