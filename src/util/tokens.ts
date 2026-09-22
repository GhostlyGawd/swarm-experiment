/**
 * Token accounting.
 *
 * FR-1.2 states a token-reduction target, so the fabric needs a token metric it
 * can compute offline, deterministically and without a vendor tokenizer.
 * `estimateTokens` models byte-pair encoding as follows:
 *
 *   • a maximal alphanumeric run (identifier, keyword or number) costs one
 *     token per four characters, rounded up, minimum one. Modern BPE
 *     vocabularies average close to 3.5–4 characters per token on source code,
 *     and long identifiers are split into several sub-word tokens;
 *   • each punctuation character costs a token, except for the digraphs every
 *     practical vocabulary merges (`==`, `<=`, `=>`, …);
 *   • a newline costs a token; other whitespace is absorbed into the token
 *     that follows it, as leading-space merging does in practice.
 *
 * Known biases, stated so that no one reads more into a ratio than is there:
 * the model *overcharges* short common identifiers (a real vocabulary has a
 * single token for `balance`) and *overcharges* punctuation-dense text. The
 * first bias favours a compact IR; the second penalises it. It is applied
 * identically to both sides of every comparison, and anything that depends on
 * an exact count must use the real tokenizer of the model in question.
 */

import { getEncoding, type TiktokenEncoding } from 'js-tiktoken';

const DIGRAPHS = new Set(['==', '!=', '<=', '>=', '=>', '->', '&&', '||', '::', '++', '**', '//']);

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  let tokens = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      tokens++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue; // absorbed into the token that follows
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      tokens += Math.max(1, Math.ceil((j - i) / CHARS_PER_TOKEN));
      i = j;
      continue;
    }
    if (i + 1 < text.length && DIGRAPHS.has(text.slice(i, i + 2))) {
      tokens++;
      i += 2;
      continue;
    }
    tokens++;
    i++;
  }
  return tokens;
}

export interface SizeReport {
  readonly bytes: number;
  readonly tokens: number;
  readonly lines: number;
}

export function measure(text: string): SizeReport {
  return {
    bytes: new TextEncoder().encode(text).length,
    tokens: estimateTokens(text),
    lines: text.length === 0 ? 0 : text.split('\n').length,
  };
}

const tokenizers = new Map<TiktokenEncoding, ReturnType<typeof getEncoding>>();

/** Exact token count from the same BPE tables used by production model APIs. */
export function countTokens(text: string, encoding: TiktokenEncoding = 'cl100k_base'): number {
  let tokenizer = tokenizers.get(encoding);
  if (!tokenizer) {
    tokenizer = getEncoding(encoding);
    tokenizers.set(encoding, tokenizer);
  }
  return tokenizer.encode(text).length;
}

export function measureWithTokenizer(
  text: string,
  encoding: TiktokenEncoding = 'cl100k_base',
): SizeReport {
  return {
    bytes: new TextEncoder().encode(text).length,
    tokens: countTokens(text, encoding),
    lines: text.length === 0 ? 0 : text.split('\n').length,
  };
}
