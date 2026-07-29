#ifndef ATCH_GENERATION_H
#define ATCH_GENERATION_H

#include <stdint.h>

typedef struct {
	uint32_t current;
	uint32_t next;
	uint32_t pending;
	int pending_active;
} atch_generation_registry;

void atch_generation_init(atch_generation_registry *r, uint32_t initial);
int atch_generation_begin(atch_generation_registry *r, uint32_t *generation);
int atch_generation_commit(atch_generation_registry *r, uint32_t generation);
int atch_generation_rollback(atch_generation_registry *r, uint32_t generation);
int atch_generation_accepts(const atch_generation_registry *r, uint32_t generation);

#endif
