/* One already-running controller; each timed trial owns a fresh VM and memory.
 * No warmup VM/vCPU/guest allocation is created during controller readiness. */
#include <Hypervisor/Hypervisor.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

static mach_timebase_info_data_t timebase;
static double nanoseconds(uint64_t ticks) { return (double)ticks*timebase.numer/timebase.denom; }
static uint64_t resident_now(void) {
  mach_task_basic_info_data_t info; mach_msg_type_number_t count=MACH_TASK_BASIC_INFO_COUNT;
  return task_info(mach_task_self(),MACH_TASK_BASIC_INFO,(task_info_t)&info,&count)==KERN_SUCCESS?info.resident_size:0;
}
static uint64_t resident_peak(void) { struct rusage usage; return getrusage(RUSAGE_SELF,&usage)==0?(uint64_t)usage.ru_maxrss:0; }
static int fail_ready(const char *stage,int64_t code) {
  printf("{\"kind\":\"controller_error\",\"stage\":\"%s\",\"code\":\"%"PRId64"\"}\n",stage,code); fflush(stdout);return 2;
}
int main(int argc,char **argv) {
  if(argc!=3) return fail_ready("usage: guest-campaign image.bin trials",0);
  char *end=NULL; errno=0; long trials=strtol(argv[2],&end,10);
  if(errno||!end||*end||trials<1||trials>100000) return fail_ready("invalid trial count",0);
  const uint64_t controller_start=mach_absolute_time();
  if(mach_timebase_info(&timebase)!=KERN_SUCCESS) return fail_ready("timebase",0);
  const size_t page=(size_t)getpagesize(), guest_bytes=65536;
  if(guest_bytes%page || guest_bytes<=page) return fail_ready("unsupported page size",(int64_t)page);
  FILE *file=fopen(argv[1],"rb"); if(!file) return fail_ready("admitted image open",errno);
  if(fseek(file,0,SEEK_END)) return fail_ready("image seek",errno);
  long image_bytes=ftell(file); rewind(file);
  if(image_bytes<1||(size_t)image_bytes>page) return fail_ready("admitted image size",image_bytes);
  unsigned char *admitted=malloc((size_t)image_bytes); if(!admitted) return fail_ready("admitted image allocation",errno);
  if(fread(admitted,1,(size_t)image_bytes,file)!=(size_t)image_bytes) return fail_ready("admitted image read",errno);
  fclose(file);
  uint32_t capacity=0; hv_return_t capacity_result=hv_vm_get_max_vcpu_count(&capacity);
  if(capacity_result!=HV_SUCCESS||!capacity) return fail_ready("hypervisor capacity query",capacity_result);
  uint64_t baseline_current=resident_now(), baseline_peak=resident_peak();
  printf("{\"kind\":\"controller_ready\",\"format\":\"aether.fresh-guest-controller/1\",\"pid\":%d,\"requestedTrials\":%ld,\"timebaseNumer\":%u,\"timebaseDenom\":%u,\"pageBytes\":%zu,\"imageBytes\":%ld,\"maximumVcpus\":%u,\"createdVmsBeforeCampaign\":0,\"createdVcpusBeforeCampaign\":0,\"guestBytesBeforeCampaign\":0,\"controllerInitializationNs\":%.3f,\"controllerCurrentRssBytes\":%"PRIu64",\"controllerPeakRssBytes\":%"PRIu64"}\n",getpid(),trials,timebase.numer,timebase.denom,page,image_bytes,capacity,nanoseconds(mach_absolute_time()-controller_start),baseline_current,baseline_peak);
  fflush(stdout);
  uint64_t created_vms=0,destroyed_vms=0,created_vcpus=0,destroyed_vcpus=0,unmapped_guests=0;
  for(long trial=0;trial<trials;trial++) {
    const uint64_t base=0x40000000, gross=1000+200*(uint64_t)trial, adjustment=7, expected=12+(uint64_t)trial;
    void *memory=MAP_FAILED; hv_vcpu_t cpu=0; hv_vcpu_exit_t *exit_info=NULL;
    int vm_created=0,vm_alive=0,vcpu_created=0,response_valid=0,cleanup_ok=1;
    const char *error_stage=NULL; int64_t error_code=0;
    uint64_t value=0,status=0,syndrome=0,response_tick=0; uint32_t reason=0;
    size_t guest_resident=0; char residency[16]={0};
    const uint64_t start=mach_absolute_time();
#define CHECK_HV(expression,stage) do {hv_return_t result=(expression);if(result!=HV_SUCCESS){error_stage=(stage);error_code=result;goto cleanup;}} while(0)
    memory=mmap(NULL,guest_bytes,PROT_READ|PROT_WRITE,MAP_ANON|MAP_PRIVATE,-1,0);
    if(memory==MAP_FAILED) {error_stage="fresh guest mmap";error_code=errno;goto cleanup;}
    memset(memory,0,guest_bytes);
    memcpy(memory,admitted,(size_t)image_bytes);
    CHECK_HV(hv_vm_create(NULL),"fresh hv_vm_create");vm_created=1;vm_alive=1;created_vms++;
    CHECK_HV(hv_vm_map(memory,base,page,HV_MEMORY_READ|HV_MEMORY_EXEC),"map fresh RX code");
    CHECK_HV(hv_vm_map((char*)memory+page,base+page,guest_bytes-page,HV_MEMORY_READ|HV_MEMORY_WRITE),"map fresh RW stack/data");
    CHECK_HV(hv_vcpu_create(&cpu,&exit_info,NULL),"fresh hv_vcpu_create");vcpu_created=1;created_vcpus++;
    CHECK_HV(hv_vcpu_set_reg(cpu,HV_REG_PC,base),"set entry");
    CHECK_HV(hv_vcpu_set_reg(cpu,HV_REG_CPSR,0x3c5),"set EL1h");
    CHECK_HV(hv_vcpu_set_sys_reg(cpu,HV_SYS_REG_SP_EL1,base+guest_bytes),"set fresh stack");
    CHECK_HV(hv_vcpu_set_reg(cpu,HV_REG_X0,gross),"set gross");
    CHECK_HV(hv_vcpu_set_reg(cpu,HV_REG_X1,adjustment),"set adjustment");
    CHECK_HV(hv_vcpu_run(cpu),"run fresh guest");
    CHECK_HV(hv_vcpu_get_reg(cpu,HV_REG_X0,&value),"read value");
    CHECK_HV(hv_vcpu_get_reg(cpu,HV_REG_X1,&status),"read status");
    reason=exit_info->reason;syndrome=exit_info->exception.syndrome;
    response_valid=reason==HV_EXIT_REASON_EXCEPTION && (syndrome>>26)==0x16 && value==expected && status==0;
    if(!response_valid) {error_stage="response validation";error_code=(int64_t)reason;goto cleanup;}
    /* Both compiler ordering and the AArch64 instruction barrier precede the
     * endpoint, so validation cannot be scheduled after the stop timestamp. */
    __asm__ volatile("isb" :: "r"(response_valid) : "memory");
    response_tick=mach_absolute_time();
    if(guest_bytes/page>sizeof(residency)) {error_stage="residency vector bounds";goto cleanup;}
    if(mincore(memory,guest_bytes,residency)) {error_stage="guest residency observation";error_code=errno;goto cleanup;}
    for(size_t p=0;p<guest_bytes/page;p++) if(residency[p]&MINCORE_INCORE) guest_resident+=page;
cleanup:
    if(!response_tick) response_tick=mach_absolute_time();
    const uint64_t current_rss=resident_now(), peak_rss=resident_peak();
    if(vcpu_created) {hv_return_t code=hv_vcpu_destroy(cpu);if(code!=HV_SUCCESS){cleanup_ok=0;if(!error_stage){error_stage="destroy vCPU";error_code=code;}}else destroyed_vcpus++;}
    if(vm_created) {hv_return_t code=hv_vm_destroy();if(code!=HV_SUCCESS){cleanup_ok=0;if(!error_stage){error_stage="destroy VM";error_code=code;}}else {destroyed_vms++;vm_alive=0;}}
    if(memory!=MAP_FAILED&&!vm_alive) {if(munmap(memory,guest_bytes)){cleanup_ok=0;if(!error_stage){error_stage="unmap guest memory";error_code=errno;}}else unmapped_guests++;}
    printf("{\"kind\":\"guest_sample\",\"trial\":%ld,\"guestId\":\"%d:%ld\",\"gross\":\"%"PRIu64"\",\"adjustment\":\"%"PRIu64"\",\"expected\":\"%"PRIu64"\",\"actual\":\"%"PRIu64"\",\"status\":\"%"PRIu64"\",\"exceptionReason\":%u,\"syndrome\":\"%"PRIu64"\",\"startTick\":\"%"PRIu64"\",\"validatedResponseTick\":\"%"PRIu64"\",\"durationTicks\":\"%"PRIu64"\",\"freshGuestToValidatedResponseNs\":%.3f,\"responseValidated\":%s,\"freshVmCreated\":%s,\"freshVcpuCreated\":%s,\"cleanupSucceeded\":%s,\"guestImageBytes\":%ld,\"guestMappedBytes\":%zu,\"guestResidentObservedBytes\":%zu,\"guestResidentPeakUpperBoundBytes\":%zu,\"controllerCurrentRssBytes\":%"PRIu64",\"controllerPeakRssBytes\":%"PRIu64",\"errorStage\":",trial,getpid(),trial,gross,adjustment,expected,value,status,reason,syndrome,start,response_tick,response_tick-start,nanoseconds(response_tick-start),response_valid?"true":"false",vm_created?"true":"false",vcpu_created?"true":"false",cleanup_ok?"true":"false",image_bytes,memory==MAP_FAILED?0:guest_bytes,guest_resident,guest_bytes,current_rss,peak_rss);
    if(error_stage) printf("\"%s\"",error_stage);else printf("null");
    printf(",\"errorCode\":\"%"PRId64"\"}\n",error_code);fflush(stdout);
    if(error_stage||!cleanup_ok||!response_valid) {free(admitted);return 3;}
#undef CHECK_HV
  }
  printf("{\"kind\":\"campaign_complete\",\"completedTrials\":%ld,\"createdVms\":%"PRIu64",\"destroyedVms\":%"PRIu64",\"createdVcpus\":%"PRIu64",\"destroyedVcpus\":%"PRIu64",\"unmappedGuests\":%"PRIu64"}\n",trials,created_vms,destroyed_vms,created_vcpus,destroyed_vcpus,unmapped_guests);fflush(stdout);
  free(admitted);return 0;
}
