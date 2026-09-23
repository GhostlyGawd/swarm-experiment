import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as b from '../../src/tier1/build.ts';
import {capability} from '../../src/tier1/ids.ts';
import {SymbolSpace} from '../../src/tier1/symbols.ts';
import {GraphStore} from '../../src/tier1/store.ts';
import {CapabilityRegistry, CapabilitySealer} from '../../src/tier2/ocap.ts';
import {ScopedGrantAuthority} from '../../src/tier2/scoped-grants.ts';
import {createEffectSignerAnchor} from '../../src/tier2/effect-signer-anchor.ts';
import {createTrustedClockAnchor, readTrustedClock} from '../../src/tier2/trusted-clock-anchor.ts';
import {wasmAdapterArtifactForBytes, admitWasmAdapterBytes, admittedAdapterArtifactDigest} from '../../src/tier2/adapter-artifact.ts';
import {effectResourcePolicyDigestV4, signEffectResourcePolicyV4, type EffectResourcePolicyBodyV4} from '../../src/tier2/effect-resource-policy.ts';
import {DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence, type EvidenceContext} from '../../src/fabric/evidence.ts';
import {DurableEffectBroker, effectAdapterDigest} from '../../src/fabric/effects.ts';
import {domainDigest, executionManifestDigest} from '../../src/fabric/identity.ts';
import {PromotionCoordinator, approvePromotion, evidenceBundleDigest, migrationPlanDigest, effectPlanDigest, type PromotionInput} from '../../src/fabric/promotion.ts';
import {BrokerEffectRouter} from '../../src/tier3/effects.ts';
import {ProcessHost, type ProcessHostOptions} from '../../src/tier4/process-host.ts';
import {ProcessDeployment, processClockedWasmEffectPlan, processMigrationPlan, type ProcessDeploymentOptions} from '../../src/tier4/process-deployment.ts';
import type {TopologyPlan} from '../../src/tier4/topology.ts';

const wasm = Uint8Array.from([0,97,115,109,1,0,0,0,
  1,6,1,0x60,1,0x7f,1,0x7f,3,2,1,0,5,4,1,1,1,1,
  7,16,2,3,114,117,110,0,0,6,109,101,109,111,114,121,2,0,
  10,16,1,14,0,0x20,0,0x45,0x04,0x40,0x00,0x0b,0x20,0,0x41,1,0x6a,0x0b]);

