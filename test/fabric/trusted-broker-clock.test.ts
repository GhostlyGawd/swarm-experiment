import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableEffectBroker, effectPayloadDigest, type EffectRequestV1} from '../../src/fabric/effects.ts';
import {domainDigest} from '../../src/fabric/identity.ts';
import {createTrustedClockAnchor} from '../../src/tier2/trusted-clock-anchor.ts';

test('independent clock is rechecked after a factory authorization callback and before the sink', () => {
  for(const mode of ['deadline','grant','after_marker'] as const){
    const directory=mkdtempSync(join(tmpdir(),'aether-broker-clock-'));
    try{
      let now=100, revision='0', calls=0, sinks=0;
      const anchor=createTrustedClockAnchor({authorityId:`clock-${mode}`,clockDomain:'broker-clock/1',
        nowMs:()=>now,revision:()=>revision});
      const broker=new DurableEffectBroker({directory,clockDomain:'broker-clock/1',clock:()=>100n,
        authorize:()=>{calls++;if(mode!=='after_marker'||calls===4){now=mode==='grant'?102:1001;revision='1';}return true;}});
      broker.pinTrustedClock(anchor,[{issuedAt:100,expiresAt:mode==='grant'?101:60_100}]);
      const payload={tag:'sequence' as const,items:[{tag:'string' as const,value:'cap:test:clock'}]};
      const request:EffectRequestV1={format:'aether.effect/1',executionId:'execution:clock',effectId:`effect:${mode}`,
        branchId:null,executionManifest:domainDigest('aether.execution/1','clock-test'),capabilityGrantRef:'grant:clock',
        policyEpoch:'0',payload,payloadDigest:effectPayloadDigest(payload),budgetReservationId:null,deadline:'1000'};
      const outcome=broker.dispatch(request,{id:'clock-adapter/1',semantics:{readOnly:true,atomicIdempotency:true,transactional:false,reconciliation:true},
        execute:()=>{sinks++;return{tag:'int',value:'1'};},reconcile:()=>({state:'not_committed'})});
      assert.equal(outcome.state,'rejected');
      if(outcome.state==='rejected')assert.equal(outcome.code,'trusted_clock_denied');
      assert.equal(calls,mode==='after_marker'?4:1);assert.equal(sinks,0);
      assert.equal(broker.events()[0].outcome?.state,'rejected');
      if(mode==='after_marker')assert.deepEqual(broker.events()[0].transitions.slice(-2).map(t=>t.dispatchStarted),[true,false]);
    }finally{rmSync(directory,{recursive:true,force:true});}
  }
});
