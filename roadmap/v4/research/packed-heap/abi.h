#ifndef AETHER_PACKED_HEAP_ABI_H
#define AETHER_PACKED_HEAP_ABI_H

#include <stddef.h>
#include <stdint.h>

/* Candidate C value ABI for the validated aether.packed-heap/1 payload.
 * The host must authenticate the image and row table before passing offsets.
 * These functions never turn an ordinal into a durable logical identity. */
typedef enum {
  AE_PACKED_OK = 0,
  AE_PACKED_BOUNDS = 1,
  AE_PACKED_WIDTH = 2,
  AE_PACKED_OVERFLOW = 3,
  AE_PACKED_REFERENCE = 4
} ae_packed_status;

typedef enum {
  AE_PACKED_TRAP = 0,
  AE_PACKED_WRAP = 1,
  AE_PACKED_SATURATE = 2
} ae_packed_overflow;

ae_packed_status ae_packed_read_u64(const uint8_t *bytes, size_t byte_length,
    size_t valid_bits, size_t bit_offset, unsigned bit_width, uint64_t *out);
ae_packed_status ae_packed_write_u64(uint8_t *bytes, size_t byte_length,
    size_t valid_bits, size_t bit_offset, unsigned bit_width, uint64_t value);
ae_packed_status ae_packed_ref_target(uint64_t code, size_t source_ordinal,
    size_t row_count, size_t max_relative, size_t *target_ordinal, int *is_null);
ae_packed_status ae_packed_add_i64(int64_t value, int64_t increment,
    int64_t min, int64_t max, ae_packed_overflow policy, int64_t *out);

#endif
