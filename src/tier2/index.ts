export * from './ocap.ts';
export { ScopedGrantAuthority, validateScopedGrant, type ScopedGrantV2, type GrantBodyV2, type GrantRequestV2, type GrantAuthorityOptions } from './scoped-grants.ts';
export { DurableGrantEpochs, type GrantEpochOptions } from './grant-epochs.ts';
export { ProofCache, type ProofCacheStats } from './proof-cache.ts';
export { verifyIncremental, type IncrementalVerificationResult } from './incremental.ts';
export { TypeChecker, typecheck, tyEqual, tyToString, underlying, type CheckResult, type Diagnostic } from './typecheck.ts';
export * as smt from './smt.ts';
export { DEFAULT_TIMEOUT_MS, checkSat, prove, type SolverResult, type SolverStatus } from './solver.ts';
export { SMT_SOLVER_PROCESS, proveWithExternalFallback, type ExternalSolverOptions } from './external-solver.ts';
export {
  dischargeProof, formatReport, verifyFunction,
  type Obligation, type VerificationDependency, type VerificationReport, type Verdict,
} from './verify.ts';
export { compileSpec, parseSpec, type CompiledSpec, type Layer, type ProductSpec, type SpecRule } from './spec.ts';
export { checkPortableCertificate, encodePortableCertificate, decodePortableCertificate, validateCheckedPortableCertificate, type PortableCertificateV1, type CheckedPortableCertificate, type PortableDerivationOptions } from './portable-proof-checker.ts';
export { generatePortableCertificate } from './portable-proof-producer.ts';
