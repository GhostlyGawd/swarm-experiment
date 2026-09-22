/**
 * Executable product specifications (FR-2.1).
 *
 * The Specifier persona writes business rules, not code. A rule here is a
 * *single* statement of intent that compiles into three things at once:
 *
 *   • contract clauses attached to the function the rule governs, which the
 *     Tier-2 verifier must discharge before any implementation ships,
 *   • enforcement artifacts for each layer the rule names — a client-side
 *     guard, an API gateway check, a persistence constraint,
 *   • a provenance record, so every node derived from the rule can be found
 *     again when the rule changes (FR-1.3).
 *
 * The point of compiling rather than documenting: a rule cannot drift out of
 * sync with the three places it is enforced, because there is only one place it
 * is written. Changing it invalidates every derived subtree by construction.
 *
 * ### Grammar
 *
 * ```
 * spec := "spec" IDENT "{" rule* "}"
 * rule := "rule" STRING "on" IDENT "{" clause* "}"
 * clause := "given" EXPR ";"            -- a precondition
 *         | "then" EXPR ";"             -- a postcondition
 *         | "changes" PLACE ("," PLACE)* ";"
 *         | "enforce" LAYER ("," LAYER)* ";"
 *         | "rigor" ("formal" | "property") ";"
 *         | "because" STRING ";"        -- rationale, kept as provenance
 *         | "guard" ("advisory"|"required"|"architectural") ";"
 * ```
 */

import { Parser, ParseError } from '../projection/parse.ts';
import { tokenize, type Token } from '../projection/lexer.ts';
import { TypeNames } from '../projection/names.ts';
import { TypeScriptProjector } from '../projection/typescript.ts';
import * as b from '../tier1/build.ts';
import type { Rigor, Term, Ty } from '../tier1/ast.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import type { InvariantId, SymbolId } from '../tier1/ids.ts';
import { blake3Hex } from '../tier1/blake3.ts';
import type { GuardPriority, ProvenanceLedger } from '../tier1/provenance.ts';

export type Layer = 'client' | 'gateway' | 'persistence';

const LAYERS: ReadonlySet<string> = new Set<Layer>(['client', 'gateway', 'persistence']);

export interface SpecRule {
  readonly label: string;
  readonly target: string;
  readonly given: readonly Term[];
  readonly then: readonly Term[];
  readonly changes: readonly Term[];
  readonly enforce: readonly Layer[];
  readonly rigor: Rigor;
  readonly rationale: string | null;
  readonly guard: GuardPriority | null;
  /** Stable identity of the rule, derived from its text. */
  readonly invariant: InvariantId;
}

export interface ProductSpec {
  readonly name: string;
  readonly rules: readonly SpecRule[];
}

export interface SpecContext {
  readonly symbols: SymbolSpace;
  readonly bindings: ReadonlyMap<string, SymbolId>;
  readonly types?: ReadonlyMap<string, Ty>;
  readonly typeNames?: TypeNames;
}

/**
 * Parse a specification.
 *
 * Rule expressions are parsed by the same grammar as the projection, so a
 * product manager's `sender.balance >= amount` and an engineer's are literally
 * the same parser — there is no second dialect to keep in step.
 */
