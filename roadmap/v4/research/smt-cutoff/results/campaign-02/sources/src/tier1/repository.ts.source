import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { blake3 } from './blake3.ts';
import { canonicalBytes, type Canonical } from './canonical.ts';
import {
  bytesToHexRef, COMMIT_PREFIX,
  type CommitRef, type NodeRef, type ProvenanceId,
} from './ids.ts';
import { atomicWrite, atomicWriteOnce, decodeStored, encodeStored, readStored, withFileLock } from './persistence.ts';
import { GraphStore } from './store.ts';

export interface CommitRecord {
  readonly id: CommitRef;
  readonly root: NodeRef;
  readonly provenance: ProvenanceId | null;
  readonly parents: readonly CommitRef[];
  readonly timestamp: number;
  readonly message: string;
}

export interface CommitOptions {
  readonly provenance?: ProvenanceId | null;
  readonly parents?: readonly CommitRef[];
  readonly timestamp?: number;
  readonly message?: string;
}

export interface GarbageCollectionResult {
  readonly keptObjects: number;
  readonly removedObjects: number;
  readonly reachableCommits: number;
}

export interface FsckIssue {
  readonly kind: 'object' | 'commit' | 'reference';
  readonly id: string;
  readonly message: string;
}

export interface Packfile {
  readonly version: 1;
  readonly objects: ReadonlyArray<{ readonly ref: NodeRef; readonly node: unknown }>;
  readonly commits: readonly CommitRecord[];
  readonly refs: ReadonlyArray<{ readonly name: string; readonly commit: CommitRef }>;
}

const branchName = (name: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('/')) {
    throw new TypeError(`invalid branch name ${name}`);
  }
  return name;
};

/** Durable repository metadata layered over the write-once AST object store. */
export class AetherRepository {
  readonly store: GraphStore;
  readonly directory: string;
  private readonly commitsDirectory: string;
  private readonly headsDirectory: string;

  constructor(directory: string) {
    this.directory = directory;
    this.commitsDirectory = join(directory, 'commits');
    this.headsDirectory = join(directory, 'refs', 'heads');
    mkdirSync(this.commitsDirectory, { recursive: true });
    mkdirSync(this.headsDirectory, { recursive: true });
    this.store = new GraphStore({ directory });
  }

  private commitPath(id: CommitRef): string {
    const digest = id.slice(id.lastIndexOf(':') + 1);
    return join(this.commitsDirectory, digest.slice(0, 2), `${digest.slice(2)}.json`);
  }

  private refPath(name: string): string {
    return join(this.headsDirectory, branchName(name));
  }

  createCommit(root: NodeRef, opts: CommitOptions = {}): CommitRecord {
    if (!this.store.has(root)) throw new ReferenceError(`cannot commit unknown root ${root}`);
    const body = {
      root,
      provenance: opts.provenance ?? null,
      parents: [...(opts.parents ?? [])],
      timestamp: opts.timestamp ?? Date.now(),
      message: opts.message ?? '',
    };
    const id = bytesToHexRef(blake3(canonicalBytes(body as Canonical)), COMMIT_PREFIX) as unknown as CommitRef;
    const record: CommitRecord = { id, ...body };
    atomicWriteOnce(this.commitPath(id), encodeStored(record));
    return record;
  }

  readCommit(id: CommitRef): CommitRecord {
    const path = this.commitPath(id);
    if (!existsSync(path)) throw new ReferenceError(`unknown commit ${id}`);
    const record = readStored<CommitRecord>(path);
    const { id: _id, ...body } = record;
    const actual = bytesToHexRef(blake3(canonicalBytes(body as unknown as Canonical)), COMMIT_PREFIX) as unknown as CommitRef;
    if (actual !== id || record.id !== id) throw new Error(`corrupt commit ${id}`);
    return record;
  }

  head(name: string): CommitRef | null {
    const path = this.refPath(name);
    return existsSync(path) ? readFileSync(path, 'utf8').trim() as CommitRef : null;
  }

  resolve(name: string): CommitRecord | null {
    const id = this.head(name);
    return id ? this.readCommit(id) : null;
  }

  updateRef(name: string, next: CommitRef, expected: CommitRef | null = this.head(name)): void {
    this.readCommit(next);
    const path = this.refPath(name);
    withFileLock(`${path}.lock`, () => {
      const current = this.head(name);
      if (current !== expected) {
        throw new Error(`reference ${name} moved: expected ${expected ?? '(absent)'}, found ${current ?? '(absent)'}`);
      }
      atomicWrite(path, `${next}\n`);
    });
  }

