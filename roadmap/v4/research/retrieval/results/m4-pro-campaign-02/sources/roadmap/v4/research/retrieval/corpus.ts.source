/** Labels and AST fixtures are authored before model inference; no generated
 * relevance judgments or benchmark-driven label adjustment. */
import * as b from '../../../../src/tier1/build.ts';
import { capability } from '../../../../src/tier1/ids.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import type { Term, Ty } from '../../../../src/tier1/ast.ts';
export function retrievalCorpus() {
  const symbols = new SymbolSpace('aether-t104-labeled-corpus-v1');
  const declarations: { label: string; term: Term }[] = [];
  const define = (label: string, parameters: [string, Ty][], returns: Ty, body: (vars: Term[]) => Term, effectful = false) => {
    const symbol = symbols.define(label), params = parameters.map(([name, ty]) => ({ symbol: symbols.define(name), ty }));
    declarations.push({ label, term: b.fn({ symbol, params, returns, capabilities: effectful ? [capability('cap:test:log')] : [], purity: effectful ? 'effectful' : 'pure', body: b.block(b.ret(body(params.map(param => b.v(param.symbol))))) }) });
  };
  const int = b.Int, str = b.Str, seq: Ty = { t: 'Seq', element: b.Int };
  define('addServiceFee', [['price', int], ['serviceFee', int]], int, ([price, fee]) => b.add(price, fee));
  define('percentageFee', [['amount', int], ['percentage', int]], int, ([amount, rate]) => b.div(b.mul(amount, rate), b.int(100)));
  define('discountedTotal', [['price', int], ['discount', int]], int, ([price, discount]) => b.sub(price, discount));
  define('remainingRequestTokens', [['tokens', int], ['requestCost', int]], int, ([tokens, cost]) => b.sub(tokens, cost));
  define('refillRequestTokens', [['tokens', int], ['elapsedSeconds', int], ['tokensPerSecond', int]], int, ([tokens, elapsed, rate]) => b.add(tokens, b.mul(elapsed, rate)));
  define('allowedRequestCost', [['tokens', int], ['requestCost', int]], b.Bool, ([tokens, cost]) => b.ge(tokens, cost));
  define('clipToLowerBound', [['value', int], ['lowerBound', int]], int, ([value, lower]) => b.cond(b.lt(value, lower), lower, value));
  define('clipToUpperBound', [['value', int], ['upperBound', int]], int, ([value, upper]) => b.cond(b.gt(value, upper), upper, value));
  define('clampToRange', [['value', int], ['lowerBound', int], ['upperBound', int]], int, ([value, lower, upper]) => b.cond(b.lt(value, lower), lower, b.cond(b.gt(value, upper), upper, value)));
  define('millisecondsFromSeconds', [['seconds', int]], int, ([seconds]) => b.mul(seconds, b.int(1000)));
  define('secondsFromMinutes', [['minutes', int]], int, ([minutes]) => b.mul(minutes, b.int(60)));
  define('hoursFromDays', [['days', int]], int, ([days]) => b.mul(days, b.int(24)));
  define('stringToLowercase', [['text', str]], str, ([text]) => ({ kind: 'StringOp', op: 'lower', args: [text] }));
  define('stringToUppercase', [['text', str]], str, ([text]) => ({ kind: 'StringOp', op: 'upper', args: [text] }));
  define('trimWhitespace', [['text', str]], str, ([text]) => ({ kind: 'StringOp', op: 'trim', args: [text] }));
  define('joinStrings', [['prefix', str], ['suffix', str]], str, ([prefix, suffix]) => b.concat(prefix, suffix));
  define('textContains', [['text', str], ['substring', str]], b.Bool, ([text, substring]) => ({ kind: 'StringOp', op: 'contains', args: [text, substring] }));
  define('textLength', [['text', str]], int, ([text]) => ({ kind: 'StringOp', op: 'strlen', args: [text] }));
  define('sequenceItemCount', [['items', seq]], int, ([items]) => ({ kind: 'SeqLength', sequence: items }));
  define('firstSequenceItem', [['items', seq]], int, ([items]) => ({ kind: 'SeqIndex', sequence: items, index: b.int(0) }));
  define('sumTwoIntegers', [['firstNumber', int], ['secondNumber', int]], int, ([a, z]) => b.add(a, z));
  define('celsiusToFahrenheit', [['celsius', int]], int, ([celsius]) => b.add(b.div(b.mul(celsius, b.int(9)), b.int(5)), b.int(32)));
  define('squareInteger', [['value', int]], int, ([value]) => b.mul(value, value));
  define('absoluteInteger', [['value', int]], int, ([value]) => b.cond(b.lt(value, b.int(0)), b.sub(b.int(0), value), value));
  for (const label of ['logMessage', 'auditPayment', 'logRateLimit', 'persistText']) define(label, [['message', str]], b.Unit, ([message]) => b.invoke(capability('cap:test:log'), message), true);
  return { symbols, declarations, module: b.module_({ symbol: symbols.define('utilityLibrary'), members: declarations.map(row => row.term), symbolTable: symbols.table() }) };
}
export const LABELED_QUERIES = [
  { text: 'calculate a percentage transaction fee', relevant: ['percentageFee'] },
  { text: 'add a service charge to the purchase price', relevant: ['addServiceFee'] },
  { text: 'subtract a discount from the total price', relevant: ['discountedTotal'] },
  { text: 'how many rate limit tokens remain after a request', relevant: ['remainingRequestTokens'] },
  { text: 'replenish a token bucket according to elapsed time', relevant: ['refillRequestTokens'] },
  { text: 'check whether the request has enough available tokens', relevant: ['allowedRequestCost'] },
  { text: 'prevent a number from going below a lower bound', relevant: ['clipToLowerBound', 'clampToRange'] },
  { text: 'limit a number to a maximum upper bound', relevant: ['clipToUpperBound', 'clampToRange'] },
  { text: 'clamp an integer inside a minimum and maximum range', relevant: ['clampToRange'] },
  { text: 'convert seconds into milliseconds', relevant: ['millisecondsFromSeconds'] },
  { text: 'convert minutes into seconds', relevant: ['secondsFromMinutes'] },
  { text: 'convert days into hours', relevant: ['hoursFromDays'] },
  { text: 'make all letters in a string lowercase', relevant: ['stringToLowercase'] },
  { text: 'capitalize all letters in text', relevant: ['stringToUppercase'] },
  { text: 'remove surrounding whitespace from a string', relevant: ['trimWhitespace'] },
  { text: 'concatenate a string prefix and suffix', relevant: ['joinStrings'] },
  { text: 'test if text includes a substring', relevant: ['textContains'] },
  { text: 'count characters in text', relevant: ['textLength'] },
  { text: 'count the number of items in a list', relevant: ['sequenceItemCount'] },
  { text: 'retrieve the first element of a sequence', relevant: ['firstSequenceItem'] },
  { text: 'sum two integer numbers', relevant: ['sumTwoIntegers'] },
  { text: 'convert a temperature from Celsius to Fahrenheit', relevant: ['celsiusToFahrenheit'] },
  { text: 'multiply a number by itself', relevant: ['squareInteger'] },
  { text: 'find the absolute magnitude of a signed integer', relevant: ['absoluteInteger'] },
] as const;
