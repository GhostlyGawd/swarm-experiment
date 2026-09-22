export {
  DEFAULT_COST_MODEL, callGraph, compareShapes, formatPlan, generateGlue, slice,
  type CostModel, type CrossUnitEdge, type EdgeTelemetry, type FunctionTelemetry,
  type Placement, type SliceOptions, type TargetShape, type Telemetry, type TopologyPlan,
  type Unit,
} from './topology.ts';
export {
  applyTuning, domainValues, findSurfaces, tune, verifyOnlyParametersChanged,
  type Assignment, type Objective, type TuningResult,
} from './surfaces.ts';
