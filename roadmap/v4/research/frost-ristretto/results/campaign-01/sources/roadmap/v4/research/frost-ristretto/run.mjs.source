import assert from 'node:assert/strict';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { cpus, platform, arch, release } from 'node:os';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { enrollValidator, quorumVoteBody, verifyQuorumVote } from '../../../../src/fabric/quorum-crypto.ts';

import { certificateFromTrial, certificateDigest, groupDigest, verifyRistrettoResearchCertificate } from './verify.mjs';

const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, '../../../..');
const output = resolve(process.argv[2] ?? join(directory, 'results/campaign-01')), trials = Number(process.argv[3] ?? 10);
assert.ok(Number.isSafeInteger(trials) && trials >= 1 && trials <= 100);
assert.equal(existsSync(output), false, 'retain prior attempts; choose a fresh output directory'); mkdirSync(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['Cargo.toml','Cargo.lock','src/lib.rs','src/main.rs','src/verify.rs','tests/protocol.rs','run.mjs','verify.mjs'].map(path => [join('roadmap/v4/research/frost-ristretto', path), join(directory, path)]);
sources.push(...['src/fabric/encoding.ts','src/fabric/quorum-crypto.ts','src/fabric/identity.ts','src/fabric/promotion.ts'].map(path => [path, join(root, path)]));
const sourceHashes = {};
for (const [relative, file] of sources) { const bytes = readFileSync(file); sourceHashes[relative] = sha(bytes); const target = join(output, 'sources', `${relative}.source`); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
// Public, deterministic fixture identities; these seeds are NOT production keys.
const members = [1,2,3,4].map(id => { const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), Buffer.alloc(32,id)]), format: 'der', type: 'pkcs8' }); return enrollValidator(`fixture-validator-${id}`, id < 3 ? 'fixture-family-a' : 'fixture-family-b', id % 2 ? 'security' : 'proof', key); });
const roster = { format: 'aether.quorum-roster/1', repositoryId: 'ristretto-research', membershipEpoch: '2', policyEpoch: '5', faultBound: 1, validators: members };
const proposal = { format: 'aether.promotion/1', repositoryId: roster.repositoryId, expectedParent: domainDigest('aether.execution/1','parent'), candidateManifest: domainDigest('aether.execution/1','candidate'), evidenceBundleDigest: domainDigest('aether.evidence-bundle/1','evidence'), migrationPlanDigest: domainDigest('aether.migration-plan/1','migration'), effectPlanDigest: domainDigest('aether.effect-plan/1','effects'), membershipEpoch: roster.membershipEpoch, policyEpoch: roster.policyEpoch, expiresAt: '999999' };
const body = quorumVoteBody(roster, proposal, '3', 'commit', domainDigest('aether.quorum-genesis/1','research'));
const input = { body, participants: members.map((member,index) => ({ participant: index+1, validatorId: member.id, family: member.family, role: member.role, enrolledPublicKey: member.publicKey })) };
const inputPath = join(output,'public-input.json'); writeFileSync(inputPath, encodeCanonical(input)); writeFileSync(join(output,'roster.json'), encodeCanonical(roster));
const buildStarted = process.hrtime.bigint(), build = spawnSync('cargo', ['build','--release','--locked','--manifest-path',join(directory,'Cargo.toml')], { encoding:'utf8', timeout:120000 });
writeFileSync(join(output,'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`); assert.equal(build.status,0,build.stderr); const buildNs = String(process.hrtime.bigint()-buildStarted);
const binary=join(directory,'target/release/aether-frost-ristretto-prototype'),verifier={binary,sha256:sha(readFileSync(binary))},results=[],attempts=[];
const fixtureKey=id=>createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,id)]),format:'der',type:'pkcs8'});
const resign=certificate=>{certificate.attestations=certificate.attestations.map(item=>({participant:item.participant,authentication:sign(null,encodeCanonical({domain:'aether.ristretto-participation/1',participant:item.participant,transcript:certificate.transcript}),fixtureKey(item.participant)).toString('hex')}));certificate.id=certificateDigest(certificate);return certificate;};
const order=(1n<<252n)+27742317777372353535851937790883648493n;
const changeScalar=(value,delta)=>Buffer.from(((BigInt('0x'+Buffer.from(value,'hex').reverse().toString('hex'))+delta+order)%order).toString(16).padStart(64,'0'),'hex').reverse().toString('hex');
for(let trial=0;trial<trials;trial++){
  const started=process.hrtime.bigint(),child=spawnSync(binary,[inputPath],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  attempts.push({trial,status:child.status,signal:child.signal,stderr:child.stderr,wallNs:String(process.hrtime.bigint()-started)});writeFileSync(join(output,'attempts.json'),JSON.stringify(attempts,null,2));
  assert.equal(child.status,0,child.stderr);const raw=JSON.parse(child.stdout);writeFileSync(join(output,`trial-${trial}.json`),JSON.stringify(raw,null,2));
  assert.equal(new Set(raw.dkg.participant_pids).size,4);assert.equal(Buffer.from(raw.group_public_key,'hex').length,32);
  const checked=[],certificates=[],rejections=[];
  for(let roundIndex=0;roundIndex<raw.rounds.length;roundIndex++){
    const round=raw.rounds[roundIndex],certificate=certificateFromTrial(raw,round,roster),context={roster,proposal,view:'3',phase:'commit',parentBlock:body.parentBlock,currentParent:proposal.expectedParent,now:'0',expectedGroup:groupDigest(certificate.group)};
    assert.deepEqual(round.envelope.body,body);assert.deepEqual(Buffer.from(round.message_hex,'hex'),Buffer.from(encodeCanonical(round.envelope)));
    const at=process.hrtime.bigint(),result=verifyRistrettoResearchCertificate(certificate,context,verifier),verifyNs=String(process.hrtime.bigint()-at);assert.equal(result.productionAdmission,false);checked.push({round:roundIndex,result,verifyNs});certificates.push(certificate);
    const reject=(name,value,ctx=context,backend=verifier)=>{assert.throws(()=>verifyRistrettoResearchCertificate(value,ctx,backend),undefined,name);rejections.push({round:roundIndex,scenario:name,rejected:true});};
    for(const field of ['view','phase','membershipEpoch','policyEpoch','candidateManifest','expectedParent','roster','parentBlock','proposal']){const changed=structuredClone(certificate);changed.subject.body[field]+='-changed';changed.id=certificateDigest(changed);reject(`changed ${field}`,changed);}
    for(const field of ['family','role']){const changed=structuredClone(certificate);changed.subject.participants[0][field]='unattested';changed.id=certificateDigest(changed);reject(`changed ${field}`,changed);}
    const missing=structuredClone(certificate);missing.attestations=[];missing.id=certificateDigest(missing);reject('group-signature-only',missing);
    const duplicate=structuredClone(certificate);duplicate.attestations[1]=duplicate.attestations[0];duplicate.id=certificateDigest(duplicate);reject('duplicate participation',duplicate);
    const identity=structuredClone(certificate);identity.attestations[0].authentication='00'.repeat(64);identity.id=certificateDigest(identity);reject('forged identity signature',identity);
    reject('expired exact boundary',certificate,{...context,now:proposal.expiresAt});reject('wrong expected group',certificate,{...context,expectedGroup:domainDigest('aether.ristretto-research-group/1','other')});reject('unpinned verifier',certificate,context,{...verifier,sha256:'00'.repeat(32)});
    for(const kind of ['changed-share','cancelling-shares','malformed-point']){
      const changed=structuredClone(certificate),ids=Object.keys(changed.transcript.signature_shares);
      if(kind==='malformed-point'){const bytes=Buffer.from(changed.transcript.signing_package,'hex');bytes.fill(0,43,75);changed.transcript.signing_package=bytes.toString('hex');}
      else {changed.transcript.signature_shares[ids[0]]=changeScalar(changed.transcript.signature_shares[ids[0]],1n);if(kind==='cancelling-shares')changed.transcript.signature_shares[ids[1]]=changeScalar(changed.transcript.signature_shares[ids[1]],-1n);}
      reject(`authenticated ${kind}`,resign(changed));
    }
    const cross=structuredClone(certificate);cross.subject.ciphersuite='FROST-ED25519-SHA512-v1';cross.id=certificateDigest(cross);reject('Ed25519 profile substitution',cross);
    assert.equal(verifyQuorumVote({body,signer:round.envelope.groupSigner,signature:Buffer.from(round.transcript.signature,'hex').toString('base64')},roster),false);
  }
  writeFileSync(join(output,`certificates-${trial}.json`),JSON.stringify(certificates,null,2));
  assert.ok(raw.rejections.every(item=>item.rejected===true));results.push({trial,checked,rejections,dkgNs:raw.dkg.elapsed_ns,signingNs:raw.rounds.map(round=>round.transcript.elapsed_ns),aggregateNs:raw.rounds.map(round=>round.transcript.aggregate_ns),verifyAllSharesNs:raw.rounds.map(round=>round.transcript.all_shares_verify_ns),round1Bytes:raw.dkg.round1_delivery_bytes,round2Bytes:raw.dkg.round2_confidential_delivery_bytes});
}
const stats=values=>{const sorted=values.map(Number).sort((a,b)=>a-b);return{count:sorted.length,minNs:sorted[0],medianNs:sorted[Math.floor(sorted.length/2)],maxNs:sorted.at(-1)};};
const manifest={format:'aether.ristretto-research-campaign/1',createdAt:new Date().toISOString(),sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceHashes,binarySha256:verifier.sha256,cargoLockSha256:sha(readFileSync(join(directory,'Cargo.lock'))),toolchain:{rust:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(),cargo:execFileSync('cargo',['--version'],{encoding:'utf8'}).trim(),node:process.version,openssl:process.versions.openssl},host:{platform:platform(),arch:arch(),release:release(),cpu:cpus()[0]?.model},buildNs,trials,signatures:trials*4,results,measurements:{dkgWithProcessLaunchIpcAndIdentityEnrollment:stats(results.map(item=>item.dkgNs)),signingWithIpcShareVerificationAndIdentityAttestation:stats(results.flatMap(item=>item.signingNs)),aggregate:stats(results.flatMap(item=>item.aggregateNs)),pinnedAllSharesAndGroupVerification:stats(results.flatMap(item=>item.verifyAllSharesNs)),freshVerifierAndOpenSslIdentityAuthentication:stats(results.flatMap(item=>item.checked.map(row=>row.verifyNs)))},limitations:['This uses D04-compatible FROST(ristretto255,SHA-512), but remains a research profile without production admission.','Four worker processes perform actual DKG/signing; trusted local plaintext IPC exposes confidential DKG deliveries to the coordinator.','Workers authenticate enrollment and complete individually-verified public transcripts with fixture identity keys, not real operator enrollment credentials.','Fresh public verification is process-separated but uses the same pinned FROST implementation; OpenSSL independently verifies Ed25519 identity attestations only.','Key custody, secure broadcast/channels, durable nonce/replay journals, membership handoff, protocol integration and independent security review remain open.','Finite same-host timings include the stated IPC/process/attestation costs; no product latency or WAN guarantee is claimed.']};
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({output,trials,signatures:manifest.signatures,rejections:results.reduce((sum,item)=>sum+item.rejections.length,0),measurements:manifest.measurements},null,2));
