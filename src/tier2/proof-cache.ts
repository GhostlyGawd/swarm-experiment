import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeRef } from '../tier1/ids.ts';
import { atomicWrite, encodeStored, readStored } from '../tier1/persistence.ts';
import type { VerificationReport } from './verify.ts';

export interface ProofCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
}

/** Content-addressed verification cache. Reports are immutable per subject. */
export class ProofCache {
  private readonly reports = new Map<NodeRef, VerificationReport>();
  private readonly directory: string | null;
  private hitCount = 0;
  private missCount = 0;

  constructor(directory?: string) {
    this.directory = directory ? join(directory, 'proofs') : null;
    if (this.directory) mkdirSync(this.directory, { recursive: true });
  }

  private path(subject: NodeRef): string {
    if (!this.directory) throw new Error('this proof cache is memory-only');
    return join(this.directory, `${subject.slice(subject.lastIndexOf(':') + 1)}.json`);
  }

  get(subject: NodeRef): VerificationReport | undefined {
    let report = this.reports.get(subject);
    if (!report && this.directory && existsSync(this.path(subject))) {
      report = readStored<VerificationReport>(this.path(subject));
      this.reports.set(subject, report);
    }
    if (report) this.hitCount++;
    else this.missCount++;
    return report;
  }

  put(report: VerificationReport): void {
    this.reports.set(report.subject, report);
    if (this.directory) atomicWrite(this.path(report.subject), encodeStored(report));
  }

  get stats(): ProofCacheStats {
    return { hits: this.hitCount, misses: this.missCount, entries: this.reports.size };
  }
}
