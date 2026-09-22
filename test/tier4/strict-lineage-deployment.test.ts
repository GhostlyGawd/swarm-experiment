import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { encode as encodeIR } from '../../src/tier1/agent-ir.ts';
import { atomicWrite } from '../../src/tier1/persistence.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger, fenceRequirement, signIntent, signSpecRevision, type SpecReference } from '../../src/tier1/causal-lineage.ts';
import { ACCOUNT, CAP_LEDGER_APPEND, buildLedgerExample } from '../../src/examples/ledger.ts';
import { CapabilitySealer } from '../../src/tier2/ocap.ts';
import { DEFAULT_EVIDENCE_POLICY, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { DurableEffectBroker, type EffectAdapter } from '../../src/fabric/effects.ts';
import { JournalLock } from '../../src/fabric/journal-lock.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import type { LogicalRefV1, TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { approvePromotion, evidenceBundleDigest, effectPlanDigest, migrationPlanDigest, PromotionCoordinator, StrictLineageServingError, type PromotionInput, type PromotionCoordinatorOptions } from '../../src/fabric/promotion.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessDeployment, processArtifactContext, processEffectPlan, processMigrationPlan, type ProcessArtifactV1, type ProcessDeploymentOptions } from '../../src/tier4/process-deployment.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const integer=(value:number):TaggedValueV1=>({tag:'int',value:String(value)});
const text=(value:string):TaggedValueV1=>({tag:'string',value});
const reference=(value:LogicalRefV1,epoch=value.ownerEpoch):TaggedValueV1=>({tag:'ref',value:{...value,ownerEpoch:epoch}});

