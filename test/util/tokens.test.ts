import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTokens, measureWithTokenizer } from '../../src/util/tokens.ts';

test('G3: the production tokenizer uses real cl100k BPE tables', () => {
  assert.equal(countTokens('hello world'), 2);
  assert.equal(measureWithTokenizer('hello world').tokens, 2);
  assert.ok(countTokens('sender.balance += amount') > 2);
});
