/**
 * The reverse direction of the projection (§5, Risk R3).
 *
 * A projection is only trustworthy if editing it is editing the graph. This
 * parser accepts exactly the language `TypeScriptProjector` emits, and is the
 * other half of the round-trip property the risk register demands:
 * `parse(project(x)) ≡ x`, structurally, for every term the substrate holds.
 *
 * Binding resolution is what makes the round trip *exact* rather than merely
 * equivalent. A projection is a view of a module whose symbol table the fabric
 * already has, so an identifier that names an existing binding resolves to that
 * binding's id — the same `SymbolId`, not a fresh one with the same spelling.
 * Only genuinely new names mint new symbols, which is precisely the case where
 * a human has added something.
 */

import { tokenize, type Token } from './lexer.ts';
import { TypeNames } from './names.ts';
import * as b from '../tier1/build.ts';
import type { BinOp, Param, Rigor, SurfaceDomain, Term, Ty } from '../tier1/ast.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import type { CapabilityName, ProvenanceId, SymbolId, TypeName } from '../tier1/ids.ts';

export class ParseError extends SyntaxError {
  readonly line: number;
  constructor(message: string, token: Token) {
    super(`${message} at line ${token.line} (near ${JSON.stringify(token.value || '<eof>')})`);
    this.line = token.line;
  }
}

export interface ParseOptions {
  readonly symbols: SymbolSpace;
  readonly typeNames?: TypeNames;
  /**
   * Existing bindings by name. Supply the module's symbol table to make the
   * round trip exact; omit it and every binder mints a fresh symbol.
   */
  readonly bindings?: ReadonlyMap<string, SymbolId>;
  /** Named types already known to the fabric. */
  readonly types?: ReadonlyMap<string, Ty>;
}

const BIN_FROM_TEXT: Record<string, BinOp> = {
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
  '===': 'eq', '!==': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge',
  '&&': 'and', '||': 'or',
};

interface Scope {
  readonly names: Map<string, SymbolId>;
  readonly parent: Scope | null;
}

/** Contract and metadata recovered from a doc comment. */
interface DocTags {
  readonly requires: string[];
  readonly ensures: string[];
  readonly modifies: string[];
  readonly capabilities: CapabilityName[];
  readonly surfaces: string[];
  readonly invariants: string[];
  readonly variants: string[];
  readonly provenance: ProvenanceId | null;
  readonly nominal: TypeName | null;
}

function parseDoc(text: string): DocTags {
  const tags: DocTags = {
    requires: [], ensures: [], modifies: [], capabilities: [], surfaces: [],
    invariants: [], variants: [], provenance: null, nominal: null,
  };
  const mutable = tags as {
    -readonly [K in keyof DocTags]: DocTags[K];
  };
  const body = text.replace(/^\/\*+/, '').replace(/\*+\/$/, '');
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/^\s*\*+\s?/, '').trim();
    const match = /^@([a-zA-Z-]+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, tag, value] = match;
    switch (tag) {
      case 'requires': mutable.requires.push(value); break;
      case 'ensures': mutable.ensures.push(value); break;
      case 'modifies': mutable.modifies.push(value); break;
      case 'capability': mutable.capabilities.push(value.trim() as CapabilityName); break;
      case 'surface': mutable.surfaces.push(value); break;
      case 'invariant': mutable.invariants.push(value); break;
      case 'variant': mutable.variants.push(value); break;
      case 'provenance': mutable.provenance = value.trim() as ProvenanceId; break;
      case 'nominal': mutable.nominal = value.trim() as TypeName; break;
      default: break;
    }
  }
  return tags;
}