// This host service factory is reconstructed from trusted code after a real
// coordinator crash. Only artifact/configuration data is stored by the driver.
function services(directory:string,artifact:ProcessArtifactV1){
  const sinkLock=new JournalLock({directory:join(directory,'sink-lock'),domain:'aether.strict-test-sink'});
  const adapter:EffectAdapter={id:'strict-ledger/1',semantics:{readOnly:false,atomicIdempotency:true,transactional:false,reconciliation:true},execute:request=>sinkLock.run(()=>{
    const file=join(directory,'sink.json'),rows=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];
    const id=`${request.executionId}/${request.effectId}`;
    if(!rows.some((row:{id:string})=>row.id===id)){rows.push({id,payload:request.payload});atomicWrite(file,JSON.stringify(rows));}
    return {tag:'null'};
  }),reconcile:request=>{
    const file=join(directory,'sink.json'),rows=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];
    return rows.some((row:{id:string})=>row.id===`${request.executionId}/${request.effectId}`)?{state:'committed',value:{tag:'null'}}:{state:'not_committed'};
  }};
  return {sealer:new CapabilitySealer(new Uint8Array(32).fill(19),()=>100),authorizeRecovery:()=>true,effectRouterFactory:(context:any)=>{
    const path=join(directory,'effects',domainDigest('aether.strict-effect/1',context.operationId).split(':').at(-1)!);
    const live=new DurableEffectBroker({directory:path,clockDomain:'test/1',clock:()=>100n,authorize:()=>true});
    const broker=context.mode==='live'?live:new DurableEffectBroker({directory:path,mode:'replay',clockDomain:'test/1',clock:()=>100n,authorize:()=>false,replayEvents:live.events()});
    return new BrokerEffectRouter({broker,manifest:artifact.manifest,executionId:context.operationId,policyEpoch:'1',deadline:'1000',adapters:new Map([[CAP_LEDGER_APPEND,adapter]]),grant:()=> 'strict-test-grant'});
  }};
}
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'aether-strict-deployment-')),ex=buildLedgerExample('strict-deployment');
  const authorKeys=generateKeyPairSync('ed25519'),governorKeys=generateKeyPairSync('ed25519');
  const authorAuthority={policyEpoch:'1',eligibleAuthors:['author']};
  const governorAuthority={repositoryId:'strict-ledger',membershipEpoch:'1',policyEpoch:'1',eligibleGovernors:['governor']};
  const store=new DurableGraphStore({directory:join(directory,'ast')});
  const ledger=new CausalLineageLedger({directory:join(directory,'lineage'),repositoryId:'strict-ledger',store,authority:()=>authorAuthority,authorKey:()=>authorKeys.publicKey});
  const base=ex.module as Extract<Term,{kind:'Module'}>;
  const moduleFor=(version:string):Term=>({...base,members:base.members.filter(member=>member.kind!=='FunctionDecl'||[ex.symbols.transfer,ex.symbols.feeFor].includes(member.symbol)).map(member=>{
    if(member.kind!=='FunctionDecl'||member.symbol!==ex.symbols.transfer||version==='v1')return member;
    const body=member.body as Extract<Term,{kind:'Block'}>;
    return {...member,body:{...body,stmts:body.stmts.map(stmt=>stmt.kind==='ExprStmt'&&stmt.expr.kind==='Invoke'?b.exprStmt(b.invoke(CAP_LEDGER_APPEND,b.concat(b.str(`${version}:`),stmt.expr.args[0]),...stmt.expr.args.slice(1))):stmt)}};
  })});
  const original=moduleFor('v1');store.intern(original,{leaseId:'original-draft'});
  const transfer=(original as Extract<Term,{kind:'Module'}>).members.find(member=>member.kind==='FunctionDecl'&&member.symbol===ex.symbols.transfer)!;
  let parent:SpecReference={id:'company',revision:ledger.publishSpec(signSpecRevision({repositoryId:'strict-ledger',id:'company',revision:1,previous:null,parents:[],text:'Conserve value under explicit authority.',requirements:[],author:'author',policyEpoch:'1',nonce:randomUUID()},authorKeys.privateKey))};
  let leaf:SpecReference={id:'ledger',revision:ledger.publishSpec(signSpecRevision({repositoryId:'strict-ledger',id:'ledger',revision:1,previous:null,parents:[parent],text:'Transfers preserve account conservation.',requirements:[fenceRequirement(transfer)],author:'author',policyEpoch:'1',nonce:randomUUID()},authorKeys.privateKey))};
  let revision=1,sequence=0;
  const prepareArtifact=(version:string,parents:string[])=>{
    const module=moduleFor(version);store.intern(module,{leaseId:`draft-${sequence++}`});
    const specification=ledger.specification(parents,[leaf]);
    const d=(value:string)=>domainDigest('aether.strict-test/1',value);
    const context:EvidenceContext={module,registry:ex.capabilities,specification,semanticsVersion:'aether-reference/1',compilerDigest:d('compiler'),target:{abiVersion:'process/1',profileDigest:d('two-workers'),artifactDigest:d(encodeIR(module).text)},capabilityPolicyDigest:d('ledger-capability-rules'),policy:{...DEFAULT_EVIDENCE_POLICY,requireFormal:false}};
    const evidence=mintLocalEvidence(context);
    return {context,evidence,manifest:executionManifestDigest(evidence.manifest),version};
  };
  const endorse=(artifact:ReturnType<typeof prepareArtifact>,parents:string[])=>{
    const intent=ledger.recordIntent(signIntent({repositoryId:'strict-ledger',subject:artifact.evidence.manifest.astRoot as any,executionManifest:artifact.manifest,evidenceBundleDigest:evidenceBundleDigest(artifact.evidence),parents,specifications:[leaf],purpose:parents.length?'rewrite':'genesis',text:`Approve ${artifact.version} with preserved ledger fences.`,author:'author',policyEpoch:authorAuthority.policyEpoch,nonce:randomUUID()},authorKeys.privateKey));
    ledger.admitArtifact(intent,artifact.evidence,artifact.context);return {...artifact,intent};
  };
  const genesis=endorse(prepareArtifact('v1',[]),[]);
  const plan=(swapped=false):TopologyPlan=>({shape:'containers',units:[{id:'a',members:[swapped?ex.symbols.feeFor:ex.symbols.transfer],capabilities:swapped?[]:[CAP_LEDGER_APPEND],placement:'container',memoryMb:16},{id:'b',members:[swapped?ex.symbols.transfer:ex.symbols.feeFor],capabilities:swapped?[CAP_LEDGER_APPEND]:[],placement:'container',memoryMb:16}],crossEdges:[],transportLatencyMsPerSecond:0,monthlyCost:0,recombinations:[],blockedMerges:[]});
  const coordinatorOptions:PromotionCoordinatorOptions={directory:join(directory,'coordinator'),repositoryId:'strict-ledger',genesisManifest:genesis.manifest,lineage:ledger.admissionAdapter(),authority:()=>governorAuthority,governorKey:()=>governorKeys.publicKey,clock:()=>100n};
  const coordinator=new PromotionCoordinator(coordinatorOptions);
  const options:ProcessDeploymentOptions={directory:join(directory,'deployment'),coordinator,factories:new Map([['ledger-services/1',(artifact:ProcessArtifactV1)=>services(directory,artifact)]]),genesis:{context:genesis.context,evidence:genesis.evidence,plan:plan(),factoryId:'ledger-services/1'}};
  const input=async(deployment:ProcessDeployment,artifact:ReturnType<typeof prepareArtifact>,swapped=true):Promise<PromotionInput>=>{
    const id=deployment.registerArtifact({context:artifact.context,evidence:artifact.evidence,plan:plan(swapped),factoryId:'ledger-services/1'});
    const migrationPlan=processMigrationPlan(await deployment.snapshotForPromotion(),id),effectPlan=processEffectPlan('ledger-services/1',artifact.evidence.manifest.capabilityPolicyDigest);
    const proposal={format:'aether.promotion/1' as const,repositoryId:'strict-ledger',expectedParent:coordinator.state().committedManifest,candidateManifest:artifact.manifest,evidenceBundleDigest:evidenceBundleDigest(artifact.evidence),migrationPlanDigest:migrationPlanDigest(migrationPlan),effectPlanDigest:effectPlanDigest(effectPlan),membershipEpoch:governorAuthority.membershipEpoch,policyEpoch:governorAuthority.policyEpoch,expiresAt:String(1000000+sequence++)};
    return {proposal,approval:approvePromotion(proposal,'governor',governorKeys.privateKey),context:artifact.context,evidence:artifact.evidence,migrationPlan,effectPlan};
  };
  const reviseSpecs=()=>{
    revision++;
    parent={id:'company',revision:ledger.publishSpec(signSpecRevision({repositoryId:'strict-ledger',id:'company',revision,previous:parent.revision,parents:[],text:`Company policy revision ${revision}.`,requirements:[],author:'author',policyEpoch:authorAuthority.policyEpoch,nonce:randomUUID()},authorKeys.privateKey))};
    leaf={id:'ledger',revision:ledger.publishSpec(signSpecRevision({repositoryId:'strict-ledger',id:'ledger',revision,previous:leaf.revision,parents:[parent],text:`Ledger policy revision ${revision}.`,requirements:[fenceRequirement(transfer)],author:'author',policyEpoch:authorAuthority.policyEpoch,nonce:randomUUID()},authorKeys.privateKey))};
  };
  const rows=():any[]=>existsSync(join(directory,'sink.json'))?JSON.parse(readFileSync(join(directory,'sink.json'),'utf8')):[];
  return {directory,ex,authorKeys,governorKeys,authorAuthority,governorAuthority,store,ledger,genesis,coordinator,coordinatorOptions,options,plan,prepareArtifact,endorse,input,reviseSpecs,rows};
}
async function accounts(deployment:ProcessDeployment){
  const alice=await deployment.allocateRecord(ACCOUNT,{id:text('alice'),balance:integer(100)},{operationId:'alice',unit:'a'});
  const bob=await deployment.allocateRecord(ACCOUNT,{id:text('bob'),balance:integer(0)},{operationId:'bob',unit:'b'});return {alice,bob};
}
async function balances(deployment:ProcessDeployment){return(await deployment.snapshotForPromotion()).records.map(record=>(record.fields.find(([key])=>key==='balance')![1] as {value:string}).value);}

