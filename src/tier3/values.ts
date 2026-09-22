/**
 * The runtime value domain.
 *
 * Records are heap-allocated and have reference identity, which is what makes
 * `modifies sender.balance` mean something and what makes the aliasing case
 * (`transfer(a, a, n)`) actually reachable by the micro-world fuzzer rather
 * than a theoretical concern.
 */

import type { Ty } from '../tier1/ast.ts';
import { underlying } from '../tier2/typecheck.ts';

/** A heap address. Allocation is sequential, so traces replay identically. */
export interface Ref {
  readonly addr: number;
}

export interface ResultValue {
  readonly variant: 'ok' | 'err';
  readonly value: Value;
}

export type Value = bigint | boolean | string | null | Ref | ResultValue;

export const isRef = (v: Value): v is Ref =>
  typeof v === 'object' && v !== null && 'addr' in v;

export const isResultValue = (v: Value): v is ResultValue =>
  typeof v === 'object' && v !== null && 'variant' in v && 'value' in v;

export function formatValue(v: Value, heap?: ReadonlyMap<number, Map<string, Value>>): string {
  if (v === null) return '()';
  if (typeof v === 'bigint') return `${v}`;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (isResultValue(v)) return `${v.variant}(${formatValue(v.value, heap)})`;
  const record = heap?.get(v.addr);
  if (!record) return `@${v.addr}`;
  const fields = [...record.entries()].map(([k, fv]) => `${k}: ${formatValue(fv, heap)}`);
  return `@${v.addr}{ ${fields.join(', ')} }`;
}

/** The zero value of a type, used to seed a record's fields. */
export function defaultValue(ty: Ty): Value {
  switch (underlying(ty).t) {
    case 'Int': return 0n;
    case 'Bool': return false;
    case 'Str': return '';
    default: return null;
  }
}