test('independent V7 clock refuses frozen-factory grant expiry and signed deadline before guest dispatch', async () => {
  const directory=mkdtempSync(join(tmpdir(),'aether-wasm-clock-'));
  let host:ProcessHost|undefined, oldHost:ProcessHost|undefined, deployment:ProcessDeployment|undefined;
  try {
    const symbols=new SymbolSpace('wasm-clock-v7'), entry=symbols.define('entry'), x=symbols.define('x');
    const CAP=capability('cap:test:wasm_clock'), registry=new CapabilityRegistry();
    registry.define({name:CAP,domain:'test',operation:'wasm_clock',arity:1,description:'bounded read-only guest',effectful:true});
    const module=b.module_({symbol:symbols.define('module'),symbolTable:symbols.table(),members:[
      b.fn({symbol:entry,params:[b.param(x,b.Int)],returns:b.Int,capabilities:[CAP],purity:'effectful',contract:b.contract({}),
        body:b.block(b.exprStmt(b.invoke(CAP,b.v(x))),b.ret(b.v(x)))})]});
    const admitted=admitWasmAdapterBytes(wasm,wasmAdapterArtifactForBytes(wasm,CAP,'wasm-clock/1',{maxMemoryPages:1,timeoutMs:1000}));
    const repositoryId='wasm-clock-repository';
    const grants=new ScopedGrantAuthority({key:new Uint8Array(32).fill(41),repositoryId,clock:()=>100,
      policyEpoch:()=> '0',revocationEpoch:()=> '0',isRevoked:()=>false,authorizeIssue:()=>true,authorizeDelegate:()=>true});
    const policy:EffectResourcePolicyBodyV4={format:'aether.effect-resource-policy/4',repositoryId,
      astRoot:new GraphStore().intern(module),policyEpoch:'0',rules:[{capability:CAP,prefix:['wasm'],argument:null,
        deadline:'1000',clockDomain:'wasm-clock-domain/1',adapterId:admitted.id,
        adapterDigest:effectAdapterDigest(admitted),adapterArtifactDigest:admittedAdapterArtifactDigest(admitted)!}]};
    const digest=(name:string)=>domainDigest('aether.wasm-clock-test/1',name);
    const context:EvidenceContext={module,registry,specification:'read-only Wasm with independent clock',semanticsVersion:'reference/1',
      compilerDigest:digest('compiler'),capabilityPolicyDigest:effectResourcePolicyDigestV4(policy),
      target:{abiVersion:'process/1',profileDigest:digest('profile'),artifactDigest:digest('artifact')},
      policy:{...DEFAULT_EVIDENCE_POLICY_V2,requireFormal:false}};
    const evidence=mintLocalEvidence(context), manifest=evidence.manifest;
    const key=generateKeyPairSync('ed25519');
    const signer=createEffectSignerAnchor({repositoryId,signer:'wasm-clock-signer',epochAuthorityId:'wasm-clock-epoch',
      publicKey:key.publicKey,currentEpoch:()=> '0'});
    const signedEffectResourcePolicy=signEffectResourcePolicyV4(policy,signer.signer,key.privateKey);
    let candidateSignedPolicy=signedEffectResourcePolicy;
    let independentNow=100, revision='0';
    const clock=createTrustedClockAnchor({authorityId:'operator-clock',clockDomain:'wasm-clock-domain/1',
      nowMs:()=>independentNow,revision:()=>revision});
    const plan:TopologyPlan={shape:'containers',units:[{id:'worker',members:[entry],capabilities:[CAP],placement:'container',memoryMb:16}],
      crossEdges:[],transportLatencyMsPerSecond:0,monthlyCost:0,recombinations:[],blockedMerges:[]};
    let routerCreations=0, liveBroker:DurableEffectBroker|undefined;
    const options:ProcessHostOptions={directory:join(directory,'v7'),module,manifest,registry,plan,
      sealer:new CapabilitySealer(new Uint8Array(32).fill(42),()=>100),scopedGrants:grants,effectSignerAnchor:signer,
      trustedClockAnchor:clock,anchoredEffectPolicyProfile:'isolated-wasm-v5-clock',signedEffectResourcePolicy,
      authorizeRecovery:()=>true,effectRouterFactory:context=>{
        routerCreations++;
        const path=join(directory,'effects',domainDigest('aether.wasm-clock-effect/1',context.operationId).split(':').at(-1)!);
        const broker=new DurableEffectBroker({directory:path,clockDomain:context.clockDomain!,clock:()=>100n,authorize:()=>true,
          authorizeReconciliation:()=>true});
        if(context.mode==='live')liveBroker=broker;
        return new BrokerEffectRouter({broker,manifest:context.manifest!,executionId:context.operationId,policyEpoch:context.policyEpoch!,
          deadline:context.deadline!,adapters:new Map([[CAP,admitted]]),grantRef:context.grantRef!,
          grant:()=>{throw new Error('unexpected grant callback');}});
      }};
    await assert.rejects(ProcessHost.open({...options,trustedClockAnchor:undefined}),/trusted clock anchor/);
    const otherClock=createTrustedClockAnchor({authorityId:'other-clock',clockDomain:'wrong-domain/1',nowMs:()=>100,revision:()=> '0'});
    await assert.rejects(ProcessHost.open({...options,trustedClockAnchor:otherClock}),/clock domain/);
    host=await ProcessHost.open(options);
    const tokens=(ttl:number)=>host!.issueScopedTokens(entry,ttl,new Map([[CAP,['wasm']]]));
    const short=tokens(1), long=tokens(60_000);
    const first=await host.call(entry,[{tag:'int',value:'41'}],{operationId:'clocked-success',tokens:long});
    assert.equal(first.state,'completed');if(first.state==='completed')assert.equal(first.execution.ok,true);
    assert.equal(liveBroker?.events()[0]?.outcome?.state,'committed');
    const governor=generateKeyPairSync('ed25519');
    const coordinator=new PromotionCoordinator({profile:'baseline-governor-v1',directory:join(directory,'coordinator'),
      repositoryId,genesisManifest:executionManifestDigest(manifest),
      authority:()=>({repositoryId,membershipEpoch:'1',policyEpoch:'1',eligibleGovernors:['governor']}),
      governorKey:()=>governor.publicKey,clock:()=>100n});
    const deploymentOptions:ProcessDeploymentOptions={directory:join(directory,'deployment'),coordinator,
      capabilityProfile:'scoped-anchored-wasm-v7',effectSignerAnchor:signer,trustedClockAnchor:clock,
      factories:new Map([['clocked-services/1',(artifact)=>({sealer:options.sealer,scopedGrants:grants,
        signedEffectResourcePolicy:artifact.manifest.capabilityPolicyDigest===context.capabilityPolicyDigest
          ?signedEffectResourcePolicy:candidateSignedPolicy,
        effectRouterFactory:options.effectRouterFactory,authorizeRecovery:()=>true})]]),
      genesis:{context,evidence,plan,factoryId:'clocked-services/1'}};
    const trustedFactory=deploymentOptions.factories.get('clocked-services/1')!;
    await assert.rejects(ProcessDeployment.open({...deploymentOptions,directory:join(directory,'bad-factory'),
      factories:new Map([['clocked-services/1',(artifact)=>({...trustedFactory(artifact),trustedClockAnchor:clock})]])}),
      /trusted clock authority must be independently provisioned/);
    deployment=await ProcessDeployment.open(deploymentOptions);
    assert.equal(deployment.status().capabilityProfile,'scoped-anchored-wasm-v7');
    const deploymentShort=deployment.issueScopedTokens(entry,1,new Map([[CAP,['wasm']]]));
    const deploymentLong=deployment.issueScopedTokens(entry,60_000,new Map([[CAP,['wasm']]]));
    const initialDeployment=await deployment.call(entry,[{tag:'int',value:'3'}],{operationId:'deployment-clocked-success',tokens:deploymentLong});
    assert.equal(initialDeployment.state,'completed');if(initialDeployment.state==='completed')assert.equal(initialDeployment.execution.ok,true);
    assert.equal(JSON.parse(readFileSync(join(deploymentOptions.directory,'deployment.json'),'utf8')).format,'aether.process-deployment/7');
    const before=await host.snapshot(), created=routerCreations;
    independentNow=102;revision='1';
    await assert.rejects(host.call(entry,[{tag:'int',value:'9'}],{operationId:'expired-independent',tokens:short}),/trusted lifetime/);
    assert.equal(routerCreations,created,'expired grant cannot create a broker router or guest');
    assert.deepEqual((await host.snapshot()).records,before.records);
    const beforeDeployment=routerCreations;
    await assert.rejects(deployment.call(entry,[{tag:'int',value:'9'}],{operationId:'expired-deployment',tokens:deploymentShort}),/trusted lifetime/);
    assert.equal(routerCreations,beforeDeployment,'expired deployment grant cannot create a broker router or guest');
    await deployment.close();deployment=undefined;
    const stateBytes=readFileSync(join(deploymentOptions.directory,'deployment.json'));
    const changedClock=createTrustedClockAnchor({authorityId:'different-operator-clock',clockDomain:'wasm-clock-domain/1',
      nowMs:()=>102,revision:()=> '1'});
    await assert.rejects(ProcessDeployment.open({...deploymentOptions,genesis:undefined,trustedClockAnchor:changedClock}),/trusted clock anchor mismatch/);
    assert.deepEqual(readFileSync(join(deploymentOptions.directory,'deployment.json')),stateBytes);
    deployment=await ProcessDeployment.open({...deploymentOptions,genesis:undefined});
    if(module.kind!=='Module')throw new Error('clock fixture module');
    const candidateModule={...module,members:module.members.map(member=>member.kind==='FunctionDecl'&&member.symbol===entry
      ?{...member,body:b.block(b.exprStmt(b.invoke(CAP,b.v(x))),b.ret(b.add(b.v(x),b.int(0))))}:member)};
    const candidatePolicy={...policy,astRoot:new GraphStore().intern(candidateModule)};
    candidateSignedPolicy=signEffectResourcePolicyV4(candidatePolicy,signer.signer,key.privateKey);
    const candidateContext:EvidenceContext={...context,module:candidateModule,
      capabilityPolicyDigest:effectResourcePolicyDigestV4(candidatePolicy)};
    const candidateEvidence=mintLocalEvidence(candidateContext);
    const artifactDigest=deployment.registerArtifact({context:candidateContext,evidence:candidateEvidence,plan,factoryId:'clocked-services/1'});
    const migrationPlan=processMigrationPlan(await deployment.snapshot(),artifactDigest);
    const effectPlan=processClockedWasmEffectPlan('clocked-services/1',candidateEvidence.manifest.capabilityPolicyDigest,
      signer.digest,clock.digest);
    const proposal={format:'aether.promotion/1' as const,repositoryId,
      expectedParent:coordinator.state().committedManifest,candidateManifest:executionManifestDigest(candidateEvidence.manifest),
      evidenceBundleDigest:evidenceBundleDigest(candidateEvidence),migrationPlanDigest:migrationPlanDigest(migrationPlan),
      effectPlanDigest:effectPlanDigest(effectPlan),membershipEpoch:'1',policyEpoch:'1',expiresAt:'1000'};
    const promotion:PromotionInput={proposal,approval:approvePromotion(proposal,'governor',governor.privateKey),
      evidence:candidateEvidence,context:candidateContext,migrationPlan,effectPlan};
    await deployment.promote(promotion);
    assert.equal(deployment.status().generation,'1');
    const promotedTokens=deployment.issueScopedTokens(entry,60_000,new Map([[CAP,['wasm']]]));
    const promoted=await deployment.call(entry,[{tag:'int',value:'5'}],{operationId:'promoted-clocked-success',tokens:promotedTokens});
    assert.equal(promoted.state,'completed');if(promoted.state==='completed')assert.equal(promoted.execution.ok,true);
    await deployment.close();deployment=await ProcessDeployment.open({...deploymentOptions,genesis:undefined});
    assert.equal(deployment.status().generation,'1');
    const beforeDeadline=routerCreations;
    independentNow=1001;revision='2';
    const deadline=await host.call(entry,[{tag:'int',value:'9'}],{operationId:'deadline-independent',tokens:long}).catch(error=>error);
    if(!(deadline instanceof Error))assert.ok(deadline.state!=='completed'||deadline.execution.ok===false);
    assert.equal(routerCreations,beforeDeadline,'expired signed deadline cannot create a broker router or guest');
    assert.deepEqual((await host.snapshot()).records,before.records);
    const deploymentBeforeDeadline=await deployment.snapshot(), createdBeforeDeploymentDeadline=routerCreations;
    const deploymentDeadline=await deployment.call(entry,[{tag:'int',value:'8'}],
      {operationId:'deadline-deployment',tokens:promotedTokens}).catch(error=>error);
    if(!(deploymentDeadline instanceof Error))assert.ok(deploymentDeadline.state!=='completed'||deploymentDeadline.execution.ok===false);
    assert.equal(routerCreations,createdBeforeDeploymentDeadline,'expired deployment deadline cannot create a broker router or guest');
    assert.deepEqual((await deployment.snapshot()).records,deploymentBeforeDeadline.records);
    independentNow=1000;revision='3';
    assert.throws(()=>readTrustedClock(clock),/rolled back/);
    await deployment.close();deployment=undefined;
    const stableState=readFileSync(join(deploymentOptions.directory,'deployment.json'));
    await assert.rejects(ProcessDeployment.open({...deploymentOptions,genesis:undefined}),/rolled back/);
    assert.deepEqual(readFileSync(join(deploymentOptions.directory,'deployment.json')),stableState);

    // V6 is explicitly historical: its factory clocks remain trusted.
    oldHost=await ProcessHost.open({...options,directory:join(directory,'v6'),trustedClockAnchor:undefined,
      anchoredEffectPolicyProfile:'isolated-wasm-v4'});
    const oldShort=oldHost.issueScopedTokens(entry,1,new Map([[CAP,['wasm']]]));
    const historical=await oldHost.call(entry,[{tag:'int',value:'2'}],{operationId:'frozen-v6-clock',tokens:oldShort});
    assert.equal(historical.state,'completed');if(historical.state==='completed')assert.equal(historical.execution.ok,true);
  } finally {await deployment?.close();await oldHost?.close();await host?.close();rmSync(directory,{recursive:true,force:true});}
});
