import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { capability } from '../../src/tier1/ids.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger, fenceRequirement, signIntent, signSpecRevision } from '../../src/tier1/causal-lineage.ts';
import { SemanticGarbageCollector } from '../../src/tier1/semantic-gc.ts';
import { SemanticAdapterGarbageCollector, declarativeAdapterTableDigest, type DeclarativeAdapterTable, type SemanticAdapterGcOptions } from '../../src/tier1/semantic-gc-adapters.ts';
import { adapterArtifactForSource } from '../../src/tier2/adapter-artifact.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { evidenceBundleDigest } from '../../src/fabric/promotion.ts';

export function adapterGcFixture(options: { exportUnused?: boolean; protectUnused?: boolean; fenceUnused?: boolean; beforePublish?: () => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-adapter-gc-')), store = new DurableGraphStore({ directory: join(directory, 'ast') });
  const symbols = new SymbolSpace('adapter-gc-fixture'), entry = symbols.define('entry'), live = symbols.define('live'), unused = symbols.define('unused'), fence = symbols.define('fence'), x = symbols.define('x');
  const liveCap = capability('cap:fixture:live'), unusedCap = capability('cap:fixture:unused'), registry = new CapabilityRegistry();
  [liveCap, unusedCap].forEach(cap => registry.declare(cap, { arity: 0, description: 'A declared third-party adapter', effectful: true }));
  const effect = (symbol: typeof live, cap: typeof liveCap, fenced = false) => b.fn({ symbol, returns: b.Unit, capabilities: [cap], contract: b.contract(fenced ? { ensures: [b.clause(b.bool(true), 'fenced-true')] } : {}), body: b.block(b.exprStmt(b.invoke(cap)), b.ret(b.unit())) });
  const fenced = b.fn({ symbol: fence, returns: b.Bool, contract: b.contract({ ensures: [b.clause(b.result(), 'preserve-true')] }), body: b.ret(b.bool(true)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, contract: b.contract({}), body: b.ret(b.v(x)) }), effect(live, liveCap), effect(unused, unusedCap, options.fenceUnused), fenced], symbolTable: symbols.table() });
  const root = store.intern(module, { leaseId: 'module' }), semantics = { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: false };
  const table: DeclarativeAdapterTable = { format: 'aether.declarative-adapter-table/1', repositoryId: 'adapter-gc', registrations: [
    { id: 'a-live', capability: liveCap, source: `export default {id:'fixture-live/1',semantics:${JSON.stringify(semantics)},execute(){return {tag:'null'}}};` },
    { id: 'b-unused', capability: unusedCap, source: `throw new Error('Dormant adapter must never be imported during GC'); export default {id:'fixture-unused/1',semantics:${JSON.stringify(semantics)},execute(){return {tag:'null'}}};` },
  ].map(item => ({ id: item.id, capability: item.capability, artifact: adapterArtifactForSource(Buffer.from(item.source), item.capability, item.id === 'a-live' ? 'fixture-live/1' : 'fixture-unused/1', semantics), sourceRoot: store.intern(b.str(item.source), { leaseId: item.id }), lifecycle: 'lazy-declarative-no-unload/1' })) };
  const author = generateKeyPairSync('ed25519'), currentAuthority = { policyEpoch: '1', eligibleAuthors: ['author'] };
  const lineage = new CausalLineageLedger({ directory: join(directory, 'lineage'), repositoryId: 'adapter-gc', store, authority: () => currentAuthority, authorKey: () => author.publicKey });
  const specification = { id: 'application', revision: lineage.publishSpec(signSpecRevision({ repositoryId: 'adapter-gc', id: 'application', revision: 1, previous: null, parents: [], text: 'Preserve the exact declared export surface and formal fences.', requirements: [fenceRequirement(fenced), ...(options.fenceUnused && module.kind === 'Module' ? [fenceRequirement(module.members[2])] : [])], author: 'author', policyEpoch: '1', nonce: randomUUID() }, author.privateKey)) };
  let sequence = 0;
  const artifact = (policy: string, parents: readonly string[], signed = true, term: Term = module) => {
    const ast = store.intern(term, { leaseId: `artifact-${sequence++}` }), d = (value: string) => domainDigest('aether.adapter-gc-fixture/1', value);
    const context: EvidenceContext = { module: term, specification: lineage.specification(parents, [specification]), registry, semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'), target: { abiVersion: 'candidate-declarative-adapters/1', profileDigest: d('profile'), artifactDigest: d(ast) }, capabilityPolicyDigest: policy };
    const evidence = mintLocalEvidence(context), digest = executionManifestDigest(evidence.manifest);
    let intent: string | null = null;
    if (signed) { intent = lineage.recordIntent(signIntent({ repositoryId: 'adapter-gc', subject: ast, executionManifest: digest, evidenceBundleDigest: evidenceBundleDigest(evidence), parents, specifications: [specification], purpose: parents.length ? 'rewrite' : 'genesis', text: 'Authorize exact candidate artifact and declarative registration policy.', author: 'author', policyEpoch: '1', nonce: randomUUID() }, author.privateKey)); lineage.admitArtifact(intent, evidence, context); }
    return { context, evidence, digest, intent };
  };
  const genesis = artifact(declarativeAdapterTableDigest(table), []); store.commit('production', root, null);
  const policy = { epoch: 'closed-exports/1', exports: [entry, live, ...(options.exportUnused ? [unused] : [])], protectedSymbols: options.protectUnused ? [unused] : [] };
  const retentionLedger = new SemanticGarbageCollector({ directory: join(directory, 'gc-retention'), repositoryId: 'adapter-gc', store, lineage, registry, policy });
  const configuration: SemanticAdapterGcOptions = { directory: join(directory, 'adapter-registry'), repositoryId: 'adapter-gc', store, lineage, registry, policy, retentionLedger, genesisManifest: genesis.evidence.manifest, genesisTable: table, key: author.privateKey, beforePublish: options.beforePublish };
  return { directory, store, module, root, table, entry, live, unused, liveCap, unusedCap, artifact, genesis, retentionLedger, configuration, manager: new SemanticAdapterGarbageCollector(configuration), currentAuthority, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
