/** Versioned, audience-bound object-capability grants.
 *
 * The issuer is a trusted host component. A token holder cannot mint or widen
 * grants; attenuation is performed by the issuer after checking the declared
 * call edge. Sinks must call verify immediately before each external action.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeCanonical, exactObject, identifier, decimal } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { capability, type CapabilityName } from '../tier1/ids.ts';

export interface GrantBodyV2 {
  readonly format: 'aether.capability-grant/2';
  readonly repositoryId: string;
  readonly capability: CapabilityName;
  readonly audience: string;
  /** Hierarchical resource components; [] names the whole capability domain. */
  readonly path: readonly string[];
  readonly policyEpoch: string;
  readonly revocationEpoch: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly parent: Digest | null;
}
export interface ScopedGrantV2 { readonly body: GrantBodyV2; readonly id: Digest; readonly signature: string }
export interface GrantRequestV2 { readonly capability: CapabilityName; readonly audience: string; readonly path: readonly string[] }
export interface GrantAuthorityOptions {
  readonly key: Uint8Array;
  readonly repositoryId: string;
  readonly clock: () => number;
  readonly policyEpoch: () => string;
  /** Must advance for every applicable global/scoped revocation or restore. */
  readonly revocationEpoch: (capability: CapabilityName, path: readonly string[]) => string;
  readonly isRevoked: (capability: CapabilityName, path: readonly string[]) => boolean;
  readonly authorizeIssue: (request: GrantRequestV2) => boolean;
  /** Trusted call-graph policy, checked before a token changes audience. */
  readonly authorizeDelegate: (from: string, to: string, capability: CapabilityName) => boolean;
  readonly maxTtlMs?: number;
}
const TOKEN_FIELDS = ['body', 'id', 'signature'];
const BODY_FIELDS = ['format', 'repositoryId', 'capability', 'audience', 'path', 'policyEpoch', 'revocationEpoch', 'issuedAt', 'expiresAt', 'nonce', 'parent'];
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function path(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(part => typeof part !== 'string' || !SEGMENT.test(part) || part === '.' || part === '..')) throw new TypeError('invalid capability resource path');
}
function epoch(value: unknown): asserts value is string { decimal(value); }
function validateBody(value: unknown): asserts value is GrantBodyV2 {
  encodeCanonical(value);
  const body = exactObject(value, BODY_FIELDS);
  if (body.format !== 'aether.capability-grant/2') throw new TypeError('unsupported capability grant version');
  identifier(body.repositoryId); identifier(body.audience); capability(body.capability as string); path(body.path);
  epoch(body.policyEpoch); epoch(body.revocationEpoch);
  if (!Number.isSafeInteger(body.issuedAt) || !Number.isSafeInteger(body.expiresAt) || (body.issuedAt as number) < 0 || (body.expiresAt as number) <= (body.issuedAt as number)) throw new TypeError('invalid capability grant lifetime');
  if (typeof body.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(body.nonce)) throw new TypeError('invalid capability grant nonce');
  if (body.parent !== null) validateDigest(body.parent, 'aether.capability-grant/2');
}
export function validateScopedGrant(value: unknown): asserts value is ScopedGrantV2 {
  encodeCanonical(value);
  const token = exactObject(value, TOKEN_FIELDS); validateBody(token.body);
  validateDigest(token.id, 'aether.capability-grant/2');
  if (token.id !== domainDigest('aether.capability-grant/2', token.body)) throw new TypeError('capability grant identity mismatch');
  if (typeof token.signature !== 'string' || !/^[0-9a-f]{64}$/.test(token.signature)) throw new TypeError('invalid capability grant signature');
}
function prefix(parent: readonly string[], child: readonly string[]): boolean {
  return parent.length <= child.length && parent.every((part, index) => part === child[index]);
}

