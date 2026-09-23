/** Opt-in v4 SMT cutoff. A separate process makes a synchronous solver loop
 * interruptible by the host; measured wall time includes launch and teardown.
 * This is not a bound on arbitrary input validation, host scheduling or an
 * external solver fallback. Those boundaries require separate qualification.
 */
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { types as nodeTypes } from 'node:util';
import { exactObject, identifier } from '../fabric/encoding.ts';
import { evaluate, type SmtFormula } from './smt.ts';
import type { SolverResult } from './solver.ts';

export const V4_SMT_HARD_CUTOFF_MS = 1500;
const MAX_NODES = 20_000, MAX_BYTES = 1024 * 1024, MAX_DEPTH = 64, MAX_DIGITS = 128;
const child = `import {readFileSync} from 'node:fs';
const {prove}=await import(process.argv[1]);
const formula=JSON.parse(readFileSync(0,'utf8'));
const restore=(value)=>{if(!value||typeof value!=='object')return;if(value.k==='int')value.v=BigInt(value.v);for(const child of Object.values(value))if(child&&typeof child==='object')Array.isArray(child)?child.forEach(restore):restore(child);};
restore(formula);
const result=prove(formula,{timeoutMs:Number(process.argv[2])});
const model=result.model?Object.entries(result.model).map(([name,value])=>[name,typeof value==='bigint'?['int',String(value)]:['bool',value]]):null;
process.stdout.write(JSON.stringify({status:result.status,reason:result.reason??null,abstractedTerms:result.abstractedTerms,model}));`;
function validateFormula(value: unknown): asserts value is SmtFormula {
  const active = new WeakSet<object>(); let nodes = 0;
  const enter = (item: unknown, depth: number): string => {
    if (!item || typeof item !== 'object' || nodeTypes.isProxy(item) || depth > MAX_DEPTH || active.has(item)) throw new TypeError('invalid or cyclic SMT input');
    if (++nodes > MAX_NODES) throw new RangeError('SMT input node bound');
    active.add(item);
    const tag = Object.getOwnPropertyDescriptor(item, 'k');
    if (!tag || !('value' in tag) || typeof tag.value !== 'string') throw new TypeError('invalid SMT node tag');
    return tag.value;
  };
  const args = (value: unknown, depth: number, kind: 'formula' | 'term'): void => {
    if (!Array.isArray(value) || nodeTypes.isProxy(value) || active.has(value) || value.length > MAX_NODES) throw new TypeError('invalid SMT arguments');
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('invalid SMT argument array shape');
    active.add(value);
    try {
      for (let index = 0; index < value.length; index++) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (!item || !('value' in item)) throw new TypeError('SMT argument accessors and holes are forbidden');
        visit(item.value, depth + 1, kind);
      }
    } finally { active.delete(value); }
  };
  const visit = (item: unknown, depth: number, kind: 'formula' | 'term'): void => {
    const k = enter(item, depth);
    try {
      if (kind === 'formula') {
        switch (k) {
          case 'true': case 'false': exactObject(item, ['k']); break;
          case 'bool': { const row = exactObject(item, ['k', 'name']); identifier(row.name); break; }
          case 'not': visit(exactObject(item, ['k', 'arg']).arg, depth + 1, 'formula'); break;
          case 'and': case 'or': args(exactObject(item, ['k', 'args']).args, depth, 'formula'); break;
          case 'implies': case 'iff': {
            const row = exactObject(item, ['k', 'left', 'right']); visit(row.left, depth + 1, 'formula'); visit(row.right, depth + 1, 'formula'); break;
          }
          case 'cmp': {
            const row = exactObject(item, ['k', 'op', 'left', 'right']);
            if (!['eq', 'lt', 'le', 'gt', 'ge'].includes(String(row.op))) throw new TypeError('invalid SMT comparison');
            visit(row.left, depth + 1, 'term'); visit(row.right, depth + 1, 'term'); break;
          }
          default: throw new TypeError('unsupported SMT formula');
        }
      } else {
        switch (k) {
          case 'int': {
            const row = exactObject(item, ['k', 'v']);
            if (typeof row.v !== 'bigint' || String(row.v).replace('-', '').length > MAX_DIGITS) throw new TypeError('invalid SMT integer'); break;
          }
          case 'var': {
            const row = exactObject(item, ['k', 'name', 'sort']); identifier(row.name);
            if (row.sort !== 'Int' && row.sort !== 'Bool') throw new TypeError('invalid SMT sort'); break;
          }
          case 'add': case 'mul': args(exactObject(item, ['k', 'args']).args, depth, 'term'); break;
          case 'sub': {
            const row = exactObject(item, ['k', 'left', 'right']); visit(row.left, depth + 1, 'term'); visit(row.right, depth + 1, 'term'); break;
          }
          case 'neg': visit(exactObject(item, ['k', 'arg']).arg, depth + 1, 'term'); break;
          case 'ite': {
            const row = exactObject(item, ['k', 'cond', 'then', 'otherwise']); visit(row.cond, depth + 1, 'formula'); visit(row.then, depth + 1, 'term'); visit(row.otherwise, depth + 1, 'term'); break;
          }
          case 'app': { const row = exactObject(item, ['k', 'name', 'args']); identifier(row.name); args(row.args, depth, 'term'); break; }
          default: throw new TypeError('unsupported SMT term');
        }
      }
    } finally { active.delete(item as object); }
  };
  visit(value, 0, 'formula');
}
function timeout(elapsedMs: number): SolverResult { return { status: 'unknown', reason: 'timeout', elapsedMs, abstractedTerms: 0 }; }
/** The call returns a measured timeout/unknown if the child is killed or the
 * complete checked answer exceeds the requested v4 boundary. */
