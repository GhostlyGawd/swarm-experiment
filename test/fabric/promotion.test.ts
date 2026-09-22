import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,unlinkSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { createEvidenceManifest,mintLocalEvidence,type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest,executionManifestDigest } from '../../src/fabric/identity.ts';
import { PromotionCoordinator,approvePromotion,createPromotionHandle,effectPlanDigest,evidenceBundleDigest,migrationPlanDigest,type PromotionBindingV1,type PreparedPromotionHandleV1,type PromotionDriver,type PromotionInput,type PromotionCoordinatorOptions } from '../../src/fabric/promotion.ts';
import type { TaggedValueV1 } from '../../src/fabric/encoding.ts';

const directories:string[]=[];
const temporary=()=>{const d=mkdtempSync(join(tmpdir(),'aether-promotion-'));directories.push(d);return d;};
after(()=>{for(const d of directories)rmSync(d,{recursive:true,force:true});});
const digest=(name:string)=>domainDigest('aether.promotion-test/1',name);
function context(left=10,right=10):EvidenceContext {
  const symbols=new SymbolSpace('promotion-literals');const sum=symbols.define('sum');
  const fn=b.fn({symbol:sum,returns:b.Int,contract:b.contract({ensures:[b.clause(b.ge(b.result(),b.int(18)),'minimum-total','formal')]}),body:b.block(b.ret(b.add(b.int(left),b.int(right))))});
  return {module:b.module_({symbol:symbols.define('module'),members:[fn],symbolTable:symbols.table()}),specification:'The sum is at least eighteen.',semanticsVersion:'aether-reference/1',compilerDigest:digest('compiler'),target:{abiVersion:'local/1',profileDigest:digest('profile'),artifactDigest:digest('artifact')},capabilityPolicyDigest:digest('capabilities'),registry:new CapabilityRegistry()};
}

/** Actual filesystem preparation/activation fixture. No runtime/process deployment claim. */
class FileDriver implements PromotionDriver {
  readonly directory:string;
  constructor(directory:string,genesis:string){this.directory=directory;mkdirSync(directory,{recursive:true});if(!existsSync(join(directory,'serving.json')))writeFileSync(join(directory,'serving.json'),JSON.stringify({manifest:genesis,generation:'0',activations:0}));}
  private path(binding:PromotionBindingV1):string{return join(this.directory,`${binding.proposalDigest.split(':').at(-1)}.prepared.json`);}
  async prepare(binding:PromotionBindingV1):Promise<PreparedPromotionHandleV1>{
    const handle=createPromotionHandle(binding,{tag:'string',value:this.path(binding)});
    writeFileSync(this.path(binding),JSON.stringify(handle));return handle;
  }
  async activate(binding:PromotionBindingV1,handle:PreparedPromotionHandleV1):Promise<void>{
    assert.equal(handle.proposalDigest,binding.proposalDigest);
    assert.deepEqual(JSON.parse(readFileSync(this.path(binding),'utf8')),JSON.parse(JSON.stringify(handle)));
    const file=join(this.directory,'serving.json');const previous=JSON.parse(readFileSync(file,'utf8'));
    if(previous.manifest!==binding.proposal.candidateManifest||previous.generation!==binding.generation)writeFileSync(file,JSON.stringify({manifest:binding.proposal.candidateManifest,generation:binding.generation,activations:previous.activations+1}));
  }
  async abort(binding:PromotionBindingV1,_handle:PreparedPromotionHandleV1|null):Promise<void>{if(existsSync(this.path(binding)))unlinkSync(this.path(binding));}
  async recover(binding:PromotionBindingV1,handle:PreparedPromotionHandleV1|null,decision:'commit'|'abort'):Promise<void>{if(decision==='commit')await this.activate(binding,handle!);else await this.abort(binding,handle);}
}
function fixture(){
  const directory=temporary(),keys=generateKeyPairSync('ed25519');
  const genesis=executionManifestDigest(createEvidenceManifest(context()));
  const authority={repositoryId:'repository:promotion',membershipEpoch:'1',policyEpoch:'1',eligibleGovernors:['governor:local']};
  const options:PromotionCoordinatorOptions={directory:join(directory,'coordinator'),repositoryId:authority.repositoryId,genesisManifest:genesis,authority:()=>authority,governorKey:()=>keys.publicKey,clock:()=>100n};
  function input(left=8,right=10,patch:Partial<PromotionInput>={}):PromotionInput{
    const ctx=context(left,right),evidence=mintLocalEvidence(ctx);const plan:TaggedValueV1={tag:'null'};
    const proposal={format:'aether.promotion/1' as const,repositoryId:authority.repositoryId,expectedParent:genesis,candidateManifest:executionManifestDigest(evidence.manifest),evidenceBundleDigest:evidenceBundleDigest(evidence),migrationPlanDigest:migrationPlanDigest(plan),effectPlanDigest:effectPlanDigest(plan),membershipEpoch:'1',policyEpoch:'1',expiresAt:'1000'};
    return {proposal,approval:approvePromotion(proposal,'governor:local',keys.privateKey),context:ctx,evidence,migrationPlan:plan,effectPlan:plan,...patch};
  }
  return {directory,keys,genesis,authority,options,input,driver:new FileDriver(join(directory,'driver'),genesis)};
}

