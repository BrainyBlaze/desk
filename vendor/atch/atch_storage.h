#ifndef ATCH_STORAGE_H
#define ATCH_STORAGE_H

#include <stddef.h>
#include <sys/types.h>

#define ATCH_MAX_PAYLOAD (1024U * 1024U)
#define ATCH_MAX_GEOMETRY (64U * 1024U)
#define ATCH_MAX_CELL (64U * 1024U)
#define ATCH_MAX_PARSER (256U * 1024U)
#define ATCH_MAX_REASSEMBLY (4U * 1024U * 1024U)
#define ATCH_MAX_SEND_QUEUE (4U * 1024U * 1024U)
#define ATCH_MAX_JOURNAL (16U * 1024U * 1024U)
#define ATCH_MAX_CHECKPOINT (4U * 1024U * 1024U)

enum atch_alloc_kind {
	ATCH_ALLOC_PAYLOAD, ATCH_ALLOC_GEOMETRY, ATCH_ALLOC_CELL,
	ATCH_ALLOC_PARSER, ATCH_ALLOC_REASSEMBLY, ATCH_ALLOC_SEND_QUEUE,
	ATCH_ALLOC_JOURNAL, ATCH_ALLOC_CHECKPOINT
};

int atch_alloc(enum atch_alloc_kind kind, size_t count, void **out);
int atch_storage_open_root(const char *path);
int atch_storage_mkdir(int dirfd, const char *name);
int atch_storage_open_dir(int dirfd, const char *name);
int atch_storage_open_file(int dirfd, const char *name, int flags, mode_t mode);
int atch_storage_open_path_file(const char *path, int flags, mode_t mode);
int atch_storage_open_sink(const char *root_path, const char *path, int flags, mode_t mode);
int atch_storage_repair_stale_lock(int dirfd, const char *name);

#endif
