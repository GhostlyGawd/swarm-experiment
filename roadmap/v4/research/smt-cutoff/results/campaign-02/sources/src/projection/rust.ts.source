import type { Term, Ty } from '../tier1/ast.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import { unsupportedProjectionKinds } from './coverage.ts';

export class RustProjector {
  private readonly symbols: SymbolSpace;
  constructor(symbols: SymbolSpace) { this.symbols = symbols; }
  private name(symbol: Parameters<SymbolSpace['nameOf']>[0]): string { return this.symbols.nameOf(symbol); }
  private ty(type: Ty): string {
    switch (type.t) {
      case 'Int': return 'i128'; case 'Bool': return 'bool'; case 'Str': return 'String'; case 'Unit': return '()';
      case 'Nominal': return type.name.split(':').at(-1)!; case 'Record': return type.name.split(':').at(-1)!;
      case 'Result': return `Result<${this.ty(type.ok)}, ${this.ty(type.err)}>`;
      case 'Seq': return `Vec<${this.ty(type.element)}>`;
      case 'Fn': return `Box<dyn Fn(${type.params.map((p) => this.ty(p)).join(', ')}) -> ${this.ty(type.returns)}>`;
      case 'TypeVar': return type.name;
      case 'IntN': return `${type.signed ? 'i' : 'u'}${type.bits}`;
      case 'Owned': return this.ty(type.inner);
      case 'Task': return `Task<${this.ty(type.result)}>`;
    }
  }
  private expr(term: Term): string {
    switch (term.kind) {
      case 'Lit': return typeof term.value === 'string' ? JSON.stringify(term.value) + '.to_string()' : term.value === null ? '()' : String(term.value).replace('n', '');
      case 'Var': return this.name(term.symbol);
      case 'Bin': {
        const op: Record<string, string> = {
          add: '+', sub: '-', mul: '*', div: '/', mod: '%', eq: '==', ne: '!=',
          lt: '<', le: '<=', gt: '>', ge: '>=', and: '&&', or: '||', concat: '+',
        };
        return `(${this.expr(term.left)} ${op[term.op]} ${this.expr(term.right)})`;
      }
      case 'Call': return `${this.name(term.callee)}(${term.args.map((arg) => this.expr(arg)).join(', ')})`;
      case 'Field': return `${this.expr(term.object)}.${term.field}`;
      case 'Cond': return `if ${this.expr(term.cond)} { ${this.expr(term.then)} } else { ${this.expr(term.otherwise)} }`;
      case 'SeqLit': return `vec![${term.items.map((item) => this.expr(item)).join(', ')}]`;
      case 'ResultValue': return `${term.variant === 'ok' ? 'Ok' : 'Err'}(${this.expr(term.value)})`;
      default: return `/* ${term.kind} */`;
    }
  }
  project(term: Term): string {
    if (term.kind === 'Module') return term.members.map((member) => this.project(member)).filter(Boolean).join('\n\n');
    if (term.kind === 'TypeDecl') return `type ${term.name.split(':').at(-1)} = ${this.ty(term.ty)};`;
    if (term.kind !== 'FunctionDecl') return '';
    const params = term.params.map((param) => `${this.name(param.symbol)}: ${this.ty(param.ty)}`).join(', ');
    const body = term.body?.kind === 'Block' && term.body.stmts.at(-1)?.kind === 'Return'
      ? this.expr((term.body.stmts.at(-1) as Extract<Term, { kind: 'Return' }>).value)
      : 'unimplemented!()';
    return `fn ${this.name(term.symbol)}${term.typeParams.length ? `<${term.typeParams.join(', ')}>` : ''}(${params}) -> ${this.ty(term.returns)} {\n    ${body}\n}`;
  }
}

export const projectRust = (term: Term, symbols: SymbolSpace): string => {
  const unsupported = unsupportedProjectionKinds(term, 'rust');
  const warning = unsupported.length ? `// Placeholder projection for: ${unsupported.join(', ')}\n` : '';
  return warning + new RustProjector(symbols).project(term);
};
