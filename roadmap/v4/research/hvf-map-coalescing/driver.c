/* Persistent research controller: split versus coalesced RW guest mapping.
 * Every sample creates a fresh Apple HVF VM/vCPU and validates exact output. */
#include <Hypervisor/Hypervisor.h>
#include <mach/mach_time.h>
#include <sys/mman.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAGIC 0x47504541u
#define DONE 0x454e4f44u
#define ROWS 16u
#define OPS 128u
#define HEADER 48u
#define ROW_BYTES 8u
#define OP_BYTES 40u
#define RESULT_BYTES 16u
#define BYTES_AT (HEADER+ROWS*ROW_BYTES+OPS*OP_BYTES+OPS*RESULT_BYTES)
#define FRAME_BYTES (BYTES_AT+ROWS)
#define WARMUP_PAIRS 20u
#define SAMPLE_PAIRS 1000u

typedef struct {
  unsigned mode, pair, resident;
  uint64_t start, copied, vm, rx, rw, configured, response;
} sample_t;
static sample_t samples[SAMPLE_PAIRS*2];
static unsigned char input[FRAME_BYTES], expected[FRAME_BYTES];
static unsigned char image[16384];
static size_t image_bytes, page;

static void put32(unsigned char *p,uint32_t n) {
  p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);
  p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);
}
static void put64(unsigned char *p,uint64_t n) {put32(p,(uint32_t)n);put32(p+4,(uint32_t)(n>>32));}
static uint32_t u32(const unsigned char *p) {
  return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;
}
static void die(const char *stage,long code,unsigned pair,unsigned mode) {
  fprintf(stderr,"hvf-map-coalescing failure stage=%s code=%ld pair=%u mode=%u\n",stage,code,pair,mode);
  exit(2);
}
static void make_frames(void) {
  put32(input,MAGIC);put32(input+4,1);put32(input+8,FRAME_BYTES);
  put32(input+12,ROWS);put32(input+16,OPS);put32(input+20,ROWS*8);
  put32(input+24,ROWS);put32(input+28,HEADER);put32(input+32,HEADER+ROWS*ROW_BYTES);
  put32(input+36,BYTES_AT);put32(input+40,HEADER+ROWS*ROW_BYTES+OPS*OP_BYTES);
  for(unsigned row=0;row<ROWS;row++) {
    put32(input+HEADER+row*ROW_BYTES,row*8);put32(input+HEADER+row*ROW_BYTES+4,8);
    input[BYTES_AT+row]=(unsigned char)(row*6);
  }
  memcpy(expected,input,sizeof(input));
  for(unsigned step=0;step<OPS;step++) {
    unsigned row=step%ROWS, kind=(step%4==0)?1:2;
    unsigned char *op=input+HEADER+ROWS*ROW_BYTES+step*OP_BYTES;
    put32(op,kind);put32(op+4,row);put32(op+8,row*8);put32(op+12,8);
    put64(op+16,0);put64(op+24,100);
    put64(op+32,(step%11==0)?200:1);
    uint64_t current=expected[BYTES_AT+row], next=current+((step%11==0)?200:1);
    unsigned status=(kind==2 && next>100)?3:0;
    if(kind==2 && !status)expected[BYTES_AT+row]=(unsigned char)next;
    unsigned char *result=expected+HEADER+ROWS*ROW_BYTES+OPS*OP_BYTES+step*RESULT_BYTES;
    put32(result,status);put32(result+4,kind);
    put64(result+8,(kind==2 && !status)?next:current);
  }
  /* Operation table is identical in input and expected. */
  memcpy(expected+HEADER+ROWS*ROW_BYTES,input+HEADER+ROWS*ROW_BYTES,OPS*OP_BYTES);
  put32(expected+44,DONE);
}
static sample_t run_guest(unsigned pair,unsigned mode) {
  sample_t s={0};s.pair=pair;s.mode=mode;
  s.start=mach_absolute_time();
  void *memory=mmap(NULL,page*4,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);
  if(memory==MAP_FAILED)die("mmap",0,pair,mode);
  memset(memory,0,page*4);
  memcpy(memory,image,image_bytes);
  unsigned char *frame=(unsigned char*)memory+page;
  memcpy(frame,input,FRAME_BYTES);
  s.copied=mach_absolute_time();
  hv_return_t code=hv_vm_create(NULL);
  if(code!=HV_SUCCESS)die("hv_vm_create",code,pair,mode);
  s.vm=mach_absolute_time();
  const uint64_t base=0x40000000;
#define HV(call,stage) do {code=(call);if(code!=HV_SUCCESS)die((stage),code,pair,mode);} while(0)
  HV(hv_vm_map(memory,base,page,HV_MEMORY_READ|HV_MEMORY_EXEC),"map RX");
  s.rx=mach_absolute_time();
  if(mode==0) {
    HV(hv_vm_map(frame,base+page,page*2,HV_MEMORY_READ|HV_MEMORY_WRITE),"map frame");
    HV(hv_vm_map((unsigned char*)memory+page*3,base+page*3,page,
      HV_MEMORY_READ|HV_MEMORY_WRITE),"map stack");
  } else {
    HV(hv_vm_map(frame,base+page,page*3,HV_MEMORY_READ|HV_MEMORY_WRITE),"map frame + stack");
  }
  s.rw=mach_absolute_time();
  hv_vcpu_t cpu;hv_vcpu_exit_t *exit_info=NULL;
  HV(hv_vcpu_create(&cpu,&exit_info,NULL),"create vCPU");
  HV(hv_vcpu_set_reg(cpu,HV_REG_PC,base),"set PC");
  HV(hv_vcpu_set_reg(cpu,HV_REG_CPSR,0x3c5),"set EL1h");
  HV(hv_vcpu_set_sys_reg(cpu,HV_SYS_REG_VBAR_EL1,base+2048),"set vectors");
  HV(hv_vcpu_set_sys_reg(cpu,HV_SYS_REG_SP_EL1,base+page*4),"set stack");
  HV(hv_vcpu_set_reg(cpu,HV_REG_X0,base+page),"set frame");
  HV(hv_vcpu_set_reg(cpu,HV_REG_X1,FRAME_BYTES),"set capacity");
  s.configured=mach_absolute_time();
  HV(hv_vcpu_run(cpu),"run guest");
  uint64_t status=UINT64_MAX;
  HV(hv_vcpu_get_reg(cpu,HV_REG_X0,&status),"read status");
  if(exit_info->reason!=HV_EXIT_REASON_EXCEPTION ||
     (exit_info->exception.syndrome>>26)!=0x16 || status!=0 ||
     u32(frame+44)!=DONE || memcmp(frame,expected,FRAME_BYTES)!=0) {
    for(unsigned i=0;i<FRAME_BYTES;i++)if(frame[i]!=expected[i]) {
      fprintf(stderr,"first mismatch byte=%u actual=%u expected=%u\n",i,frame[i],expected[i]);break;
    }
    fprintf(stderr,"exit=%u syndrome=%llu marker=%u\n",exit_info->reason,
      (unsigned long long)exit_info->exception.syndrome,u32(frame+44));
    die("validated response",(long)status,pair,mode);
  }
  s.response=mach_absolute_time();
  unsigned char resident[4]={0};
  if(mincore(memory,page*4,(char*)resident))die("mincore",0,pair,mode);
  for(unsigned i=0;i<4;i++)if(resident[i]&MINCORE_INCORE)s.resident+=(unsigned)page;
  HV(hv_vcpu_destroy(cpu),"destroy vCPU");
  HV(hv_vm_destroy(),"destroy VM");
  if(munmap(memory,page*4))die("munmap",0,pair,mode);
#undef HV
  return s;
}
int main(int argc,char **argv) {
  if(argc!=2)die("usage: driver guest.bin",0,0,0);
  page=(size_t)getpagesize();
  if(page!=16384)die("unsupported page",(long)page,0,0);
  FILE *file=fopen(argv[1],"rb");if(!file)die("guest image open",0,0,0);
  if(fseek(file,0,SEEK_END))die("guest image seek",0,0,0);
  long length=ftell(file);rewind(file);
  if(length<1 || (size_t)length>page)die("guest image length",length,0,0);
  image_bytes=(size_t)length;
  if(fread(image,1,image_bytes,file)!=image_bytes)die("guest image read",0,0,0);
  fclose(file);make_frames();
  for(unsigned pair=0;pair<WARMUP_PAIRS;pair++) {
    run_guest(pair,0);run_guest(pair,1);
  }
  for(unsigned pair=0;pair<SAMPLE_PAIRS;pair++) {
    const unsigned first=pair&1u,second=first^1u;
    samples[pair*2+first]=run_guest(pair,first);
    samples[pair*2+second]=run_guest(pair,second);
  }
  mach_timebase_info_data_t timebase;
  if(mach_timebase_info(&timebase))die("timebase",0,0,0);
  printf("{\"format\":\"aether.hvf-map-coalescing-raw/1\",\"warmupPairs\":%u,\"samplePairs\":%u,\"guestImageBytes\":%zu,\"guestMappedBytes\":%zu,\"frameBytes\":%u,\"tickNumer\":%u,\"tickDenom\":%u,\"samples\":[",
    WARMUP_PAIRS,SAMPLE_PAIRS,image_bytes,page*4,FRAME_BYTES,timebase.numer,timebase.denom);
  for(unsigned i=0;i<SAMPLE_PAIRS*2;i++) {
    const sample_t *s=&samples[i];
    printf("%s{\"mode\":%u,\"pair\":%u,\"residentBytes\":%u,\"ticks\":[%llu,%llu,%llu,%llu,%llu,%llu,%llu]}",
      i?",":"",s->mode,s->pair,s->resident,
      (unsigned long long)s->start,(unsigned long long)s->copied,
      (unsigned long long)s->vm,(unsigned long long)s->rx,
      (unsigned long long)s->rw,(unsigned long long)s->configured,
      (unsigned long long)s->response);
  }
  puts("]}");
  return 0;
}
