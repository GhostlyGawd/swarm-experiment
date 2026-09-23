#define _POSIX_C_SOURCE 200809L
#include "abi.h"
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum { HEADER_BYTES = 40, ROW_BYTES = 40, OPS = 100000, WARMUPS = 5, TRIALS = 7, ARM_COUNT = 4 };
typedef struct baseline_row baseline_row;
struct baseline_row {
  uint64_t id, epoch, version;
  uint32_t value;
  uint8_t alive;
  baseline_row *target;
};
typedef struct { uint64_t id, epoch, version; uint32_t bit_offset; } packed_row;
typedef struct {
  uint32_t count, width, ref_width, row_bits, payload_len, max_relative, distribution;
  baseline_row *baseline;
  packed_row *packed;
  uint8_t *payload;
  uint64_t mapping_checksum;
  uint32_t alias_targets;
} fixture;

static _Noreturn void fail(const char *why) { fprintf(stderr, "%s\n", why); exit(2); }
static uint32_t u32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint64_t u64(const uint8_t *p) { return (uint64_t)u32(p) | (uint64_t)u32(p + 4) << 32; }
static uint32_t next(uint32_t *state) { *state ^= *state << 13; *state ^= *state >> 17; *state ^= *state << 5; return *state; }
static uint64_t mix(uint64_t h, uint64_t value, uint64_t alive, uint64_t id, uint64_t epoch) {
  return h * UINT64_C(1099511628211) + value + (alive << 11) + id * 17 + epoch * 31;
}
static uint64_t fast_read(const fixture *f, uint32_t bit, uint32_t width) {
  const uint32_t byte = bit >> 3, shift = bit & 7;
  uint32_t word = 0;
  for (uint32_t i = 0; i < 4 && byte + i < f->payload_len; i++) word |= (uint32_t)f->payload[byte + i] << (8 * i);
  return (word >> shift) & ((UINT32_C(1) << width) - 1);
}
static uint32_t target_from_code(uint64_t code, uint32_t source) {
  return (code & 1) ? source + (uint32_t)((code - 1) / 2) : source - (uint32_t)(code / 2);
}

