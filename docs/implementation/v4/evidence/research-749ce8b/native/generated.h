#include <stdint.h>
#include <stddef.h>
typedef struct { int64_t value; uint32_t status; uint32_t reserved; } aether_i64_result;
_Static_assert(sizeof(aether_i64_result)==16,"ABI result size");
_Static_assert(offsetof(aether_i64_result,status)==8,"ABI status offset");
/* status 0=value, 1=checked integer overflow, 2=division by zero. */
/* aether.native-i64/1; C compiler is in the prototype TCB. */
aether_i64_result aether_add(int64_t a,int64_t b) {
int64_t v0;
if (__builtin_add_overflow(a,b,&v0)) return (aether_i64_result){0,1,0};
return (aether_i64_result){v0,0,0};
}

/* aether.native-i64/1; C compiler is in the prototype TCB. */
aether_i64_result aether_sub(int64_t a,int64_t b) {
int64_t v0;
if (__builtin_sub_overflow(a,b,&v0)) return (aether_i64_result){0,1,0};
return (aether_i64_result){v0,0,0};
}

/* aether.native-i64/1; C compiler is in the prototype TCB. */
aether_i64_result aether_mul(int64_t a,int64_t b) {
int64_t v0;
if (__builtin_mul_overflow(a,b,&v0)) return (aether_i64_result){0,1,0};
return (aether_i64_result){v0,0,0};
}

/* aether.native-i64/1; C compiler is in the prototype TCB. */
aether_i64_result aether_div(int64_t a,int64_t b) {
int64_t v0;
if (b==0) return (aether_i64_result){0,2,0};
if (a==INT64_MIN && b==-1) return (aether_i64_result){0,1,0};
v0=a/b;
return (aether_i64_result){v0,0,0};
}

/* aether.native-i64/1; C compiler is in the prototype TCB. */
aether_i64_result aether_mod(int64_t a,int64_t b) {
int64_t v0;
if (b==0) return (aether_i64_result){0,2,0};
v0=(a==INT64_MIN && b==-1)?0:a%b;
return (aether_i64_result){v0,0,0};
}
/* aether.native-i64/1; C compiler is in the prototype TCB. */
aether_i64_result aether_eval(int64_t a,int64_t b) {
int64_t v0;
if (200LL==0) return (aether_i64_result){0,2,0};
if (a==INT64_MIN && 200LL==-1) return (aether_i64_result){0,1,0};
v0=a/200LL;
int64_t v1;
if (__builtin_add_overflow(v0,b,&v1)) return (aether_i64_result){0,1,0};
return (aether_i64_result){v1,0,0};
}
