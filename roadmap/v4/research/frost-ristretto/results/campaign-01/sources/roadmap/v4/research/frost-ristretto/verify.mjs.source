/** Research adapter only: OpenSSL authenticates enrolled fixture identities;
 * a pinned fresh Rust process verifies every Ristretto FROST share and signature.
 * No production admission, key ceremony, membership handoff or replay journal. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { encodeCanonical, exactObject, decimal } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { quorumRosterDigest, quorumVoteBody } from '../../../../src/fabric/quorum-crypto.ts';
const limits={maxFrameBytes:128*1024,maxDecompressedBytes:128*1024,maxObjects:5000,maxDepth:24};
const same=(a,b)=>Buffer.from(encodeCanonical(a,limits)).equals(Buffer.from(encodeCanonical(b,limits)));
const bytes=(value,length)=>{if(typeof value!=='string'||value.length!==length*2||!/^[0-9a-f]+$/.test(value))throw new TypeError('invalid public cryptographic bytes');return Buffer.from(value,'hex');};
const hash=value=>createHash('sha256').update(value).digest('hex');
export const groupDigest=group=>domainDigest('aether.ristretto-research-group/1',{roster:group.roster,session:group.session,publicPackage:group.publicPackage,groupPublicKey:group.groupPublicKey},limits);
export const certificateDigest=certificate=>{const {id:_id,...body}=certificate;return domainDigest('aether.ristretto-research-certificate/1',body,limits);};
export function certificateFromTrial(trial,round,roster){const certificate={format:'aether.ristretto-research-certificate/1',group:{roster:quorumRosterDigest(roster),session:trial.dkg.session,publicPackage:trial.dkg.public_package,groupPublicKey:trial.group_public_key,enrollments:trial.dkg.enrollments},subject:round.envelope,transcript:round.transcript.public_transcript,attestations:round.transcript.attestations};return {...certificate,id:certificateDigest(certificate)};}
function identity(payload,signature,member){const key=createPublicKey({key:Buffer.from(member.publicKey,'base64'),format:'der',type:'spki'});if(!verify(null,encodeCanonical(payload,limits),key,bytes(signature,64)))throw new TypeError('invalid enrolled identity authentication');}
export function verifyRistrettoResearchCertificate(certificate,context,verifier){
  encodeCanonical(certificate,limits);encodeCanonical(context,limits);
  exactObject(context,['roster','proposal','view','phase','parentBlock','currentParent','now','expectedGroup']);decimal(context.now);
  exactObject(certificate,['format','group','subject','transcript','attestations','id']);
  if(certificate.format!=='aether.ristretto-research-certificate/1'||certificate.id!==certificateDigest(certificate))throw new TypeError('research certificate format/address mismatch');
  const roster=context.roster, rosterId=quorumRosterDigest(roster);if(roster.validators.length!==4||roster.faultBound!==1)throw new TypeError('research committee must be n=4,f=1,t=3');
  const group=certificate.group;exactObject(group,['roster','session','publicPackage','groupPublicKey','enrollments']);bytes(group.session,16);bytes(group.groupPublicKey,32);
  if(group.roster!==rosterId||groupDigest(group)!==context.expectedGroup||!Array.isArray(group.enrollments)||group.enrollments.length!==4)throw new TypeError('untrusted/missing group enrollment');
  for(let index=0;index<4;index++){
    const entry=group.enrollments[index];exactObject(entry,['public_package','group_key','enrollment','authentication']);
    const expected={domain:'aether.ristretto-group-enrollment/1',session:group.session,participant:index+1,n:4,threshold:3,public_package:group.publicPackage,group_key:group.groupPublicKey};
    if(entry.public_package!==group.publicPackage||entry.group_key!==group.groupPublicKey||!same(entry.enrollment,expected))throw new TypeError('mixed group enrollment');identity(expected,entry.authentication,roster.validators[index]);
  }
  if(context.proposal.expectedParent!==context.currentParent||BigInt(context.now)>=BigInt(context.proposal.expiresAt))throw new TypeError('stale proposal');
  const subject=certificate.subject;exactObject(subject,['domain','body','groupSigner','dkgSession','ciphersuite','threshold','participants']);
  if(subject.domain!=='aether.quorum-ristretto-vote-prototype/1'||subject.ciphersuite!=='FROST-RISTRETTO255-SHA512-v1'||subject.groupSigner!==`frost-ristretto255:${group.groupPublicKey}`||subject.dkgSession!==group.session||subject.threshold!==3||!same(subject.body,quorumVoteBody(roster,context.proposal,context.view,context.phase,context.parentBlock)))throw new TypeError('Ristretto subject binding mismatch');
  const transcript=certificate.transcript;exactObject(transcript,['format','session','public_package','group_public_key','nonce_id','signing_package','signature_shares','signature']);
  if(transcript.format!=='aether.ristretto-public-transcript/1'||transcript.session!==group.session||transcript.public_package!==group.publicPackage||transcript.group_public_key!==group.groupPublicKey)throw new TypeError('mixed public transcript');
  if(!Array.isArray(subject.participants)||subject.participants.length<3||subject.participants.length>4||!Array.isArray(certificate.attestations)||certificate.attestations.length!==subject.participants.length)throw new TypeError('group signature alone lacks quorum participation');
  const families=new Set(),roles=new Set(),shares=new Set(),selected=[];let previous=0;
  for(let index=0;index<subject.participants.length;index++){
    const participant=subject.participants[index],number=participant.participant,attestation=certificate.attestations[index];exactObject(attestation,['participant','authentication']);
    if(!Number.isSafeInteger(number)||number<=previous||number>4||attestation.participant!==number)throw new TypeError('duplicate or wrong signing participant');previous=number;
    const member=roster.validators[number-1];if(!same(participant,{participant:number,validatorId:member.id,family:member.family,role:member.role,enrolledPublicKey:member.publicKey}))throw new TypeError('unattested family/role mapping');
    const share=transcript.signature_shares?.[String(number)];bytes(share,32);if(shares.has(share))throw new TypeError('duplicate signature share');shares.add(share);selected.push(String(number));families.add(member.family);roles.add(member.role);
    identity({domain:'aether.ristretto-participation/1',participant:number,transcript},attestation.authentication,member);
  }
  exactObject(transcript.signature_shares,selected);if(families.size<2||roles.size<2)throw new TypeError('homogeneous signing quorum');
  if(typeof verifier.binary!=='string'||!/^[a-f0-9]{64}$/.test(verifier.sha256)||hash(readFileSync(verifier.binary))!==verifier.sha256)throw new TypeError('unpinned public verifier binary');
  const checked=spawnSync(verifier.binary,['verify'],{input:JSON.stringify([transcript]),encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});if(checked.status!==0)throw new Error('public verifier process failed');
  const output=JSON.parse(checked.stdout);if(!Array.isArray(output)||output.length!==1||output[0].valid!==true||!same(output[0].subject,subject)||output[0].message_hex!==Buffer.from(encodeCanonical(subject,limits)).toString('hex'))throw new TypeError('pinned FROST rejected group/share transcript');
  return {profile:'ristretto255-research-only/1',certificate:certificate.id,group:context.expectedGroup,participants:subject.participants.map(item=>item.validatorId),productionAdmission:false};
}
