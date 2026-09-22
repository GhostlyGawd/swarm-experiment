#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <inttypes.h>
#include <string.h>
#include <time.h>
#ifdef __APPLE__
#include <mach/mach_time.h>
#endif
#include "generated.h"

typedef struct { int64_t value; uint64_t version; int64_t history[8]; } frame;
typedef struct { int64_t value; uint32_t status; uint32_t tier; } fallback_result;
static volatile uint64_t sink;
static volatile uint32_t detected_fault=1;
static inline void barrier(void) { __asm__ volatile("" ::: "memory"); }
static uint64_t tick(void) {
#ifdef __APPLE__
  return mach_absolute_time();
#else
  struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return (uint64_t)t.tv_sec*1000000000ULL+t.tv_nsec;
#endif
}
static double ns(uint64_t ticks) {
#ifdef __APPLE__
  mach_timebase_info_data_t t; mach_timebase_info(&t); return (double)ticks*t.numer/t.denom;
#else
  return (double)ticks;
#endif
}
__attribute__((noinline)) static uint32_t select_path(uint32_t fault,uint32_t allowed,uint32_t conservative_available) {
  if(!allowed) return 3;
  return fault?(conservative_available?2:3):1;
}
/* Three-tier, pure in-frame fixture. Snapshot/rollback and invariant checking
 * are timed. External effects, repair queue and native heap frames are absent. */
__attribute__((noinline)) static fallback_result full_flow(frame *state,int64_t gross,int64_t adjustment,uint32_t allowed,uint32_t fail_speculative,uint32_t conservative_available) {
  frame before=*state;
  if(!allowed) return (fallback_result){before.value,3,3};
  aether_i64_result speculative=aether_eval(gross,adjustment);
  if(fail_speculative) speculative.status=1;
  state->value=speculative.value; state->version++; barrier();
  if(speculative.status==0) return (fallback_result){state->value,0,1};
  *state=before; barrier();
  if(conservative_available) {
    /* Preserve an actual second execution in this measurement fixture; a
     * compiler must not replace the fallback with a reused earlier result. */
    __asm__ volatile("" : "+r"(gross), "+r"(adjustment) :: "memory");
    aether_i64_result conservative=aether_eval(gross,adjustment);
    if(conservative.status==0) {state->value=conservative.value;state->version++;return (fallback_result){conservative.value,0,2};}
  }
  *state=before; barrier(); return (fallback_result){before.value,3,3};
}
static int checks(void) {
  unsigned op; int64_t a,b;
  while(scanf("%u %"SCNd64" %"SCNd64,&op,&a,&b)==3) {
    aether_i64_result result;
    switch(op) {case 0:result=aether_add(a,b);break;case 1:result=aether_sub(a,b);break;case 2:result=aether_mul(a,b);break;case 3:result=aether_div(a,b);break;case 4:result=aether_mod(a,b);break;default:return 2;}
    printf("%u %"PRId64"\n",result.status,result.value);
  }
  return ferror(stdin)?2:0;
}
static int fallback_checks(void) {
  frame state={.value=99,.version=7};
  fallback_result first=full_flow(&state,1000,7,1,0,1);
  if(first.value!=12 || first.tier!=1 || state.value!=12 || state.version!=8) return 2;
  state=(frame){.value=99,.version=7};
  fallback_result second=full_flow(&state,1000,7,1,1,1);
  if(second.value!=12 || second.tier!=2 || state.value!=12 || state.version!=8) return 3;
  state=(frame){.value=99,.version=7};
  fallback_result third=full_flow(&state,INT64_MAX,INT64_MAX,1,1,1);
  if(third.tier!=3 || third.status!=3 || state.value!=99 || state.version!=7) return 4;
  fallback_result revoked=full_flow(&state,1000,7,0,1,1);
  if(revoked.tier!=3 || state.value!=99 || state.version!=7) return 5;
  printf("{\"threeTiers\":true,\"rollbackPreserved\":true,\"revocationTrap\":true}\n"); return 0;
}
int main(int argc,char **argv) {
  if(argc==2 && strcmp(argv[1],"--check")==0) return checks();
  if(argc==2 && strcmp(argv[1],"--fallback-check")==0) return fallback_checks();
  const int trials=30, iterations=100000, individual=2000;
  frame state={0};
  for(int i=0;i<10000;i++) {sink+=select_path(detected_fault,1,1);sink+=(uint64_t)full_flow(&state,i,7,1,1,1).value;}
#ifdef __APPLE__
  mach_timebase_info_data_t t; mach_timebase_info(&t);
  printf("{\"clock\":\"mach_absolute_time\",\"tickNs\":%.9f,",(double)t.numer/t.denom);
#else
  printf("{\"clock\":\"CLOCK_MONOTONIC\",\"tickNs\":1,");
#endif
  printf("\"warmup\":10000,\"batchIterations\":%d,\"dispatchBatchNsPerCall\":[",iterations);
  for(int trial=0;trial<trials;trial++) {
    uint64_t start=tick(); for(int i=0;i<iterations;i++) {barrier();sink+=select_path(detected_fault,1,1);} uint64_t end=tick();
    printf("%s%.9f",trial?",":"",ns(end-start)/iterations);
  }
  printf("],\"fullFlowBatchNsPerCall\":[");
  for(int trial=0;trial<trials;trial++) {
    uint64_t start=tick(); for(int i=0;i<iterations;i++) {barrier();sink+=(uint64_t)full_flow(&state,i,7,1,1,1).value;} uint64_t end=tick();
    printf("%s%.9f",trial?",":"",ns(end-start)/iterations);
  }
  printf("],\"timerPairNs\":[");
  for(int i=0;i<individual;i++) {uint64_t start=tick();barrier();uint64_t end=tick();printf("%s%.9f",i?",":"",ns(end-start));}
  printf("],\"fullFlowIndividualNs\":[");
  for(int i=0;i<individual;i++) {barrier();uint64_t start=tick();sink+=(uint64_t)full_flow(&state,i,7,1,1,1).value;barrier();uint64_t end=tick();printf("%s%.9f",i?",":"",ns(end-start));}
  printf("],\"sink\":\"%"PRIu64"\"}\n",sink); return 0;
}