test('F08 core: exact governor-approved subject commits and filesystem activation is idempotent',async()=>{
  const f=fixture(),coordinator=new PromotionCoordinator(f.options),input=f.input();
  const result=await coordinator.promote(input,f.driver);
  assert.equal(result.committedManifest,input.proposal.candidateManifest);assert.equal(result.activationPending,false);assert.equal(result.generation,'1');
  assert.equal(coordinator.servingManifest(),input.proposal.candidateManifest);
  assert.deepEqual(coordinator.history()[0].audit.map(e=>e.event),['candidate','validated','authorized','prepare-requested','prepared','commit','activation-complete']);
  assert.equal(new PromotionCoordinator(f.options).state().committedManifest,input.proposal.candidateManifest);
  await coordinator.promote(input,f.driver);await coordinator.recover(f.driver);
  assert.equal(JSON.parse(readFileSync(join(f.directory,'driver','serving.json'),'utf8')).activations,1);
});

test('F08 core: individually valid literal edits fail when their composed root violates a+b >= 18',async()=>{
  const f=fixture();mintLocalEvidence(context(8,10));mintLocalEvidence(context(10,8));
  assert.throws(()=>mintLocalEvidence(context(8,8)),/refuted|incomplete/);
  const approved=f.input(8,10);const coordinator=new PromotionCoordinator(f.options);
  await assert.rejects(()=>coordinator.promote({...approved,context:context(8,8)},f.driver),/stale|subject|manifest/);
  assert.equal(coordinator.state().committedManifest,f.genesis);assert.equal(coordinator.history()[0].phase,'rejected');
  assert.equal(JSON.parse(readFileSync(join(f.directory,'driver','serving.json'),'utf8')).manifest,f.genesis);
});

test('F08 core: forged signatures, changed effect/migration context and stale policy/expiration cannot authorize',async()=>{
  for(const variant of ['forged','policy','epoch','expired','revoked','effect','migration']){
    const f=fixture();let input=f.input();
    if(variant==='forged')input={...input,approval:approvePromotion(input.proposal,'governor:local',generateKeyPairSync('ed25519').privateKey)};
    if(variant==='policy')f.authority.policyEpoch='2';
    if(variant==='epoch')f.authority.membershipEpoch='2';
    if(variant==='revoked')f.authority.eligibleGovernors=[];
    if(variant==='expired'){const proposal={...input.proposal,expiresAt:'99'};input={...input,proposal,approval:approvePromotion(proposal,'governor:local',f.keys.privateKey)};}
    if(variant==='effect')input={...input,effectPlan:{tag:'string',value:'changed-effect'}};
    if(variant==='migration')input={...input,migrationPlan:{tag:'string',value:'changed-schema'}};
    const coordinator=new PromotionCoordinator(f.options);
    await assert.rejects(()=>coordinator.promote(input,f.driver));assert.equal(coordinator.servingManifest(),f.genesis);
  }
});

