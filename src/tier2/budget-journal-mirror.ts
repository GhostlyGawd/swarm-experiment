/** Local mirror of an externally held complete canonical budget journal.
 * The witness CAS is the commit point. A crash before local publication is
 * repaired from that head on reopen; a same-revision local edit is rejected. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeCanonical, decimal, encodeCanonical, exactObject } from '../fabric/encoding.ts';
import { domainDigest, type Digest } from '../fabric/identity.ts';
import { advanceBudgetJournalHead, readBudgetJournalHead, type BudgetJournalHead, type BudgetJournalWitness } from '../fabric/budget-journal-witness.ts';

const FORMAT = 'aether.resource-budget-local-mirror/1' as const;
interface Marker { readonly format: typeof FORMAT; readonly revision: string; readonly journalDigest: Digest }
const journalDigest = (journal: string): Digest => domainDigest('aether.resource-budget-witnessed-bytes/1', journal);
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function canonical(value: unknown): Buffer { return Buffer.from(encodeCanonical(value)); }
function marker(head: BudgetJournalHead): Marker {
  if (head.journal === null) throw new Error('budget witness is not initialized');
  return { format: FORMAT, revision: head.revision, journalDigest: journalDigest(head.journal) };
}
function publish(path: string, bytes: Buffer): void {
  const temp = join(dirname(path), `.budget-mirror-${randomUUID()}`), fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); sync(dirname(path)); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}

export class BudgetJournalMirror {
  private readonly markerFile: string;
  private readonly file: string;
  private readonly witness: BudgetJournalWitness;
  private readonly afterWitnessCommit?: () => void;
  private observedJournal: string | null = null;
  constructor(file: string, witness: BudgetJournalWitness, afterWitnessCommit?: () => void) {
    this.file = file; this.witness = witness;
    this.afterWitnessCommit = afterWitnessCommit;
    this.markerFile = join(dirname(file), 'journal-witness-head.json');
  }
  private localMarker(): Marker | null {
    if (!existsSync(this.markerFile)) return null;
    const bytes = readFileSync(this.markerFile), decoded = decodeCanonical(bytes);
    if (!canonical(decoded).equals(bytes)) throw new TypeError('noncanonical budget mirror marker');
    const row = exactObject(decoded, ['format', 'revision', 'journalDigest']);
    if (row.format !== FORMAT) throw new TypeError('invalid budget mirror marker');
    decimal(row.revision);
    if (typeof row.journalDigest !== 'string' || !row.journalDigest.startsWith('aether.resource-budget-witnessed-bytes/1:'))
      throw new TypeError('invalid budget mirror journal digest');
    return row as unknown as Marker;
  }
  private localJournal(): string | null {
    if (!existsSync(this.file)) return null;
    if (statSync(this.file).size > 32 * 1024 * 1024) throw new RangeError('oversized budget local journal');
    return readFileSync(this.file, 'utf8');
  }
  private storeMarker(head: BudgetJournalHead): void { publish(this.markerFile, canonical(marker(head))); }
  private reconcile(head: BudgetJournalHead): string {
    if (head.journal === null) throw new Error('missing established budget witness journal');
    const local = this.localJournal(), record = this.localMarker();
    if (record && BigInt(record.revision) > BigInt(head.revision))
      throw new Error('budget witness rolled back behind local mirror');
    if (record?.revision === head.revision) {
      if (record.journalDigest !== journalDigest(head.journal)
        || local !== null && local !== head.journal)
        throw new Error('same-revision budget journal tamper');
      if (local === null) publish(this.file, Buffer.from(head.journal, 'utf8'));
      return head.journal;
    }
    if (!record && local !== null && local !== head.journal)
      throw new Error('unversioned budget journal conflicts with external head');
    if (local !== head.journal) publish(this.file, Buffer.from(head.journal, 'utf8'));
    this.storeMarker(head);
    return head.journal;
  }
  /** Genesis may be enrolled only when no established local marker exists. */
  initialize(genesis: string): void {
    const head = readBudgetJournalHead(this.witness);
    if (head.revision === '0') {
      if (this.localMarker() || this.localJournal() !== genesis)
        throw new Error('budget witness genesis conflicts with local journal');
      const enrolled = advanceBudgetJournalHead(this.witness, '0', genesis);
      this.storeMarker(enrolled);
      this.observedJournal = genesis;
      return;
    }
    this.observedJournal = this.reconcile(head);
  }
  read(): string {
    const journal = this.reconcile(readBudgetJournalHead(this.witness));
    this.observedJournal = journal;
    return journal;
  }
  /** CAS before publishing the local file; a failed local write leaves an
   * externally committed head that the next read restores. */
  advance(next: string, publishLocal: () => void): void {
    const prior = readBudgetJournalHead(this.witness);
    const priorJournal = this.reconcile(prior);
    if (this.observedJournal === null || this.observedJournal !== priorJournal)
      throw new Error('budget witness advanced since local journal read');
    const accepted = advanceBudgetJournalHead(this.witness, prior.revision, next);
    this.observedJournal = next;
    this.afterWitnessCommit?.();
    publishLocal();
    this.storeMarker(accepted);
  }
}