test('strict deployment requires signed genesis, exact evidence and causal parent linkage for real ledger promotion/rollback',async()=>{
  const f=fixture();let deployment:ProcessDeployment|undefined;
  try{
    deployment=await ProcessDeployment.open(f.options);assert.equal(f.coordinator.admissionProfile,'strict-lineage-v1');assert.equal(Object.keys(deployment.status().workerPids).length,2);
    const {alice,bob}=await accounts(deployment);
    const receipt=await deployment.call(f.ex.symbols.transfer,[reference(alice),reference(bob),integer(10)],{operationId:'first-transfer',tokens:deployment.issueTokens(f.ex.symbols.transfer)});
    assert.equal(receipt.state,'completed');assert.deepEqual(await balances(deployment),['90','10']);assert.equal(f.rows().length,1);
    const unsigned=f.prepareArtifact('v2',[f.genesis.intent]);
    await assert.rejects(deployment.promote(await f.input(deployment,unsigned)),/signed intent/);
    assert.equal(deployment.servingManifest(),f.genesis.manifest);assert.equal(f.rows().length,1);
    const candidate=f.endorse(unsigned,[f.genesis.intent]);await deployment.promote(await f.input(deployment,candidate));
    assert.equal(deployment.servingManifest(),candidate.manifest);assert.equal(f.rows().length,1);
    assert.deepEqual(await deployment.call(f.ex.symbols.transfer,[reference(alice,'1'),reference(bob,'1'),integer(10)],{operationId:'first-transfer',tokens:deployment.issueTokens(f.ex.symbols.transfer)}),receipt);
    await deployment.call(f.ex.symbols.transfer,[reference(alice,'1'),reference(bob,'1'),integer(5)],{operationId:'second-transfer',tokens:deployment.issueTokens(f.ex.symbols.transfer)});
    assert.equal(f.rows()[1].payload.items[1].value,'v2:alice');assert.deepEqual(await balances(deployment),['85','15']);
    await assert.rejects(deployment.promote(await f.input(deployment,f.genesis,false)),/causal links/);
    f.endorse(f.genesis,[candidate.intent]);await deployment.promote(await f.input(deployment,f.genesis,false));
    assert.equal(deployment.servingManifest(),f.genesis.manifest);assert.equal(deployment.status().generation,'2');assert.deepEqual(await balances(deployment),['85','15']);assert.equal(f.rows().length,2);
    await deployment.close();deployment=await ProcessDeployment.open({...f.options,genesis:undefined});assert.equal(deployment.servingManifest(),f.genesis.manifest);
  }finally{await deployment?.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('strict serving invalidates on transitive specification revision and signed repair can replace the quiescent stale source',async()=>{
  const f=fixture();let deployment:ProcessDeployment|undefined;
  try{
    deployment=await ProcessDeployment.open(f.options);const {alice,bob}=await accounts(deployment);
    const tokens=deployment.issueTokens(f.ex.symbols.transfer);
    f.reviseSpecs();assert.equal(f.coordinator.servingReady(),false);assert.equal(deployment.status().readiness,'ready');assert.equal(deployment.status().servingReady,false);
    assert.throws(()=>deployment!.servingManifest(),/InvalidatedSpec/);
    await assert.rejects(deployment.call(f.ex.symbols.transfer,[reference(alice),reference(bob),integer(10)],{operationId:'stale-spec-call',tokens}),/InvalidatedSpec/);
    assert.deepEqual(await balances(deployment),['100','0']);assert.equal(f.rows().length,0);
    await deployment.close();deployment=await ProcessDeployment.open({...f.options,genesis:undefined});assert.deepEqual(deployment.status().workerPids,{});
    const candidate=f.endorse(f.prepareArtifact('v2',[f.genesis.intent]),[f.genesis.intent]);await deployment.promote(await f.input(deployment,candidate));
    assert.equal(deployment.servingManifest(),candidate.manifest);
    const result=await deployment.call(f.ex.symbols.transfer,[reference(alice,'1'),reference(bob,'1'),integer(10)],{operationId:'current-spec-call',tokens:deployment.issueTokens(f.ex.symbols.transfer)});
    assert.equal(result.state,'completed');assert.deepEqual(await balances(deployment),['90','10']);assert.equal(f.rows().length,1);
  }finally{await deployment?.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('strict precommit checkpoint catches author revocation during prepare and aborts isolated candidate workers',async()=>{
  const f=fixture();let deployment:ProcessDeployment|undefined;
  try{
    let armed=false;
    deployment=await ProcessDeployment.open({...f.options,phase:phase=>{if(phase==='prepared'&&armed)f.authorAuthority.eligibleAuthors=[];}});
    await accounts(deployment);const candidate=f.endorse(f.prepareArtifact('v2',[f.genesis.intent]),[f.genesis.intent]);const input=await f.input(deployment,candidate);armed=true;
    await assert.rejects(deployment.promote(input),/revoked|lineage|current/);
    assert.equal(f.coordinator.state().committedManifest,f.genesis.manifest);assert.equal(f.coordinator.state().pendingProposal,null);assert.equal(f.coordinator.history().at(-1)!.phase,'aborted');assert.equal(f.rows().length,0);
    assert.throws(()=>deployment!.servingManifest(),StrictLineageServingError);
    f.authorAuthority.eligibleAuthors=['author'];assert.equal(deployment.servingManifest(),f.genesis.manifest);assert.deepEqual(await balances(deployment),['100','0']);
    f.authorAuthority.policyEpoch='2';f.governorAuthority.policyEpoch='2';assert.throws(()=>deployment!.servingManifest(),StrictLineageServingError);
    f.endorse(f.genesis,[]);assert.equal(deployment.servingManifest(),f.genesis.manifest,'fresh signed intent/evidence renews current policy authority');
  }finally{await deployment?.close();rmSync(f.directory,{recursive:true,force:true});}
});

function crashCoordinator(f:ReturnType<typeof fixture>,input:PromotionInput,phase:string){
  writeFileSync(join(f.directory,'author-public.pem'),f.authorKeys.publicKey.export({type:'spki',format:'pem'}));
  writeFileSync(join(f.directory,'governor-public.pem'),f.governorKeys.publicKey.export({type:'spki',format:'pem'}));
  const {context:_context,...request}=input;writeFileSync(join(f.directory,'promotion.json'),JSON.stringify(request));
  const script=`
    import {existsSync,readFileSync} from 'node:fs';import {createPublicKey} from 'node:crypto';import {join} from 'node:path';
    import {CapabilitySealer} from ${JSON.stringify(new URL('../../src/tier2/ocap.ts',import.meta.url).href)};
    import {CAP_LEDGER_APPEND} from ${JSON.stringify(new URL('../../src/examples/ledger.ts',import.meta.url).href)};
    import {atomicWrite} from ${JSON.stringify(new URL('../../src/tier1/persistence.ts',import.meta.url).href)};
    import {DurableGraphStore} from ${JSON.stringify(new URL('../../src/tier1/durable-store.ts',import.meta.url).href)};
    import {CausalLineageLedger} from ${JSON.stringify(new URL('../../src/tier1/causal-lineage.ts',import.meta.url).href)};
    import {DurableEffectBroker} from ${JSON.stringify(new URL('../../src/fabric/effects.ts',import.meta.url).href)};
    import {BrokerEffectRouter} from ${JSON.stringify(new URL('../../src/tier3/effects.ts',import.meta.url).href)};
    import {JournalLock} from ${JSON.stringify(new URL('../../src/fabric/journal-lock.ts',import.meta.url).href)};
    import {domainDigest} from ${JSON.stringify(new URL('../../src/fabric/identity.ts',import.meta.url).href)};
    import {PromotionCoordinator} from ${JSON.stringify(new URL('../../src/fabric/promotion.ts',import.meta.url).href)};
    import {ProcessDeployment,processArtifactContext} from ${JSON.stringify(new URL('../../src/tier4/process-deployment.ts',import.meta.url).href)};
    const services=${services.toString()};const [directory,genesisManifest,phase]=process.argv.slice(1);
    const store=new DurableGraphStore({directory:join(directory,'ast')});
    const lineage=new CausalLineageLedger({directory:join(directory,'lineage'),repositoryId:'strict-ledger',store,authority:()=>({policyEpoch:'1',eligibleAuthors:['author']}),authorKey:()=>createPublicKey(readFileSync(join(directory,'author-public.pem')))});
    const coordinator=new PromotionCoordinator({directory:join(directory,'coordinator'),repositoryId:'strict-ledger',genesisManifest,lineage:lineage.admissionAdapter(),authority:()=>({repositoryId:'strict-ledger',membershipEpoch:'1',policyEpoch:'1',eligibleGovernors:['governor']}),governorKey:()=>createPublicKey(readFileSync(join(directory,'governor-public.pem'))),clock:()=>100n,fault:point=>{if(point===phase)process.kill(process.pid,'SIGKILL');}});
    const deployment=await ProcessDeployment.open({directory:join(directory,'deployment'),coordinator,factories:new Map([['ledger-services/1',artifact=>services(directory,artifact)]])});
    const input=JSON.parse(readFileSync(join(directory,'promotion.json'),'utf8'));
    await deployment.promote({...input,context:processArtifactContext(deployment.artifact(input.proposal.candidateManifest))});await deployment.close();
  `;
  return spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,f.directory,f.genesis.manifest,phase],{encoding:'utf8',timeout:20000});
}

test('strict actual-process crash recovery follows commit even if specification invalidation blocks serving',async()=>{
  for(const phase of ['after-prepared','after-commit']){
    const f=fixture();let deployment:ProcessDeployment|undefined;
    try{
      deployment=await ProcessDeployment.open(f.options);const {alice,bob}=await accounts(deployment);
      await deployment.call(f.ex.symbols.transfer,[reference(alice),reference(bob),integer(10)],{operationId:'before-crash',tokens:deployment.issueTokens(f.ex.symbols.transfer)});
      const candidate=f.endorse(f.prepareArtifact('v2',[f.genesis.intent]),[f.genesis.intent]);const request=await f.input(deployment,candidate);
      await deployment.close();deployment=undefined;
      const crash=crashCoordinator(f,request,phase);assert.equal(crash.signal,'SIGKILL',crash.stderr);
      if(phase==='after-commit')f.reviseSpecs();
      const coordinator=new PromotionCoordinator(f.coordinatorOptions);coordinator.recoverDeadWriter();
      deployment=await ProcessDeployment.open({...f.options,coordinator,genesis:undefined});
      if(phase==='after-prepared'){
        await deployment.recover();assert.equal(deployment.servingManifest(),f.genesis.manifest);assert.equal(coordinator.history().at(-1)!.phase,'aborted');
      }else{
        await assert.rejects(deployment.recover(),error=>error instanceof StrictLineageServingError&&/durable decision/.test(error.message));
        assert.equal(coordinator.state().committedManifest,candidate.manifest);assert.equal(coordinator.state().activationPending,false);assert.equal(coordinator.history().at(-1)!.phase,'active');
        assert.throws(()=>deployment!.servingManifest(),/InvalidatedSpec/);assert.equal(deployment.status().generation,'1');
        assert.deepEqual(await balances(deployment),['90','10']);assert.equal(f.rows().length,1);
        const repair=f.endorse(f.prepareArtifact('v3',[candidate.intent]),[candidate.intent]);await deployment.promote(await f.input(deployment,repair));
        assert.equal(deployment.servingManifest(),repair.manifest);assert.equal(deployment.status().generation,'2');
      }
      const epoch=deployment.status().generation;
      await deployment.call(f.ex.symbols.transfer,[reference(alice,epoch),reference(bob,epoch),integer(5)],{operationId:'after-recovery',tokens:deployment.issueTokens(f.ex.symbols.transfer)});
      assert.deepEqual(await balances(deployment),['85','15']);assert.equal(f.rows().length,2);
    }finally{await deployment?.close();rmSync(f.directory,{recursive:true,force:true});}
  }
});

test('strict live invalidation blocks the next effect and privileged historical recovery creates no live append',async()=>{
  const f=fixture();let deployment:ProcessDeployment|undefined;let armed=false;
  try{
    deployment=await ProcessDeployment.open({...f.options,factories:new Map([['ledger-services/1',artifact=>({...services(f.directory,artifact),onPhase:phase=>{if(armed&&phase==='call-intent')f.authorAuthority.eligibleAuthors=[];}})]])});
    const {alice,bob}=await accounts(deployment);armed=true;
    const result=await deployment.call(f.ex.symbols.transfer,[reference(alice),reference(bob),integer(10)],{operationId:'invalidated-live',tokens:deployment.issueTokens(f.ex.symbols.transfer)});
    assert.equal(result.state,'indeterminate');assert.equal(f.rows().length,0);assert.throws(()=>deployment!.servingManifest(),StrictLineageServingError);
    armed=false;
    const recovered=await deployment.recoverOperation('invalidated-live',{strategy:'abort-before-effects'});
    assert.equal(recovered.state,'aborted');assert.equal(f.rows().length,0);
    f.authorAuthority.eligibleAuthors=['author'];assert.equal(deployment.servingManifest(),f.genesis.manifest);assert.deepEqual(await balances(deployment),['100','0']);
  }finally{await deployment?.close();rmSync(f.directory,{recursive:true,force:true});}
});


test('strict readiness preserves malformed authority errors instead of presenting ordinary invalidation',async()=>{
  const f=fixture();let deployment:ProcessDeployment|undefined;
  try {
    deployment=await ProcessDeployment.open(f.options);assert.equal(deployment.status().servingReady,true);
    (f.authorAuthority as any).eligibleAuthors='author';
    assert.throws(()=>deployment!.status(),TypeError);
    f.authorAuthority.eligibleAuthors=['author'];assert.equal(deployment.status().servingReady,true);
  }finally{f.authorAuthority.eligibleAuthors=['author'];await deployment?.close();rmSync(f.directory,{recursive:true,force:true});}
});