test('F08 core: failed prepare, cross-subject handles and policy changes during prepare preserve old state',async()=>{
  for(const variant of ['failure','handle','revocation']){
    const f=fixture(),coordinator=new PromotionCoordinator(f.options);const input=f.input();
    const prepare=f.driver.prepare.bind(f.driver);
    f.driver.prepare=async binding=>{const handle=await prepare(binding);if(variant==='failure')throw new Error('compile/import failed');if(variant==='revocation')f.authority.policyEpoch='2';return variant==='handle'?{...handle,generation:'99'}:handle;};
    await assert.rejects(()=>coordinator.promote(input,f.driver));
    assert.equal(coordinator.state().committedManifest,f.genesis);assert.equal(coordinator.history()[0].phase,'aborted');
    assert.equal(coordinator.state().pendingProposal,null);
  }
});

test('F08 core: activation failure after commit blocks serving and recovers the committed new target',async()=>{
  const f=fixture(),input=f.input(),coordinator=new PromotionCoordinator(f.options);const activate=f.driver.activate.bind(f.driver);
  f.driver.activate=async()=>{throw new Error('worker activation unavailable');};
  await assert.rejects(()=>coordinator.promote(input,f.driver),/activation unavailable/);
  assert.equal(coordinator.state().committedManifest,input.proposal.candidateManifest);assert.equal(coordinator.state().activationPending,true);
  assert.throws(()=>coordinator.servingManifest(),/serving is blocked/);
  await assert.rejects(()=>coordinator.promote(f.input(10,8),f.driver),/pending/);
  f.driver.activate=activate;
  const recovered=new PromotionCoordinator(f.options);await recovered.recover(f.driver);
  assert.equal(recovered.servingManifest(),input.proposal.candidateManifest);assert.equal(recovered.state().activationPending,false);
  assert.equal(recovered.history()[0].audit.at(-1)?.event,'recovery-activation-complete');
});