export class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private scope: Scope;
  private readonly opts: ParseOptions;
  private readonly types: TypeNames;
  private readonly typeEnv = new Map<string, Ty>();
  /** `result` and `old(…)` are legal only while parsing an ensures clause. */
  private inEnsures = false;

  constructor(source: string, opts: ParseOptions) {
    this.tokens = tokenize(source);
    this.opts = opts;
    this.types = opts.typeNames ?? new TypeNames();
    this.scope = { names: new Map(opts.bindings ?? []), parent: null };
    for (const [name, ty] of opts.types ?? []) this.typeEnv.set(name, ty);
  }

  // --- token helpers -------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private at(value: string, type: 'punct' | 'ident' = 'punct'): boolean {
    const t = this.peek();
    return t.type === type && t.value === value;
  }

  private accept(value: string, type: 'punct' | 'ident' = 'punct'): boolean {
    if (!this.at(value, type)) return false;
    this.pos++;
    return true;
  }

  private expect(value: string, type: 'punct' | 'ident' = 'punct'): Token {
    if (!this.at(value, type)) throw new ParseError(`expected ${JSON.stringify(value)}`, this.peek());
    return this.next();
  }

  private expectIdent(): string {
    const t = this.peek();
    if (t.type !== 'ident') throw new ParseError('expected an identifier', t);
    this.pos++;
    return t.value;
  }

  private skipTrivia(): string[] {
    const docs: string[] = [];
    while (this.peek().type === 'doc' || this.peek().type === 'line') {
      docs.push(this.next().value);
    }
    return docs;
  }

  // --- binding -------------------------------------------------------------

  private resolve(name: string): SymbolId | null {
    for (let s: Scope | null = this.scope; s; s = s.parent) {
      const hit = s.names.get(name);
      if (hit) return hit;
    }
    return null;
  }

  /** Introduce a binding, reusing the fabric's existing symbol where one exists. */
  private bind(name: string): SymbolId {
    const existing = this.opts.bindings?.get(name) ?? this.resolve(name);
    const id = existing ?? this.opts.symbols.define(name);
    this.scope.names.set(name, id);
    return id;
  }

  private pushScope(): void {
    this.scope = { names: new Map(), parent: this.scope };
  }

  private popScope(): void {
    if (this.scope.parent) this.scope = this.scope.parent;
  }

  // --- types ---------------------------------------------------------------

  parseType(): Ty {
    const t = this.peek();
    if (t.type !== 'ident') throw new ParseError('expected a type', t);
    const name = this.next().value;
    switch (name) {
      case 'bigint': return { t: 'Int' };
      case 'boolean': return { t: 'Bool' };
      case 'string': return { t: 'Str' };
      case 'void': return { t: 'Unit' };
      case 'Result': {
        this.expect('<');
        const ok = this.parseType();
        this.expect(',');
        const err = this.parseType();
        this.expect('>');
        return { t: 'Result', ok, err };
      }
      default: {
        const known = this.typeEnv.get(name);
        if (known) return known;
        const long = this.types.long(name);
        if (long) return { t: 'Nominal', name: long, repr: { t: 'Int' } };
        throw new ParseError(`unknown type ${name}`, t);
      }
    }
  }

  // --- expressions ---------------------------------------------------------

  parseExpression(): Term {
    return this.parseTernary();
  }

  private parseTernary(): Term {
    const cond = this.parseBinary(1);
    if (!this.accept('?')) return cond;
    const then = this.parseTernary();
    this.expect(':');
    return b.cond(cond, then, this.parseTernary());
  }

  /** Precedence climbing over the same table the projector prints with. */
  private parseBinary(minPrecedence: number): Term {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct') break;
      const op = BIN_FROM_TEXT[t.value];
      if (!op) break;
      const precedence = PRECEDENCE[op];
      if (precedence < minPrecedence) break;
      this.pos++;
      const right = this.parseBinary(precedence + 1);
      left = b.bin(op, left, right);
    }
    return left;
  }

  private parseUnary(): Term {
    if (this.accept('!')) return b.not(this.parseUnary());
    if (this.accept('-')) {
      // A minus directly against a numeral is part of the literal. Negation of
      // a literal is written `-(5n)`, and the parenthesis is what tells them
      // apart — see the matching comment in the projector.
      const t = this.peek();
      if (t.type === 'number') {
        this.pos++;
        return b.int(-BigInt(t.value.replace(/[_n]/g, '')));
      }
      return b.neg(this.parseUnary());
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Term {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.accept('.')) {
        expr = b.field(expr, this.expectIdent());
        continue;
      }
      if (this.at('(') && expr.kind === 'Var') {
        this.next();
        const args: Term[] = [];
        if (!this.at(')')) {
          do args.push(this.parseExpression());
          while (this.accept(','));
        }
        this.expect(')');
        expr = b.call(expr.symbol, ...args);
        continue;
      }
      break;
    }
    return expr;
  }

  private parsePrimary(): Term {
    const t = this.peek();

    if (t.type === 'number') {
      this.pos++;
      return b.int(BigInt(t.value.replace(/[_n]/g, '')));
    }
    if (t.type === 'string') {
      this.pos++;
      return b.str(t.value);
    }
    if (this.accept('(')) {
      // `({ … } satisfies T)` — a record literal.
      if (this.at('{')) {
        const record = this.parseRecordLiteral();
        this.expect(')');
        return record;
      }
      const inner = this.parseExpression();
      // `(0n as Cents)` — a literal carrying a nominal type.
      if (this.accept('as', 'ident')) {
        const ty = this.parseType();
        this.expect(')');
        if (inner.kind !== 'Lit') throw new ParseError('only literals may carry an `as` type', t);
        return b.typed(ty, inner.value);
      }
      this.expect(')');
      return inner;
    }
    if (t.type !== 'ident') throw new ParseError('expected an expression', t);

    switch (t.value) {
      case 'true': this.pos++; return b.bool(true);
      case 'false': this.pos++; return b.bool(false);
      case 'undefined': this.pos++; return b.unit();
      case 'result':
        if (!this.inEnsures) break; // an ordinary variable called `result`
        this.pos++;
        return b.result();
      case 'old': {
        if (!this.inEnsures) break;
        this.pos++;
        this.expect('(');
        const inner = this.parseExpression();
        this.expect(')');
        return b.old(inner);
      }
      case 'invoke': {
        this.pos++;
        this.expect('(');
        const capToken = this.peek();
        if (capToken.type !== 'string') throw new ParseError('invoke needs a capability name', capToken);
        this.pos++;
        const args: Term[] = [];
        while (this.accept(',')) args.push(this.parseExpression());
        this.expect(')');
        return b.invoke(capToken.value as CapabilityName, ...args);
      }
      default: break;
    }

    this.pos++;
    const symbol = this.resolve(t.value);
    if (!symbol) throw new ParseError(`${t.value} is not in scope`, t);
    return b.v(symbol);
  }

  private parseRecordLiteral(): Term {
    this.expect('{');
    const fields: Record<string, Term> = {};
    if (!this.at('}')) {
      do {
        const name = this.expectIdent();
        this.expect(':');
        fields[name] = this.parseExpression();
      } while (this.accept(','));
    }
    this.expect('}');
    this.expect('satisfies', 'ident');
    const ty = this.parseType();
    return b.record(ty, fields);
  }

  /** Turn an already-parsed expression into an assignment target. */
  private toPlace(expr: Term, token: Token): Term {
    const path: string[] = [];
    let cursor = expr;
    while (cursor.kind === 'Field') {
      path.unshift(cursor.field);
      cursor = cursor.object;
    }
    if (cursor.kind !== 'Var') throw new ParseError('not an assignable place', token);
    return b.place(cursor.symbol, ...path);
  }

  // --- statements ----------------------------------------------------------

  parseBlock(): Term {
    this.expect('{');
    this.pushScope();
    const stmts: Term[] = [];
    while (!this.at('}')) {
      if (this.peek().type === 'eof') throw new ParseError('unterminated block', this.peek());
      stmts.push(this.parseStatement());
    }
    this.popScope();
    this.expect('}');
    return b.block(...stmts);
  }

  private parseStatement(): Term {
    const docs = this.skipTrivia();
    const t = this.peek();

    if (t.type === 'ident') {
      switch (t.value) {
        case 'let': {
          this.pos++;
          const name = this.expectIdent();
          this.expect(':');
          const ty = this.parseType();
          this.expect('=');
          const init = this.parseExpression();
          this.accept(';');
          // The binder is introduced *after* its initializer is parsed, so
          // `let x = x` reads the outer `x`, as it does in the projection.
          return b.let_(this.bind(name), ty, init);
        }
        case 'if': {
          this.pos++;
          this.expect('(');
          const cond = this.parseExpression();
          this.expect(')');
          const then = this.parseBlock();
          if (!this.accept('else', 'ident')) return b.if_(cond, then);
          return b.if_(cond, then, this.parseBlock());
        }
        case 'while': {
          this.pos++;
          this.expect('(');
          const cond = this.parseExpression();
          this.expect(')');
          const tags = docs.map(parseDoc);
          const invariants = tags.flatMap((d) => d.invariants).map((src) => this.subExpression(src));
          const variants = tags.flatMap((d) => d.variants).map((src) => this.subExpression(src));
          const body = this.parseBlock();
          return b.while_(cond, body, {
            invariants,
            variant: variants[0] ?? null,
          });
        }
        case 'return': {
          this.pos++;
          const value = this.parseExpression();
          this.accept(';');
          return b.ret(value);
        }
        case 'assert': {
          this.pos++;
          this.expect('(');
          const expr = this.parseExpression();
          this.expect(',');
          const label = this.peek();
          if (label.type !== 'string') throw new ParseError('assert needs a label', label);
          this.pos++;
          this.expect(')');
          this.accept(';');
          return b.assert_(expr, label.value);
        }
        default: break;
      }
    }
    if (this.at('{')) return this.parseBlock();

    const expr = this.parseExpression();
    if (this.accept('=')) {
      const value = this.parseExpression();
      this.accept(';');
      return b.assign(this.toPlace(expr, t), value);
    }
    this.accept(';');
    return b.exprStmt(expr);
  }

  /**
   * Parse an expression that may mention `result` and `old(…)`, as contract
   * clauses do. Public so the specification DSL can share this grammar rather
   * than growing a second dialect of its own.
   */
  parseContractExpression(ensures: boolean): Term {
    this.inEnsures = ensures;
    const expr = this.parseExpression();
    if (this.peek().type !== 'eof') throw new ParseError('trailing input', this.peek());
    return expr;
  }

  /** Parse an expression fragment lifted out of a doc comment. */
  private subExpression(source: string, ensures = false): Term {
    const sub = new Parser(source, { ...this.opts, typeNames: this.types });
    sub.scope = this.scope;
    sub.inEnsures = ensures;
    for (const [name, ty] of this.typeEnv) sub.typeEnv.set(name, ty);
    const expr = sub.parseExpression();
    if (sub.peek().type !== 'eof') throw new ParseError('trailing input in doc comment', sub.peek());
    return expr;
  }

  private parseClause(source: string, ensures: boolean): Term {
    const match = /^\[([^\]]+)\]\s*(@property\s+)?(.*)$/.exec(source.trim());
    if (!match) throw new SyntaxError(`malformed contract clause: ${source}`);
    const [, label, property, body] = match;
    const rigor: Rigor = property ? 'property' : 'formal';
    return b.clause(this.subExpression(body, ensures), label, rigor);
  }

  private parseSurface(source: string): Term {
    const match = /^(\w+)\s*:\s*(choice\(([^)]*)\)|range\(([^)]*)\))\s+(\w+)\s*=\s*(.+)$/.exec(source.trim());
    if (!match) throw new SyntaxError(`malformed surface: ${source}`);
    const [, name, , choices, rangeArgs, objective, current] = match;
    const domain: SurfaceDomain = choices !== undefined
      ? { d: 'choice', options: choices.split(',').map((o) => o.trim()) }
      : (() => {
          const [min, max, step] = rangeArgs.split(',').map((x) => BigInt(x.trim()));
          return { d: 'range', min, max, step } as const;
        })();
    return b.surface({
      symbol: this.bind(name),
      domain,
      current: domain.d === 'choice' ? current.trim() : BigInt(current.trim()),
      objective: objective as never,
    });
  }

  // --- declarations --------------------------------------------------------

  parseModule(): Term {
    let moduleName = 'module';
    let provenance: ProvenanceId | null = null;
    const members: Term[] = [];

    for (;;) {
      const docs = this.skipTrivia();
      for (const doc of docs) {
        const moduleTag = /^\/\/\s*@module\s+(\S+)/.exec(doc);
        if (moduleTag) moduleName = moduleTag[1];
        const provTag = /^\/\/\s*@provenance\s+(\S+)/.exec(doc);
        if (provTag) provenance = provTag[1] as ProvenanceId;
      }
      if (this.peek().type === 'eof') break;
      members.push(this.parseDeclaration(docs));
    }

    return b.module_({
      symbol: this.bind(moduleName),
      members,
      symbolTable: this.opts.symbols.table(),
      provenance,
    });
  }

  parseDeclaration(docs: readonly string[] = this.skipTrivia()): Term {
    const tags = docs.map(parseDoc);
    const t = this.peek();
    if (t.type !== 'ident') throw new ParseError('expected a declaration', t);

    if (t.value === 'interface' || t.value === 'type') return this.parseTypeDeclaration(tags);
    if (t.value === 'pure' || t.value === 'function') return this.parseFunction(docs, tags);
    throw new ParseError(`expected a declaration, got ${t.value}`, t);
  }

  private parseTypeDeclaration(tags: readonly DocTags[]): Term {
    const nominal = tags.map((d) => d.nominal).find(Boolean) ?? null;
    const provenance = tags.map((d) => d.provenance).find(Boolean) ?? null;
    const keyword = this.expectIdent();
    const short = this.expectIdent();
    const long = nominal ?? (`type:projected:${short.toLowerCase()}` as TypeName);
    this.types.bind(short, long);

    if (keyword === 'interface') {
      this.expect('{');
      const fields: Array<readonly [string, Ty]> = [];
      while (!this.at('}')) {
        const name = this.expectIdent();
        this.expect(':');
        fields.push([name, this.parseType()]);
        this.accept(';');
      }
      this.expect('}');
      const ty: Ty = { t: 'Record', name: long, fields };
      this.typeEnv.set(short, ty);
      return b.typeDecl(long, ty, provenance);
    }

    this.expect('=');
    const repr = this.parseType();
    this.accept(';');
    const ty: Ty = { t: 'Nominal', name: long, repr };
    this.typeEnv.set(short, ty);
    return b.typeDecl(long, ty, provenance);
  }

  private parseFunction(docs: readonly string[], tags: readonly DocTags[]): Term {
    const pure = this.accept('pure', 'ident');
    this.expect('function', 'ident');
    const name = this.expectIdent();
    const symbol = this.bind(name);

    this.pushScope();
    this.expect('(');
    const params: Param[] = [];
    if (!this.at(')')) {
      do {
        const paramName = this.expectIdent();
        this.expect(':');
        const ty = this.parseType();
        params.push(b.param(this.bind(paramName), ty));
      } while (this.accept(','));
    }
    this.expect(')');
    this.expect(':');
    const returns = this.parseType();

    const surfaces = tags.flatMap((d) => d.surfaces).map((s) => this.parseSurface(s));
    const requires = tags.flatMap((d) => d.requires).map((s) => this.parseClause(s, false));
    const ensures = tags.flatMap((d) => d.ensures).map((s) => this.parseClause(s, true));
    const modifies = tags
      .flatMap((d) => d.modifies)
      .flatMap((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
      .map((p) => {
        const parsed = this.subExpression(p);
        return this.toPlace(parsed, this.peek());
      });
    const capabilities = tags.flatMap((d) => d.capabilities);
    const provenance = tags.map((d) => d.provenance).find(Boolean) ?? null;

    const hasContract = requires.length || ensures.length || modifies.length;
    const contract = hasContract ? b.contract({ requires, ensures, modifies }) : null;

    let body: Term | null = null;
    if (this.accept(';')) {
      this.skipTrivia(); // `// @unsynthesized`
    } else {
      body = this.parseBlock();
    }
    this.popScope();
    void docs;

    return b.fn({
      symbol,
      params,
      returns,
      capabilities,
      purity: pure ? 'pure' : 'effectful',
      contract,
      body,
      surfaces,
      provenance,
    });
  }
}

const PRECEDENCE: Record<BinOp, number> = {
  or: 1, and: 2,
  eq: 3, ne: 3,
  lt: 4, le: 4, gt: 4, ge: 4,
  add: 5, sub: 5, concat: 5,
  mul: 6, div: 6, mod: 6,
};

/** Parse a projected module back into an AST term. */
export function parseTypeScript(source: string, opts: ParseOptions): Term {
  return new Parser(source, opts).parseModule();
}

/** Parse a single expression, for the specification DSL and for tests. */
export function parseExpression(source: string, opts: ParseOptions): Term {
  const parser = new Parser(source, opts);
  return parser.parseExpression();
}

export { parseDoc };
