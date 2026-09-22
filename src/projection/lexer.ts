/**
 * Tokenizer for the projected TypeScript subset.
 *
 * Doc comments are emitted as tokens rather than skipped: in a projection they
 * carry the contract, the capability list and the tunable surfaces, so throwing
 * them away would make the round trip lossy at exactly the points that matter.
 */

export type TokenType = 'ident' | 'number' | 'string' | 'punct' | 'doc' | 'line' | 'eof';

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly start: number;
  readonly line: number;
}

const PUNCTUATION = [
  '===', '!==', '<=', '>=', '&&', '||', '=>',
  '{', '}', '(', ')', '[', ']', '<', '>', '.', ',', ':', ';', '=', '+', '-', '*', '/', '%', '!', '?',
];

export class LexError extends SyntaxError {
  readonly position: number;
  readonly line: number;
  constructor(message: string, position: number, line: number) {
    super(`${message} (line ${line})`);
    this.position = position;
    this.line = line;
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  const push = (type: TokenType, value: string, start: number) =>
    tokens.push({ type, value, start, line });

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new LexError('unterminated block comment', i, line);
      const body = source.slice(i, end + 2);
      push('doc', body, i);
      line += body.split('\n').length - 1;
      i = end + 2;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      push('line', source.slice(i, end), i);
      i = end;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j++;
      push('ident', source.slice(i, j), i);
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9_]/.test(source[j])) j++;
      if (source[j] === 'n') j++; // bigint suffix
      push('number', source.slice(i, j), i);
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') {
          const escape = source[j + 1];
          out += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape;
          j += 2;
          continue;
        }
        out += source[j];
        j++;
      }
      if (j >= source.length) throw new LexError('unterminated string', i, line);
      push('string', out, i);
      i = j + 1;
      continue;
    }

    const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
    if (!punct) throw new LexError(`unexpected character ${JSON.stringify(ch)}`, i, line);
    push('punct', punct, i);
    i += punct.length;
  }

  tokens.push({ type: 'eof', value: '', start: source.length, line });
  return tokens;
}
