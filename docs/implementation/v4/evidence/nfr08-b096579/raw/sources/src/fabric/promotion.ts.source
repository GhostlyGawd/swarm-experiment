/** Durable exact-root admission. New journals require signed causal lineage;
 * legacy governor-only admission is an explicit persisted compatibility profile. */
import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from '../tier1/persistence.ts';
import { decodeCanonical, decimal, encodeCanonical, encodingLimits, exactObject, identifier, validateTaggedValue, type EncodingLimits, type TaggedValueV1 } from './encoding.ts';
import { domainDigest, executionManifestDigest, validateDigest, validateExecutionManifest, type Digest, type ExecutionManifestV1 } from './identity.ts';
import { validateEvidence, type EvidenceContext, type LocalEvidenceV1, type VettedEvidence } from './evidence.ts';
import { JournalLock } from './journal-lock.ts';
import { LineageAdmissionError, validateStrictLineageAdmission, type StrictLineageAdmission } from '../tier1/causal-lineage.ts';

export interface PromotionProposalV1 {
  readonly format: 'aether.promotion/1'; readonly repositoryId: string;
  readonly expectedParent: Digest; readonly candidateManifest: Digest; readonly evidenceBundleDigest: Digest;
  readonly migrationPlanDigest: Digest; readonly effectPlanDigest: Digest;
  readonly membershipEpoch: string; readonly policyEpoch: string; readonly expiresAt: string;
}
export interface GovernorApprovalV1 {
  readonly format: 'aether.governor-approval/1'; readonly governorId: string;
  readonly proposalDigest: Digest; readonly signature: string;
}
export interface PromotionAuthorityV1 {
  readonly repositoryId: string; readonly membershipEpoch: string; readonly policyEpoch: string;
  readonly eligibleGovernors: readonly string[];
}
export interface PromotionBindingV1 {
  readonly format: 'aether.promotion-binding/1'; readonly proposalDigest: Digest;
  readonly proposal: PromotionProposalV1; readonly manifest: ExecutionManifestV1;
  readonly generation: string; readonly migrationPlan: TaggedValueV1; readonly effectPlan: TaggedValueV1;
}
export interface PreparedPromotionHandleV1 {
  readonly format: 'aether.prepared-promotion/1'; readonly proposalDigest: Digest;
  readonly targetManifest: Digest; readonly generation: string; readonly payload: TaggedValueV1;
}
export interface PromotionDriver {
  /** Isolate preparation by proposalDigest. A crash may require abort with no returned handle. */
  prepare(binding: PromotionBindingV1, evidence: VettedEvidence): Promise<PreparedPromotionHandleV1>;
  /** Optional operator-held synchronous fence around the final authority
   * recheck and durable commit. A retention authority can hold its own lock
   * across `commit()` so a new task pin cannot race the active decision.
   * The callback must invoke `commit()` exactly once before returning. */
  commitFence?(binding: PromotionBindingV1, commit: () => void): void;
  /** Idempotent commit installation. Never serve the old target after the coordinator commits. */
  activate(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1): Promise<void>;
  abort(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1 | null): Promise<void>;
  recover(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1 | null, decision: 'commit' | 'abort'): Promise<void>;
}
export type PromotionPhase = 'candidate' | 'validated' | 'authorized' | 'prepared' | 'active' | 'rejected' | 'aborted';
export interface PromotionRecordV1 {
  readonly format: 'aether.promotion-record/1'; readonly binding: PromotionBindingV1; readonly approval: GovernorApprovalV1;
  readonly phase: PromotionPhase; readonly prepareStarted: boolean; readonly activated: boolean;
  readonly handle: PreparedPromotionHandleV1 | null;
  readonly audit: readonly { readonly event: string; readonly at: string }[];
  readonly failure: string | null;
}
export type PromotionAdmissionProfile = 'strict-lineage-v1' | 'baseline-governor-v1';
interface PromotionJournalV2 {
  readonly format: 'aether.production-journal/2'; readonly profile: PromotionAdmissionProfile; readonly repositoryId: string;
  readonly genesisManifest: Digest; readonly activeManifest: Digest; readonly generation: string;
  readonly records: readonly PromotionRecordV1[];
}
export interface ProductionAdmissionState {
  readonly committedManifest: Digest; readonly generation: string; readonly activationPending: boolean;
  readonly pendingProposal: Digest | null;
}
export type PromotionFaultPoint = 'after-candidate' | 'after-validated' | 'after-authorized' | 'after-prepared' | 'after-commit' | 'after-activation' | 'after-abort';
export interface PromotionCoordinatorOptions {
  readonly directory: string; readonly repositoryId: string; readonly genesisManifest: Digest;
  readonly authority: () => PromotionAuthorityV1;
  /** Trusted historical enrollment resolver; retired keys remain available for audit verification. */
  readonly governorKey: (governorId: string, membershipEpoch: string) => KeyObject | string | undefined;
  readonly clock?: () => bigint; readonly limits?: Partial<EncodingLimits>;
  readonly fault?: (point: PromotionFaultPoint) => void;
  /** New journals default to mandatory signed causal lineage. */
  readonly profile?: PromotionAdmissionProfile;
  readonly lineage?: StrictLineageAdmission;
  /** Explicitly adopt a validated unprofiled v1 journal as governor-only history. */
  readonly legacyJournalMigration?: 'adopt-baseline-v1';
}
export class StrictLineageServingError extends Error {
  readonly code = 'strict_lineage_unavailable';
  readonly manifest: Digest;
  constructor(manifest: Digest, message: string) { super(message); this.name = 'StrictLineageServingError'; this.manifest = manifest; }
}
export interface PromotionInput {
  readonly proposal: PromotionProposalV1; readonly approval: GovernorApprovalV1;
  readonly evidence: LocalEvidenceV1; readonly context: EvidenceContext;
  readonly migrationPlan: TaggedValueV1; readonly effectPlan: TaggedValueV1;
}
export function validatePromotionProposal(value: unknown): asserts value is PromotionProposalV1 {
  encodeCanonical(value);
  const p = exactObject(value, ['format','repositoryId','expectedParent','candidateManifest','evidenceBundleDigest','migrationPlanDigest','effectPlanDigest','membershipEpoch','policyEpoch','expiresAt']);
  if (p.format !== 'aether.promotion/1') throw new TypeError('unsupported promotion version');
  identifier(p.repositoryId); decimal(p.membershipEpoch); decimal(p.policyEpoch); decimal(p.expiresAt);
  validateDigest(p.expectedParent,'aether.execution/1'); validateDigest(p.candidateManifest,'aether.execution/1');
  validateDigest(p.evidenceBundleDigest,'aether.evidence-bundle/1'); validateDigest(p.migrationPlanDigest,'aether.migration-plan/1'); validateDigest(p.effectPlanDigest,'aether.effect-plan/1');
}
export function promotionDigest(proposal: PromotionProposalV1): Digest { validatePromotionProposal(proposal); return domainDigest('aether.promotion/1',proposal); }
export function evidenceBundleDigest(evidence: LocalEvidenceV1): Digest { return domainDigest('aether.evidence-bundle/1',evidence); }
export function migrationPlanDigest(plan: TaggedValueV1): Digest { validateTaggedValue(plan); return domainDigest('aether.migration-plan/1',plan); }
export function effectPlanDigest(plan: TaggedValueV1): Digest { validateTaggedValue(plan); return domainDigest('aether.effect-plan/1',plan); }
function approvalBytes(approval: Omit<GovernorApprovalV1,'signature'>): Uint8Array { return encodeCanonical({ domain:'aether.governor-approval-signature/1',approval }); }
function validateApprovalSchema(value:unknown):asserts value is GovernorApprovalV1 {
  const a=exactObject(value,['format','governorId','proposalDigest','signature']);identifier(a.governorId);
  validateDigest(a.proposalDigest,'aether.promotion/1');
  if(a.format!=='aether.governor-approval/1'||typeof a.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(a.signature)||Buffer.from(a.signature,'base64').toString('base64')!==a.signature)throw new TypeError('invalid governor approval schema');
}
export function approvePromotion(proposal: PromotionProposalV1, governorId: string, key: KeyObject | string): GovernorApprovalV1 {
  identifier(governorId);
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 governor private key required');
  const approval = { format:'aether.governor-approval/1' as const, governorId, proposalDigest:promotionDigest(proposal) };
  return { ...approval,signature:sign(null,approvalBytes(approval),privateKey).toString('base64') };
}
function verifyApproval(value: unknown, proposal: PromotionProposalV1, key: KeyObject | string | undefined): asserts value is GovernorApprovalV1 {
  validateApprovalSchema(value);
  const a=exactObject(value,['format','governorId','proposalDigest','signature']);
  identifier(a.governorId);
  if(a.format!=='aether.governor-approval/1'||a.proposalDigest!==promotionDigest(proposal)||typeof a.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(a.signature)||!key) throw new TypeError('invalid governor approval');
  const publicKey=typeof key==='string'?createPublicKey(key):key.type==='private'?createPublicKey(key):key;
  if(publicKey.asymmetricKeyType!=='ed25519') throw new TypeError('Ed25519 governor key required');
  const signature=Buffer.from(a.signature,'base64');
  if(signature.toString('base64')!==a.signature||!verify(null,approvalBytes({format:'aether.governor-approval/1',governorId:a.governorId,proposalDigest:a.proposalDigest as Digest}),publicKey,signature)) throw new TypeError('invalid governor signature');
}
function clone<T>(value:T):T { return decodeCanonical(encodeCanonical(value)) as T; }
function freeze<T>(value:T):T { if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value; }
export function createPromotionHandle(binding: PromotionBindingV1, payload: TaggedValueV1): PreparedPromotionHandleV1 {
  validateTaggedValue(payload);
  return freeze({format:'aether.prepared-promotion/1',proposalDigest:binding.proposalDigest,targetManifest:binding.proposal.candidateManifest,generation:binding.generation,payload:clone(payload)});
}
function validateHandle(value:unknown,binding:PromotionBindingV1):asserts value is PreparedPromotionHandleV1 {
  const h=exactObject(value,['format','proposalDigest','targetManifest','generation','payload']);
  if(h.format!=='aether.prepared-promotion/1'||h.proposalDigest!==binding.proposalDigest||h.targetManifest!==binding.proposal.candidateManifest||h.generation!==binding.generation) throw new TypeError('prepared handle subject/generation mismatch');
  validateTaggedValue(h.payload);
}
function sync(directory:string):void {const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function ensureDurableDirectory(path:string):void {
  if(existsSync(path))return;
  ensureDurableDirectory(dirname(path));
  try{mkdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  sync(path);sync(dirname(path));
}
function initialize(path:string,directory:string,bytes:Uint8Array):void {
  const temporary=join(directory,`.promotion-init-${randomUUID()}`);const fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  try{try{linkSync(temporary,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}sync(directory);}finally{unlinkSync(temporary);}
}

export class PromotionCoordinator {
  private readonly options:PromotionCoordinatorOptions;
  private readonly limits:EncodingLimits;
  private readonly file:string;
  private readonly lock:JournalLock;
  readonly admissionProfile:PromotionAdmissionProfile;
  private readonly lineage?:StrictLineageAdmission;
  constructor(options:PromotionCoordinatorOptions){
    identifier(options.repositoryId);validateDigest(options.genesisManifest,'aether.execution/1');
    this.admissionProfile=options.profile??'strict-lineage-v1';
    if(!['strict-lineage-v1','baseline-governor-v1'].includes(this.admissionProfile))throw new TypeError('unknown production admission profile');
    if(this.admissionProfile==='strict-lineage-v1'){validateStrictLineageAdmission(options.lineage,options.repositoryId);this.lineage=options.lineage;}
    else if(options.lineage)throw new TypeError('baseline profile cannot silently enable lineage admission');
    if(options.legacyJournalMigration!==undefined&&(options.legacyJournalMigration!=='adopt-baseline-v1'||this.admissionProfile!=='baseline-governor-v1'))throw new TypeError('legacy history can only be explicitly adopted as baseline');
    this.options={...options};this.limits=encodingLimits(options.limits);ensureDurableDirectory(options.directory);
    this.file=join(options.directory,'production.json');this.lock=new JournalLock({directory:join(options.directory,'promotion-lock-tickets'),limits:this.limits});
    this.lock.run(()=>{
      if(!existsSync(this.file)){
        this.assertLineageCurrent(options.genesisManifest);
        initialize(this.file,options.directory,encodeCanonical({format:'aether.production-journal/2',profile:this.admissionProfile,repositoryId:options.repositoryId,genesisManifest:options.genesisManifest,activeManifest:options.genesisManifest,generation:'0',records:[]},this.limits));
      }else{
        if(statSync(this.file).size>this.limits.maxFrameBytes)throw new RangeError('promotion journal byte limit');
        const existing=decodeCanonical(readFileSync(this.file),this.limits) as {format?:unknown};
        if(existing?.format==='aether.production-journal/1'){
          if(options.legacyJournalMigration!=='adopt-baseline-v1')throw new Error('unprofiled production history requires explicit baseline migration');
          // Full identity, signature, audit and head validation precedes the only upgrade write.
          this.write(this.read(true));
        }
      }
      this.read();
    },10000);
  }
  private now():string {const t=this.options.clock?.()??BigInt(Date.now());if(typeof t!=='bigint'||t<0n)throw new TypeError('invalid promotion clock');return t.toString();}
  private read(legacy=false):PromotionJournalV2 {
    if(statSync(this.file).size>this.limits.maxFrameBytes)throw new RangeError('promotion journal byte limit');
    const j=exactObject(decodeCanonical(readFileSync(this.file),this.limits),['format',...(legacy?[]:['profile']),'repositoryId','genesisManifest','activeManifest','generation','records']);
    if(j.format!==(legacy?'aether.production-journal/1':'aether.production-journal/2')||(!legacy&&j.profile!==this.admissionProfile)||j.repositoryId!==this.options.repositoryId||j.genesisManifest!==this.options.genesisManifest||!Array.isArray(j.records))throw new TypeError('production journal identity/profile mismatch');
    let head=this.options.genesisManifest,generation=0n,pending=false;const ids=new Set<string>();
    for(const record of j.records){
      const r=exactObject(record,['format','binding','approval','phase','prepareStarted','activated','handle','audit','failure']);
      const b=exactObject(r.binding,['format','proposalDigest','proposal','manifest','generation','migrationPlan','effectPlan']);
      validatePromotionProposal(b.proposal);validateExecutionManifest(b.manifest);decimal(b.generation);
      if(b.format!=='aether.promotion-binding/1'||b.proposalDigest!==promotionDigest(b.proposal)||ids.has(String(b.proposalDigest))||b.proposal.repositoryId!==this.options.repositoryId||b.proposal.expectedParent!==head||b.generation!==String(generation+1n)||executionManifestDigest(b.manifest)!==b.proposal.candidateManifest||migrationPlanDigest(b.migrationPlan as TaggedValueV1)!==b.proposal.migrationPlanDigest||effectPlanDigest(b.effectPlan as TaggedValueV1)!==b.proposal.effectPlanDigest)throw new TypeError('corrupt promotion binding');
      if(pending)throw new TypeError('promotion follows unresolved decision');ids.add(b.proposalDigest as string);
      const binding=r.binding as PromotionBindingV1;
      if(r.format!=='aether.promotion-record/1'||!['candidate','validated','authorized','prepared','active','rejected','aborted'].includes(String(r.phase))||typeof r.prepareStarted!=='boolean'||typeof r.activated!=='boolean'||!Array.isArray(r.audit)||r.audit.length===0||(r.failure!==null&&typeof r.failure!=='string'))throw new TypeError('corrupt promotion state');
      validateApprovalSchema(r.approval);
      let phase:PromotionPhase='candidate',started=false,activated=false,authorized=false;
      for(let index=0;index<r.audit.length;index++){
        const a=exactObject(r.audit[index],['event','at']);identifier(a.event);decimal(a.at);
        if(index===0){if(a.event!=='candidate')throw new TypeError('missing initial promotion audit');continue;}
        switch(a.event){
          case 'validated':if(phase!=='candidate')throw new TypeError('illegal promotion transition');phase='validated';break;
          case 'authorized':if(phase!=='validated')throw new TypeError('illegal promotion transition');phase='authorized';authorized=true;break;
          case 'prepare-requested':if(phase!=='authorized'||started)throw new TypeError('illegal promotion transition');started=true;break;
          case 'prepared':if(phase!=='authorized'||!started)throw new TypeError('illegal promotion transition');phase='prepared';break;
          case 'commit':if(phase!=='prepared')throw new TypeError('illegal promotion commit');phase='active';break;
          case 'activation-complete':case 'recovery-activation-complete':if(phase!=='active'||activated)throw new TypeError('illegal activation transition');activated=true;break;
          case 'rejected':if(['active','rejected','aborted'].includes(phase))throw new TypeError('illegal promotion rejection');phase=started?'aborted':'rejected';break;
          case 'recovery-abort':if(['active','rejected','aborted'].includes(phase))throw new TypeError('illegal promotion recovery');phase='aborted';break;
          default:throw new TypeError('unknown promotion audit event');
        }
      }
      if(r.phase!==phase||r.prepareStarted!==started||r.activated!==activated)throw new TypeError('promotion state does not match audit');
      if((r.phase==='prepared'||r.phase==='active')&&(!r.prepareStarted||r.handle===null))throw new TypeError('missing prepared promotion handle');
      if(r.handle!==null)validateHandle(r.handle,binding);
      if(r.activated&&r.phase!=='active')throw new TypeError('activation without committed decision');
      // Historical signature checks do not authorize a fresh promotion.
      if(authorized){const approval=r.approval as GovernorApprovalV1;verifyApproval(approval,binding.proposal,this.options.governorKey(approval.governorId,binding.proposal.membershipEpoch));}
      if(r.phase==='active'){head=binding.proposal.candidateManifest;generation++;pending=!r.activated;}
      else pending=r.phase!=='rejected'&&r.phase!=='aborted';
    }
    if(j.activeManifest!==head||j.generation!==String(generation))throw new TypeError('production head does not match committed history');
    return (legacy?{...j,format:'aether.production-journal/2',profile:'baseline-governor-v1'}:j) as unknown as PromotionJournalV2;
  }
  private write(journal:PromotionJournalV2):void {atomicWrite(this.file,Buffer.from(encodeCanonical(journal,this.limits)).toString('utf8'));sync(this.options.directory);}
  private record(j:PromotionJournalV2,r:PromotionRecordV1,event:string,patch:Partial<PromotionRecordV1>={},at=this.now()):PromotionJournalV2 {
    const next={...r,...patch,audit:[...r.audit,{event,at}]};
    const records=j.records.map(old=>old.binding.proposalDigest===r.binding.proposalDigest?next:old);
    const committed=next.phase==='active';
    const out={...j,records,...(committed?{activeManifest:next.binding.proposal.candidateManifest,generation:next.binding.generation}:{})};this.write(out);return out;
  }
  private current(j:PromotionJournalV2,proposal:PromotionProposalV1,approval:GovernorApprovalV1):void {
    const now=this.now();
    const key=this.options.governorKey(approval.governorId,proposal.membershipEpoch);
    const authority=this.options.authority();
    exactObject(authority,['repositoryId','membershipEpoch','policyEpoch','eligibleGovernors']);
    identifier(authority.repositoryId);decimal(authority.membershipEpoch);decimal(authority.policyEpoch);
    if(!Array.isArray(authority.eligibleGovernors))throw new TypeError('invalid governor membership');
    for(const governor of authority.eligibleGovernors)identifier(governor);
    if(authority.repositoryId!==this.options.repositoryId||proposal.repositoryId!==authority.repositoryId||proposal.membershipEpoch!==authority.membershipEpoch||proposal.policyEpoch!==authority.policyEpoch)throw new Error('stale promotion policy/membership');
    if(proposal.expectedParent!==j.activeManifest)throw new Error('stale promotion parent');
    if(BigInt(now)>=BigInt(proposal.expiresAt))throw new Error('promotion approval expired');
    if(!authority.eligibleGovernors.includes(approval.governorId))throw new Error('governor revoked or ineligible');
    verifyApproval(approval,proposal,key);
  }
  state():ProductionAdmissionState {
    const j=this.read();const unfinished=j.records.find(r=>r.phase==='active'&&!r.activated||!['active','rejected','aborted'].includes(r.phase));
    return {committedManifest:j.activeManifest,generation:j.generation,activationPending:j.records.some(r=>r.phase==='active'&&!r.activated),pendingProposal:unfinished?.binding.proposalDigest??null};
  }
  assertLineageCurrent(manifest:Digest):void {
    validateDigest(manifest,'aether.execution/1');
    if(!this.lineage)return;
    try{this.lineage.assertCurrent(manifest);}catch(error){
      if(!(error instanceof LineageAdmissionError))throw error;
      throw new StrictLineageServingError(manifest,`strict lineage blocks serving ${manifest}: ${error.message}`);
    }
  }
  servingManifest():Digest {const state=this.state();if(state.activationPending)throw new Error('committed target awaiting activation; serving is blocked');this.assertLineageCurrent(state.committedManifest);return state.committedManifest;}
  servingReady():boolean {const state=this.state();if(state.activationPending)return false;try{this.assertLineageCurrent(state.committedManifest);return true;}catch(error){if(error instanceof StrictLineageServingError)return false;throw error;}}
  history():readonly PromotionRecordV1[]{return freeze(clone(this.read().records));}
  recoverDeadWriter():void{this.lock.recoverDeadWriter();}
  async promote(input:PromotionInput,driver:PromotionDriver):Promise<ProductionAdmissionState>{
    validatePromotionProposal(input.proposal);validateApprovalSchema(input.approval);validateTaggedValue(input.migrationPlan);validateTaggedValue(input.effectPlan);
    const proposal=freeze(clone(input.proposal)),approval=freeze(clone(input.approval));
    const manifest=freeze(clone(input.evidence.manifest));validateExecutionManifest(manifest);
    if(executionManifestDigest(manifest)!==proposal.candidateManifest||evidenceBundleDigest(input.evidence)!==proposal.evidenceBundleDigest||migrationPlanDigest(input.migrationPlan)!==proposal.migrationPlanDigest||effectPlanDigest(input.effectPlan)!==proposal.effectPlanDigest)throw new TypeError('promotion input binding mismatch');
    return this.lock.runAsync(async()=>{
      let journal=this.read();const id=promotionDigest(proposal),existing=journal.records.find(r=>r.binding.proposalDigest===id);
      if(existing){if(existing.phase==='active'&&existing.activated){this.assertLineageCurrent(journal.activeManifest);return this.state();}throw new Error('promotion already recorded; recover pending work or submit a new proposal');}
      if(this.state().pendingProposal!==null)throw new Error('pending promotion requires recovery');
      // Refuse a stale parent before appending a record that cannot belong to this history.
      if(proposal.expectedParent!==journal.activeManifest)throw new Error('stale promotion parent');
      const binding:PromotionBindingV1=freeze({format:'aether.promotion-binding/1',proposalDigest:id,proposal,manifest,generation:String(BigInt(journal.generation)+1n),migrationPlan:clone(input.migrationPlan),effectPlan:clone(input.effectPlan)});
      let record:PromotionRecordV1={format:'aether.promotion-record/1',binding,approval,phase:'candidate',prepareStarted:false,activated:false,handle:null,audit:[{event:'candidate',at:this.now()}],failure:null};
      journal={...journal,records:[...journal.records,record]};this.write(journal);
      try{
        this.options.fault?.('after-candidate');
        let vetted=validateEvidence(input.evidence,input.context);
        if(vetted.manifestDigest!==proposal.candidateManifest)throw new TypeError('candidate evidence subject mismatch');
        const admit=async(checkpoint:()=>void):Promise<ProductionAdmissionState>=>{
        journal=this.record(journal,record,'validated',{phase:'validated'});record=journal.records.at(-1)!;this.options.fault?.('after-validated');
        this.current(journal,proposal,approval);
        journal=this.record(journal,record,'authorized',{phase:'authorized'});record=journal.records.at(-1)!;this.options.fault?.('after-authorized');
        journal=this.record(journal,record,'prepare-requested',{prepareStarted:true});record=journal.records.at(-1)!;
        const handle=await driver.prepare(binding,vetted);validateHandle(handle,binding);
        journal=this.record(journal,record,'prepared',{phase:'prepared',handle:freeze(clone(handle))});record=journal.records.at(-1)!;this.options.fault?.('after-prepared');
        // Recompute the composed code/closure after async preparation and inspect current authority
        // immediately before the synchronous durable compare-and-swap decision.
        vetted=validateEvidence(input.evidence,input.context);
        if(vetted.manifestDigest!==proposal.candidateManifest||evidenceBundleDigest(input.evidence)!==proposal.evidenceBundleDigest)throw new TypeError('candidate changed during preparation');
        let fenceOpen=true,committed=false;
        const commit=()=>{
          if(!fenceOpen||committed)throw new Error('promotion commit fence invoked outside its single decision');
          // A fence may wait for an independent retention lock. Recheck the
          // candidate and current authority *inside* that lock, immediately
          // before the synchronous durable decision.
          vetted=validateEvidence(input.evidence,input.context);
          if(vetted.manifestDigest!==proposal.candidateManifest||evidenceBundleDigest(input.evidence)!==proposal.evidenceBundleDigest)throw new TypeError('candidate changed inside promotion commit fence');
          journal=this.read();record=journal.records.find(r=>r.binding.proposalDigest===id)!;
          const commitTime=this.now();this.current(journal,proposal,approval);
          checkpoint();
          journal=this.record(journal,record,'commit',{phase:'active'},commitTime);record=journal.records.at(-1)!;committed=true;
        };
        if(driver.commitFence){
          try{
            const result:unknown=driver.commitFence(binding,commit);
            if(result&&typeof result==='object'&&'then'in result)throw new TypeError('promotion commit fence must be synchronous');
          }finally{fenceOpen=false;}
          if(!committed)throw new Error('promotion commit fence omitted the durable decision');
        }else{commit();fenceOpen=false;}
        this.options.fault?.('after-commit');
        await driver.activate(binding,record.handle!);
        journal=this.record(journal,record,'activation-complete',{activated:true});this.options.fault?.('after-activation');
        return this.state();
        };
        return this.lineage?await this.lineage.withAdmission(binding,vetted,admit):await admit(()=>{});
      }catch(error){
        // Inspect durable authority; an exception after atomic rename is not proof of noncommit.
        journal=this.read();record=journal.records.find(r=>r.binding.proposalDigest===id)!;
        if(record.phase==='active')throw error;
        if(record.prepareStarted)await driver.abort(binding,record.handle);
        this.record(journal,record,'rejected',{phase:record.prepareStarted?'aborted':'rejected',failure:error instanceof Error?error.message:String(error)});
        this.options.fault?.('after-abort');throw error;
      }
    });
  }
  async recover(driver:PromotionDriver):Promise<ProductionAdmissionState>{
    return this.lock.runAsync(async()=>{
      let journal=this.read();const record=journal.records.find(r=>r.phase==='active'&&!r.activated||!['active','rejected','aborted'].includes(r.phase));
      const readiness=():ProductionAdmissionState=>{const state=this.state();try{this.assertLineageCurrent(state.committedManifest);}catch(error){if(error instanceof StrictLineageServingError)throw new StrictLineageServingError(error.manifest,`recovery followed the durable decision; serving remains blocked: ${error.message}`);throw error;}return state;};
      if(!record)return readiness();
      const commit=record.phase==='active';
      if(commit||record.prepareStarted)await driver.recover(freeze(clone(record.binding)),record.handle===null?null:freeze(clone(record.handle)),commit?'commit':'abort');
      journal=this.record(journal,record,commit?'recovery-activation-complete':'recovery-abort',commit?{activated:true}:{phase:'aborted',failure:'recovered before durable commit'});
      return readiness();
    });
  }
}