export function parseSpec(source: string, ctx: SpecContext): ProductSpec {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = (): Token => tokens[Math.min(pos, tokens.length - 1)];
  const next = (): Token => tokens[pos++];
  const at = (value: string): boolean => {
    const t = peek();
    return (t.type === 'ident' || t.type === 'punct') && t.value === value;
  };
  const expect = (value: string): Token => {
    if (!at(value)) throw new ParseError(`expected ${JSON.stringify(value)}`, peek());
    return next();
  };
  const expectString = (): string => {
    const t = peek();
    if (t.type !== 'string') throw new ParseError('expected a quoted string', t);
    pos++;
    return t.value;
  };
  const expectIdent = (): string => {
    const t = peek();
    if (t.type !== 'ident') throw new ParseError('expected an identifier', t);
    pos++;
    return t.value;
  };

  /** Collect raw source between here and a terminator, then parse it. */
  const expressionUntil = (terminator: string, ensures: boolean): Term[] => {
    const parts: Term[][] = [];
    let start = peek().start;
    const chunks: string[] = [];
    while (!at(terminator)) {
      if (peek().type === 'eof') throw new ParseError(`expected ${terminator}`, peek());
      if (at(',')) {
        chunks.push(source.slice(start, peek().start));
        next();
        start = peek().start;
        continue;
      }
      next();
    }
    chunks.push(source.slice(start, peek().start));
    expect(terminator);
    for (const chunk of chunks) {
      const text = chunk.trim();
      if (!text) continue;
      const parser = new Parser(ensures ? `${text}` : text, {
        symbols: ctx.symbols,
        bindings: ctx.bindings,
        types: ctx.types,
        typeNames: ctx.typeNames,
      });
      parts.push([parser.parseContractExpression(ensures)]);
    }
    return parts.flat();
  };

  expect('spec');
  const name = expectIdent();
  expect('{');

  const rules: SpecRule[] = [];
  while (!at('}')) {
    if (peek().type === 'eof') throw new ParseError('unterminated spec', peek());
    expect('rule');
    const label = expectString();
    expect('on');
    const target = expectIdent();
    expect('{');

    const given: Term[] = [];
    const then: Term[] = [];
    const changes: Term[] = [];
    let enforce: Layer[] = [];
    let rigor: Rigor = 'formal';
    let rationale: string | null = null;
    let guard: GuardPriority | null = null;

    while (!at('}')) {
      const keyword = expectIdent();
      switch (keyword) {
        case 'given': given.push(...expressionUntil(';', false)); break;
        case 'then': then.push(...expressionUntil(';', true)); break;
        case 'changes': changes.push(...expressionUntil(';', false)); break;
        case 'enforce': {
          enforce = [];
          do {
            const layer = expectIdent();
            if (!LAYERS.has(layer)) throw new ParseError(`unknown layer ${layer}`, peek());
            enforce.push(layer as Layer);
          } while (at(',') && next());
          expect(';');
          break;
        }
        case 'rigor': {
          const value = expectIdent();
          if (value !== 'formal' && value !== 'property') {
            throw new ParseError('rigor must be formal or property', peek());
          }
          rigor = value;
          expect(';');
          break;
        }
        case 'because':
          rationale = expectString();
          expect(';');
          break;
        case 'guard': {
          const value = expectIdent();
          if (value !== 'advisory' && value !== 'required' && value !== 'architectural') {
            throw new ParseError('guard must be advisory, required or architectural', peek());
          }
          guard = value;
          expect(';');
          break;
        }
        default:
          throw new ParseError(`unknown rule clause ${keyword}`, peek());
      }
    }
    expect('}');

    rules.push({
      label,
      target,
      given,
      then,
      changes: changes.map(toPlace),
      enforce: enforce.length ? enforce : ['gateway'],
      rigor,
      rationale,
      guard,
      invariant: `inv:b3:${blake3Hex(`${name}/${target}/${label}`)}` as InvariantId,
    });
  }
  expect('}');

  return { name, rules };
}

function toPlace(expr: Term): Term {
  const path: string[] = [];
  let cursor = expr;
  while (cursor.kind === 'Field') {
    path.unshift(cursor.field);
    cursor = cursor.object;
  }
  if (cursor.kind !== 'Var') throw new TypeError('a `changes` entry must be a place expression');
  return b.place(cursor.symbol, ...path);
}

// ---------------------------------------------------------------------------
// compilation
// ---------------------------------------------------------------------------

export interface EnforcementArtifact {
  readonly layer: Layer;
  readonly rule: string;
  /** Generated source, in the idiom of that layer. */
  readonly code: string;
}

export interface CompiledSpec {
  readonly spec: ProductSpec;
  /** Contract to merge into each target function, keyed by function name. */
  readonly contracts: ReadonlyMap<string, Term>;
  readonly artifacts: readonly EnforcementArtifact[];
  /** Provenance ids, one per rule, for FR-1.3 invalidation. */
  readonly provenance: ReadonlyMap<string, string>;
}

