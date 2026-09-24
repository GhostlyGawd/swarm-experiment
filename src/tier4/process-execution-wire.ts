/** Shared authenticated process execution wire codec. The worker imports this
 * narrow module so host admission code cannot enter its executable closure. */
import type { ExecutionResult } from '../tier3/runtime.ts';
import { exactObject, type TaggedValueV1 } from '../fabric/encoding.ts';
import { decodeProcessValue, encodeProcessValue, type ProcessScope } from './process-values.ts';
import type { RuntimeSnapshotV1 } from '../fabric/snapshot.ts';

type WireExecution = { ok: true; value: TaggedValueV1; steps: number } | Extract<ExecutionResult, { ok: false }>;
export function encodeProcessExecution(execution: ExecutionResult, scope: ProcessScope, snapshot: RuntimeSnapshotV1): WireExecution {
  return execution.ok ? { ok: true, value: encodeProcessValue(execution.value, scope, snapshot), steps: execution.steps } : execution;
}
export function decodeProcessExecution(value: unknown, scope: ProcessScope, snapshot: RuntimeSnapshotV1): ExecutionResult {
  if (!value || typeof value !== 'object' || !('ok' in value)) throw new TypeError('invalid process execution result');
  const execution = exactObject(value, value.ok === true ? ['ok', 'value', 'steps'] : ['ok', 'fault', 'steps']);
  if (!Number.isSafeInteger(execution.steps) || (execution.steps as number) < 0) throw new TypeError('invalid execution steps');
  if (execution.ok === true) return { ok: true, value: decodeProcessValue(execution.value as TaggedValueV1, scope, snapshot), steps: execution.steps as number };
  if (execution.ok !== false || !execution.fault || typeof execution.fault !== 'object') throw new TypeError('invalid process execution fault');
  const fields = ['kind', 'message', 'label', 'step', 'bindings', ...('recoveryId' in execution.fault ? ['recoveryId'] : [])];
  const fault = exactObject(execution.fault, fields);
  if (!['precondition', 'postcondition', 'assertion', 'capability_denied', 'capability_revoked', 'division_by_zero', 'step_budget', 'unbound', 'type_error', 'effect_failed', 'effect_indeterminate'].includes(fault.kind as string)
    || typeof fault.message !== 'string' || (fault.label !== null && typeof fault.label !== 'string') || !Number.isSafeInteger(fault.step) || (fault.step as number) < 0
    || (fault.recoveryId !== undefined && typeof fault.recoveryId !== 'string')) throw new TypeError('invalid process fault fields');
  if (!fault.bindings || typeof fault.bindings !== 'object' || Array.isArray(fault.bindings) || Object.values(fault.bindings).some(item => typeof item !== 'string')) throw new TypeError('invalid fault bindings');
  return value as ExecutionResult;
}

