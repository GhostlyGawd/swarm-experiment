/**
 * The TypeScript projection (§5, FR-1.2).
 *
 * A projection is a *view*, not a file format. The graph is the code; this is
 * how a human is shown it. The projector is total — every term the substrate
 * can hold has a rendering — and the parser in `parse.ts` accepts exactly the
 * language the projector emits, which is what makes the round-trip property
 * `parse(project(x)) ≡ x` checkable rather than aspirational (Risk R3).
 *
 * Everything the text carries beyond ordinary TypeScript — contracts,
 * capabilities, tunable surfaces, provenance — is rendered in structured doc
 * comments. That keeps the projection readable by people and by ordinary
 * TypeScript tooling, while losing nothing on the way back.
 */

import type { SymbolSpace } from '../tier1/symbols.ts';
import type { BinOp, Param, Term, Ty, UnOp } from '../tier1/ast.ts';
import type { ProvenanceLedger } from '../tier1/provenance.ts';
import type { NodeRef, SymbolId } from '../tier1/ids.ts';
import { TypeNames } from './names.ts';

export interface ProjectOptions {
  readonly typeNames?: TypeNames;
  readonly indent?: string;
  /** Render causal lineage inline, for the Auditor's review view. */
  readonly ledger?: ProvenanceLedger;
  /** Node addresses, when the reader wants to point an agent at a subtree. */
  readonly addresses?: ReadonlyMap<Term, NodeRef>;
}

const BIN_TEXT: Record<BinOp, string> = {
  add: '+', sub: '-', mul: '*', div: '/', mod: '%',
  eq: '===', ne: '!==', lt: '<', le: '<=', gt: '>', ge: '>=',
  and: '&&', or: '||', concat: '+',
};

const UN_TEXT: Record<UnOp, string> = { not: '!', neg: '-' };

/** Binding power, high binds tighter. Mirrors TypeScript's own precedence. */
const PRECEDENCE: Record<BinOp, number> = {
  or: 1, and: 2,
  eq: 3, ne: 3,
  lt: 4, le: 4, gt: 4, ge: 4,
  add: 5, sub: 5, concat: 5,
  mul: 6, div: 6, mod: 6,
};
const UNARY_PRECEDENCE = 7;
const COND_PRECEDENCE = 0;

export class TypeScriptProjector {
  private readonly types: TypeNames;
  private readonly indentUnit: string;

  private readonly syms: SymbolSpace;
  private readonly opts: ProjectOptions;

  constructor(syms: SymbolSpace, opts: ProjectOptions = {}) {
    this.syms = syms;
    this.opts = opts;
    this.types = opts.typeNames ?? new TypeNames();
    this.indentUnit = opts.indent ?? '  ';
  }

  get typeNames(): TypeNames {
    return this.types;
  }

  private name(symbol: SymbolId): string {
    return this.syms.nameOf(symbol);
  }

  ty(t: Ty): string {
    switch (t.t) {
      case 'Int': return 'bigint';
      case 'Bool': return 'boolean';
      case 'Str': return 'string';
      case 'Unit': return 'void';
      case 'Nominal': return this.types.short(t.name);
      case 'Record': return this.types.short(t.name);
      case 'Result': return `Result<${this.ty(t.ok)}, ${this.ty(t.err)}>`;
      case 'Seq': return `Seq<${this.ty(t.element)}>`;
      case 'Fn': return `Fn<(${t.params.map((param) => this.ty(param)).join(', ')}), ` +
        `${this.ty(t.returns)}, ${JSON.stringify(t.capabilities.join(','))}>`;
      case 'TypeVar': return t.name;
      case 'IntN': return `IntN<${t.bits}, ${t.signed ? 'signed' : 'unsigned'}, ${t.overflow}>`;
      case 'Owned': return `Owned<${this.ty(t.inner)}>`;
      case 'Task': return `Task<${this.ty(t.result)}>`;
    }
  }