static fixture load(const char *path) {
  FILE *file = fopen(path, "rb"); if (!file) fail("fixture open failed");
  if (fseek(file, 0, SEEK_END)) fail("fixture seek failed");
  long length = ftell(file); if (length < HEADER_BYTES || fseek(file, 0, SEEK_SET)) fail("fixture length failed");
  uint8_t *raw = malloc((size_t)length); if (!raw) fail("fixture allocation failed");
  if (fread(raw, 1, (size_t)length, file) != (size_t)length || fclose(file)) fail("fixture read failed");
  if (memcmp(raw, "AENLOC01", 8)) fail("fixture magic mismatch");
  fixture f = { .count = u32(raw + 8), .width = u32(raw + 12), .ref_width = u32(raw + 16),
    .row_bits = u32(raw + 20), .payload_len = u32(raw + 24), .max_relative = u32(raw + 28), .distribution = u32(raw + 32) };
  if (u32(raw + 36) || f.count < 1 || f.count > 20000 || f.width != 10 || f.ref_width < 1 || f.ref_width > 16 ||
      f.row_bits != f.width + 1 + f.ref_width || f.payload_len != (f.count * f.row_bits + 7) / 8 ||
      (size_t)length != HEADER_BYTES + (size_t)f.count * ROW_BYTES + f.payload_len || f.distribution > 2 ||
      f.max_relative != (f.distribution == 2 ? f.count - 1 : 63)) fail("fixture header mismatch");
  f.baseline = calloc(f.count, sizeof(*f.baseline)); f.packed = calloc(f.count, sizeof(*f.packed));
  f.payload = malloc(f.payload_len); uint32_t *targets = calloc(f.count, sizeof(*targets));
  uint32_t *indegree = calloc(f.count, sizeof(*indegree));
  if (!f.baseline || !f.packed || !f.payload || !targets || !indegree) fail("row allocation failed");
  for (uint32_t i = 0; i < f.count; i++) {
    const uint8_t *p = raw + HEADER_BYTES + (size_t)i * ROW_BYTES;
    baseline_row *b = &f.baseline[i]; packed_row *r = &f.packed[i];
    b->id = r->id = u64(p); b->epoch = r->epoch = u64(p + 8); b->version = r->version = u64(p + 16);
    b->value = u32(p + 24); b->alive = p[28]; targets[i] = u32(p + 32); r->bit_offset = i * f.row_bits;
    if (b->id != (uint64_t)i + 1 || b->epoch != 1 + i % 7 || b->version != i % 3 ||
        b->value > 1000 || b->alive > 1 || p[29] || p[30] || p[31] || u32(p + 36) || targets[i] >= f.count) fail("logical row malformed");
    indegree[targets[i]]++;
  }
  memcpy(f.payload, raw + HEADER_BYTES + (size_t)f.count * ROW_BYTES, f.payload_len);
  free(raw);
  for (uint32_t i = 0; i < f.count; i++) {
    f.baseline[i].target = &f.baseline[targets[i]];
    uint64_t value, alive, code; size_t target; int is_null;
    size_t bit = (size_t)i * f.row_bits, valid = (size_t)f.count * f.row_bits;
    ae_packed_bounded_row fused;
    if (ae_packed_read_bounded_row(f.payload, f.payload_len, valid, bit, f.ref_width,
          i, f.count, f.max_relative, &fused) != AE_PACKED_OK ||
        ae_packed_read_u64(f.payload, f.payload_len, valid, bit, f.width, &value) != AE_PACKED_OK ||
        ae_packed_read_u64(f.payload, f.payload_len, valid, bit + f.width, 1, &alive) != AE_PACKED_OK ||
        ae_packed_read_u64(f.payload, f.payload_len, valid, bit + f.width + 1, f.ref_width, &code) != AE_PACKED_OK ||
        ae_packed_ref_target(code, i, f.count, f.max_relative, &target, &is_null) != AE_PACKED_OK || is_null ||
        value != f.baseline[i].value || alive != f.baseline[i].alive || target != targets[i] ||
        fused.value != value || fused.alive != alive || fused.is_null || fused.target_ordinal != target ||
        f.packed[target].id != f.baseline[i].target->id || f.packed[target].epoch != f.baseline[i].target->epoch ||
        fast_read(&f, (uint32_t)bit, f.width) != value || fast_read(&f, (uint32_t)bit + f.width, 1) != alive ||
        fast_read(&f, (uint32_t)bit + f.width + 1, f.ref_width) != code) fail("packed/logical value or alias mismatch");
    f.mapping_checksum = mix(f.mapping_checksum, value + f.baseline[i].version, alive, f.packed[target].id, f.packed[target].epoch);
    if (indegree[i] > 1) f.alias_targets++;
  }
  free(targets); free(indegree); return f;
}