test('F08 core: two coordinator instances racing the same parent commit at most one candidate',async()=>{
  const f=fixture(),one=new PromotionCoordinator(f.options),two=new PromotionCoordinator(f.options);
  const first=f.input(8,10),second=f.input(10,8);
  const result=await Promise.allSettled([one.promote(first,f.driver),two.promote(second,f.driver)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected').length,1);
  assert.equal(one.state().generation,'1');assert.equal(one.history().filter(r=>r.phase==='active').length,1);
});

test('F08 core: malformed approvals are rejected before mutation and corrupt readiness/history fails closed',async()=>{
  const f=fixture(),coordinator=new PromotionCoordinator(f.options),input=f.input();
  await assert.rejects(()=>coordinator.promote({...input,approval:{...input.approval,unknown:true} as never},f.driver),/fields/);
  assert.equal(coordinator.history().length,0);
  await coordinator.promote(input,f.driver);
  const path=join(f.options.directory,'production.json');const original=readFileSync(path,'utf8');
  for(const change of [
    (journal:any)=>{journal.records[0].audit=journal.records[0].audit.filter((event:any)=>event.event!=='authorized');},
    (journal:any)=>{journal.records[0].activated=false;},
    (journal:any)=>{journal.records[0].handle.generation='99';},
    (journal:any)=>{journal.activeManifest=f.genesis;},
  ]){
    const journal=JSON.parse(original);change(journal);writeFileSync(path,JSON.stringify(journal));
    assert.throws(()=>coordinator.state());
  }
  writeFileSync(path,original);assert.equal(coordinator.servingManifest(),input.proposal.candidateManifest);
});

test('F08 core: real process death at each durable phase recovers before/after the commit boundary',async()=>{
  for(const phase of ['after-candidate','after-validated','after-authorized','after-prepared','after-commit','after-activation']){
    const f=fixture();const keyPath=join(f.directory,'governor.pem');writeFileSync(keyPath,f.keys.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
    const script=`
      import assert from 'node:assert/strict';
      import {createPrivateKey,createPublicKey} from 'node:crypto';
      import {existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
      import {join} from 'node:path';
      import * as b from ${JSON.stringify(new URL('../../src/tier1/build.ts',import.meta.url).href)};
      import {SymbolSpace} from ${JSON.stringify(new URL('../../src/tier1/symbols.ts',import.meta.url).href)};
      import {CapabilityRegistry} from ${JSON.stringify(new URL('../../src/tier2/ocap.ts',import.meta.url).href)};
      import {createEvidenceManifest,mintLocalEvidence} from ${JSON.stringify(new URL('../../src/fabric/evidence.ts',import.meta.url).href)};
      import {domainDigest,executionManifestDigest} from ${JSON.stringify(new URL('../../src/fabric/identity.ts',import.meta.url).href)};
      import {PromotionCoordinator,approvePromotion,createPromotionHandle,effectPlanDigest,evidenceBundleDigest,migrationPlanDigest} from ${JSON.stringify(new URL('../../src/fabric/promotion.ts',import.meta.url).href)};
      const digest=name=>domainDigest('aether.promotion-test/1',name);const context=${context.toString()};const FileDriver=${FileDriver.toString()};
      const [directory,keyPath,phase]=process.argv.slice(1);const privateKey=createPrivateKey(readFileSync(keyPath));const publicKey=createPublicKey(privateKey);
      const genesis=executionManifestDigest(createEvidenceManifest(context()));const ctx=context(8,10),evidence=mintLocalEvidence(ctx),plan={tag:'null'};
      const proposal={format:'aether.promotion/1',repositoryId:'repository:promotion',expectedParent:genesis,candidateManifest:executionManifestDigest(evidence.manifest),evidenceBundleDigest:evidenceBundleDigest(evidence),migrationPlanDigest:migrationPlanDigest(plan),effectPlanDigest:effectPlanDigest(plan),membershipEpoch:'1',policyEpoch:'1',expiresAt:'1000'};
      const coordinator=new PromotionCoordinator({directory:join(directory,'coordinator'),repositoryId:'repository:promotion',genesisManifest:genesis,authority:()=>({repositoryId:'repository:promotion',membershipEpoch:'1',policyEpoch:'1',eligibleGovernors:['governor:local']}),governorKey:()=>publicKey,clock:()=>100n,fault:point=>{if(point===phase)process.kill(process.pid,'SIGKILL');}});
      await coordinator.promote({proposal,approval:approvePromotion(proposal,'governor:local',privateKey),evidence,context:ctx,migrationPlan:plan,effectPlan:plan},new FileDriver(join(directory,'driver'),genesis));
    `;
    const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,f.directory,keyPath,phase],{encoding:'utf8'});
    assert.equal(child.signal,'SIGKILL',child.stderr);
    const coordinator=new PromotionCoordinator(f.options);coordinator.recoverDeadWriter();await coordinator.recover(f.driver);
    const committed=phase==='after-commit'||phase==='after-activation';
    assert.equal(coordinator.state().committedManifest,committed?f.input().proposal.candidateManifest:f.genesis);
    assert.equal(coordinator.state().activationPending,false);assert.equal(coordinator.state().pendingProposal,null);
    assert.equal(JSON.parse(readFileSync(join(f.directory,'driver','serving.json'),'utf8')).manifest,coordinator.servingManifest());
  }
});