  /** Render an expression, parenthesizing only where precedence demands it. */
  expr(t: Term, outer = 0): string {
    const wrap = (inner: string, prec: number) => (prec < outer ? `(${inner})` : inner);
    switch (t.kind) {
      case 'Lit':
        if (typeof t.value === 'bigint') {
          const lit = `${t.value}n`;
          return t.ty.t === 'Int' ? lit : `(${lit} as ${this.ty(t.ty)})`;
        }
        if (typeof t.value === 'boolean') return String(t.value);
        if (typeof t.value === 'string') return JSON.stringify(t.value);
        return 'undefined';
      case 'Var': return this.name(t.symbol);
      case 'Bin': {
        const p = PRECEDENCE[t.op];
        // Same-precedence right operands need parens: a - (b - c) ≠ a - b - c.
        return wrap(`${this.expr(t.left, p)} ${BIN_TEXT[t.op]} ${this.expr(t.right, p + 1)}`, p);
      }
      case 'Un': {
        // `-5n` is a negative literal; `-(5n)` is negation applied to a
        // positive one. They evaluate alike but are different nodes, so the
        // projection has to keep them apart or the round trip is lossy.
        const operand = t.op === 'neg' && t.operand.kind === 'Lit'
          ? `(${this.expr(t.operand)})`
          : this.expr(t.operand, UNARY_PRECEDENCE);
        return wrap(`${UN_TEXT[t.op]}${operand}`, UNARY_PRECEDENCE);
      }
      case 'Cond':
        return wrap(
          `${this.expr(t.cond, COND_PRECEDENCE + 1)} ? ${this.expr(t.then, COND_PRECEDENCE)}` +
            ` : ${this.expr(t.otherwise, COND_PRECEDENCE)}`,
          COND_PRECEDENCE,
        );
      case 'Call':
        return `${this.name(t.callee)}(${t.args.map((a) => this.expr(a)).join(', ')})`;
      case 'Field': return `${this.expr(t.object, 8)}.${t.field}`;
      case 'RecordLit': {
        const body = t.fields.map(([n, v]) => `${n}: ${this.expr(v)}`).join(', ');
        return `({ ${body} } satisfies ${this.ty(t.ty)})`;
      }
      case 'ResultValue':
        return `${t.variant}<${this.ty(t.ty)}>(${this.expr(t.value)})`;
      case 'MatchResult':
        return `matchResult(${this.expr(t.value)}, ${this.name(t.okSymbol)} => ${this.expr(t.ok)}, ` +
          `${this.name(t.errSymbol)} => ${this.expr(t.err)})`;
      case 'SeqLit': return `seq<${this.ty(t.ty.element)}>(${t.items.map((item) => this.expr(item)).join(', ')})`;
      case 'SeqIndex': return `index(${this.expr(t.sequence)}, ${this.expr(t.index)})`;
      case 'SeqLength': return `length(${this.expr(t.sequence)})`;
      case 'SeqMap': return `seqMap(${this.expr(t.sequence)}, ${this.name(t.callee)})`;
      case 'SeqFold': return `seqFold(${this.expr(t.sequence)}, ${this.expr(t.initial)}, ${this.name(t.callee)})`;
      case 'Lambda':
        return `lambda(${JSON.stringify(t.capabilities.join(','))}, (` +
          `${t.params.map((param) => `${this.name(param.symbol)}: ${this.ty(param.ty)}`).join(', ')}` +
          `): ${this.ty(t.returns)} => ${this.expr(t.body)})`;
      case 'Apply': return `apply(${this.expr(t.fn)}${t.args.map((arg) => `, ${this.expr(arg)}`).join('')})`;
      case 'StringOp': {
        const name = { strlen: 'strLen', contains: 'strContains', slice: 'strSlice', lower: 'strLower', upper: 'strUpper', trim: 'strTrim' }[t.op];
        return `${name}(${t.args.map((arg) => this.expr(arg)).join(', ')})`;
      }
      case 'IntCast': return `intCast<${this.ty(t.ty)}>(${this.expr(t.value)})`;
      case 'FixedBin': {
        const name = `fixed${t.op[0].toUpperCase()}${t.op.slice(1)}`;
        return `${name}<${this.ty(t.ty)}>(${this.expr(t.left)}, ${this.expr(t.right)})`;
      }
      case 'ForAll':
        return `forall(${this.expr(t.start)}, ${this.expr(t.end)}, ${this.name(t.symbol)} => ${this.expr(t.body)})`;
      case 'Spawn': return `spawn(${this.expr(t.body)})`;
      case 'Await': return `awaitTask(${this.expr(t.task)})`;
      case 'Old': return `old(${this.expr(t.expr)})`;
      case 'ResultRef': return 'result';
      case 'Invoke':
        return `invoke("${t.capability}"${t.args.map((a) => `, ${this.expr(a)}`).join('')})`;
      case 'Place':
        return [this.name(t.symbol), ...t.path].join('.');
      default:
        throw new TypeError(`${t.kind} is not an expression`);
    }
  }

