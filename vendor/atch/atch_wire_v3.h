#ifndef ATCH_WIRE_V3_H
#define ATCH_WIRE_V3_H

#include <stddef.h>
#include <stdint.h>

#define ATCH_V3_HEADER_LEN 36u
#define ATCH_V3_MAX_PAYLOAD (1u << 20)
#define ATCH_V3_MAX_MSG (16u << 20)
#define ATCH_V3_MAX_STR16 65535u
#define ATCH_V3_MAX_CHECKPOINT (4u << 20)
#define ATCH_V3_MAX_TERMINAL_REPLY 256u
#define ATCH_V3_MORE_TIMEOUT_MS 5000u

enum atch_v3_error {
    ATCH_V3_OK = 0, ATCH_V3_BAD_MAGIC = 1, ATCH_V3_BAD_VERSION = 2,
    ATCH_V3_PAYLOAD_TOO_LARGE = 3, ATCH_V3_UNKNOWN_TYPE = 4,
    ATCH_V3_LEASE_DENIED = 6, ATCH_V3_BAD_SEQUENCE = 7, ATCH_V3_TRUNCATED = 8, ATCH_V3_BAD_FLAGS = 11,
    ATCH_V3_CAP_UNSUPPORTED = 12, ATCH_V3_KEY_CONFLICT = 13,
    ATCH_V3_GENERATION_MISMATCH = 14, ATCH_V3_GEOMETRY_INVALID = 15
};

typedef struct {
    uint16_t type;
    uint32_t flags;
    uint32_t generation;
    uint64_t sequence;
    uint64_t aux;
    uint32_t payload_length;
    unsigned char *payload;
} atch_v3_frame;

int atch_v3_decode_frame(const unsigned char *, size_t, atch_v3_frame *);
int atch_v3_decode_frame_ex(const unsigned char *, size_t, atch_v3_frame *, int strict);
int atch_v3_validate_payload(uint16_t type, const unsigned char *, size_t);
size_t atch_v3_encode_header(unsigned char *, size_t, uint16_t, uint32_t,
                             uint32_t, uint64_t, uint64_t, uint32_t);
uint32_t atch_v3_crc32(const unsigned char *, size_t);

typedef struct {
    uint8_t record_type;
    uint64_t record_seq;
    uint32_t generation;
    uint64_t output_offset;
    uint32_t body_length;
    unsigned char *body;
} atch_v3_record;
int atch_v3_decode_record(const unsigned char *, size_t, atch_v3_record *);

typedef struct { uint16_t client_version; uint8_t peer_role; uint32_t capabilities; unsigned char incarnation[16]; } atch_v3_hello;
typedef struct { uint8_t role; uint32_t prev_generation; uint64_t last_seen_offset, last_seen_record_seq; uint16_t rows, cols; const char *session_id; } atch_v3_attach;
typedef struct { uint8_t source, query_class; uint32_t generation, lease_epoch; uint64_t query_id; const unsigned char *reply; uint32_t reply_length; } atch_v3_terminal_reply;
int atch_v3_validate_capabilities(uint32_t caps);
int atch_v3_validate_geometry(uint16_t rows, uint16_t cols);
int atch_v3_encode_hello(const atch_v3_hello *, unsigned char *, size_t, size_t *);
int atch_v3_decode_hello(const unsigned char *, size_t, atch_v3_hello *);
int atch_v3_encode_attach(const atch_v3_attach *, unsigned char *, size_t, size_t *);
int atch_v3_decode_attach(const unsigned char *, size_t, atch_v3_attach *, char *, size_t);
int atch_v3_validate_checkpoint(uint32_t snapshot_length, uint8_t snapshot_kind, const unsigned char checksum[32], const unsigned char *snapshot);
typedef struct { uint64_t checkpoint_set_id; uint8_t present, snapshot_kind; const unsigned char *put; size_t put_length; } atch_v3_checkpoint_data;
int atch_v3_decode_checkpoint_data(const unsigned char *, size_t, atch_v3_checkpoint_data *);
typedef struct { uint32_t record_count; const unsigned char *records; size_t records_length; } atch_v3_journal_data;
int atch_v3_decode_journal_data(const unsigned char *, size_t, atch_v3_journal_data *);
int atch_v3_validate_terminal_reply(const atch_v3_terminal_reply *);
int atch_v3_validate_generation(uint32_t expected, uint32_t actual);
int atch_v3_authorize(uint16_t type, uint8_t role, int lease_owner);

typedef struct {
    unsigned char *payload;
    size_t length, capacity;
    uint16_t type;
    uint32_t flags, generation;
    uint64_t sequence, aux, next_sequence;
    uint64_t expiry_ms;
    int active;
} atch_v3_reassembler;
void atch_v3_reassembler_init(atch_v3_reassembler *);
void atch_v3_reassembler_free(atch_v3_reassembler *);
int atch_v3_reassembler_push(atch_v3_reassembler *, const unsigned char *, size_t,
                             atch_v3_frame *);
int atch_v3_reassembler_push_at(atch_v3_reassembler *, const unsigned char *, size_t,
                                uint64_t now_ms, atch_v3_frame *);
int atch_v3_reassembler_expired(const atch_v3_reassembler *, uint64_t now_ms);

#endif