/**
 * Compile a spec into contracts, per-layer enforcement and provenance.
 *
 * Note what a rule turns into at each layer: the *same* predicate, projected
 * into that layer's idiom. The client refuses to dispatch, the gateway rejects
 * with a stable error code, and the store refuses to persist. Three defences,
 * one statement of intent, no opportunity for them to disagree.
 */
export function compileSpec(
  spec: ProductSpec,
  ctx: SpecContext,
  ledger?: ProvenanceLedger,
): CompiledSpec {
  const projector = new TypeScriptProjector(ctx.symbols, { typeNames: ctx.typeNames });
  const contracts = new Map<string, Term>();
  const artifacts: EnforcementArtifact[] = [];
  const provenance = new Map<string, string>();

  const byTarget = new Map<string, SpecRule[]>();
  for (const rule of spec.rules) {
    byTarget.set(rule.target, [...(byTarget.get(rule.target) ?? []), rule]);
  }

  for (const [target, rules] of byTarget) {
    contracts.set(
      target,
      b.contract({
        requires: rules.flatMap((r) =>
          r.given.map((g, i) => b.clause(g, `${slug(r.label)}_given_${i}`, r.rigor))),
        ensures: rules.flatMap((r) =>
          r.then.map((t, i) => b.clause(t, `${slug(r.label)}_then_${i}`, r.rigor))),
        modifies: rules.flatMap((r) => r.changes),
      }),
    );
  }

  for (const rule of spec.rules) {
    if (ledger) {
      provenance.set(
        rule.label,
        ledger.record({
          intent: rule.label,
          origin: { kind: 'spec_clause', ref: `${spec.name}/${rule.target}`, actor: 'product' },
          specClauses: [rule.invariant],
          reasoning: rule.rationale ? [rule.rationale] : [],
          guard: rule.guard
            ? {
                invariant: rule.invariant,
                priority: rule.guard,
                rationale: rule.rationale ?? rule.label,
              }
            : undefined,
        }),
      );
    }

    const predicate = rule.given.length
      ? rule.given.map((g) => projector.expr(g)).join(' && ')
      : 'true';

    for (const layer of rule.enforce) {
      artifacts.push({ layer, rule: rule.label, code: renderLayer(layer, rule, predicate, projector) });
    }
  }

  return { spec, contracts, artifacts, provenance };
}

const slug = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);

function renderLayer(
  layer: Layer,
  rule: SpecRule,
  predicate: string,
  projector: TypeScriptProjector,
): string {
  const code = slug(rule.label).toUpperCase();
  switch (layer) {
    case 'client':
      return [
        `// ${rule.label}`,
        `export function can${pascal(rule.target)}(${'…args'}: Args): Guard {`,
        `  if (!(${predicate})) {`,
        `    return { allowed: false, reason: ${JSON.stringify(rule.label)}, code: ${JSON.stringify(code)} };`,
        '  }',
        '  return { allowed: true };',
        '}',
      ].join('\n');
    case 'gateway':
      return [
        `// ${rule.label}`,
        `gateway.precondition(${JSON.stringify(rule.target)}, {`,
        `  code: ${JSON.stringify(code)},`,
        `  status: 422,`,
        `  check: (args) => ${predicate},`,
        `  invariant: ${JSON.stringify(rule.invariant)},`,
        '});',
      ].join('\n');
    case 'persistence': {
      const touched = rule.changes.map((p) => projector.expr(p)).join(', ');
      return [
        `-- ${rule.label}`,
        `ALTER TABLE ${rule.target.toLowerCase()}`,
        `  ADD CONSTRAINT ${slug(rule.label)}`,
        `  CHECK (${toSql(predicate)});`,
        touched ? `-- writes: ${touched}` : '-- writes: (none declared)',
      ].join('\n');
    }
  }
}

const pascal = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** A deliberately small translation: enough for comparisons, no more. */
const toSql = (predicate: string): string =>
  predicate
    .replace(/&&/g, ' AND ')
    .replace(/\|\|/g, ' OR ')
    .replace(/===/g, ' = ')
    .replace(/!==/g, ' <> ')
    .replace(/(\d)n\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
