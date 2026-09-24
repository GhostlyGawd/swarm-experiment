/** Real controller process for the Artifact/4 pure host crash test. */
import { readFileSync } from 'node:fs';
import { decode as decodeIR } from '../../src/tier1/agent-ir.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ProcessHost } from '../../src/tier4/process-host.ts';
import type { ProcessVirtualArtifactV4 } from '../../src/tier4/process-virtual-artifact-v4.ts';
import type { ProcessVirtualWorkerTrustV1 } from '../../src/tier4/process-virtual-worker-contract.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
import type { SymbolId } from '../../src/tier1/ids.ts';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  directory: string; artifact: ProcessVirtualArtifactV4;
  trust: ProcessVirtualWorkerTrustV1; plan: TopologyPlan; entry: SymbolId;
};
const module = decodeIR(config.artifact.candidateIr);
const host = await ProcessHost.open({ directory: config.directory, module,
  manifest: config.artifact.candidateEvidence.manifest, plan: config.plan,
  registry: new CapabilityRegistry(),
  sealer: new CapabilitySealer(new Uint8Array(32).fill(7), () => 100),
  virtualArtifactV4: { format: 'aether.process-host-virtual/1',
    artifact: config.artifact, trust: config.trust },
  authorizeRecovery: () => true,
  onPhase: phase => {
    if (phase === 'call-before-commit') process.kill(process.pid, 'SIGKILL');
  } });
await host.call(config.entry, [{ tag: 'int', value: '3' }],
  { operationId: 'artifact4-controller-crash', tokens: host.issueTokens(config.entry) });
throw new Error('controller survived its call-before-commit crash boundary');
