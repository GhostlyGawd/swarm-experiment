import type { Term, Ty } from '../tier1/ast.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import { unsupportedProjectionKinds } from './coverage.ts';

export class PythonProjector {
  private readonly symbols: SymbolSpace;
  constructor(symbols: SymbolSpace) { this.symbols = symbols; }
  private name(symbol: Parameters<SymbolSpace['nameOf']>[0]): string { return this.symbols.nameOf(symbol); }
  private ty(type: Ty): string {
    switch (type.t) {
      case 'Int': case 'IntN': return 'int'; case 'Bool': return 'bool'; case 'Str': return 'str'; case 'Unit': return 'None';
      case 'Nominal': case 'Record': return type.name.split(':').at(-1)!;
      case 'Result': return `${this.ty(type.ok)} | ${this.ty(type.err)}`;
      case 'Seq': return `tuple[${this.ty(type.element)}, ...]`;
      case 'Fn': return 'Callable'; case 'TypeVar': return type.name;
      case 'Owned': return this.ty(type.inner); case 'Task': return `Task[${this.ty(type.result)}]`;
    }
  }
  private expr(term: Term): string {
    switch (term.kind) {
      case 'Lit': return term.value === null ? 'None' : typeof term.value === 'string' ? JSON.stringify(term.value) : String(term.value).replace('n', '');
      case 'Var': return this.name(term.symbol);
      case 'Bin': {
        const op: Record<string, string> = {
          add: '+', sub: '-', mul: '*', div: '//', mod: '%', eq: '==', ne: '!=',
          lt: '<', le: '<=', gt: '>', ge: '>=', and: 'and', or: 'or', concat: '+',
        };
        return `(${this.expr(term.left)} ${op[term.op]} ${this.expr(term.right)})`;
      }
      case 'Call': return `${this.name(term.callee)}(${term.args.map((arg) => this.expr(arg)).join(', ')})`;
      case 'Field': return `${this.expr(term.object)}.${term.field}`;
      case 'Cond': return `(${this.expr(term.then)} if ${this.expr(term.cond)} else ${this.expr(term.otherwise)})`;
      case 'SeqLit': return `(${term.items.map((item) => this.expr(item)).join(', ')})`;
      case 'ResultValue': return `(${JSON.stringify(term.variant)}, ${this.expr(term.value)})`;
      default: return `None  # ${term.kind}`;
    }
  }
  project(term: Term): string {
    if (term.kind === 'Module') return term.members.map((member) => this.project(member)).filter(Boolean).join('\n\n');
    if (term.kind === 'TypeDecl') return `${term.name.split(':').at(-1)} = ${this.ty(term.ty)}`;
    if (term.kind !== 'FunctionDecl') return '';
    const params = term.params.map((param) => `${this.name(param.symbol)}: ${this.ty(param.ty)}`).join(', ');
    const body = term.body?.kind === 'Block' && term.body.stmts.at(-1)?.kind === 'Return'
      ? this.expr((term.body.stmts.at(-1) as Extract<Term, { kind: 'Return' }>).value)
      : 'NotImplemented';
    return `def ${this.name(term.symbol)}(${params}) -> ${this.ty(term.returns)}:\n    return ${body}`;
  }
}

export const projectPython = (term: Term, symbols: SymbolSpace): string => {
  const unsupported = unsupportedProjectionKinds(term, 'python');
  const warning = unsupported.length ? `# Placeholder projection for: ${unsupported.join(', ')}\n` : '';
  return warning + new PythonProjector(symbols).project(term);
};
