/** Research lowering of an actual, checked two-tier Aether AST into one C
 * call frame. The supported domain is one-field Int records and signed i64
 * values. It is not production native admission or full Aether Int semantics. */
import { createHash } from 'node:crypto';
import type { Term, Ty } from '../../../../src/tier1/ast.ts';
import type { SymbolId } from '../../../../src/tier1/ids.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { typecheck } from '../../../../src/tier2/typecheck.ts';
import { executionManifestDigest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';

type Function = Extract<Term, { kind: 'FunctionDecl' }>;
type Binding = { readonly code: string; readonly type: 'record' | 'int' };
const i64Min = -(1n << 63n), i64Max = (1n << 63n) - 1n;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function oneFieldRecord(ty: Ty): boolean {
  return ty.t === 'Record' && ty.fields.length === 1 && ty.fields[0][0] === 'value' && ty.fields[0][1].t === 'Int';
}
function literal(value: bigint): string {
  if (value < i64Min || value > i64Max) throw new TypeError('native fallback literal outside signed i64 domain');
  return `((int64_t)UINT64_C(${BigInt.asUintN(64, value)}))`;
}
function declaration(module: Extract<Term, { kind: 'Module' }>, symbol: SymbolId): Function {
  const result = module.members.find((member): member is Function => member.kind === 'FunctionDecl' && member.symbol === symbol);
  if (!result) throw new TypeError('native fallback tier is absent');
  return result;
}
export interface NativeFallbackInput {
  readonly module: Term;
  readonly manifest: ExecutionManifestV1;
  readonly tier1: SymbolId;
  readonly tier2: SymbolId;
}
export interface NativeFallbackOutput {
  readonly root: string;
  readonly manifestDigest: string;
  readonly source: string;
  readonly sourceSha256: string;
}

export function lowerFallbackAst(input: NativeFallbackInput): NativeFallbackOutput {
  const { module, manifest, tier1, tier2 } = input;
  if (module.kind !== 'Module' || module.members.length !== 2 || module.members.some(member => member.kind !== 'FunctionDecl')
    || tier1 === tier2 || manifest.dependencies.length || !['reference/1', 'aether-reference/1'].includes(manifest.semanticsVersion))
    throw new TypeError('unsupported native fallback module or semantics');
  const root = new GraphStore().intern(module);
  if (root !== manifest.astRoot) throw new TypeError('native fallback AST/manifest mismatch');
  if (!typecheck(module, { registry: new CapabilityRegistry() }).ok)
    throw new TypeError('native fallback requires a closed well-typed module');
  const first = declaration(module, tier1), second = declaration(module, tier2);
  const valid = (fn: Function) => fn.purity === 'pure' && fn.capabilities.length === 0 && fn.typeParams.length === 0
    && fn.surfaces.length === 0 && fn.params.length === 2 && fn.params.every(param => oneFieldRecord(param.ty))
    && fn.returns.t === 'Int' && fn.body !== null && fn.contract?.kind === 'Contract'
    && fn.contract.modifies.length === 1 && fn.contract.ensures.length > 0;
  if (!valid(first) || !valid(second) || !same(first.params, second.params)
    || new GraphStore().intern(first.contract!) !== new GraphStore().intern(second.contract!))
    throw new TypeError('native fallback requires two pure tiers with the same checked record signature and contract');
  const contract = first.contract;
  if (contract?.kind !== 'Contract') throw new TypeError('native fallback contract missing');
  const modified = contract.modifies[0];
  if (modified.kind !== 'Place' || modified.symbol !== first.params[0].symbol || !same(modified.path, ['value']))
    throw new TypeError('native fallback contract frame is outside supported record field');
  let nodes = 0, localNumber = 0;
  const bounded = (depth: number) => { if (++nodes > 512 || depth > 48) throw new RangeError('native fallback AST resource bound'); };
  const bindings = () => new Map<SymbolId, Binding>([
    [first.params[0].symbol, { code: 'left', type: 'record' }],
    [first.params[1].symbol, { code: 'right', type: 'record' }],
  ]);
  const expression = (term: Term, env: ReadonlyMap<SymbolId, Binding>, frame: string,
    before: string, result: string | null, depth = 0): { code: string; type: 'int' | 'bool' } => {
    bounded(depth);
    switch (term.kind) {
      case 'Lit':
        if (term.ty.t === 'Int' && typeof term.value === 'bigint') return { code: literal(term.value), type: 'int' };
        if (term.ty.t === 'Bool' && typeof term.value === 'boolean') return { code: term.value ? '1' : '0', type: 'bool' };
        break;
      case 'Var': {
        const item = env.get(term.symbol);
        if (item?.type === 'int') return { code: item.code, type: 'int' };
        break;
      }
      case 'Field': {
        const item = term.object.kind === 'Var' ? env.get(term.object.symbol) : null;
        if (item?.type === 'record' && term.field === 'value')
          return { code: `${frame}->records[${item.code}].value`, type: 'int' };
        break;
      }
      case 'Old': return expression(term.expr, env, before, before, result, depth + 1);
      case 'ResultRef': if (result) return { code: result, type: 'int' }; break;
      case 'Bin': {
        const left = expression(term.left, env, frame, before, result, depth + 1);
        const right = expression(term.right, env, frame, before, result, depth + 1);
        if (left.type === 'int' && right.type === 'int') {
          if (term.op === 'add' || term.op === 'sub')
            return { code: `ae_${term.op}(${left.code},${right.code},&fault)`, type: 'int' };
          if (['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(term.op)) {
            const op = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' }[term.op as 'eq'];
            return { code: `((${left.code})${op}(${right.code}))`, type: 'bool' };
          }
        }
        if (left.type === 'bool' && right.type === 'bool' && (term.op === 'and' || term.op === 'or'))
          return { code: `((${left.code})${term.op === 'and' ? '&&' : '||'}(${right.code}))`, type: 'bool' };
        break;
      }
    }
    throw new TypeError(`unsupported native fallback expression ${term.kind}`);
  };
  const requireType = (value: { code: string; type: 'int' | 'bool' }, type: 'int' | 'bool') => {
    if (value.type !== type) throw new TypeError('native fallback expression type mismatch');
    return value.code;
  };
  const statement = (term: Term, env: Map<SymbolId, Binding>, depth = 0): string => {
    bounded(depth);
    switch (term.kind) {
      case 'Block': return term.stmts.map(child => statement(child, env, depth + 1)).join('\n');
      case 'Let': {
        if (!oneFieldRecord(term.ty) || term.init.kind !== 'RecordLit' || !same(term.ty, term.init.ty)
          || term.init.fields.length !== 1 || term.init.fields[0][0] !== 'value' || env.has(term.symbol))
          throw new TypeError('unsupported native fallback local allocation');
        const value = requireType(expression(term.init.fields[0][1], env, 'frame', 'before', null, depth + 1), 'int');
        const name = `local${localNumber++}`;
        env.set(term.symbol, { code: name, type: 'record' });
        return `int64_t value${name}=${value}; if(fault)return 1; uint32_t ${name}=ae_alloc(frame,value${name},&fault); if(fault)return 1; (void)${name};`;
      }
      case 'Assign': {
        if (term.target.kind !== 'Place' || !same(term.target.path, ['value']))
          throw new TypeError('unsupported native fallback assignment');
        const target = env.get(term.target.symbol);
        if (target?.type !== 'record' || target.code === 'right') throw new TypeError('native fallback writes outside declared frame');
        const value = requireType(expression(term.value, env, 'frame', 'before', null, depth + 1), 'int');
        return `int64_t assigned${localNumber++}=${value}; if(fault)return 1; frame->records[${target.code}].value=assigned${localNumber - 1};`;
      }
      case 'Assert': {
        const predicate = requireType(expression(term.expr, env, 'frame', 'before', null, depth + 1), 'bool');
        return `int asserted${localNumber++}=(${predicate}); if(fault||!asserted${localNumber - 1})return 1;`;
      }
      case 'Return': {
        const value = requireType(expression(term.value, env, 'frame', 'before', null, depth + 1), 'int');
        return `*out=${value}; if(fault)return 1; return 0;`;
      }
    }
    throw new TypeError(`unsupported native fallback statement ${term.kind}`);
  };
  const firstBody = statement(first.body!, bindings());
  const secondBody = statement(second.body!, bindings());
  const contractEnv = bindings();
  const requires = contract.requires.map(clause => {
    if (clause.kind !== 'Clause') throw new TypeError('invalid native fallback precondition');
    return requireType(expression(clause.expr, contractEnv, 'before', 'before', null), 'bool');
  });
  const ensures = contract.ensures.map(clause => {
    if (clause.kind !== 'Clause') throw new TypeError('invalid native fallback postcondition');
    return requireType(expression(clause.expr, contractEnv, 'after', 'before', 'result'), 'bool');
  });
  const manifestDigest = executionManifestDigest(manifest);
  const source = `/* Aether AST root ${root}; manifest ${manifestDigest}; bounded research ABI. */\n`
    + `static int tier1(Frame*frame,const Frame*before,uint32_t left,uint32_t right,int64_t*out){uint32_t fault=0;(void)before;(void)right;${firstBody}return 1;}\n`
    + `__attribute__((noinline)) static int tier2(Frame*frame,const Frame*before,uint32_t left,uint32_t right,int64_t*out,uint64_t started,uint64_t*switch_ticks){if(switch_ticks)*switch_ticks=tick()-started;uint32_t fault=0;(void)before;(void)right;${secondBody}return 1;}\n`
    + `static int precondition(const Frame*before,uint32_t left,uint32_t right){uint32_t fault=0;(void)before;(void)left;(void)right;${requires.map(code => `if(!(${code})||fault)return 0;`).join('')}return !fault;}\n`
    + `static int postcondition(const Frame*before,const Frame*after,uint32_t left,uint32_t right,int64_t result){uint32_t fault=0;(void)left;(void)right;(void)result;for(uint32_t id=1;id<before->next_id;id++)if(id!=left&&before->records[id].value!=after->records[id].value)return 0;${ensures.map(code => `if(!(${code})||fault)return 0;`).join('')}return !fault;}\n`;
  return { root, manifestDigest, source, sourceSha256: hash(source) };
}