export class ScopedGrantAuthority {
  readonly repositoryId: string;
  private readonly key: Buffer;
  private readonly options: GrantAuthorityOptions;
  private readonly maxTtlMs: number;
  constructor(options: GrantAuthorityOptions) {
    identifier(options.repositoryId);
    if (!(options.key instanceof Uint8Array) || options.key.byteLength < 32) throw new TypeError('capability grant key must contain 32 bytes');
    this.repositoryId = options.repositoryId;
    this.key = Buffer.from(options.key); this.options = options; this.maxTtlMs = options.maxTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.maxTtlMs) || this.maxTtlMs < 1) throw new TypeError('invalid capability grant TTL profile');
  }
  private now(): number {
    const value = this.options.clock(); if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid grant clock'); return value;
  }
  private signature(body: GrantBodyV2): Buffer {
    return createHmac('sha256', this.key).update(encodeCanonical({ domain: 'aether.capability-grant-signature/2', body })).digest();
  }
  private seal(body: GrantBodyV2): ScopedGrantV2 {
    validateBody(body);
    return { body, id: domainDigest('aether.capability-grant/2', body), signature: this.signature(body).toString('hex') };
  }
  private currentEpochs(cap: CapabilityName, resource: readonly string[]): { policyEpoch: string; revocationEpoch: string } {
    const policyEpoch = this.options.policyEpoch(), revocationEpoch = this.options.revocationEpoch(cap, resource);
    epoch(policyEpoch); epoch(revocationEpoch); return { policyEpoch, revocationEpoch };
  }
  issue(request: GrantRequestV2, ttlMs: number): ScopedGrantV2 {
    const r = exactObject(request, ['capability', 'audience', 'path']); capability(r.capability as string); identifier(r.audience); path(r.path);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > this.maxTtlMs) throw new TypeError('invalid capability grant lifetime');
    if (this.options.isRevoked(request.capability, request.path) !== false || this.options.authorizeIssue(request) !== true) throw new Error('capability grant issuance denied');
    const issuedAt = this.now(), expiresAt = issuedAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new RangeError('capability grant expiry overflow');
    const { policyEpoch, revocationEpoch } = this.currentEpochs(request.capability, request.path);
    return this.seal({ format: 'aether.capability-grant/2', repositoryId: this.options.repositoryId,
      capability: request.capability, audience: request.audience, path: [...request.path], policyEpoch, revocationEpoch,
      issuedAt, expiresAt, nonce: randomBytes(16).toString('hex'), parent: null });
  }
  verify(value: unknown, request: GrantRequestV2): value is ScopedGrantV2 {
    try {
      validateScopedGrant(value);
      const r = exactObject(request, ['capability', 'audience', 'path']); capability(r.capability as string); identifier(r.audience); path(r.path);
      const token = value as ScopedGrantV2, body = token.body, now = this.now();
      if (body.repositoryId !== this.options.repositoryId || body.capability !== request.capability || body.audience !== request.audience || !prefix(body.path, request.path) || now < body.issuedAt || now >= body.expiresAt || body.expiresAt - body.issuedAt > this.maxTtlMs) return false;
      if (this.options.isRevoked(body.capability, request.path) !== false) return false;
      // A broad grant must still observe revocation of the concrete resource
      // used at this boundary, including narrower descendant scopes.
      const current = this.currentEpochs(body.capability, request.path);
      if (current.policyEpoch !== body.policyEpoch || current.revocationEpoch !== body.revocationEpoch) return false;
      const actual = Buffer.from(token.signature, 'hex'), expected = this.signature(body);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch { return false; }
  }
  attenuate(parent: ScopedGrantV2, next: GrantRequestV2, ttlMs: number): ScopedGrantV2 {
    if (!this.verify(parent, { capability: parent.body.capability, audience: parent.body.audience, path: parent.body.path })) throw new Error('invalid parent capability grant');
    const r = exactObject(next, ['capability', 'audience', 'path']); capability(r.capability as string); identifier(r.audience); path(r.path);
    if (next.capability !== parent.body.capability || !prefix(parent.body.path, next.path)) throw new Error('capability attenuation would widen authority');
    if (!this.verify(parent, { capability: next.capability, audience: parent.body.audience, path: next.path })) throw new Error('parent capability grant is revoked for the child resource');
    if (this.options.authorizeDelegate(parent.body.audience, next.audience, next.capability) !== true) throw new Error('capability delegation denied');
    const issuedAt = this.now();
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > this.maxTtlMs || issuedAt + ttlMs > parent.body.expiresAt) throw new Error('capability attenuation would extend lifetime');
    const current = this.currentEpochs(next.capability, next.path);
    if (current.policyEpoch !== parent.body.policyEpoch || current.revocationEpoch !== parent.body.revocationEpoch) throw new Error('capability attenuation crosses authority epoch');
    return this.seal({ ...parent.body, audience: next.audience, path: [...next.path], issuedAt, expiresAt: issuedAt + ttlMs,
      nonce: randomBytes(16).toString('hex'), parent: parent.id });
  }
}