export function proveWithHardCutoff(formula: SmtFormula, timeoutMs = V4_SMT_HARD_CUTOFF_MS): SolverResult {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > V4_SMT_HARD_CUTOFF_MS) throw new RangeError('invalid v4 SMT cutoff');
  const started = performance.now(); validateFormula(formula);
  const input = JSON.stringify(formula, (_key, value) => typeof value === 'bigint' ? String(value) : value);
  if (Buffer.byteLength(input) > MAX_BYTES) return { status: 'unknown', reason: 'too_large', elapsedMs: performance.now() - started, abstractedTerms: 0 };
  const remaining = Math.floor(timeoutMs - (performance.now() - started) - 20);
  if (remaining < 1) return timeout(performance.now() - started);
  const solverUrl = new URL(import.meta.url.endsWith('.ts') ? './solver.ts' : './solver.js', import.meta.url).href;
  const flags = solverUrl.endsWith('.ts') ? ['--experimental-strip-types'] : [];
  const result = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', child, solverUrl, String(remaining)],
    { input, encoding: 'utf8', timeout: remaining, killSignal: 'SIGKILL', maxBuffer: MAX_BYTES, windowsHide: true });
  let elapsedMs = performance.now() - started;
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL' || elapsedMs > timeoutMs) return timeout(elapsedMs);
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') return { status: 'unknown', reason: 'too_large', elapsedMs, abstractedTerms: 0 };
  if (result.error || result.status !== 0) throw new Error(`isolated SMT worker failed: ${result.error?.message ?? result.stderr?.slice(0, 300) ?? result.status}`);
  const wire = JSON.parse(result.stdout) as { status: string; reason: string | null; abstractedTerms: number; model: Array<[string, ['int', string] | ['bool', boolean]]> | null };
  if (!['sat', 'unsat', 'unknown'].includes(wire.status) || !Number.isSafeInteger(wire.abstractedTerms) || wire.abstractedTerms < 0 || wire.model !== null && !Array.isArray(wire.model)) throw new TypeError('invalid isolated SMT result');
  const model: Record<string, bigint | boolean> = Object.create(null);
  if (wire.status === 'sat') {
    if (!wire.model) throw new TypeError('isolated SMT counterexample missing model');
    for (const [name, item] of wire.model) {
      identifier(name); if (Object.hasOwn(model, name) || !Array.isArray(item) || item.length !== 2) throw new TypeError('invalid isolated SMT model entry');
      if (item[0] === 'int' && typeof item[1] === 'string' && /^-?(0|[1-9][0-9]*)$/.test(item[1]) && item[1].replace('-', '').length <= MAX_DIGITS) model[name] = BigInt(item[1]);
      else if (item[0] === 'bool' && typeof item[1] === 'boolean') model[name] = item[1];
      else throw new TypeError('invalid isolated SMT model value');
    }
    if (evaluate(formula, model) !== false) throw new Error('isolated SMT counterexample does not refute the formula');
  }
  elapsedMs = performance.now() - started;
  if (elapsedMs > timeoutMs) return timeout(elapsedMs);
  return { status: wire.status as SolverResult['status'], ...(wire.status === 'sat' ? { model } : {}),
    ...(wire.status === 'unknown' && wire.reason ? { reason: wire.reason as SolverResult['reason'] } : {}), elapsedMs, abstractedTerms: wire.abstractedTerms };
}