static uint64_t run(const fixture *f, int pattern, int arm) {
  uint64_t checksum = 0; uint32_t index = 0, random = UINT32_C(0x62ca1234) ^ f->count ^ f->distribution;
  for (uint32_t step = 0; step < OPS; step++) {
    if (pattern == 0) index = step % f->count;
    else if (pattern == 1) index = next(&random) % f->count;
    uint64_t value, alive, target_id, target_epoch; uint32_t target_index;
    if (arm == 0) {
      const baseline_row *row = &f->baseline[index];
      value = row->value; alive = row->alive; target_id = row->target->id; target_epoch = row->target->epoch;
      target_index = (uint32_t)(row->target - f->baseline);
    } else {
      const packed_row *row = &f->packed[index]; uint64_t code;
      if (arm == 1) {
        const size_t valid = (size_t)f->count * f->row_bits;
        if (ae_packed_read_u64(f->payload, f->payload_len, valid, row->bit_offset, f->width, &value) != AE_PACKED_OK ||
            ae_packed_read_u64(f->payload, f->payload_len, valid, row->bit_offset + f->width, 1, &alive) != AE_PACKED_OK ||
            ae_packed_read_u64(f->payload, f->payload_len, valid, row->bit_offset + f->width + 1, f->ref_width, &code) != AE_PACKED_OK) fail("timed ABI read failed");
        size_t target; int is_null;
        if (ae_packed_ref_target(code, index, f->count, f->max_relative, &target, &is_null) != AE_PACKED_OK || is_null) fail("timed ABI reference failed");
        target_index = (uint32_t)target;
      } else if (arm == 2) {
        value = fast_read(f, row->bit_offset, f->width);
        alive = fast_read(f, row->bit_offset + f->width, 1);
        code = fast_read(f, row->bit_offset + f->width + 1, f->ref_width);
        target_index = target_from_code(code, index);
      } else {
        ae_packed_bounded_row decoded;
        if (ae_packed_read_bounded_row(f->payload, f->payload_len,
              (size_t)f->count * f->row_bits, row->bit_offset, f->ref_width,
              index, f->count, f->max_relative, &decoded) != AE_PACKED_OK ||
            decoded.is_null) fail("timed fused read failed");
        value = decoded.value; alive = decoded.alive;
        target_index = (uint32_t)decoded.target_ordinal;
      }
      target_id = f->packed[target_index].id; target_epoch = f->packed[target_index].epoch;
    }
    checksum = mix(checksum, value, alive, target_id, target_epoch);
    if (pattern == 2) index = target_index;
  }
  return checksum;
}
static uint64_t nanos(void) { struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) fail("clock failed"); return (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec; }
int main(int argc, char **argv) {
  if (argc != 2) fail("usage: native fixture.bin"); fixture f = load(argv[1]);
  printf("{\"count\":%u,\"distribution\":%u,\"mappingChecksum\":\"%" PRIu64 "\",\"aliasTargets\":%u,\"baselineBytes\":%zu,\"packedBytes\":%zu,\"baselineRowBytes\":%zu,\"packedRowBytes\":%zu,\"payloadBytes\":%u,\"patterns\":[",
    f.count, f.distribution, f.mapping_checksum, f.alias_targets, sizeof(*f.baseline) * (size_t)f.count,
    sizeof(*f.packed) * (size_t)f.count + f.payload_len, sizeof(*f.baseline), sizeof(*f.packed), f.payload_len);
  const char *names[] = { "scan", "scatter", "chase" };
  for (int pattern = 0; pattern < 3; pattern++) {
    uint64_t expected = run(&f, pattern, 0), samples[ARM_COUNT][TRIALS], checksums[ARM_COUNT][TRIALS];
    for (int arm = 1; arm < ARM_COUNT; arm++) if (run(&f, pattern, arm) != expected) fail("untimed checksum mismatch");
    for (int warmup = 0; warmup < WARMUPS; warmup++) for (int arm = 0; arm < ARM_COUNT; arm++)
      if (run(&f, pattern, arm) != expected) fail("warmup checksum mismatch");
    for (int trial = 0; trial < TRIALS; trial++) for (int position = 0; position < ARM_COUNT; position++) {
      const int arm = (trial + position) % ARM_COUNT;
      uint64_t start = nanos(), checksum = run(&f, pattern, arm), elapsed = nanos() - start;
      if (checksum != expected) fail("measured checksum mismatch");
      samples[arm][trial] = elapsed; checksums[arm][trial] = checksum;
    }
    if (pattern) printf(",");
    printf("{\"name\":\"%s\",\"expectedChecksum\":\"%" PRIu64 "\",\"arms\":[", names[pattern], expected);
    const char *arms[] = { "baseline", "packedAbi", "packedValidated", "packedFusedChecked" };
    for (int arm = 0; arm < ARM_COUNT; arm++) {
      if (arm) printf(","); printf("{\"name\":\"%s\",\"samples\":[", arms[arm]);
      for (int trial = 0; trial < TRIALS; trial++) {
        if (trial) printf(","); printf("{\"ns\":%" PRIu64 ",\"checksum\":\"%" PRIu64 "\"}", samples[arm][trial], checksums[arm][trial]);
      }
      printf("]}");
    }
    printf("]}");
  }
  printf("]}\n"); free(f.baseline); free(f.packed); free(f.payload); return 0;
}
