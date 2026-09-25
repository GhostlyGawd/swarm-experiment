/** Exact bounded fractional paths selected by D04 version 0.2.0. */
import { createHash } from 'node:crypto';
import { validateDigest, type Digest } from '../fabric/identity.ts';
export type Fraction = readonly [bigint, bigint];
const gcd = (a: bigint, b: bigint): bigint => { while (b !== 0n) [a, b] = [b, a % b]; return a; };
const reduce = (n: bigint, d: bigint): Fraction => { const divisor = gcd(n, d); return [n / divisor, d / divisor]; };
export function parseFractionalPosition(value: string): Fraction[] {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('fi1:')) throw new Error('fractional_position_version_or_size');
  const components = value.slice(4).split(';');
  if (components.length > 8) throw new Error('fractional_position_depth');
  return components.map(component => {
    if (!/^[1-9][0-9]{0,127}\/[1-9][0-9]{0,127}$/.test(component)) throw new Error('fractional_position_component');
    const [n, d] = component.split('/').map(BigInt);
    if (gcd(n, d) !== 1n) throw new Error('noncanonical_fractional_position');
    return [n, d] as const;
  });
}
const compareFraction = ([a, b]: Fraction, [c, d]: Fraction): number => a * d < c * b ? -1 : a * d > c * b ? 1 : 0;
export function compareFractionalPositions(left: string, right: string): number {
  const a = parseFractionalPosition(left), b = parseFractionalPosition(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) { const result = compareFraction(a[index], b[index]); if (result) return result; }
  return a.length - b.length;
}
export function allocateFractionalPosition(left: string | null, right: string | null, operationId: Digest): string {
  validateDigest(operationId, 'aether.operation-id/1');
  const a = left === null ? [] : parseFractionalPosition(left), b = right === null ? [] : parseFractionalPosition(right);
  let prefix: Fraction[];
  if (left === null) prefix = b.length ? [reduce(b[0][0], b[0][1] * 2n)] : [[1n, 1n]];
  else if (right === null) prefix = [reduce(a[0][0] + a[0][1], a[0][1])];
  else {
    const order = compareFractionalPositions(left, right);
    if (order >= 0) throw new Error(order === 0 ? 'equal_fractional_bounds' : 'reversed_fractional_bounds');
    let index = 0;
    while (index < a.length && index < b.length && compareFraction(a[index], b[index]) === 0) index++;
    prefix = a.slice(0, index);
    prefix.push(index === a.length ? reduce(b[index][0], b[index][1] * 2n) : reduce(a[index][0] + b[index][0], a[index][1] + b[index][1]));
  }
  const hash = BigInt(`0x${createHash('sha256').update(`aether.fractional-position/1:${operationId}`).digest('hex')}`);
  prefix.push(reduce(hash + 1n, (1n << 256n) + 1n));
  const result = `fi1:${prefix.map(([n, d]) => `${n}/${d}`).join(';')}`;
  parseFractionalPosition(result); return result;
}
