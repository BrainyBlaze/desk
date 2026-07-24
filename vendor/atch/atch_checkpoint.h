#ifndef ATCH_CHECKPOINT_H
#define ATCH_CHECKPOINT_H
#include <stddef.h>
#include <stdint.h>
typedef struct { uint32_t format_version, patch_version; uint64_t set_id; uint8_t snapshot_kind; const void *snapshot; size_t snapshot_length; const void *metadata; size_t metadata_length; } atch_checkpoint_set;
int atch_checkpoint_write(const char *path, const atch_checkpoint_set *set);
int atch_checkpoint_read(const char *path, atch_checkpoint_set *set, void *snapshot, size_t capacity);
#endif