  /** Render a statement or block at the given indentation depth. */
  stmt(t: Term, depth = 0): string {
    const pad = this.indentUnit.repeat(depth);
    switch (t.kind) {
      case 'Block': {
        if (t.stmts.length === 0) return `${pad}{}`;
        const inner = t.stmts.map((s) => this.stmt(s, depth + 1)).join('\n');
        return `${pad}{\n${inner}\n${pad}}`;
      }
      case 'Let':
        return `${pad}let ${this.name(t.symbol)}: ${this.ty(t.ty)} = ${this.expr(t.init)};`;
      case 'Assign':
        return `${pad}${this.expr(t.target)} = ${this.expr(t.value)};`;
      case 'If': {
        const head = `${pad}if (${this.expr(t.cond)}) ${this.blockInline(t.then, depth)}`;
        return t.otherwise === null
          ? head
          : `${head} else ${this.blockInline(t.otherwise, depth)}`;
      }
      case 'While': {
        const notes = [
          ...t.invariants.map((i) => `${pad} * @invariant ${this.expr(i)}`),
          ...(t.variant ? [`${pad} * @variant ${this.expr(t.variant)}`] : []),
        ];
        const doc = notes.length ? `${pad}/**\n${notes.join('\n')}\n${pad} */\n` : '';
        return `${doc}${pad}while (${this.expr(t.cond)}) ${this.blockInline(t.body, depth)}`;
      }
      case 'Return': return `${pad}return ${this.expr(t.value)};`;
      case 'Assert': return `${pad}assert(${this.expr(t.expr)}, ${JSON.stringify(t.label)});`;
      case 'ExprStmt': return `${pad}${this.expr(t.expr)};`;
      case 'Yield': return `${pad}yield;`;
      case 'Atomic': return `${pad}atomic ${this.blockInline(t.body, depth)}`;
      default:
        return `${pad}${this.expr(t, 0)};`;
    }
  }

  /** A block rendered with its opening brace on the current line. */
  private blockInline(t: Term, depth: number): string {
    return t.kind === 'Block' ? this.stmt(t, depth).trimStart() : `{\n${this.stmt(t, depth + 1)}\n${this.indentUnit.repeat(depth)}}`;
  }

