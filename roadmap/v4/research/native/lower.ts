import type { Term, Ty } from '../../../../src/tier1/ast.ts';
import type { SymbolId } from '../../../../src/tier1/ids.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import * as b from '../../../../src/tier1/build.ts';

export const I64: Ty = { t: 'IntN', bits: 64, signed: true, overflow: 'trap' };
export const NATIVE_ABI = 'aether.native-i64/1';
export const NATIVE_HEADER = `#include <stdint.h>
#include <stddef.h>
typedef struct { int64_t value; uint32_t status; uint32_t reserved; } aether_i64_result;
_Static_assert(sizeof(aether_i64_result)==16,"ABI result size");
_Static_assert(offsetof(aether_i64_result,status)==8,"ABI status offset");
/* status 0=value, 1=checked integer overflow, 2=division by zero. */
`;
function i64(ty: Ty): boolean { return ty.t === 'IntN' && ty.bits === 64 && ty.signed && ty.overflow === 'trap'; }
function literal(value: bigint): string {
  if (value < -(1n << 63n) || value >= 1n << 63n) throw new Error('literal outside checked i64 ABI');
  return value === -(1n << 63n) ? 'INT64_MIN' : `${value}LL`;
}
/** Bounded lowering prototype, not the complete native compiler. Reject every
 * unbounded, effectful, contract-bearing or unsupported declaration explicitly. */
export function lowerI64(fn: Term, name = 'aether_eval'): { source: string; astRoot: string; abi: string } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('invalid C symbol');
  if (fn.kind !== 'FunctionDecl' || !i64(fn.returns) || fn.params.length !== 2 || fn.params.some(parameter => !i64(parameter.ty)) || fn.capabilities.length || fn.purity !== 'pure' || fn.contract !== null || fn.typeParams.length || fn.surfaces.length) throw new Error('unsupported native declaration; requires pure binary checked-i64 function without contracts');
  if (new Set(fn.params.map(parameter => parameter.symbol)).size !== 2) throw new Error('duplicate native parameter');
  if (fn.body?.kind !== 'Block' || fn.body.stmts.length !== 1 || fn.body.stmts[0].kind !== 'Return') throw new Error('native prototype supports one return expression');
  const names = new Map<SymbolId, string>(fn.params.map((parameter, index) => [parameter.symbol, index === 0 ? 'a' : 'b']));
  const lines: string[] = [];
  let next = 0;
  const expression = (term: Term): string => {
    if (term.kind === 'Var') { const variable = names.get(term.symbol); if (!variable) throw new Error('unbound native variable'); return variable; }
    if (term.kind === 'Lit' && i64(term.ty) && typeof term.value === 'bigint') return literal(term.value);
    if (term.kind !== 'FixedBin' || !i64(term.ty)) throw new Error(`unsupported native expression ${term.kind}`);
    const left = expression(term.left), right = expression(term.right), value = `v${next++}`;
    lines.push(`int64_t ${value};`);
    if (term.op === 'add' || term.op === 'sub' || term.op === 'mul') {
      lines.push(`if (__builtin_${term.op}_overflow(${left},${right},&${value})) return (aether_i64_result){0,1,0};`);
    } else {
      lines.push(`if (${right}==0) return (aether_i64_result){0,2,0};`);
      if (term.op === 'div') {
        lines.push(`if (${left}==INT64_MIN && ${right}==-1) return (aether_i64_result){0,1,0};`);
        lines.push(`${value}=${left}/${right};`);
      } else if (term.op === 'mod') lines.push(`${value}=(${left}==INT64_MIN && ${right}==-1)?0:${left}%${right};`);
      else throw new Error('unsupported fixed-width operation');
    }
    return value;
  };
  const value = expression(fn.body.stmts[0].value);
  lines.push(`return (aether_i64_result){${value},0,0};`);
  return { source: `/* ${NATIVE_ABI}; C compiler is in the prototype TCB. */\naether_i64_result ${name}(int64_t a,int64_t b) {\n${lines.join('\n')}\n}\n`, astRoot: new GraphStore().intern(fn), abi: NATIVE_ABI };
}
export function nativeFixtures() {
  const syms = new SymbolSpace('native-r02/1'), first = syms.define('first'), second = syms.define('second');
  const make = (name: string, body: Term) => b.fn({ symbol: syms.define(name), params: [b.param(first, I64), b.param(second, I64)], returns: I64, body: b.block(b.ret(body)) });
  const operations = (['add', 'sub', 'mul', 'div', 'mod'] as const).map(op => ({ name: `aether_${op}`, fn: make(op, b.fixed(op, I64 as Extract<Ty, { t: 'IntN' }>, b.v(first), b.v(second))) }));
  const fee = make('fee', b.fixed('add', I64 as Extract<Ty, { t: 'IntN' }>, b.fixed('div', I64 as Extract<Ty, { t: 'IntN' }>, b.v(first), b.typed(I64, 200n)), b.v(second)));
  return { syms, operations, fee };
}
