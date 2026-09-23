/* Research controller for an actual AArch64 EL1 Hypervisor.framework guest.
 * The controller accepts a bounded binary frame and returns bytes written by
 * the guest only after checking the HVC exit, guest status and DONE marker. */
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
static uint32_t u32(const unsigned char *p) {
  return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;
}
static int failure(const char *stage,long code) {
  fprintf(stderr,"packed-hvf-guest %s: %ld\n",stage,code);return 2;
}
static unsigned long long resident_now(void) {
  mach_task_basic_info_data_t info;mach_msg_type_number_t count=MACH_TASK_BASIC_INFO_COUNT;
  return task_info(mach_task_self(),MACH_TASK_BASIC_INFO,(task_info_t)&info,&count)==KERN_SUCCESS?
    (unsigned long long)info.resident_size:0;
}
int main(int argc,char **argv) {
  const uint64_t main_start=mach_absolute_time();
  if(argc!=2) return failure("usage: driver kernel.bin",0);
  const size_t page=(size_t)getpagesize(),guest_bytes=page*4;
  if(page!=16384) return failure("unsupported page bytes",(long)page);
  FILE *image=fopen(argv[1],"rb");if(!image)return failure("image open",0);
  if(fseek(image,0,SEEK_END))return failure("image seek",0);
  long image_bytes=ftell(image);rewind(image);
  if(image_bytes<1||(size_t)image_bytes>page)return failure("image outside code page",image_bytes);
  unsigned char header[48];
  if(fread(header,1,sizeof(header),stdin)!=sizeof(header))return failure("short frame header",0);
  size_t frame_bytes=u32(header+8);
  if(u32(header)!=FRAME_MAGIC||u32(header+4)!=1||frame_bytes<48||frame_bytes>page*2)
    return failure("invalid frame header",(long)frame_bytes);
  const uint64_t guest_start=mach_absolute_time();
  void *memory=mmap(NULL,guest_bytes,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);
  if(memory==MAP_FAILED)return failure("guest allocation",0);
  memset(memory,0,guest_bytes);
  if(fread(memory,1,(size_t)image_bytes,image)!=(size_t)image_bytes)return failure("image read",0);
  fclose(image);
  unsigned char *frame=(unsigned char*)memory+page;
  memcpy(frame,header,sizeof(header));
  if(fread(frame+sizeof(header),1,frame_bytes-sizeof(header),stdin)!=frame_bytes-sizeof(header) || fgetc(stdin)!=EOF)
    return failure("frame length",0);
  const uint64_t base=0x40000000;
  hv_return_t code=hv_vm_create(NULL);if(code!=HV_SUCCESS)return failure("hv_vm_create",code);
#define HV(call,stage) do {code=(call);if(code!=HV_SUCCESS)return failure((stage),code);} while(0)
  HV(hv_vm_map(memory,base,page,HV_MEMORY_READ|HV_MEMORY_EXEC),"map RX code");
  HV(hv_vm_map(frame,base+page,page*2,HV_MEMORY_READ|HV_MEMORY_WRITE),"map RW frame");
  HV(hv_vm_map((unsigned char*)memory+page*3,base+page*3,page,HV_MEMORY_READ|HV_MEMORY_WRITE),"map RW stack");
  hv_vcpu_t cpu;hv_vcpu_exit_t *exit_info=NULL;
  HV(hv_vcpu_create(&cpu,&exit_info,NULL),"hv_vcpu_create");
  HV(hv_vcpu_set_reg(cpu,HV_REG_PC,base),"set PC");
  HV(hv_vcpu_set_reg(cpu,HV_REG_CPSR,0x3c5),"set EL1h");
  HV(hv_vcpu_set_sys_reg(cpu,HV_SYS_REG_VBAR_EL1,base+2048),"set exception vectors");
  HV(hv_vcpu_set_sys_reg(cpu,HV_SYS_REG_SP_EL1,base+guest_bytes),"set stack");
  HV(hv_vcpu_set_reg(cpu,HV_REG_X0,base+page),"set frame GPA");
  HV(hv_vcpu_set_reg(cpu,HV_REG_X1,frame_bytes),"set frame bytes");
  const uint64_t run_start=mach_absolute_time();
  HV(hv_vcpu_run(cpu),"run EL1 guest");
  uint64_t guest_status=UINT64_MAX;
  HV(hv_vcpu_get_reg(cpu,HV_REG_X0,&guest_status),"read guest status");
  int valid=exit_info->reason==HV_EXIT_REASON_EXCEPTION &&
    (exit_info->exception.syndrome>>26)==0x16 && guest_status==0 && u32(frame+44)==FRAME_DONE;
  if(!valid) {
    uint64_t pc=0,far=0,elr=0,marker=0;
    hv_vcpu_get_reg(cpu,HV_REG_PC,&pc);hv_vcpu_get_reg(cpu,HV_REG_X1,&far);
    hv_vcpu_get_reg(cpu,HV_REG_X2,&elr);hv_vcpu_get_reg(cpu,HV_REG_X3,&marker);
    fprintf(stderr,"packed-hvf-guest exit reason=%u syndrome=%llu pc=%llu status=%llu far=%llu elr=%llu marker=%llu frameState=%u\n",
      exit_info->reason,(unsigned long long)exit_info->exception.syndrome,
      (unsigned long long)pc,(unsigned long long)guest_status,(unsigned long long)far,
      (unsigned long long)elr,(unsigned long long)marker,u32(frame+44));
    return failure("guest exit/status",(long)guest_status);
  }
  const uint64_t response=mach_absolute_time();
  unsigned char residency[4]={0};size_t resident=0;
  if(mincore(memory,guest_bytes,(char*)residency))return failure("guest residency",0);
  for(size_t i=0;i<4;i++)if(residency[i]&MINCORE_INCORE)resident+=page;
  struct rusage usage;if(getrusage(RUSAGE_SELF,&usage))return failure("controller RSS",0);
  mach_timebase_info_data_t timebase;if(mach_timebase_info(&timebase))return failure("timebase",0);
  fprintf(stderr,"{\"kind\":\"packed_hvf_guest_sample\",\"mainStartTick\":%llu,\"guestStartTick\":%llu,\"runStartTick\":%llu,\"validatedResponseTick\":%llu,\"tickNs\":%.9f,\"mainToResponseNs\":%.3f,\"freshGuestToValidatedResponseNs\":%.3f,\"hvVcpuRunToValidatedResponseNs\":%.3f,\"guestImageBytes\":%ld,\"guestMappedBytes\":%zu,\"guestResidentObservedBytes\":%zu,\"guestResidentPeakUpperBoundBytes\":%zu,\"controllerCurrentRssBytes\":%llu,\"controllerPeakRssBytes\":%llu}\n",
    (unsigned long long)main_start,(unsigned long long)guest_start,
    (unsigned long long)run_start,(unsigned long long)response,
    (double)timebase.numer/timebase.denom,
    (double)(response-main_start)*timebase.numer/timebase.denom,
    (double)(response-guest_start)*timebase.numer/timebase.denom,
    (double)(response-run_start)*timebase.numer/timebase.denom,
    image_bytes,guest_bytes,resident,guest_bytes,resident_now(),(unsigned long long)usage.ru_maxrss);
  if(fwrite(frame,1,frame_bytes,stdout)!=frame_bytes||fflush(stdout))return failure("output frame",0);
  HV(hv_vcpu_destroy(cpu),"destroy vCPU");
  HV(hv_vm_destroy(),"destroy VM");
  if(munmap(memory,guest_bytes))return failure("unmap guest",0);
  return 0;
#undef HV
}
