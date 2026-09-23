/** Versioned wire encoding. Deliberately independent of immutable v1 AST encoding. */
import { types as nodeTypes } from 'node:util';
export interface EncodingLimits {
  maxFrameBytes: number;
  maxDecompressedBytes: number;
  maxObjects: number;
  maxDepth: number;
  maxIntegerDigits: number;
}
export const DEFAULT_ENCODING_LIMITS: Readonly<EncodingLimits> = Object.freeze({
  maxFrameBytes: 8 * 1024 * 1024, maxDecompressedBytes: 8 * 1024 * 1024,
  maxObjects: 100_000, maxDepth: 64, maxIntegerDigits: 4096,
});
export type WireValue = null | boolean | number | string | readonly WireValue[] | { readonly [key: string]: WireValue };
export function encodingLimits(overrides: Partial<EncodingLimits> = {}): EncodingLimits {
  const limits = { ...DEFAULT_ENCODING_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_ENCODING_LIMITS) || !Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid encoding limits');
  }
  // Prevent caller-supplied recursion limits from overflowing the reference implementation stack.
  if (limits.maxDepth > 256) throw new RangeError('maximum supported depth is 256');
  return limits;
}
export function validString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) throw new TypeError('expected well-formed UTF-8 string');
}
export function identifier(value: unknown): asserts value is string {
  validString(value);
  if (!value.length || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('invalid identifier');
}
export function decimal(value: unknown, limits: EncodingLimits = DEFAULT_ENCODING_LIMITS, signed = false): asserts value is string {
  if (typeof value !== 'string' || !(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)) throw new TypeError('invalid canonical decimal');
  if (value.replace('-', '').length > limits.maxIntegerDigits) throw new RangeError('integer digit limit exceeded');
}
export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (nodeTypes.isProxy(value)) throw new TypeError('proxy objects are not canonical data');
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('expected plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(descriptors, k)) || Object.values(descriptors).some(d => !('value' in d) || !d.enumerable)) throw new TypeError('unknown, missing or accessor object fields');
  return value as Record<string, unknown>;
}

/** Rejects accessors/resources, unsafe numeric values, cycles and size excess before output. */
export function encodeCanonical(value: unknown, overrides: Partial<EncodingLimits> = {}): Uint8Array {
  const limits = encodingLimits(overrides);
  let count = 0, bytes = 0;
  const active = new Set<object>();
  const chunks: string[] = [];
  const put = (text: string): void => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > Math.min(limits.maxFrameBytes, limits.maxDecompressedBytes)) throw new RangeError('frame byte limit exceeded');
    chunks.push(text);
  };
  const visit = (v: unknown, depth: number): void => {
    if (depth > limits.maxDepth || ++count > limits.maxObjects) throw new RangeError('depth or object limit exceeded');
    if (v === null || typeof v === 'boolean') { put(String(v)); return; }
    if (typeof v === 'string') {
      if (v.length > Math.min(limits.maxFrameBytes, limits.maxDecompressedBytes)) throw new RangeError('frame byte limit exceeded');
      validString(v); put(JSON.stringify(v)); return;
    }
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new TypeError('unsafe integer conversion');
      decimal(String(v), limits, true); put(String(v)); return;
    }
    if (typeof v !== 'object') throw new TypeError('unsupported wire value');
    if (nodeTypes.isProxy(v)) throw new TypeError('proxy objects are not canonical data');
    if (active.has(v)) throw new TypeError('cycles must use logical references');
    active.add(v);
    if (Array.isArray(v)) {
      if (v.length > limits.maxObjects || Object.keys(v).length !== v.length || Reflect.ownKeys(v).length !== v.length + 1) throw new TypeError('invalid or oversized array');
      put('[');
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !('value' in d)) throw new TypeError('array accessor or hole');
        if (i) put(','); visit(d.value, depth + 1);
      }
      put(']');
    } else {
      const keys = Object.keys(v).sort(); exactObject(v, keys);
      if (keys.length > limits.maxObjects) throw new RangeError('object limit exceeded');
      put('{');
      keys.forEach((k, i) => {
        if (k.length > Math.min(limits.maxFrameBytes, limits.maxDecompressedBytes)) throw new RangeError('frame byte limit exceeded');
        validString(k); if (i) put(','); put(JSON.stringify(k)); put(':'); visit((v as Record<string, unknown>)[k], depth + 1);
      });
      put('}');
    }
    active.delete(v);
  };
  visit(value, 0);
  return new TextEncoder().encode(chunks.join(''));
}