  commit(name: string, root: NodeRef, opts: Omit<CommitOptions, 'parents'> = {}): CommitRecord {
    const previous = this.head(name);
    const record = this.createCommit(root, { ...opts, parents: previous ? [previous] : [] });
    this.updateRef(name, record.id, previous);
    return record;
  }

  listBranches(): string[] {
    const walk = (directory: string, prefix = ''): string[] => {
      if (!existsSync(directory)) return [];
      const out: string[] = [];
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walk(join(directory, entry.name), relative));
        else if (entry.isFile()) out.push(relative);
      }
      return out;
    };
    return walk(this.headsDirectory).sort();
  }

  listCommits(): CommitRef[] {
    const out: CommitRef[] = [];
    if (!existsSync(this.commitsDirectory)) return out;
    for (const shard of readdirSync(this.commitsDirectory, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
      for (const file of readdirSync(join(this.commitsDirectory, shard.name), { withFileTypes: true })) {
        if (file.isFile() && /^[0-9a-f]{62}\.json$/.test(file.name)) {
          out.push(`${COMMIT_PREFIX}${shard.name}${file.name.slice(0, -5)}` as CommitRef);
        }
      }
    }
    return out.sort();
  }

  collectGarbage(): GarbageCollectionResult {
    const commits = new Set<CommitRef>();
    const roots = new Set<NodeRef>();
    const pending = this.listBranches().map((name) => this.head(name)).filter(Boolean) as CommitRef[];
    while (pending.length) {
      const id = pending.pop()!;
      if (commits.has(id)) continue;
      commits.add(id);
      const commit = this.readCommit(id);
      roots.add(commit.root);
      pending.push(...commit.parents);
    }
    const live = new Set<NodeRef>();
    for (const root of roots) for (const ref of this.store.reachable(root)) live.add(ref);
    let removedObjects = 0;
    for (const ref of this.store.listRefs()) {
      if (!live.has(ref) && this.store.delete(ref)) removedObjects++;
    }
    return { keptObjects: live.size, removedObjects, reachableCommits: commits.size };
  }

  fsck(): FsckIssue[] {
    const issues: FsckIssue[] = [];
    for (const ref of this.store.listRefs()) {
      try {
        this.store.get(ref);
      } catch (error) {
        issues.push({ kind: 'object', id: ref, message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const id of this.listCommits()) {
      try {
        const commit = this.readCommit(id);
        if (!this.store.has(commit.root)) {
          issues.push({ kind: 'commit', id, message: `missing root ${commit.root}` });
        }
      } catch (error) {
        issues.push({ kind: 'commit', id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const name of this.listBranches()) {
      try {
        const id = this.head(name);
        if (!id) issues.push({ kind: 'reference', id: name, message: 'empty reference' });
        else this.readCommit(id);
      } catch (error) {
        issues.push({ kind: 'reference', id: name, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return issues;
  }

  /** Portable, deterministic repository archive. */
  exportPackfile(): Uint8Array {
    const pack: Packfile = {
      version: 1,
      objects: this.store.listRefs().map((ref) => ({ ref, node: this.store.get(ref) })),
      commits: this.listCommits().map((id) => this.readCommit(id)),
      refs: this.listBranches().map((name) => ({ name, commit: this.head(name)! })),
    };
    return new TextEncoder().encode(encodeStored(pack));
  }

  importPackfile(bytes: Uint8Array, opts: { updateRefs?: boolean } = {}): Packfile {
    const pack = decodeStored<Packfile>(new TextDecoder().decode(bytes));
    if (pack.version !== 1) throw new TypeError(`unsupported packfile version ${String(pack.version)}`);
    for (const object of pack.objects) {
      const actual = this.store.put(object.node as never);
      if (actual !== object.ref) throw new Error(`packfile object ${object.ref} failed content validation`);
    }
    for (const commit of pack.commits) {
      const imported = this.createCommit(commit.root, commit);
      if (imported.id !== commit.id) throw new Error(`packfile commit ${commit.id} failed content validation`);
    }
    if (opts.updateRefs) {
      for (const ref of pack.refs) this.updateRef(ref.name, ref.commit, this.head(ref.name));
    }
    return pack;
  }
}
