#include "atch_generation.h"

#include <errno.h>
#include <limits.h>

void atch_generation_init(atch_generation_registry *r, uint32_t initial) {
	r->current = initial;
	r->next = initial == UINT32_MAX ? UINT32_MAX : initial + 1;
	r->pending = 0;
	r->pending_active = 0;
}

int atch_generation_begin(atch_generation_registry *r, uint32_t *generation) {
	if (!r || !generation || r->pending_active || r->next == 0 || r->next == UINT32_MAX)
		return ERANGE;
	r->pending = r->next++;
	r->pending_active = 1;
	*generation = r->pending;
	return 0;
}

int atch_generation_commit(atch_generation_registry *r, uint32_t generation) {
	if (!r || !r->pending_active || generation != r->pending) return EINVAL;
	r->current = generation;
	r->pending = 0;
	r->pending_active = 0;
	return 0;
}

int atch_generation_rollback(atch_generation_registry *r, uint32_t generation) {
	if (!r || !r->pending_active || generation != r->pending) return EINVAL;
	/* The allocated value stays consumed: a rollback can never be replayed. */
	r->pending = 0;
	r->pending_active = 0;
	return 0;
}

int atch_generation_accepts(const atch_generation_registry *r, uint32_t generation) {
	return r && generation == r->current;
}
