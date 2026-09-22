/**
 * Aether identifier space (FR-1.1, FR-1.3).
 *
 * Every durable handle in the fabric is a prefixed, self-describing string.
 * Prefixes are load-bearing: they say which index a handle belongs to and
 * whether it is content-derived (and therefore immutable) or opaque (and
 * therefore stable across renames).
 */

/** Content address of an AST node: `ast:b3:<64 hex>`. Immutable. */
export type NodeRef = string & { readonly __brand: 'NodeRef' };
/** Alpha-normalized structural key: `struct:b3:<64 hex>`. Drives dedup. */
export type StructuralKey = string & { readonly __brand: 'StructuralKey' };
/** Opaque binding identity: `sym:<22 base32>`. Survives renaming. */
export type SymbolId = string & { readonly __brand: 'SymbolId' };
/** Causal provenance record: `prov:b3:<64 hex>`. */
export type ProvenanceId = string & { readonly __brand: 'ProvenanceId' };
/** Invariant/contract clause: `inv:b3:<64 hex>`. */
export type InvariantId = string & { readonly __brand: 'InvariantId' };
/** Capability name: `cap:<domain>:<operation>`, e.g. `cap:db:ledger_append`. */
export type CapabilityName = string & { readonly __brand: 'CapabilityName' };
/** Nominal type name: `type:<namespace>:<name>`, e.g. `type:currency:cents`. */
export type TypeName = string & { readonly __brand: 'TypeName' };

const HEX64 = /^[0-9a-f]{64}$/;

export const NODE_PREFIX = 'ast:b3:';
export const STRUCT_PREFIX = 'struct:b3:';
export const SYMBOL_PREFIX = 'sym:';
export const PROVENANCE_PREFIX = 'prov:b3:';
export const INVARIANT_PREFIX = 'inv:b3:';
export const CAPABILITY_PREFIX = 'cap:';
export const TYPE_PREFIX = 'type:';

function tagged(prefix: string, hex: string): string {
  if (!HEX64.test(hex)) throw new TypeError(`expected 64 lowercase hex chars, got ${hex!}`);
  return prefix + hex;
}

export const nodeRef = (hex: string): NodeRef => tagged(NODE_PREFIX, hex) as NodeRef;
export const structuralKey = (hex: string): StructuralKey =>
  tagged(STRUCT_PREFIX, hex) as StructuralKey;
export const provenanceId = (hex: string): ProvenanceId =>
  tagged(PROVENANCE_PREFIX, hex) as ProvenanceId;
export const invariantId = (hex: string): InvariantId => tagged(INVARIANT_PREFIX, hex) as InvariantId;

export function isNodeRef(v: unknown): v is NodeRef {
  return typeof v === 'string' && v.startsWith(NODE_PREFIX) && HEX64.test(v.slice(NODE_PREFIX.length));
}

export function capability(name: string): CapabilityName {
  if (!/^cap:[a-z0-9_]+:[a-z0-9_]+$/.test(name)) {
    throw new TypeError(`capability must look like cap:<domain>:<operation>, got ${name}`);
  }
  return name as CapabilityName;
}

export function typeName(name: string): TypeName {
  if (!/^type:[a-z0-9_]+:[a-z0-9_]+$/.test(name)) {
    throw new TypeError(`nominal type must look like type:<namespace>:<name>, got ${name}`);
  }
  return name as TypeName;
}

/** Short, human-scannable rendering used in traces and error messages. */
export function abbrev(id: string, keep = 8): string {
  const colon = id.lastIndexOf(':');
  const head = id.slice(0, colon + 1);
  const tail = id.slice(colon + 1);
  return tail.length <= keep ? id : `${head}${tail.slice(0, keep)}…`;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Symbol ids are deliberately *not* content-derived. A rename must change the
 * symbol table and nothing else (FR-1.1), so the identity a `Var` node commits
 * to has to be independent of the spelling.
 */
export function freshSymbolId(rng: () => number = Math.random): SymbolId {
  let s = '';
  for (let i = 0; i < 22; i++) s += B32[Math.floor(rng() * 32) % 32];
  return (SYMBOL_PREFIX + s) as SymbolId;
}

/** Hex-encode a digest into a prefixed handle. */
export function bytesToHexRef(bytes: Uint8Array, prefix: string = NODE_PREFIX): NodeRef {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return (prefix + hex) as NodeRef;
}
