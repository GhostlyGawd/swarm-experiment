/** Real controller process for the Artifact/4 pure host crash test. */
import { readFileSync } from 'node:fs';
import { decode as decodeIR } from '../../src/tier1/agent-ir.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ProcessHost } from '../../src/tier4/process-host.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { selectHostJournalWitness } from '../../src/fabric/host-journal-witness.ts';
import type { ProcessVirtualArtifactV4 } from '../../src/tier4/process-virtual-artifact-v4.ts';
import type { ProcessVirtualWorkerTrustV1 } from '../../src/tier4/process-virtual-worker-contract.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
import type { SymbolId } from '../../src/tier1/ids.ts';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  directory: string; artifact: ProcessVirtualArtifactV4;
  trust: ProcessVirtualWorkerTrustV1; plan: TopologyPlan; entry: SymbolId;
  operationId?: string; crashPhase?: 'call-before-commit' | 'call-committed';
  source?: boolean;
  witness?: { socketPath: string; keyPath: string; authorityId: string;
    repositoryId: string; deploymentId: string; hostId: string };
};
const module = decodeIR(config.source ? config.artifact.sourceIr
  : config.artifact.candidateIr);
const witness = config.witness ? selectHostJournalWitness(
  createProcessWitnessClient({ socketPath: config.witness.socketPath,
    key: readFileSync(config.witness.keyPath) }).hostCatalog({
      authorityId: config.witness.authorityId, repositoryId: config.witness.repositoryId,
      deploymentId: config.witness.deploymentId }),
  config.witness.hostId) : undefined;
const host = await ProcessHost.open({ directory: config.directory, module,
  manifest: config.source ? config.artifact.sourceEvidence.manifest
    : config.artifact.candidateEvidence.manifest, plan: config.plan,
  registry: new CapabilityRegistry(),
  sealer: new CapabilitySealer(new Uint8Array(32).fill(7), () => 100),
  virtualArtifactV4: { format: config.source ? 'aether.process-host-virtual/3'
    : witness ? 'aether.process-host-virtual/2' : 'aether.process-host-virtual/1',
    artifact: config.artifact, trust: config.trust },
  hostJournalWitness: witness,
  initialGeneration: config.source ? '0' : undefined,
  authorizeRecovery: () => true,
  onPhase: phase => {
    if (phase === (config.crashPhase ?? 'call-before-commit')) process.kill(process.pid, 'SIGKILL');
  } });
await host.call(config.entry, [{ tag: 'int', value: '3' }],
  { operationId: config.operationId ?? 'artifact4-controller-crash', tokens: host.issueTokens(config.entry) });
throw new Error('controller survived its selected crash boundary');
