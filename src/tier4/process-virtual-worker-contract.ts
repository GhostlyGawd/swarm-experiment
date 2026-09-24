/** Operator-held trust and executable closure for the opt-in pure virtual worker.
 * This is a worker protocol, not ProcessDeployment or ProcessHost admission.
 */
import { createPublicKey } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { DurableGraphStore } from '../tier1/durable-store.ts';
import { CausalLineageLedger } from '../tier1/causal-lineage.ts';
import { exactObject, identifier } from '../fabric/encoding.ts';
import { type ProcessVirtualArtifactV3 } from './process-virtual-artifact.ts';

export interface ProcessVirtualWorkerTrustV1 {
  readonly format: 'aether.process-virtual-worker-trust/1';
  readonly repositoryId: string;
  readonly lineageDirectory: string;
  readonly storeDirectory: string;
  readonly policyEpoch: string;
  readonly eligibleAuthors: readonly string[];
  /** Public keys enrolled by the operator, independent of Artifact/3 bytes. */
  readonly authorKeys: readonly { readonly author: string; readonly policyEpoch: string; readonly publicKeyPem: string }[];
}

export function openProcessVirtualWorkerLineageV1(value: unknown): CausalLineageLedger {
  const trust = exactObject(value, ['format', 'repositoryId', 'lineageDirectory', 'storeDirectory',
    'policyEpoch', 'eligibleAuthors', 'authorKeys']);
  if (trust.format !== 'aether.process-virtual-worker-trust/1'
    || !Array.isArray(trust.eligibleAuthors) || !Array.isArray(trust.authorKeys))
    throw new TypeError('invalid virtual worker trust version');
  identifier(trust.repositoryId); identifier(trust.policyEpoch);
  if (new Set(trust.eligibleAuthors).size !== trust.eligibleAuthors.length
    || !trust.eligibleAuthors.length) throw new TypeError('invalid virtual worker author authority');
  for (const author of trust.eligibleAuthors) identifier(author);
  const keys = new Map<string, ReturnType<typeof createPublicKey>>();
  for (const raw of trust.authorKeys) {
    const item = exactObject(raw, ['author', 'policyEpoch', 'publicKeyPem']);
    identifier(item.author); identifier(item.policyEpoch);
    if (typeof item.publicKeyPem !== 'string') throw new TypeError('invalid worker author key');
    const key = createPublicKey(item.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('worker author key must be Ed25519');
    const identity = `${item.author}\u0000${item.policyEpoch}`;
    if (keys.has(identity)) throw new TypeError('duplicate worker author key');
    keys.set(identity, key);
  }
  for (const field of ['lineageDirectory', 'storeDirectory'] as const) {
    if (typeof trust[field] !== 'string' || !trust[field].startsWith(sep)
      || !existsSync(trust[field])) throw new TypeError('worker trust requires an existing absolute directory');
  }
  const store = new DurableGraphStore({ directory: realpathSync(trust.storeDirectory as string) });
  return new CausalLineageLedger({ directory: realpathSync(trust.lineageDirectory as string),
    repositoryId: trust.repositoryId as string, store,
    authority: () => ({ policyEpoch: trust.policyEpoch as string,
      eligibleAuthors: [...trust.eligibleAuthors as string[]] }),
    authorKey: (author, epoch) => keys.get(`${author}\u0000${epoch}`) });
}

/** Bind Artifact/3 to the exact path launched by the parent (or seen as argv[1]
 * in the child). The full transitive executable closure remains a separate gate. */
export function assertProcessVirtualWorkerBundleV1(artifact: ProcessVirtualArtifactV3,
  launchedPath: string): void {
  if (artifact.executableSubject.bundle.path !== realpathSync(launchedPath))
    throw new TypeError('Artifact/3 does not measure the launched worker entry');
}