/** Parses without JSON.parse's silent duplicate-key loss; limits apply during parsing. */
export function decodeCanonical(input: Uint8Array, overrides: Partial<EncodingLimits> = {}): WireValue {
  const limits = encodingLimits(overrides);
  if (input.byteLength > Math.min(limits.maxFrameBytes, limits.maxDecompressedBytes)) throw new RangeError('frame byte limit exceeded');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  let pos = 0, count = 0;
  const ws = (): void => { while (/^[\x20\t\r\n]$/.test(text[pos] ?? '')) pos++; };
  const string = (): string => {
    const start = pos++;
    while (pos < text.length) {
      const c = text[pos++];
      if (c === '\\') { pos++; continue; }
      if (c === '"') { const value: unknown = JSON.parse(text.slice(start, pos)); validString(value); return value; }
    }
    throw new TypeError('unterminated string');
  };
  const parse = (depth: number): WireValue => {
    if (depth > limits.maxDepth || ++count > limits.maxObjects) throw new RangeError('depth or object limit exceeded');
    ws(); const c = text[pos];
    if (c === '"') return string();
    if (c === '[' || c === '{') {
      pos++; ws(); const end = c === '[' ? ']' : '}';
      const array: WireValue[] = []; const object: Record<string, WireValue> = Object.create(null);
      if (text[pos] === end) { pos++; return c === '[' ? array : object; }
      for (;;) {
        if (c === '[') array.push(parse(depth + 1));
        else {
          ws(); if (text[pos] !== '"') throw new TypeError('expected object key');
          const key = string(); if (Object.hasOwn(object, key)) throw new TypeError('duplicate object key');
          ws(); if (text[pos++] !== ':') throw new TypeError('expected colon');
          object[key] = parse(depth + 1);
        }
        ws(); if (text[pos] === end) { pos++; return c === '[' ? array : object; }
        if (text[pos++] !== ',') throw new TypeError('expected delimiter');
      }
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, pos)) { pos += literal.length; return value; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(pos));
    if (!match) throw new TypeError('invalid JSON value');
    decimal(match[0], limits, true); const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || Object.is(number, -0)) throw new TypeError('unsafe integer conversion');
    pos += match[0].length; return number;
  };
  const value = parse(0); ws(); if (pos !== text.length) throw new TypeError('trailing or nonintegral data');
  return value;
}

export interface LogicalRefV1 { readonly heapId: string; readonly objectId: string; readonly ownerEpoch: string }
export type TaggedValueV1 =
  | { readonly tag: 'null' }
  | { readonly tag: 'bool'; readonly value: boolean }
  | { readonly tag: 'string'; readonly value: string }
  | { readonly tag: 'int'; readonly value: string }
  | { readonly tag: 'sequence'; readonly items: readonly TaggedValueV1[] }
  | { readonly tag: 'result'; readonly variant: 'ok' | 'err'; readonly value: TaggedValueV1 }
  | { readonly tag: 'ref'; readonly value: LogicalRefV1 }
  | { readonly tag: 'authority'; readonly authorityId: string; readonly policyEpoch: string };

export function validateLogicalRef(value: unknown, limits: EncodingLimits = DEFAULT_ENCODING_LIMITS): asserts value is LogicalRefV1 {
  const ref = exactObject(value, ['heapId', 'objectId', 'ownerEpoch']); identifier(ref.heapId); decimal(ref.objectId, limits); decimal(ref.ownerEpoch, limits);
}
/** Structural validation only: authority references still require policy/epoch reissuance by the destination. */
export function validateTaggedValue(value: unknown, overrides: Partial<EncodingLimits> = {}): asserts value is TaggedValueV1 {
  const limits = encodingLimits(overrides); encodeCanonical(value, limits);
  const check = (v: unknown): void => {
    if (!v || typeof v !== 'object') throw new TypeError('invalid tagged value');
    const tag = (v as { tag?: unknown }).tag;
    if (tag === 'null') { exactObject(v, ['tag']); return; }
    if (tag === 'authority') { const x = exactObject(v, ['tag', 'authorityId', 'policyEpoch']); identifier(x.authorityId); decimal(x.policyEpoch, limits); return; }
    if (tag === 'sequence') { const x = exactObject(v, ['tag', 'items']); if (!Array.isArray(x.items)) throw new TypeError('invalid sequence'); x.items.forEach(check); return; }
    const x = exactObject(v, tag === 'result' ? ['tag', 'variant', 'value'] : ['tag', 'value']);
    switch (tag) {
      case 'bool': if (typeof x.value !== 'boolean') throw new TypeError('invalid boolean'); break;
      case 'string': validString(x.value); break;
      case 'int': decimal(x.value, limits, true); break;
      case 'ref': validateLogicalRef(x.value, limits); break;
      case 'result': if (x.variant !== 'ok' && x.variant !== 'err') throw new TypeError('invalid result'); check(x.value); break;
      default: throw new TypeError('unknown tagged value');
    }
  };
  check(value);
}

export function encodeTaggedValue(value: TaggedValueV1, limits: Partial<EncodingLimits> = {}): Uint8Array {
  validateTaggedValue(value, limits); return encodeCanonical({ format: 'aether.value/1', value }, limits);
}
export function decodeTaggedValue(bytes: Uint8Array, limits: Partial<EncodingLimits> = {}): TaggedValueV1 {
  const envelope = exactObject(decodeCanonical(bytes, limits), ['format', 'value']);
  if (envelope.format !== 'aether.value/1') throw new TypeError('unsupported value version');
  validateTaggedValue(envelope.value, limits); return envelope.value;
}
