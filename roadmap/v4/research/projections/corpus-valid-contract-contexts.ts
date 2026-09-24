import * as b from '../../../../src/tier1/build.ts';
import type { Term, Ty } from '../../../../src/tier1/ast.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import type { SymbolId } from '../../../../src/tier1/ids.ts';

export const CONTRACT_BODY_FORMS = ['literal', 'negative_division', 'string_length',
  'quantifier', 'direct_pure_call', 'result_binder', 'sequence_fold', 'nested_lambda',
  'fresh_record_field', 'fixed_wrap', 'lazy_task'] as const;
export const CONTRACT_BODY_FORMS_V17 = [...CONTRACT_BODY_FORMS, 'task_record_field', 'task_identity'] as const;
export const CONTRACT_CARRIERS = ['inline', 'direct_factory', 'block_factory',
  'branch_factory', 'passed_parameter'] as const;

export interface ValidContractContext {
  id: string;
  bodyForm: typeof CONTRACT_BODY_FORMS_V17[number];
  carrier: typeof CONTRACT_CARRIERS[number];
  module: Term;
  symbols: SymbolSpace;
  entry: SymbolId;
}

/** Fixed Cartesian corpus: 11 body forms × 5 closure carriers. Every row is
 * accepted and executed by the reference runtime before native classification. */
export function validContractContexts(version: 16 | 17 = 16): ValidContractContext[] {
  const rows: ValidContractContext[] = [];
  const forms = version === 17 ? CONTRACT_BODY_FORMS_V17 : CONTRACT_BODY_FORMS;
  for (const bodyForm of forms) for (const carrier of CONTRACT_CARRIERS) {
    const id = `${bodyForm}/${carrier}`, symbols = new SymbolSpace(`projection-valid-v16-${id}`);
    const helper = symbols.define('helper'), sum = symbols.define('sum');
    const factory = symbols.define('factory');
    const entry = symbols.define('entry'), wrapper = symbols.define('wrapper');
    const fnValue = symbols.define('fnValue'), localA = symbols.define('localA');
    const localB = symbols.define('localB'), iterator = symbols.define('iterator');
    const ok = symbols.define('ok'), err = symbols.define('err');
    const accumulator = symbols.define('accumulator'), item = symbols.define('item');
    const fnType: Ty = { t: 'Fn', params: [], returns: b.Int, capabilities: [] };
    const result: Ty = { t: 'Result', ok: b.Int, err: b.Int };
    const box: Ty = { t: 'Record', name: 'type:projection:generated-box' as never, fields: [['value', b.Int]] };
    const byte: Ty = { t: 'IntN', bits: 8, signed: false, overflow: 'wrap' };
    const body = (): Term => {
      switch (bodyForm) {
        case 'literal': return b.int(7);
        case 'negative_division': return b.div(b.int(-7), b.int(3));
        case 'string_length': return b.strlen(b.str('abc'));
        case 'quantifier': return b.cond(b.forall(iterator, b.int(0), b.int(3), b.ge(b.v(iterator), b.int(0))), b.int(1), b.int(0));
        case 'direct_pure_call': return b.call(helper);
        case 'result_binder': return b.matchResult(b.ok(result as Extract<Ty,{t:'Result'}>, b.int(3)), ok, b.v(ok), err, b.int(0));
        case 'sequence_fold': return b.fold(b.seq(b.Int, b.int(1), b.int(2)), b.int(0), sum);
        case 'nested_lambda': return b.apply(b.lambda({ returns: b.Int, body: b.int(5) }));
        case 'fresh_record_field': return b.field(b.record(box as Extract<Ty,{t:'Record'}>, { value: b.int(5) }), 'value');
        case 'fixed_wrap': return b.cond(b.eq(b.fixed('add', byte as Extract<Ty,{t:'IntN'}>,
          b.typed(byte, 250n), b.typed(byte, 10n)), b.typed(byte, 4n)), b.int(1), b.int(0));
        case 'lazy_task': return b.await_(b.spawn(b.int(5)));
        case 'task_record_field': return b.field(b.await_(b.spawn(
          b.record(box as Extract<Ty,{t:'Record'}>, { value: b.int(5) }))), 'value');
        case 'task_identity': return b.cond(b.ne(b.spawn(b.int(1)), b.spawn(b.int(1))), b.int(1), b.int(0));
      }
    };
    const lambda = (extra?: SymbolId): Term => b.lambda({ returns: b.Int,
      body: extra ? b.add(body(), b.v(extra)) : body() });
    const members: Term[] = [
      b.fn({ symbol: helper, returns: b.Int, body: b.ret(b.int(7)) }),
      b.fn({ symbol: sum, params: [b.param(accumulator, b.Int), b.param(item, b.Int)], returns: b.Int,
        body: b.ret(b.add(b.v(accumulator), b.v(item))) }),
    ];
    let target: Term, invokedEntry = entry;
    if (carrier === 'inline') target = lambda();
    else if (carrier === 'passed_parameter') target = b.v(fnValue);
    else {
      if (carrier === 'direct_factory') members.push(b.fn({ symbol: factory, returns: fnType, body: b.ret(lambda()) }));
      else if (carrier === 'block_factory') members.push(b.fn({ symbol: factory, returns: fnType,
        body: b.block(b.let_(localA, b.Int, b.int(1)), b.ret(lambda(localA))) }));
      else members.push(b.fn({ symbol: factory, returns: fnType,
        body: b.if_(b.bool(true),
          b.block(b.let_(localA, b.Int, b.int(1)), b.ret(lambda(localA))),
          b.block(b.let_(localB, b.Int, b.int(2)), b.ret(lambda(localB)))) }));
      target = b.call(factory);
    }
    members.push(b.fn({ symbol: entry,
      params: carrier === 'passed_parameter' ? [b.param(fnValue, fnType)] : [], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(target), b.int(-1000)), 'generated predicate')] }),
      body: b.ret(b.int(1)) }));
    if (carrier === 'passed_parameter') {
      members.push(b.fn({ symbol: wrapper, returns: b.Int, body: b.ret(b.call(entry, lambda())) }));
      invokedEntry = wrapper;
    }
    const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members });
    rows.push({ id, bodyForm, carrier, module, symbols, entry: invokedEntry });
  }
  return rows;
}
