/* Read-only resolution probe for FR-3.7's hard 50 ns switch bound.
 * Adjacent-read histograms show clock cadence; they do not measure a switch
 * or prove any hard maximum. Build on the target Mac with:
 * clang -O2 -std=c11 -Wall -Wextra -Werror clock-probe.c -o clock-probe
 */
#define _DARWIN_C_SOURCE 1
#include <inttypes.h>
#include <mach/mach_time.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>

typedef uint64_t (*ClockRead)(void);
static uint64_t mach_read(void) { return mach_absolute_time(); }
static uint64_t uptime_read(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }
static uint64_t monotonic_read(void) { return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW); }
#if defined(__aarch64__)
static uint64_t counter_read(void) {
  uint64_t value;
  __asm__ volatile("isb\n\tmrs %0, cntvct_el0" : "=r"(value) :: "memory");
  return value;
}
static uint64_t counter_frequency(void) {
  uint64_t value;
  __asm__ volatile("mrs %0, cntfrq_el0" : "=r"(value));
  return value;
}
#endif
static void probe(const char *name, ClockRead clock) {
  uint64_t counts[129] = {0}, overflow = 0;
  for (unsigned i = 0; i < 100000; i++) {
    uint64_t before = clock(), after = clock(), delta = after - before;
    if (delta <= 128) counts[delta]++;
    else overflow++;
  }
  printf("{\"clock\":\"%s\",\"pairs\":100000,\"deltas\":[", name);
  int first = 1;
  for (unsigned delta = 0; delta <= 128; delta++) if (counts[delta]) {
    printf("%s[%u,%" PRIu64 "]", first ? "" : ",", delta, counts[delta]);
    first = 0;
  }
  printf("],\"above128\":%" PRIu64 "}\n", overflow);
}
int main(void) {
  mach_timebase_info_data_t info;
  if (mach_timebase_info(&info) != KERN_SUCCESS) return 2;
  printf("{\"machTimebaseNumer\":%u,\"machTimebaseDenom\":%u",
         info.numer, info.denom);
#if defined(__aarch64__)
  printf(",\"counterFrequency\":%" PRIu64, counter_frequency());
#endif
  printf("}\n");
  probe("mach_absolute_ticks", mach_read);
  probe("clock_uptime_raw_ns", uptime_read);
  probe("clock_monotonic_raw_ns", monotonic_read);
#if defined(__aarch64__)
  probe("cntvct_el0_units", counter_read);
#endif
  return 0;
}
