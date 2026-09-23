#include "abi.h"

static ae_packed_status range(size_t byte_length, size_t valid_bits, size_t bit_offset,
    unsigned bit_width) {
  if (bit_width > 64) return AE_PACKED_WIDTH;
  if (byte_length > SIZE_MAX / 8) return AE_PACKED_BOUNDS;
  const size_t bits = valid_bits;
  if (valid_bits > byte_length * 8) return AE_PACKED_BOUNDS;
  if (bit_offset > bits || bit_width > bits - bit_offset) return AE_PACKED_BOUNDS;
  return AE_PACKED_OK;
}

ae_packed_status ae_packed_read_u64(const uint8_t *bytes, size_t byte_length,
    size_t valid_bits, size_t bit_offset, unsigned bit_width, uint64_t *out) {
  if (bytes == NULL || out == NULL) return AE_PACKED_BOUNDS;
  ae_packed_status status = range(byte_length, valid_bits, bit_offset, bit_width);
  if (status != AE_PACKED_OK) return status;
  uint64_t value = 0;
  for (unsigned bit = 0; bit < bit_width; bit++)
    value |= (uint64_t)((bytes[(bit_offset + bit) / 8] >> ((bit_offset + bit) % 8)) & 1u) << bit;
  *out = value;
  return AE_PACKED_OK;
}

ae_packed_status ae_packed_write_u64(uint8_t *bytes, size_t byte_length,
    size_t valid_bits, size_t bit_offset, unsigned bit_width, uint64_t value) {
  if (bytes == NULL) return AE_PACKED_BOUNDS;
  ae_packed_status status = range(byte_length, valid_bits, bit_offset, bit_width);
  if (status != AE_PACKED_OK) return status;
  if (bit_width < 64 && (value >> bit_width) != 0) return AE_PACKED_WIDTH;
  for (unsigned bit = 0; bit < bit_width; bit++) {
    const size_t index = (bit_offset + bit) / 8;
    const uint8_t mask = (uint8_t)(1u << ((bit_offset + bit) % 8));
    if ((value >> bit) & 1u) bytes[index] |= mask;
    else bytes[index] &= (uint8_t)~mask;
  }
  return AE_PACKED_OK;
}

ae_packed_status ae_packed_ref_target(uint64_t code, size_t source_ordinal,
    size_t row_count, size_t max_relative, size_t *target_ordinal, int *is_null) {
  if (target_ordinal == NULL || is_null == NULL || source_ordinal >= row_count)
    return AE_PACKED_REFERENCE;
  if (code == 0) { *is_null = 1; *target_ordinal = 0; return AE_PACKED_OK; }
  const uint64_t magnitude = (code & 1u) ? (code - 1u) / 2u : code / 2u;
  if (magnitude > max_relative || magnitude > SIZE_MAX) return AE_PACKED_REFERENCE;
  const size_t distance = (size_t)magnitude;
  size_t target;
  if (code & 1u) {
    if (distance > SIZE_MAX - source_ordinal) return AE_PACKED_REFERENCE;
    target = source_ordinal + distance;
  } else {
    if (distance > source_ordinal) return AE_PACKED_REFERENCE;
    target = source_ordinal - distance;
  }
  if (target >= row_count) return AE_PACKED_REFERENCE;
  *is_null = 0; *target_ordinal = target;
  return AE_PACKED_OK;
}

ae_packed_status ae_packed_add_i64(int64_t value, int64_t increment,
    int64_t min, int64_t max, ae_packed_overflow policy, int64_t *out) {
  if (out == NULL || min > max || value < min || value > max || policy < AE_PACKED_TRAP || policy > AE_PACKED_SATURATE)
    return AE_PACKED_BOUNDS;
  const __int128 requested = (__int128)value + (__int128)increment;
  if (policy == AE_PACKED_TRAP && (requested < min || requested > max)) return AE_PACKED_OVERFLOW;
  if (policy == AE_PACKED_SATURATE) {
    *out = (int64_t)(requested < min ? min : requested > max ? max : requested);
    return AE_PACKED_OK;
  }
  if (policy == AE_PACKED_WRAP) {
    const __int128 span = (__int128)max - (__int128)min + 1;
    __int128 residue = (requested - (__int128)min) % span;
    if (residue < 0) residue += span;
    *out = (int64_t)((__int128)min + residue);
    return AE_PACKED_OK;
  }
  *out = (int64_t)requested;
  return AE_PACKED_OK;
}
