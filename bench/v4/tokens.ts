import { decode, encode, IrContext } from '../../src/tier1/agent-ir.ts';
import { buildLedgerExample } from '../../src/examples/ledger.ts';
import { projectTypeScript } from '../../src/projection/typescript.ts';
import { countTokens } from '../../src/util/tokens.ts';
import type { Term } from '../../src/tier1/ast.ts';
import * as b from '../../src/tier1/build.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { isDeepStrictEqual } from 'node:util';

export const TOKENIZER = { package: 'js-tiktoken', version: '1.0.21', encoding: 'cl100k_base' } as const;

export interface TokenPair {
  baseline: string;
  candidate: string;
}
export interface SessionMessage extends TokenPair {
  role: 'system' | 'user' | 'assistant' | 'tool';
  purpose: 'instructions' | 'initial_context' | 'change_request' | 'change' | 'repair' | 'failed_attempt' | 'response';
}
export interface TokenWorkload {
  id: string;
  description: string;
  cold: TokenPair;
  changes: Array<TokenPair & { id: string; body: string }>;
  session: SessionMessage[];
  sessionScope: string;
  training: { performed: false; tokens: 0; cost: 0 };
}
export interface TokenCounts { baseline: number; candidate: number; ratio: number | null }

export function aggregateCounts(pairs: ReadonlyArray<{ baseline: number; candidate: number }>): TokenCounts {
  let baseline = 0;
  let candidate = 0;
  for (const pair of pairs) {
    if (![pair.baseline, pair.candidate].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw new TypeError('Token counts must be nonnegative safe integers');
    }
    baseline += pair.baseline;
    candidate += pair.candidate;
  }
  if (!Number.isSafeInteger(baseline) || !Number.isSafeInteger(candidate)) throw new RangeError('Token count overflow');
  return { baseline, candidate, ratio: candidate === 0 ? null : baseline / candidate };
}

export function countPair(pair: TokenPair): TokenCounts {
  return aggregateCounts([{ baseline: countTokens(pair.baseline, TOKENIZER.encoding), candidate: countTokens(pair.candidate, TOKENIZER.encoding) }]);
}

/** The entire declared wire message is tokenized, including role and JSON framing.
 * This is an offline text protocol fixture, not a claim about proprietary API
 * chat templates, unseen reasoning tokens, or a live model's billed usage. */
export function sessionWire(message: SessionMessage, side: 'baseline' | 'candidate'): string {
  return JSON.stringify({ role: message.role, purpose: message.purpose, content: message[side] }) + '\n';
}

export function measureWorkload(workload: TokenWorkload) {
  const changes = workload.changes.map(change => ({
    id: change.id,
    body: countPair({ baseline: change.baseline, candidate: change.body }),
    message: countPair(change),
  }));
  const session = workload.session.map((message, index) => ({
    index, role: message.role, purpose: message.purpose,
    ...countPair({ baseline: sessionWire(message, 'baseline'), candidate: sessionWire(message, 'candidate') }),
  }));
  return {
    id: workload.id, cold: countPair(workload.cold), changes,
    warmBody: aggregateCounts(changes.map(change => change.body)),
    warmMessage: aggregateCounts(changes.map(change => change.message)),
    session, fullSession: aggregateCounts(session),
  };
}

/** Pinned baseline fixture. Warm diagnostics retransmit four declarations.
 * A separate complete session changes feeFor from gross/100 to gross/200,
 * records an executed failing attempt and the corrected result. Candidate
 * generation is deterministic, with no model/API costs claimed. Representative
 * autonomous change campaigns belong to V4-Q03/Q06. */
export function ledgerCorpus(): TokenWorkload[] {
  const ex = buildLedgerExample();
  const ctx = new IrContext();
  const cold = { baseline: projectTypeScript(ex.module, ex.syms, {}), candidate: encode(ex.module, ctx).text };
  const changes = (ex.module as Extract<Term, { kind: 'Module' }>).members
    .filter(member => member.kind === 'FunctionDecl').map(member => {
      const ir = encode(member, ctx);
      return { id: ex.syms.nameOf(member.symbol), baseline: projectTypeScript(member, ex.syms, {}), candidate: ir.text, body: ir.body };
    });
  const same = (content: string) => ({ baseline: content, candidate: content });
  const session: SessionMessage[] = [
    { role: 'system', purpose: 'instructions', ...same('Return complete updated declarations preserving contracts. Correct failed attempts using the reported execution results.') },
    { role: 'user', purpose: 'initial_context', ...cold },
    { role: 'user', purpose: 'change_request', ...same('Change feeFor to gross/200. For gross=1000 the fee must be 5. Preserve existing contracts.') },
  ];
  const module = ex.module as Extract<Term, { kind: 'Module' }>;
  const original = module.members.find(member => member.kind === 'FunctionDecl' && member.symbol === ex.symbols.feeFor);
  if (!original || original.kind !== 'FunctionDecl') throw new Error('feeFor fixture missing');
  const sessionEncoder = new IrContext();
  const sessionDecoder = new IrContext();
  decode(encode(ex.module, sessionEncoder).text, sessionDecoder);
  for (const [index, divisor] of [100, 200].entries()) {
    const candidate: typeof original = { ...original, body: b.block(b.ret(b.div(b.v(original.params[0].symbol), b.int(divisor)))) };
    const wire = encode(candidate, sessionEncoder).text;
    const decoded = decode(wire, sessionDecoder);
    if (!isDeepStrictEqual(decoded, candidate)) throw new Error('Change fixture failed IR round trip');
    const runtime = new Runtime({ registry: ex.capabilities, symbols: ex.syms });
    runtime.load({ ...module, members: module.members.map(member => member === original ? decoded : member) });
    const result = runtime.call(ex.symbols.feeFor, [1000n]);
    if (!result.ok) throw new Error('Change fixture violated an existing runtime contract');
    const actual = result.value;
    const accepted = actual === 5n;
    if (accepted !== (index === 1)) throw new Error('Change fixture outcome changed; version this corpus');
    session.push({ role: 'assistant', purpose: index === 0 ? 'failed_attempt' : 'repair', baseline: projectTypeScript(candidate, ex.syms, {}), candidate: wire });
    session.push({ role: 'tool', purpose: 'response', ...same(JSON.stringify({ input: '1000', expected: '5', actual: String(actual), accepted })) });
  }
  return [{
    id: 'ledger-baseline/1',
    description: 'Default buildLedgerExample(), unmodified TypeScript projections, AE1 streams, four warm declarations.',
    cold, changes, session,
    sessionScope: 'Complete offline JSONL change transcript. Includes initial instructions/context, feeFor change request, one executed failing attempt (10 instead of 5), repair and successful response (5). Deterministic candidate generator; no model inference, API billing, or training performed. Warm declaration diagnostics are measured separately.',
    training: { performed: false, tokens: 0, cost: 0 },
  }];
}
