/* Bounded native process checkpoint-image executor. The TypeScript host first
 * authenticates a full resumable checkpoint and derives every field offset.
 * This executable still checks all ranges before touching the packed bytes.
 * It is a research process, not the bare Hypervisor.framework guest. */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../packed-heap/abi.h"

#define MAX_ROWS 1024u
#define MAX_BYTES 65536u
#define MAX_OPS 4096u
#define MAX_STRINGS 4096u
#define MAX_STRING_BYTES 4096u
#define MAX_ARENA_BYTES 65536u

typedef struct { char id[128], epoch[128]; size_t offset, length; } row;
typedef struct { size_t offset, length; } string_entry;
static row rows[MAX_ROWS];
static uint8_t bytes[MAX_BYTES];
static uint8_t arena[MAX_ARENA_BYTES];
static string_entry strings[MAX_STRINGS];
static size_t row_count, byte_count, valid_bits;
static size_t string_count, arena_count;
static int version;

static int hex_digit(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}
static int decimal_token(const char *value, int positive) {
  if (!value[0] || (value[0] == '0' && (value[1] || positive))) return 0;
  for (size_t i = 0; value[i]; i++) if (value[i] < '0' || value[i] > '9') return 0;
  return 1;
}
static int field(size_t ordinal, size_t offset, unsigned width) {
  if (ordinal >= row_count || offset < rows[ordinal].offset ||
      offset - rows[ordinal].offset > rows[ordinal].length ||
      width > rows[ordinal].length - (offset - rows[ordinal].offset)) return 0;
  return 1;
}
static int utf8_valid(const uint8_t *data, size_t count) {
  for (size_t i = 0; i < count;) {
    uint8_t a = data[i++];
    if (a < 0x80) continue;
    unsigned extra; uint32_t cp;
    if (a >= 0xc2 && a <= 0xdf) { extra = 1; cp = a & 0x1f; }
    else if (a >= 0xe0 && a <= 0xef) { extra = 2; cp = a & 0x0f; }
    else if (a >= 0xf0 && a <= 0xf4) { extra = 3; cp = a & 0x07; }
    else return 0;
    if (extra > count - i) return 0;
    for (unsigned j = 0; j < extra; j++) {
      uint8_t next = data[i++];
      if ((next & 0xc0) != 0x80) return 0;
      cp = (cp << 6) | (next & 0x3f);
    }
    if (cp < (extra == 1 ? 0x80u : extra == 2 ? 0x800u : 0x10000u) ||
        cp > 0x10ffffu || (cp >= 0xd800u && cp <= 0xdfffu)) return 0;
  }
  return 1;
}
static int read_hex(uint8_t *destination, size_t count) {
  if (count == 0) {
    char marker[4];
    return scanf("%3s", marker) == 1 && !strcmp(marker, "-");
  }
  for (size_t i = 0; i < count; i++) {
    int high, low;
    do { high = getchar(); } while (high == ' ' || high == '\n');
    low = getchar();
    if (hex_digit(high) < 0 || hex_digit(low) < 0) return 0;
    destination[i] = (uint8_t)((hex_digit(high) << 4) | hex_digit(low));
  }
  return getchar() == '\n';
}
static int load(void) {
  size_t operations;
  char magic[16];
  if (scanf("%15s %zu %zu %zu %zu", magic, &row_count, &byte_count,
            &valid_bits, &operations) != 5 ||
      ((version = !strcmp(magic, "AEPBR001") ? 1 : !strcmp(magic, "AEPBR002") ? 2 : 0) == 0) ||
      row_count == 0 || row_count > MAX_ROWS || byte_count > MAX_BYTES ||
      operations > MAX_OPS || valid_bits > byte_count * 8 ||
      byte_count != (valid_bits + 7) / 8) return -1;
  if (version == 2 &&
      (scanf("%zu %zu", &string_count, &arena_count) != 2 ||
       string_count > MAX_STRINGS || arena_count > MAX_ARENA_BYTES)) return -1;
  if (!read_hex(bytes, byte_count)) return -1;
  if (byte_count && valid_bits % 8 && (bytes[byte_count - 1] >> (valid_bits % 8))) return -1;
  size_t end = 0;
  for (size_t i = 0; i < row_count; i++) {
    if (scanf("%127s %127s %zu %zu", rows[i].id,
              rows[i].epoch, &rows[i].offset, &rows[i].length) != 4 ||
        !decimal_token(rows[i].id, 1) || !decimal_token(rows[i].epoch, 0) ||
        rows[i].offset != end ||
        rows[i].length > valid_bits - end) return -1;
    end += rows[i].length;
    for (size_t j = 0; j < i; j++) if (!strcmp(rows[i].id, rows[j].id)) return -1;
  }
  if (end != valid_bits) return -1;
  if (version == 2) {
    end = 0;
    for (size_t i = 0; i < string_count; i++) {
      if (scanf("%zu %zu", &strings[i].offset, &strings[i].length) != 2 ||
          strings[i].offset != end || strings[i].length > MAX_STRING_BYTES ||
          strings[i].length > arena_count - end) return -1;
      end += strings[i].length;
    }
    if (end != arena_count || !read_hex(arena, arena_count)) return -1;
    for (size_t i = 0; i < string_count; i++) {
      if (!utf8_valid(arena + strings[i].offset, strings[i].length)) return -1;
      for (size_t j = 0; j < i; j++) {
        if (strings[i].length == strings[j].length &&
            !memcmp(arena + strings[i].offset, arena + strings[j].offset, strings[i].length)) return -1;
      }
    }
  }
  return (int)operations;
}
static int read_string(size_t ordinal, size_t offset, unsigned width,
                       size_t max_utf8, const string_entry **out) {
  uint64_t index = 0;
  if (version != 2 || width != 12 || max_utf8 > MAX_STRING_BYTES ||
      !field(ordinal, offset, width) ||
      ae_packed_read_u64(bytes, byte_count, valid_bits, offset, width, &index) != AE_PACKED_OK ||
      index >= string_count || strings[index].length > max_utf8) return -1;
  *out = &strings[index];
  return 0;
}
static int read_integer(size_t ordinal, size_t offset, unsigned width,
                        int64_t min, int64_t max, int64_t *out) {
  uint64_t code = 0;
  if (min > max || !field(ordinal, offset, width)) return AE_PACKED_BOUNDS;
  int status = ae_packed_read_u64(bytes, byte_count, valid_bits, offset, width, &code);
  if (status != AE_PACKED_OK) return status;
  __int128 value = (__int128)min + code;
  if (value > max) return AE_PACKED_BOUNDS;
  *out = (int64_t)value;
  return AE_PACKED_OK;
}
static int execute(size_t count) {
  for (size_t i = 0; i < count; i++) {
    char op;
    if (scanf(" %c", &op) != 1) return -1;
    if (op == 'i' || op == 'I') {
      size_t ordinal, offset;
      unsigned width, policy;
      int64_t min, max, increment, value = 0;
      if (scanf("%zu %zu %u %" SCNd64 " %" SCNd64 " %u %" SCNd64,
                &ordinal, &offset, &width, &min, &max, &policy, &increment) != 7)
        return -1;
      int status = read_integer(ordinal, offset, width, min, max, &value);
      if (!status && op == 'I') {
        int64_t next;
        status = ae_packed_add_i64(value, increment, min, max,
                                   (ae_packed_overflow)policy, &next);
        if (!status) {
          __int128 code = (__int128)next - min;
          status = ae_packed_write_u64(bytes, byte_count, valid_bits, offset,
                                        width, (uint64_t)code);
          if (!status) value = next;
        }
      }
      printf("%c %d %" PRId64 "\n", op, status, value);
    } else if (op == 'B') {
      size_t ordinal, offset;
      unsigned width;
      uint64_t value = 0;
      if (scanf("%zu %zu %u", &ordinal, &offset, &width) != 3) return -1;
      int status = !field(ordinal, offset, width) || width != 1 ?
          AE_PACKED_BOUNDS : ae_packed_read_u64(bytes, byte_count, valid_bits,
                                                offset, width, &value);
      printf("B %d %" PRIu64 "\n", status, value);
    } else if (op == 'T') {
      size_t ordinal, offset, max_utf8;
      unsigned width;
      const string_entry *value;
      if (scanf("%zu %zu %u %zu", &ordinal, &offset, &width, &max_utf8) != 4 ||
          read_string(ordinal, offset, width, max_utf8, &value)) return -1;
      printf("T 0 ");
      if (value->length == 0) printf("-");
      for (size_t j = 0; j < value->length; j++) printf("%02x", arena[value->offset + j]);
      printf("\n");
    } else if (op == 'E') {
      size_t left_ordinal, left_offset, left_max, right_ordinal, right_offset, right_max;
      unsigned left_width, right_width;
      const string_entry *left, *right;
      if (scanf("%zu %zu %u %zu %zu %zu %u %zu", &left_ordinal, &left_offset,
                &left_width, &left_max, &right_ordinal, &right_offset,
                &right_width, &right_max) != 8 ||
          read_string(left_ordinal, left_offset, left_width, left_max, &left) ||
          read_string(right_ordinal, right_offset, right_width, right_max, &right)) return -1;
      int equal = left->length == right->length &&
          !memcmp(arena + left->offset, arena + right->offset, left->length);
      printf("E 0 %d\n", equal);
    } else if (op == 'R') {
      size_t ordinal, offset, max_relative, target = 0;
      unsigned width;
      uint64_t code = 0;
      int is_null = 0;
      if (scanf("%zu %zu %u %zu", &ordinal, &offset, &width, &max_relative) != 4)
        return -1;
      int status = max_relative > 20000 || !field(ordinal, offset, width) ? AE_PACKED_BOUNDS :
          ae_packed_read_u64(bytes, byte_count, valid_bits, offset, width, &code);
      if (!status) status = ae_packed_ref_target(code, ordinal, row_count,
                                                 max_relative, &target, &is_null);
      printf("R %d %d %s %s\n", status, is_null,
             status || is_null ? "0" : rows[target].id,
             status || is_null ? "0" : rows[target].epoch);
    } else if (op == 'S') {
      size_t ordinal, offset, max_relative;
      long long target;
      unsigned width;
      char expected_id[128], expected_epoch[128];
      uint64_t code = 0;
      if (scanf("%zu %zu %u %zu %lld %127s %127s",
                &ordinal, &offset, &width, &max_relative, &target,
                expected_id, expected_epoch) != 7 ||
          !decimal_token(expected_id, 0) || !decimal_token(expected_epoch, 0)) return -1;
      int status = max_relative > 20000 || !field(ordinal, offset, width) || target < -1 ||
          (target >= 0 && (unsigned long long)target >= row_count) ?
          AE_PACKED_REFERENCE : AE_PACKED_OK;
      if (!status && target >= 0) {
        size_t destination = (size_t)target;
        size_t distance = ordinal > destination ? ordinal - destination : destination - ordinal;
        if (strcmp(rows[destination].id, expected_id) ||
            strcmp(rows[destination].epoch, expected_epoch) ||
            distance > max_relative) status = AE_PACKED_REFERENCE;
        else code = destination >= ordinal ? 2 * distance + 1 : 2 * distance;
      } else if (!status && (strcmp(expected_id, "0") || strcmp(expected_epoch, "0"))) status = AE_PACKED_REFERENCE;
      if (!status) status = ae_packed_write_u64(bytes, byte_count, valid_bits,
                                                offset, width, code);
      printf("S %d\n", status);
    } else return -1;
  }
  if (version == 2) {
    int trailing;
    while ((trailing = getchar()) != EOF) {
      if (trailing != ' ' && trailing != '\n' && trailing != '\r' && trailing != '\t') return -1;
    }
  }
  printf("H ");
  if (byte_count == 0) printf("-");
  for (size_t i = 0; i < byte_count; i++) printf("%02x", bytes[i]);
  printf("\n");
  return 0;
}
int main(void) {
  int count = load();
  if (count < 0 || execute((size_t)count)) {
    fprintf(stderr, "invalid packed-native-bridge/%d frame\n", version);
    return 2;
  }
  return 0;
}
