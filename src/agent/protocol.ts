import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Term } from '../tier1/ast.ts';
import type { NodeRef } from '../tier1/ids.ts';
import { atomicWrite, encodeStored, decodeStored, readStored, withFileLock } from '../tier1/persistence.ts';
import type { AetherRepository } from '../tier1/repository.ts';
import type { Step } from '../tier1/store.ts';

export type AgentRequest =
  | { readonly id: string; readonly op: 'hydrate'; readonly root: NodeRef }
  | { readonly id: string; readonly op: 'intern'; readonly term: Term }
  | { readonly id: string; readonly op: 'lease'; readonly root: NodeRef; readonly owner: string; readonly ttlMs?: number }
  | { readonly id: string; readonly op: 'release'; readonly root: NodeRef; readonly owner: string; readonly token: string }
  | {
      readonly id: string; readonly op: 'replace'; readonly root: NodeRef;
      readonly path: readonly Step[]; readonly replacement: NodeRef;
      readonly owner: string; readonly token: string;
    };

export type AgentResponse =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly error: string };

export interface Lease {
  readonly root: NodeRef;
  readonly owner: string;
  readonly token: string;
  readonly expiresAt: number;
}

/** Durable subtree claims, coordinated with the same lock discipline as refs. */
export class LeaseManager {
  private readonly directory: string;
  private readonly clock: () => number;
  constructor(directory: string, clock: () => number = () => Date.now()) {
    this.directory = join(directory, 'leases');
    this.clock = clock;
    mkdirSync(this.directory, { recursive: true });
  }

  private path(root: NodeRef): string {
    return join(this.directory, `${root.slice(root.lastIndexOf(':') + 1)}.json`);
  }

  current(root: NodeRef): Lease | null {
    const path = this.path(root);
    if (!existsSync(path)) return null;
    const lease = readStored<Lease>(path);
    if (lease.expiresAt <= this.clock()) { unlinkSync(path); return null; }
    return lease;
  }

  acquire(root: NodeRef, owner: string, ttlMs = 30_000): Lease {
    const path = this.path(root);
    return withFileLock(`${path}.lock`, () => {
      const current = this.current(root);
      if (current && current.owner !== owner) throw new Error(`${root} is leased by ${current.owner}`);
      const lease: Lease = {
        root, owner, expiresAt: this.clock() + ttlMs,
        token: current?.token ?? randomBytes(24).toString('hex'),
      };
      atomicWrite(path, encodeStored(lease));
      return lease;
    });
  }

  assert(root: NodeRef, owner: string, token: string): Lease {
    const lease = this.current(root);
    if (!lease || lease.owner !== owner || lease.token !== token) throw new Error(`no valid lease for ${root}`);
    return lease;
  }

  release(root: NodeRef, owner: string, token: string): void {
    this.assert(root, owner, token);
    const path = this.path(root);
    if (existsSync(path)) unlinkSync(path);
  }
}

/** Length-prefixed frames allow multiple messages on any byte stream. */
export function encodeFrame(message: AgentRequest | AgentResponse): Uint8Array {
  const body = new TextEncoder().encode(encodeStored(message));
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, 4);
  return frame;
}

export class FrameDecoder {
  private buffered = new Uint8Array();
  push(chunk: Uint8Array): Array<AgentRequest | AgentResponse> {
    const joined = new Uint8Array(this.buffered.length + chunk.length);
    joined.set(this.buffered); joined.set(chunk, this.buffered.length);
    this.buffered = joined;
    const messages: Array<AgentRequest | AgentResponse> = [];
    while (this.buffered.length >= 4) {
      const length = new DataView(this.buffered.buffer, this.buffered.byteOffset, 4).getUint32(0);
      if (this.buffered.length < 4 + length) break;
      messages.push(decodeStored(new TextDecoder().decode(this.buffered.slice(4, 4 + length))));
      this.buffered = this.buffered.slice(4 + length);
    }
    return messages;
  }
}

export class AgentSession {
  private readonly repository: AetherRepository;
  private readonly leases: LeaseManager;
  constructor(repository: AetherRepository, leases = new LeaseManager(repository.directory)) {
    this.repository = repository;
    this.leases = leases;
  }

  handle(request: AgentRequest): AgentResponse {
    try {
      switch (request.op) {
        case 'hydrate': return { id: request.id, ok: true, value: this.repository.store.hydrate(request.root) };
        case 'intern': return { id: request.id, ok: true, value: this.repository.store.intern(request.term) };
        case 'lease': return { id: request.id, ok: true, value: this.leases.acquire(request.root, request.owner, request.ttlMs) };
        case 'release':
          this.leases.release(request.root, request.owner, request.token);
          return { id: request.id, ok: true, value: null };
        case 'replace':
          this.leases.assert(request.root, request.owner, request.token);
          return {
            id: request.id, ok: true,
            value: this.repository.store.replaceAt(request.root, request.path, request.replacement),
          };
      }
    } catch (error) {
      return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
