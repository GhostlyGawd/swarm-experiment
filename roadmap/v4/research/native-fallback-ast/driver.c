#define _POSIX_C_SOURCE 200809L
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __APPLE__
#include <mach/mach_time.h>
#endif

/* Shared bounded frame. tier1, tier2, precondition and postcondition are
 * generated from the exact Aether AST into generated.h. */
typedef struct { int64_t value; } Record;
typedef struct { Record records[4]; uint32_t next_id; } Frame;
typedef struct { uint32_t tier, code; int64_t value; } Result;
typedef struct { uint64_t switch_ticks, full_ticks, pair_ticks; } Sample;
static volatile uint32_t fault_marker;
static volatile uint64_t observation_sink;
static inline void barrier(void) { __asm__ volatile("" ::: "memory"); }
static uint64_t tick(void) {
#ifdef __APPLE__
  return mach_absolute_time();
#else
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
#endif
}
static double tick_ns(void) {
#ifdef __APPLE__
  mach_timebase_info_data_t info;
  mach_timebase_info(&info);
  return (double)info.numer / (double)info.denom;
#else
  return 1.0;
#endif
}
static int64_t ae_add(int64_t a, int64_t b, uint32_t *fault) {
  int64_t value = 0;
  if (__builtin_add_overflow(a, b, &value)) *fault = 1;
  return value;
}
__attribute__((unused)) static int64_t ae_sub(int64_t a, int64_t b, uint32_t *fault) {
  int64_t value = 0;
  if (__builtin_sub_overflow(a, b, &value)) *fault = 1;
  return value;
}
static uint32_t ae_alloc(Frame *frame, int64_t value, uint32_t *fault) {
  if (frame->next_id >= 4) { *fault = 1; return 0; }
  uint32_t id = frame->next_id++;
  frame->records[id].value = value;
  return id;
}
#include "generated.h"

static Result abort_result(uint32_t code) { return (Result){3, code, 0}; }
static Result invoke(Frame *frame, uint32_t left, uint32_t right,
                     uint32_t grant1, uint32_t grant2,
                     uint32_t revoke_at_fault, uint64_t *switch_ticks) {
  if (switch_ticks) *switch_ticks = UINT64_MAX;
  if (!grant1) return abort_result(2);
  Frame before = *frame;
  if (!precondition(&before, left, right)) return abort_result(2);
  int64_t value = 0;
  int fault = tier1(frame, &before, left, right, &value);
  if (!fault && postcondition(&before, frame, left, right, value))
    return (Result){1, 0, value};
  fault_marker = 1;
  barrier();
  uint64_t started = tick();
  if (fault_marker) {
    *frame = before;
    barrier();
    if (!grant2 || revoke_at_fault) return abort_result(2);
    fault = tier2(frame, &before, left, right, &value, started, switch_ticks);
    if (!fault && postcondition(&before, frame, left, right, value))
      return (Result){2, 0, value};
    *frame = before;
    return abort_result(1);
  }
  abort();
}
static Frame initial_frame(int64_t initial, uint32_t alias, uint32_t *left,
                           uint32_t *right) {
  Frame frame = {.next_id = 1};
  uint32_t fault = 0;
  *left = ae_alloc(&frame, initial, &fault);
  *right = alias ? *left : ae_alloc(&frame, initial + 100, &fault);
  if (fault) abort();
  return frame;
}
static int case_main(int argc, char **argv) {
  if (argc != 7) return 2;
  uint32_t alias = (uint32_t)strtoul(argv[2], NULL, 10);
  int64_t initial = (int64_t)strtoll(argv[3], NULL, 10);
  uint32_t grant1 = (uint32_t)strtoul(argv[4], NULL, 10);
  uint32_t grant2 = (uint32_t)strtoul(argv[5], NULL, 10);
  uint32_t revoke = (uint32_t)strtoul(argv[6], NULL, 10);
  if (alias > 1 || grant1 > 1 || grant2 > 1 || revoke > 1
      || initial < -1000000 || initial > 1000000) return 2;
  uint32_t left, right;
  Frame frame = initial_frame(initial, alias, &left, &right);
  uint64_t switch_ticks;
  Result result = invoke(&frame, left, right, grant1, grant2, revoke,
                         &switch_ticks);
  printf("{\"tier\":%u,\"code\":%u,\"value\":%" PRId64
         ",\"left\":%u,\"right\":%u,\"nextObjectId\":%u,\"records\":[",
         result.tier, result.code, result.value, left, right, frame.next_id);
  for (uint32_t id = 1; id < frame.next_id; id++)
    printf("%s[%u,%" PRId64 "]", id == 1 ? "" : ",", id,
           frame.records[id].value);
  printf("]}\n");
  return 0;
}
static int benchmark_main(int argc, char **argv) {
  if (argc != 5) return 2;
  unsigned warmup = (unsigned)strtoul(argv[2], NULL, 10);
  unsigned trials = (unsigned)strtoul(argv[3], NULL, 10);
  unsigned per_trial = (unsigned)strtoul(argv[4], NULL, 10);
  if (warmup != 10000 || trials != 5 || per_trial != 2000) return 2;
  Sample *samples = calloc((size_t)trials * per_trial, sizeof(*samples));
  if (!samples) return 2;
  for (unsigned i = 0; i < warmup + trials * per_trial; i++) {
    uint32_t left, right;
    int64_t initial = 10 + (int64_t)(i % 1000);
    Frame frame = initial_frame(initial, 1, &left, &right);
    uint64_t switch_ticks;
    uint64_t pair_begin = tick();
    uint64_t pair_end = tick();
    barrier();
    uint64_t full_begin = tick();
    Result result = invoke(&frame, left, right, 1, 1, 0, &switch_ticks);
    barrier();
    uint64_t full_end = tick();
    if (result.tier != 2 || result.value != initial + 1 ||
        frame.next_id != 3 || frame.records[1].value != initial + 1 ||
        frame.records[2].value != 888 || switch_ticks == UINT64_MAX) {
      free(samples); return 3;
    }
    observation_sink += (uint64_t)result.value + frame.next_id;
    if (i >= warmup) samples[i - warmup] = (Sample){switch_ticks,
      full_end - full_begin, pair_end - pair_begin};
  }
  printf("{\"kind\":\"metadata\",\"clock\":\"%s\",\"tickNs\":%.12f,"
         "\"warmup\":%u,\"trials\":%u,\"samplesPerTrial\":%u,"
         "\"sink\":\"%" PRIu64 "\"}\n",
#ifdef __APPLE__
         "mach_absolute_time",
#else
         "CLOCK_MONOTONIC",
#endif
         tick_ns(), warmup, trials, per_trial, observation_sink);
  for (unsigned trial = 0; trial < trials; trial++)
    for (unsigned index = 0; index < per_trial; index++) {
      Sample sample = samples[trial * per_trial + index];
      printf("{\"kind\":\"sample\",\"trial\":%u,\"index\":%u,"
             "\"switchTicks\":%" PRIu64 ",\"fullTicks\":%" PRIu64
             ",\"timerPairTicks\":%" PRIu64 "}\n",
             trial, index, sample.switch_ticks, sample.full_ticks,
             sample.pair_ticks);
    }
  free(samples);
  return 0;
}
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--case") == 0) return case_main(argc, argv);
  if (argc > 1 && strcmp(argv[1], "--benchmark") == 0)
    return benchmark_main(argc, argv);
  return 2;
}