  decl(t: Term, depth = 0): string {
    const pad = this.indentUnit.repeat(depth);
    switch (t.kind) {
      case 'TypeDecl': {
        const short = this.types.register(t.name);
        const lines = [`${pad}/** @nominal ${t.name}`];
        if (t.provenance) lines.push(`${pad} * @provenance ${t.provenance}`);
        lines.push(`${pad} */`);
        if (t.ty.t === 'Record') {
          lines.push(`${pad}interface ${short} {`);
          for (const [f, ft] of t.ty.fields) lines.push(`${pad}${this.indentUnit}${f}: ${this.ty(ft)};`);
          lines.push(`${pad}}`);
        } else {
          const repr = t.ty.t === 'Nominal' ? t.ty.repr : t.ty;
          lines.push(`${pad}type ${short} = ${this.ty(repr)};`);
        }
        return lines.join('\n');
      }
      case 'Surface': {
        const d = t.domain;
        const domain =
          d.d === 'choice'
            ? `choice(${d.options.join(', ')})`
            : `range(${d.min}, ${d.max}, ${d.step})`;
        const current = typeof t.current === 'bigint' ? String(t.current) : t.current;
        return `${pad}// @surface ${this.name(t.symbol)}: ${domain} ${t.objective} = ${current}`;
      }
      case 'FunctionDecl': return this.fnDecl(t, depth);
      case 'Import':
        return `${pad}// @import ${t.module}${t.symbols.length ? ` ${t.symbols.join(',')}` : ''}`;
      case 'Module': {
        const parts: string[] = [
          `// @module ${this.name(t.symbol)}`,
          ...(t.provenance ? [`// @provenance ${t.provenance}`] : []),
          '',
        ];
        for (const m of t.members) {
          parts.push(this.decl(m, depth), '');
        }
        return parts.join('\n').trimEnd() + '\n';
      }
      default:
        return this.stmt(t, depth);
    }
  }

  private fnDecl(
    t: Extract<Term, { kind: 'FunctionDecl' }>,
    depth: number,
  ): string {
    const pad = this.indentUnit.repeat(depth);
    const doc: string[] = [];

    if (this.opts.ledger && t.provenance) {
      const rec = this.opts.ledger.get(t.provenance);
      doc.push(` * ${rec.intent}`);
      doc.push(` * @provenance ${t.provenance}`);
      doc.push(` * @origin ${rec.origin.kind} ${rec.origin.ref}`);
      for (const step of rec.reasoning) doc.push(` * @reasoning ${step}`);
      if (rec.guard) doc.push(` * @guard ${rec.guard.priority} ${rec.guard.invariant} ${rec.guard.rationale}`);
    } else if (t.provenance) {
      doc.push(` * @provenance ${t.provenance}`);
    }

    for (const cap of t.capabilities) doc.push(` * @capability ${cap}`);

    if (t.contract && t.contract.kind === 'Contract') {
      const c = t.contract;
      for (const r of c.requires) {
        if (r.kind === 'Clause') doc.push(` * @requires ${this.clauseText(r)}`);
      }
      for (const e of c.ensures) {
        if (e.kind === 'Clause') doc.push(` * @ensures ${this.clauseText(e)}`);
      }
      if (c.modifies.length) {
        doc.push(` * @modifies ${c.modifies.map((m) => this.expr(m)).join(', ')}`);
      }
    }

    for (const s of t.surfaces) {
      if (s.kind !== 'Surface') continue;
      doc.push(` * ${this.decl(s, 0).replace(/^\/\/ /, '')}`);
    }

    const header = doc.length
      ? `${pad}/**\n${doc.map((l) => pad + l).join('\n')}\n${pad} */\n`
      : '';

    const params = t.params
      .map((p: Param) => `${this.name(p.symbol)}: ${this.ty(p.ty)}`)
      .join(', ');
    const modifier = t.purity === 'pure' ? 'pure ' : '';
    const typeParams = t.typeParams.length ? `<${t.typeParams.join(', ')}>` : '';
    const signature =
      `${pad}${modifier}function ${this.name(t.symbol)}${typeParams}(${params}): ${this.ty(t.returns)}`;

    if (t.body === null) {
      // An unsynthesized contract: the specification exists, the code does not.
      return `${header}${signature};${'  // @unsynthesized'}`;
    }
    return `${header}${signature} ${this.blockInline(t.body, depth)}`;
  }

  private clauseText(c: Extract<Term, { kind: 'Clause' }>): string {
    const rigor = c.rigor === 'property' ? ' @property' : '';
    return `[${c.label}]${rigor} ${this.expr(c.expr)}`;
  }
}

/** Project a term into readable TypeScript. */
export function projectTypeScript(
  term: Term,
  syms: SymbolSpace,
  opts: ProjectOptions = {},
): string {
  return new TypeScriptProjector(syms, opts).decl(term, 0);
}
