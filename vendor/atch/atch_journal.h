#ifndef ATCH_JOURNAL_H
#define ATCH_JOURNAL_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
	uint32_t generation;
	uint64_t record_seq;
	uint64_t output_offset;
} atch_journal_cursor;

typedef struct {
	uint8_t record_type;
	uint32_t generation;
	uint64_t record_seq;
	uint64_t output_offset;
	const void *body;
	uint32_t body_length;
} atch_journal_record;

typedef struct {
	int fd;
	size_t limit;
	uint64_t first_offset;
	uint64_t end_offset;
	atch_journal_cursor first_cursor;
	int truncated;
	int gap;
} atch_journal;

int atch_journal_open(atch_journal *j, const char *path, size_t limit);
void atch_journal_close(atch_journal *j);
int atch_journal_append(atch_journal *j, const atch_journal_record *record);
int atch_journal_read(const atch_journal *j, atch_journal_cursor after,
	unsigned char *buf, size_t capacity, size_t *used, atch_journal_cursor *next);
int atch_journal_has_gap(const atch_journal *j, atch_journal_cursor requested);
int atch_journal_was_truncated(const atch_journal *j);

#endif
