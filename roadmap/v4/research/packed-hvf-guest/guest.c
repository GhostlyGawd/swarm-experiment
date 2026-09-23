/* Freestanding EL1 guest. All offsets are relative to one RW shared frame.
 * The host authenticates the checkpoint, layout and executable first; this
 * kernel independently bounds its frame before any packed field access. */
#include <stdint.h>
#include <stddef.h>

#define FRAME_MAGIC 0x47504541u /* AEPG */
#define FRAME_DONE 0x454e4f44u /* DONE */
#define HEADER 48u
#define ROW 8u
#define OP 40u
#define RESULT 16u
#define MAX_FRAME 32768u
#define MAX_ROWS 1024u
#define MAX_OPS 256u
#define MAX_BYTES 16384u

static uint32_t u32(const uint8_t *p) {
  const volatile uint8_t *v=p;
  return (uint32_t)v[0] | (uint32_t)v[1]<<8 | (uint32_t)v[2]<<16 | (uint32_t)v[3]<<24;
}
static uint64_t u64(const uint8_t *p) {
  return (uint64_t)u32(p) | (uint64_t)u32(p+4)<<32;
}
static void put32(uint8_t *p,uint32_t n) {
  volatile uint8_t *v=p;
  v[0]=(uint8_t)n;v[1]=(uint8_t)(n>>8);v[2]=(uint8_t)(n>>16);v[3]=(uint8_t)(n>>24);
}
static void put64(uint8_t *p,uint64_t n) { put32(p,(uint32_t)n);put32(p+4,(uint32_t)(n>>32)); }
static int field(uint32_t row_start,uint32_t row_bits,uint32_t offset,uint32_t width) {
  return width<=64 && offset>=row_start && offset-row_start<=row_bits && width<=row_bits-(offset-row_start);
}
static uint64_t read_bits(const uint8_t *bytes,uint32_t offset,uint32_t width) {
  const volatile uint8_t *v=bytes;
  uint64_t result=0;
  for(uint32_t i=0;i<width;i++) result|=(uint64_t)((v[(offset+i)>>3]>>((offset+i)&7))&1u)<<i;
  return result;
}
static void write_bits(uint8_t *bytes,uint32_t offset,uint32_t width,uint64_t code) {
  for(uint32_t i=0;i<width;i++) {
    volatile uint8_t *byte=bytes+((offset+i)>>3);
    uint8_t mask=(uint8_t)(1u<<((offset+i)&7));
    if((code>>i)&1u)*byte|=mask;else *byte&=(uint8_t)~mask;
  }
}

uint64_t aether_packed_guest(uint8_t *frame,uint64_t capacity) {
  if(!frame || capacity<HEADER || capacity>MAX_FRAME) return 1;
  if(u32(frame)!=FRAME_MAGIC || u32(frame+4)!=1 || u32(frame+8)!=capacity || u32(frame+44)!=0) return 2;
  uint32_t rows=u32(frame+12),ops=u32(frame+16),bits=u32(frame+20),byte_count=u32(frame+24);
  uint32_t rows_at=u32(frame+28),ops_at=u32(frame+32),bytes_at=u32(frame+36),results_at=u32(frame+40);
  if(!rows || rows>MAX_ROWS || ops>MAX_OPS || byte_count>MAX_BYTES || bits>byte_count*8 ||
     byte_count!=(bits+7)/8 || rows_at!=HEADER || ops_at!=rows_at+rows*ROW ||
     results_at!=ops_at+ops*OP || bytes_at!=results_at+ops*RESULT ||
     bytes_at>capacity || byte_count!=capacity-bytes_at) return 3;
  uint32_t end=0;
  for(uint32_t i=0;i<rows;i++) {
    const uint8_t *row=frame+rows_at+i*ROW;
    uint32_t offset=u32(row),length=u32(row+4);
    if(offset!=end || length>bits-end) return 4;
    end+=length;
  }
  if(end!=bits) return 5;
  uint8_t *bytes=frame+bytes_at;
  if(bits&7) {
    uint8_t mask=(uint8_t)(0xffu << (bits&7));
    if(bytes[byte_count-1]&mask) return 6;
  }
  for(uint32_t i=0;i<ops;i++) {
    const uint8_t *operation=frame+ops_at+i*OP;
    uint32_t kind=u32(operation),ordinal=u32(operation+4),offset=u32(operation+8),width=u32(operation+12);
    if(ordinal>=rows) return 7;
    const uint8_t *row=frame+rows_at+ordinal*ROW;
    if(!field(u32(row),u32(row+4),offset,width)) return 8;
    uint64_t code=read_bits(bytes,offset,width),value=0;
    uint32_t status=0;
    if(kind==1 || kind==2) {
      int64_t min=(int64_t)u64(operation+16),max=(int64_t)u64(operation+24);
      __int128 span=(__int128)max-(__int128)min;
      if(min>max || (width<64 && span>=((__int128)1<<width)) ||
         (width==64 && span>(__int128)UINT64_MAX)) return 9;
      __int128 current=(__int128)min+(__int128)code;
      if(current>max) return 10;
      value=(uint64_t)(int64_t)current;
      if(kind==2) {
        __int128 requested=current+(int64_t)u64(operation+32);
        if(requested<min || requested>max) status=3;
        else { value=(uint64_t)(int64_t)requested;write_bits(bytes,offset,width,(uint64_t)(requested-min)); }
      }
    } else if(kind==3) {
      if(width!=1 || code>1) return 11;
      value=code;
    } else if(kind==4) {
      value=code;
    } else return 12;
    uint8_t *result=frame+results_at+i*RESULT;
    put32(result,status);put32(result+4,kind);put64(result+8,value);
  }
  put32(frame+44,FRAME_DONE);
  return 0;
}
