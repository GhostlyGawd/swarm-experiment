/* Aether AST root ast:b3:29f42a044c0869d1894add326539a9fcc80efecce34e760b4871f840c6fdfb3b; manifest aether.execution/1:b3:d95ca974f55a26620d0b90929f4eae81b5d1c212ed68f00c38f9b3398b24a149; bounded research ABI. */
static int tier1(Frame*frame,const Frame*before,uint32_t left,uint32_t right,int64_t*out){uint32_t fault=0;(void)before;(void)right;int64_t valuelocal0=((int64_t)UINT64_C(777)); if(fault)return 1; uint32_t local0=ae_alloc(frame,valuelocal0,&fault); if(fault)return 1; (void)local0;
int64_t assigned1=((int64_t)UINT64_C(99)); if(fault)return 1; frame->records[left].value=assigned1;
int asserted2=(0); if(fault||!asserted2)return 1;
*out=((int64_t)UINT64_C(99)); if(fault)return 1; return 0;return 1;}
__attribute__((noinline)) static int tier2(Frame*frame,const Frame*before,uint32_t left,uint32_t right,int64_t*out,uint64_t started,uint64_t*switch_ticks){if(switch_ticks)*switch_ticks=tick()-started;uint32_t fault=0;(void)before;(void)right;int64_t valuelocal3=((int64_t)UINT64_C(777)); if(fault)return 1; uint32_t local3=ae_alloc(frame,valuelocal3,&fault); if(fault)return 1; (void)local3;
int64_t assigned4=((int64_t)UINT64_C(99)); if(fault)return 1; frame->records[left].value=assigned4;
int asserted5=(0); if(fault||!asserted5)return 1;
*out=((int64_t)UINT64_C(99)); if(fault)return 1; return 0;return 1;}
static int precondition(const Frame*before,uint32_t left,uint32_t right){uint32_t fault=0;(void)before;(void)left;(void)right;return !fault;}
static int postcondition(const Frame*before,const Frame*after,uint32_t left,uint32_t right,int64_t result){uint32_t fault=0;(void)left;(void)right;(void)result;for(uint32_t id=1;id<before->next_id;id++)if(id!=left&&before->records[id].value!=after->records[id].value)return 0;if(!(((result)==(ae_add(before->records[left].value,((int64_t)UINT64_C(1)),&fault))))||fault)return 0;return !fault;}
