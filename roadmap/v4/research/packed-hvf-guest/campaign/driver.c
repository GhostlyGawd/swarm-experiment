/* Authenticated-frame campaign driver. bridge.ts authenticates the checkpoint
 * and compares final bytes; this controller executes one pinned frame in 1,000
 * fresh EL1 guests within a single already-running process. */
#include <Hypervisor/Hypervisor.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define FRAME_MAGIC 0x47504541u
#define FRAME_DONE 0x454e4f44u
#define WARMUPS 20u
#define SAMPLES 1000u
typedef struct {
  uint64_t start,copied,vm,rx,rw,configured,response;
  unsigned resident;
} sample_t;
static sample_t samples[SAMPLES];
static unsigned char input[32768], reference[32768], image[16384];
static size_t image_bytes,frame_bytes,page;
static unsigned have_reference;
static uint32_t u32(const unsigned char *p) {
  return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;
}
static int failure(const char *stage,long code,unsigned ordinal) {
  fprintf(stderr,"packed-hvf-campaign %s: %ld guest=%u\n",stage,code,ordinal);
  return 2;
}
static unsigned long long resident_now(void) {
  mach_task_basic_info_data_t info;mach_msg_type_number_t count=MACH_TASK_BASIC_INFO_COUNT;
  return task_info(mach_task_self(),MACH_TASK_BASIC_INFO,(task_info_t)&info,&count)==KERN_SUCCESS?
    (unsigned long long)info.resident_size:0;
}
static int run_one(unsigned ordinal,sample_t *s) {
  s->start=mach_absolute_time();
  void *memory=mmap(NULL,page*4,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);
  if(memory==MAP_FAILED)return failure("guest allocation",0,ordinal);
  memset(memory,0,page*4);
  memcpy(memory,image,image_bytes);
  unsigned char *frame=(unsigned char*)memory+page;
  memcpy(frame,input,frame_bytes);
  s->copied=mach_absolute_time();
  hv_return_t code=hv_vm_create(NULL);
  if(code!=HV_SUCCESS)return failure("hv_vm_create",code,ordinal);
  s->vm=mach_absolute_time();
  const uint64_t base=0x40000000;
#define HV(call,stage) do {code=(call);if(code!=HV_SUCCESS)return failure((stage),code,ordinal);} while(0)
  HV(hv_vm_map(memory,base,page,HV_MEMORY_READ|HV_MEMORY_EXEC),"map RX code");
  s->rx=mach_absolute_time();
  HV(hv_vm_map(frame,base+page,page*3,HV_MEMORY_READ|HV_MEMORY_WRITE),"map RW frame and stack");
  s->rw=mach_absolute_time();
  hv_vcpu_t cpu;hv_vcpu_exit_t *exit_info=NULL;
  HV(hv_vcpu_create(&cpu,&exit_info,NULL),"hv_vcpu_create");
  HV(hv_vcpu_set_reg(cpu,HV_REG_PC,base),"set PC");
  HV(hv_vcpu_set_reg(cpu,HV_REG_CPSR,0x3c5),"set EL1h");
  HV(hv_vcpu_set_sys_reg(cpu,HV_SYS_REG_VBAR_EL1,base+2048),"set exception vectors");
  HV(hv_vcpu_set_sys_reg(cpu,HV_SYS_REG_SP_EL1,base+page*4),"set stack");
  HV(hv_vcpu_set_reg(cpu,HV_REG_X0,base+page),"set frame GPA");
  HV(hv_vcpu_set_reg(cpu,HV_REG_X1,frame_bytes),"set frame bytes");
  s->configured=mach_absolute_time();
  HV(hv_vcpu_run(cpu),"run EL1 guest");
  uint64_t status=UINT64_MAX;
  HV(hv_vcpu_get_reg(cpu,HV_REG_X0,&status),"read guest status");
  if(exit_info->reason!=HV_EXIT_REASON_EXCEPTION ||
     (exit_info->exception.syndrome>>26)!=0x16 || status!=0 ||
     u32(frame+44)!=FRAME_DONE || (have_reference && memcmp(frame,reference,frame_bytes)!=0))
    return failure("guest exit/status or response mismatch",(long)status,ordinal);
  if(!have_reference) {memcpy(reference,frame,frame_bytes);have_reference=1;}
  s->response=mach_absolute_time();
  unsigned char resident[4]={0};
  if(mincore(memory,page*4,(char*)resident))return failure("guest residency",0,ordinal);
  s->resident=0;
  for(unsigned i=0;i<4;i++)if(resident[i]&MINCORE_INCORE)s->resident+=(unsigned)page;
  HV(hv_vcpu_destroy(cpu),"destroy vCPU");
  HV(hv_vm_destroy(),"destroy VM");
  if(munmap(memory,page*4))return failure("unmap guest",0,ordinal);
#undef HV
  return 0;
}
int main(int argc,char **argv) {
  const uint64_t main_start=mach_absolute_time();
  if(argc!=2)return failure("usage: driver kernel.bin",0,0);
  page=(size_t)getpagesize();
  if(page!=16384)return failure("unsupported page bytes",(long)page,0);
  FILE *file=fopen(argv[1],"rb");if(!file)return failure("image open",0,0);
  if(fseek(file,0,SEEK_END))return failure("image seek",0,0);
  long length=ftell(file);rewind(file);
  if(length<1 || (size_t)length>page)return failure("image outside code page",length,0);
  image_bytes=(size_t)length;
  if(fread(image,1,image_bytes,file)!=image_bytes)return failure("image read",0,0);
  fclose(file);
  if(fread(input,1,48,stdin)!=48)return failure("short frame header",0,0);
  frame_bytes=u32(input+8);
  if(u32(input)!=FRAME_MAGIC || u32(input+4)!=1 || frame_bytes<48 || frame_bytes>page*2)
    return failure("invalid frame header",(long)frame_bytes,0);
  if(fread(input+48,1,frame_bytes-48,stdin)!=frame_bytes-48 || fgetc(stdin)!=EOF)
    return failure("frame length",0,0);
  sample_t warm={0};
  for(unsigned index=0;index<WARMUPS;index++)if(run_one(index,&warm))return 2;
  for(unsigned index=0;index<SAMPLES;index++)if(run_one(WARMUPS+index,&samples[index]))return 2;
  if(fwrite(reference,1,frame_bytes,stdout)!=frame_bytes || fflush(stdout))return failure("output frame",0,0);
  struct rusage usage;if(getrusage(RUSAGE_SELF,&usage))return failure("controller RSS",0,0);
  mach_timebase_info_data_t timebase;if(mach_timebase_info(&timebase))return failure("timebase",0,0);
  const sample_t last=samples[SAMPLES-1];
  fprintf(stderr,"{\"kind\":\"packed_hvf_guest_sample\",\"mainStartTick\":%llu,\"guestStartTick\":%llu,\"runStartTick\":%llu,\"validatedResponseTick\":%llu,\"tickNs\":%.9f,\"mainToResponseNs\":%.3f,\"freshGuestToValidatedResponseNs\":%.3f,\"hvVcpuRunToValidatedResponseNs\":%.3f,\"guestImageBytes\":%zu,\"guestMappedBytes\":%zu,\"guestResidentObservedBytes\":%u,\"guestResidentPeakUpperBoundBytes\":%zu,\"controllerCurrentRssBytes\":%llu,\"controllerPeakRssBytes\":%llu,\"campaignWarmups\":%u,\"campaignSamples\":[",
    (unsigned long long)main_start,(unsigned long long)last.start,
    (unsigned long long)last.configured,(unsigned long long)last.response,
    (double)timebase.numer/timebase.denom,
    (double)(last.response-main_start)*timebase.numer/timebase.denom,
    (double)(last.response-last.start)*timebase.numer/timebase.denom,
    (double)(last.response-last.configured)*timebase.numer/timebase.denom,
    image_bytes,page*4,last.resident,page*4,resident_now(),
    (unsigned long long)usage.ru_maxrss,WARMUPS);
  for(unsigned index=0;index<SAMPLES;index++) {
    const sample_t s=samples[index];
    fprintf(stderr,"%s{\"ordinal\":%u,\"residentBytes\":%u,\"ticks\":[%llu,%llu,%llu,%llu,%llu,%llu,%llu]}",
      index?",":"",index,s.resident,
      (unsigned long long)s.start,(unsigned long long)s.copied,
      (unsigned long long)s.vm,(unsigned long long)s.rx,
      (unsigned long long)s.rw,(unsigned long long)s.configured,
      (unsigned long long)s.response);
  }
  fprintf(stderr,"]}\n");
  return 0;
}
