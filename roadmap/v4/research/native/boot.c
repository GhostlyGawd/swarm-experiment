/* Apple-silicon HVF research loader: a real EL1 bare guest, no guest OS. */
#include <Hypervisor/Hypervisor.h>
#include <mach/mach_time.h>
#include <sys/resource.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static double ns(uint64_t ticks) { mach_timebase_info_data_t t; mach_timebase_info(&t); return (double)ticks*t.numer/t.denom; }
static void check(hv_return_t code,const char *where) { if(code!=HV_SUCCESS) { fprintf(stderr,"%s=%#x\n",where,code); exit(2); } }
int main(int argc,char **argv) {
  if(argc!=2) { fprintf(stderr,"usage: boot image.bin\n"); return 2; }
  uint64_t start=mach_absolute_time();
  const uint64_t base=0x40000000; const size_t guest_bytes=65536, page=(size_t)getpagesize();
  FILE *image=fopen(argv[1],"rb"); if(!image) {perror("image");return 2;}
  fseek(image,0,SEEK_END); long image_bytes=ftell(image); rewind(image);
  if(image_bytes<=0 || (size_t)image_bytes>page) {fprintf(stderr,"image outside bounded code page\n");return 2;}
  void *memory=NULL; if(posix_memalign(&memory,page,guest_bytes)) return 2; memset(memory,0,guest_bytes);
  if(fread(memory,1,(size_t)image_bytes,image)!=(size_t)image_bytes) return 2; fclose(image);
  check(hv_vm_create(NULL),"hv_vm_create");
  check(hv_vm_map(memory,base,page,HV_MEMORY_READ|HV_MEMORY_EXEC),"map_rx_code");
  check(hv_vm_map((char*)memory+page,base+page,guest_bytes-page,HV_MEMORY_READ|HV_MEMORY_WRITE),"map_rw_stack");
  hv_vcpu_t cpu; hv_vcpu_exit_t *exit_info=NULL;
  check(hv_vcpu_create(&cpu,&exit_info,NULL),"hv_vcpu_create");
  check(hv_vcpu_set_reg(cpu,HV_REG_PC,base),"set_pc");
  check(hv_vcpu_set_reg(cpu,HV_REG_CPSR,0x3c5),"set_el1h");
  check(hv_vcpu_set_sys_reg(cpu,HV_SYS_REG_SP_EL1,base+guest_bytes),"set_sp_el1");
  check(hv_vcpu_set_reg(cpu,HV_REG_X0,1000),"set_gross");
  check(hv_vcpu_set_reg(cpu,HV_REG_X1,7),"set_adjustment");
  check(hv_vcpu_run(cpu),"hv_vcpu_run");
  uint64_t value=0,status=0; check(hv_vcpu_get_reg(cpu,HV_REG_X0,&value),"read_value"); check(hv_vcpu_get_reg(cpu,HV_REG_X1,&status),"read_status");
  uint64_t response=mach_absolute_time();
  if(exit_info->reason!=HV_EXIT_REASON_EXCEPTION || (exit_info->exception.syndrome>>26)!=0x16 || value!=12 || status!=0) {
    fprintf(stderr,"unexpected guest response reason=%u syndrome=%#llx value=%llu status=%llu\n",exit_info->reason,(unsigned long long)exit_info->exception.syndrome,(unsigned long long)value,(unsigned long long)status); return 3;
  }
  struct rusage usage; getrusage(RUSAGE_SELF,&usage);
  printf("{\"format\":\"aether.native-boot-sample/1\",\"mainToResponseNs\":%.3f,\"guestImageBytes\":%ld,\"guestMappedBytes\":%zu,\"hostProcessPeakRssBytes\":%ld,\"value\":\"%llu\",\"status\":%llu,\"syndrome\":%llu}\n",ns(response-start),image_bytes,guest_bytes,usage.ru_maxrss,(unsigned long long)value,(unsigned long long)status,(unsigned long long)exit_info->exception.syndrome);
  fflush(stdout);
  check(hv_vcpu_destroy(cpu),"destroy_vcpu"); check(hv_vm_destroy(),"destroy_vm"); free(memory); return 0;
}
