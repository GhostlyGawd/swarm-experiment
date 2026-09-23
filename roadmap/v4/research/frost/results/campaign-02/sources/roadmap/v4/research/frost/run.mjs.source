import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { cpus, platform, arch, release } from 'node:os';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { enrollValidator, quorumVoteBody, verifyQuorumVote } from '../../../../src/fabric/quorum-crypto.ts';

const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, '../../../..');
const output = resolve(process.argv[2] ?? join(directory, 'results/campaign-01')), trials = Number(process.argv[3] ?? 10);
assert.ok(Number.isSafeInteger(trials) && trials >= 1 && trials <= 100);
assert.equal(existsSync(output), false, 'retain prior attempts; choose a fresh output directory'); mkdirSync(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['Cargo.toml','Cargo.lock','src/lib.rs','src/main.rs','tests/protocol.rs','run.mjs'].map(path => [join('roadmap/v4/research/frost', path), join(directory, path)]);
sources.push(...['src/fabric/encoding.ts','src/fabric/quorum-crypto.ts','src/fabric/identity.ts','src/fabric/promotion.ts'].map(path => [path, join(root, path)]));
const sourceHashes = {};
for (const [relative, file] of sources) { const bytes = readFileSync(file); sourceHashes[relative] = sha(bytes); const target = join(output, 'sources', `${relative}.source`); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
// Public, deterministic fixture identities; these seeds are NOT production keys.
const members = [1,2,3,4].map(id => { const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), Buffer.alloc(32,id)]), format: 'der', type: 'pkcs8' }); return enrollValidator(`fixture-validator-${id}`, id < 3 ? 'fixture-family-a' : 'fixture-family-b', id % 2 ? 'security' : 'proof', key); });
const roster = { format: 'aether.quorum-roster/1', repositoryId: 'frost-research', membershipEpoch: '2', policyEpoch: '5', faultBound: 1, validators: members };
const proposal = { format: 'aether.promotion/1', repositoryId: roster.repositoryId, expectedParent: domainDigest('aether.execution/1','parent'), candidateManifest: domainDigest('aether.execution/1','candidate'), evidenceBundleDigest: domainDigest('aether.evidence-bundle/1','evidence'), migrationPlanDigest: domainDigest('aether.migration-plan/1','migration'), effectPlanDigest: domainDigest('aether.effect-plan/1','effects'), membershipEpoch: roster.membershipEpoch, policyEpoch: roster.policyEpoch, expiresAt: '999999' };
const body = quorumVoteBody(roster, proposal, '3', 'commit', domainDigest('aether.quorum-genesis/1','research'));
const input = { body, participants: members.map((member,index) => ({ participant: index+1, validatorId: member.id, family: member.family, role: member.role, enrolledPublicKey: member.publicKey })) };
const inputPath = join(output,'public-input.json'); writeFileSync(inputPath, encodeCanonical(input)); writeFileSync(join(output,'roster.json'), encodeCanonical(roster));
const buildStarted = process.hrtime.bigint(), build = spawnSync('cargo', ['build','--release','--locked','--manifest-path',join(directory,'Cargo.toml')], { encoding:'utf8', timeout:120000 });
writeFileSync(join(output,'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`); assert.equal(build.status,0,build.stderr); const buildNs = String(process.hrtime.bigint()-buildStarted);
const binary = join(directory,'target/release/aether-frost-prototype'), results = [], attempts = [];
for (let trial=0; trial<trials; trial++) {
  const started = process.hrtime.bigint(), child = spawnSync(binary,[inputPath],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  const attempt = { trial, status:child.status, signal:child.signal, stderr:child.stderr, wallNs:String(process.hrtime.bigint()-started) }; attempts.push(attempt); writeFileSync(join(output,'attempts.json'),JSON.stringify(attempts,null,2));
  assert.equal(child.status,0,child.stderr); const result=JSON.parse(child.stdout); writeFileSync(join(output,`trial-${trial}.json`),JSON.stringify(result,null,2));
  assert.equal(new Set(result.dkg.participant_pids).size,4); const rawKey=Buffer.from(result.group_public_key,'hex'); assert.equal(rawKey.length,32);
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),rawKey]),format:'der',type:'spki'});
  const verification=[];
  for (const round of result.rounds) {
    assert.deepEqual(round.envelope.body,body); assert.deepEqual(Buffer.from(round.message_hex,'hex'),Buffer.from(encodeCanonical(round.envelope)));
    assert.equal(round.envelope.groupSigner,`frost-ed25519:${result.group_public_key}`); assert.equal(round.envelope.dkgSession,result.dkg.session);
    assert.deepEqual(round.envelope.participants,round.transcript.participants.map(id=>input.participants[id-1]));
    const message=Buffer.from(round.message_hex,'hex'), signature=Buffer.from(round.transcript.signature,'hex'); assert.equal(signature.length,64);
    const at=process.hrtime.bigint(); assert.equal(verify(null,message,key,signature),true); const verifyNs=String(process.hrtime.bigint()-at);
    const rejected=[];
    for (const field of ['view','phase','membershipEpoch','policyEpoch','proposal','expectedParent','candidateManifest','parentBlock','roster','block']) {
      const changed=structuredClone(round.envelope); changed.body[field]+='-changed'; assert.equal(verify(null,encodeCanonical(changed),key,signature),false); rejected.push(field);
    }
    const changed=structuredClone(round.envelope); changed.participants[0].family='unattested-other-family'; assert.equal(verify(null,encodeCanonical(changed),key,signature),false);
    assert.equal(verifyQuorumVote({body,signer:round.envelope.groupSigner,signature:signature.toString('base64')},roster),false,'prototype is not an existing individual quorum vote');
    verification.push({participants:round.transcript.participants,opensslVerified:true,verifyNs,rejectedSubjectChanges:rejected,rejectedFamilyChange:true,existingVoteAdmission:false});
  }
  assert.ok(result.rejections.every(check=>check.rejected===true)); results.push({trial,verification,dkgNs:result.dkg.elapsed_ns,signingNs:result.rounds.map(round=>round.transcript.elapsed_ns),aggregateNs:result.rounds.map(round=>round.transcript.aggregate_ns),round1Bytes:result.dkg.round1_delivery_bytes,round2Bytes:result.dkg.round2_confidential_delivery_bytes});
}
const stats=values=>{const sorted=values.map(Number).sort((a,b)=>a-b);return {count:sorted.length,minNs:sorted[0],medianNs:sorted[Math.floor(sorted.length/2)],maxNs:sorted.at(-1)};};
const manifest={format:'aether.frost-research-campaign/1',createdAt:new Date().toISOString(),sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceHashes,binarySha256:sha(readFileSync(binary)),cargoLockSha256:sha(readFileSync(join(directory,'Cargo.lock'))),toolchain:{rust:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(),cargo:execFileSync('cargo',['--version'],{encoding:'utf8'}).trim(),node:process.version,openssl:process.versions.openssl},host:{platform:platform(),arch:arch(),release:release(),cpu:cpus()[0]?.model},buildNs,trials,signatures:trials*4,results,measurements:{dkgIncludingFourProcessLaunchAndLocalIpc:stats(results.map(result=>result.dkgNs)),signingIncludingLocalIpcAndFrostVerify:stats(results.flatMap(result=>result.signingNs)),aggregate:stats(results.flatMap(result=>result.aggregateNs)),independentOpenSslVerify:stats(results.flatMap(result=>result.verification.map(item=>item.verifyNs)))},limitations:['Trusted coordinator/local pipes observe confidential DKG round2 packages; this is not a secure network DKG deployment.','Four participant processes hold private state; no keys or nonces are persisted or resumed. Process loss aborts that session.','Fixture family/role metadata and public share transcript are retained; a group signature alone does not attest operator enrollment or family independence.','Distinct prototype group envelope retains the exact current quorum vote body; existing individual-vote/QC admission rejects it.','No production key ceremony, authenticated broadcast, confidential transport, durable nonce journal, membership handoff, threshold QC admission or formal audit is completed.','Finite same-host timings include IPC and stated process launch costs; no WAN, throughput or product latency gate is qualified.']};
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)); console.log(JSON.stringify({output,trials,signatures:manifest.signatures,measurements:manifest.measurements},null,2));
