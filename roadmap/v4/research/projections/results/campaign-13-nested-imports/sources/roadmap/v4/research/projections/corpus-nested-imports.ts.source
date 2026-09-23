import * as b from '../../../../src/tier1/build.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';

/** An addressed library imported from a nested module, with an editable root literal. */
export function nestedImportCorpus() {
  const symbols = new SymbolSpace('projection-nested-import-campaign-13');
  const helper = symbols.define('helper'), x = symbols.define('x');
  const library = b.module_({symbol: symbols.define('library'), symbolTable: symbols.table(), members: [
    b.fn({symbol: helper, params: [b.param(x, b.Int)], returns: b.Int,
      body: b.ret(b.add(b.v(x), b.int(1)))})
  ]});
  const address = new GraphStore().intern(library);
  const entry = symbols.define('entry');
  const inner = b.module_({symbol: symbols.define('inner'), symbolTable: symbols.table(), members: [
    b.import_(address, [helper]),
    b.fn({symbol: entry, returns: b.Int, body: b.ret(b.call(helper, b.int(41)))})
  ]});
  const module = b.module_({symbol: symbols.define('outer'), symbolTable: symbols.table(), members: [inner]});
  return [{id: 'nested-exact-address-import', module, symbols, modules: new Map([[address, library]])}];
}
