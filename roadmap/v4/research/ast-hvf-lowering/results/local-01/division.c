/* Generated from Tier 1 AST root ast:b3:7fdf5d1f8227ca14c31803f573284942af233b294c7a197771ab8501d5293342. Research subset only. */
#include <stdint.h>
#include <stddef.h>
#define MAGIC UINT32_C(0x46454841)
#define DONE UINT32_C(0x454e4f44)
#define HEADER 96u
#define ARGS 2u
#define BITS 0u
#define MAYBE_UNUSED __attribute__((unused))
static const uint8_t expected_digest[32]={0xdc,0xd6,0xd7,0xaa,0x35,0x53,0x26,0x6c,0x3d,0xf3,0x97,0x4e,0x96,0x91,0x44,0xbd,0xaa,0xe7,0xe2,0x0d,0x8a,0x2a,0x0e,0x31,0x01,0xcb,0xf5,0x18,0x30,0x89,0xbb,0xcb};
static uint32_t rd32(const volatile uint8_t*p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
static MAYBE_UNUSED uint64_t rd64(const volatile uint8_t*p){return (uint64_t)rd32(p)|((uint64_t)rd32(p+4)<<32);}
static void wr32(volatile uint8_t*p,uint32_t n){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(n>>(8*i));}
static void wr64(volatile uint8_t*p,uint64_t n){for(unsigned i=0;i<8;i++)p[i]=(uint8_t)(n>>(8*i));}
static MAYBE_UNUSED int64_t ae_add(int64_t a,int64_t b,uint32_t*s){int64_t r=0;if(__builtin_add_overflow(a,b,&r))*s=1;return r;}
static MAYBE_UNUSED int64_t ae_sub(int64_t a,int64_t b,uint32_t*s){int64_t r=0;if(__builtin_sub_overflow(a,b,&r))*s=1;return r;}
static MAYBE_UNUSED int64_t ae_mul(int64_t a,int64_t b,uint32_t*s){int64_t r=0;if(__builtin_mul_overflow(a,b,&r))*s=1;return r;}
static MAYBE_UNUSED int64_t ae_div(int64_t a,int64_t b,uint32_t*s){if(!b){*s=2;return 0;}if(a==INT64_MIN&&b==-1){*s=1;return 0;}return a/b;}
static MAYBE_UNUSED int64_t ae_mod(int64_t a,int64_t b,uint32_t*s){if(!b){*s=2;return 0;}if(a==INT64_MIN&&b==-1){*s=1;return 0;}return a%b;}
static MAYBE_UNUSED int64_t ae_field(const volatile uint8_t*f,uint64_t cap,uint32_t off,uint32_t width,int64_t min,int64_t max,uint32_t*s){uint32_t at=HEADER+ARGS*8u;if(off> BITS||width>BITS-off||at+(BITS+7u)/8u>cap){*s=3;return 0;}uint64_t code=0;for(uint32_t i=0;i<width;i++)code|=(uint64_t)((f[at+(off+i)/8u]>>((off+i)%8u))&1u)<<i;__int128 value=(__int128)min+code;if(value>max){*s=3;return 0;}return (int64_t)value;}
static int64_t execute(const volatile uint8_t*frame,uint64_t capacity,uint32_t*status){(void)frame;(void)capacity;(void)status;int64_t a0=(int64_t)rd64(frame+HEADER+0u*8u);int64_t a1=(int64_t)rd64(frame+HEADER+1u*8u); return ae_div(a0, a1, status);}
uint64_t aether_ast_guest(uint8_t*bytes,uint64_t capacity){volatile uint8_t*frame=bytes;if(!frame||capacity!=HEADER+ARGS*8u+(BITS+7u)/8u||capacity>32768u||rd32(frame)!=MAGIC||rd32(frame+4)!=1u||rd32(frame+8)!=capacity||rd32(frame+12)!=ARGS||rd32(frame+16)!=BITS||rd32(frame+20)!=(BITS+7u)/8u||rd32(frame+40)!=0u)return 1;for(unsigned i=0;i<32;i++)if(frame[48+i]!=expected_digest[i])return 2;if(BITS%8u&&((frame[HEADER+ARGS*8u+(BITS/8u)]>>(BITS%8u))!=0u))return 4;uint32_t status=0;int64_t value=execute(frame,capacity,&status);wr32(frame+24,status);wr32(frame+28,1u);wr64(frame+32,(uint64_t)value);wr32(frame+40,DONE);return 0;}
