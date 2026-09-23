#include "abi.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static _Noreturn void fail(const char *why) { fprintf(stderr, "%s\n", why); exit(2); }
static void put(uint8_t *bytes, size_t bit, unsigned width, uint64_t value) {
  if (ae_packed_write_u64(bytes, 8, 64, bit, width, value) != AE_PACKED_OK)
    fail("test row write failed");
}
static void expect_error(uint8_t *bytes, size_t byte_length, size_t valid_bits,
    size_t bit_offset, unsigned ref_width, size_t source, size_t count,
    size_t max_relative, ae_packed_status expected) {
  ae_packed_bounded_row out, before;
  memset(&out, 0xa5, sizeof out);
  before = out;
  if (ae_packed_read_bounded_row(bytes, byte_length, valid_bits, bit_offset,
        ref_width, source, count, max_relative, &out) != expected ||
      memcmp(&out, &before, sizeof out)) fail("error status or output mutation");
}

int main(void) {
  const uint64_t codes[] = { 0, 1, 2, 3, 126, 127 };
  uint64_t cases = 0;
  for (unsigned ref_width = 7; ref_width <= 15; ref_width += 8)
    for (size_t offset = 0; offset < 8; offset++)
      for (uint16_t value = 0; value <= 1000; value++)
        for (uint8_t alive = 0; alive < 2; alive++)
          for (size_t c = 0; c < sizeof codes / sizeof codes[0]; c++) {
            uint8_t bytes[8] = { 0 };
            const size_t valid_bits = offset + 11 + ref_width;
            put(bytes, offset, 10, value);
            put(bytes, offset + 10, 1, alive);
            put(bytes, offset + 11, ref_width, codes[c]);
            uint64_t old_value, old_alive, old_code;
            size_t old_target; int old_null;
            if (ae_packed_read_u64(bytes, 8, valid_bits, offset, 10, &old_value) != AE_PACKED_OK ||
                ae_packed_read_u64(bytes, 8, valid_bits, offset + 10, 1, &old_alive) != AE_PACKED_OK ||
                ae_packed_read_u64(bytes, 8, valid_bits, offset + 11, ref_width, &old_code) != AE_PACKED_OK ||
                ae_packed_ref_target(old_code, 80, 160, 63, &old_target, &old_null) != AE_PACKED_OK)
              fail("legacy reader mismatch");
            ae_packed_bounded_row fused;
            if (ae_packed_read_bounded_row(bytes, 8, valid_bits, offset,
                  ref_width, 80, 160, 63, &fused) != AE_PACKED_OK ||
                fused.value != old_value || fused.alive != old_alive ||
                fused.target_ordinal != old_target || fused.is_null != old_null)
              fail("fused reader parity mismatch");
            cases++;
          }

  uint8_t bad[8] = { 0 };
  put(bad, 0, 10, 1001);
  expect_error(bad, 8, 18, 0, 7, 80, 160, 63, AE_PACKED_BOUNDS);
  memset(bad, 0, sizeof bad); put(bad, 11, 7, 2);
  expect_error(bad, 8, 18, 0, 7, 0, 160, 63, AE_PACKED_REFERENCE);
  memset(bad, 0, sizeof bad); put(bad, 11, 7, 3);
  expect_error(bad, 8, 18, 0, 7, 159, 160, 63, AE_PACKED_REFERENCE);
  expect_error(bad, 8, 18, 0, 7, 160, 160, 63, AE_PACKED_REFERENCE);
  memset(bad, 0, sizeof bad); put(bad, 11, 8, 128);
  expect_error(bad, 8, 19, 0, 8, 80, 160, 63, AE_PACKED_REFERENCE);
  expect_error(bad, 8, 17, 0, 7, 80, 160, 63, AE_PACKED_BOUNDS);
  expect_error(bad, 8, 65, 0, 7, 80, 160, 63, AE_PACKED_BOUNDS);
  expect_error(bad, 8, 64, SIZE_MAX, 7, 80, 160, 63, AE_PACKED_BOUNDS);
  expect_error(bad, 0, 0, 0, 7, 80, 160, 63, AE_PACKED_BOUNDS);
  expect_error(NULL, 8, 18, 0, 7, 80, 160, 63, AE_PACKED_BOUNDS);
  expect_error(bad, 8, 18, 0, 0, 80, 160, 63, AE_PACKED_WIDTH);
  expect_error(bad, 8, 18, 0, 17, 80, 160, 63, AE_PACKED_WIDTH);
  if (ae_packed_read_bounded_row(bad, 8, 18, 0, 7, 80, 160, 63, NULL) != AE_PACKED_BOUNDS)
    fail("null output accepted");
  printf("{\"validParityRows\":%llu,\"invalidCases\":13}\n",
      (unsigned long long)cases);
  return 0;
}
