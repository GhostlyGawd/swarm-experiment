/** Real controller for governor promotion crash boundaries. */
import { readFileSync } from 'node:fs';
import { decode as decodeIR } from '../../src/tier1/agent-ir.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { DEFAULT_EVIDENCE_POLICY_V3, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { executionManifestDigest } from '../../src/fabric/identity.ts';
import { PromotionCoordinator, type PromotionInput } from '../../src/fabric/promotion.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { openProcessVirtualWorkerLineageV1,
  type ProcessVirtualWorkerTrustV1 } from '../../src/tier4/process-virtual-worker-contract.ts';
import { PureVirtualProcessDeployment } from '../../src/tier4/process-virtual-deployment.ts';
import type { ProcessVirtualArtifactV4 } from '../../src/tier4/process-virtual-artifact-v4.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  directory: string; coordinatorDirectory: string;
  artifact: ProcessVirtualArtifactV4; trust: ProcessVirtualWorkerTrustV1;
  sourcePlan: TopologyPlan; candidatePlan: TopologyPlan;
  governorPublicKeyPem: string;
  proposal: PromotionInput['proposal']; approval: PromotionInput['approval'];
  migrationPlan: PromotionInput['migrationPlan']; effectPlan: PromotionInput['effectPlan'];
  witness: { socketPath: string; keyPath: string; authorityId: string;
    repositoryId: string; deploymentId: string };
  crashPhase: 'prepared' | 'before-activation';
};
const { artifact, trust } = config;
const source = decodeIR(artifact.sourceIr), candidate = decodeIR(artifact.candidateIr);
const archived = decodeIR(artifact.archivedWrapper.ir);
if (source.kind !== 'Module' || candidate.kind !== 'Module')
  throw new TypeError('virtual controller requires source/candidate modules');
const context: EvidenceContext = { module: candidate, specification: artifact.specification,
  registry: new CapabilityRegistry(),
  semanticsVersion: artifact.candidateEvidence.manifest.semanticsVersion,
  compilerDigest: artifact.candidateEvidence.manifest.compilerDigest,
  capabilityPolicyDigest: artifact.candidateEvidence.manifest.capabilityPolicyDigest,
  target: artifact.candidateEvidence.manifest.target,
  policy: DEFAULT_EVIDENCE_POLICY_V3,
  virtualForward: { source, descriptor: artifact.descriptor },
  resolveDeclaration: symbol => symbol === artifact.archivedWrapper.symbol ? archived : undefined };
const witness = createProcessWitnessClient({ socketPath: config.witness.socketPath,
  key: readFileSync(config.witness.keyPath) });
const namespace = { authorityId: config.witness.authorityId,
  repositoryId: config.witness.repositoryId,
  deploymentId: config.witness.deploymentId };
const lineage = openProcessVirtualWorkerLineageV1(trust);
const coordinator = new PromotionCoordinator({ profile: 'strict-lineage-v1',
  directory: config.coordinatorDirectory, repositoryId: trust.repositoryId,
  genesisManifest: executionManifestDigest(artifact.sourceEvidence.manifest),
  authority: () => ({ repositoryId: trust.repositoryId, membershipEpoch: '1',
    policyEpoch: trust.policyEpoch, eligibleGovernors: ['governor'] }),
  governorKey: () => config.governorPublicKeyPem, clock: () => 100n,
  lineage: lineage.admissionAdapter() });
const deployment = await PureVirtualProcessDeployment.open({ directory: config.directory,
  coordinator, artifact, trust, sourcePlan: config.sourcePlan,
  candidatePlan: config.candidatePlan,
  sealer: new CapabilitySealer(new Uint8Array(32).fill(7), () => 100),
  hostWitnessCatalog: witness.hostCatalog(namespace),
  deploymentWitness: witness.virtualDeploymentWitness(namespace),
  authorizeRecovery: () => true, recoveryAuthorityId: 'pure-recovery',
  onPhase: phase => { if (phase === config.crashPhase) process.kill(process.pid, 'SIGKILL'); } });
await deployment.promote({ proposal: config.proposal, approval: config.approval,
  migrationPlan: config.migrationPlan, effectPlan: config.effectPlan,
  evidence: artifact.candidateEvidence, context });
throw new Error('controller survived its selected promotion crash boundary');
