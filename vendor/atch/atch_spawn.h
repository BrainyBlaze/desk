#ifndef ATCH_SPAWN_H
#define ATCH_SPAWN_H

#include <stddef.h>
#include <sys/types.h>

#define ATCH_LAUNCH_DIGEST_HEXLEN 64

struct atch_launch {
	char *const *argv;
	char *const *envp;
};

int atch_launch_validate(const struct atch_launch *launch);
int atch_launch_digest(const struct atch_launch *launch,
		       char digest[ATCH_LAUNCH_DIGEST_HEXLEN + 1]);

struct atch_worker {
	unsigned reserved;
};

int atch_worker_reserve(struct atch_worker *worker);
void atch_worker_release(struct atch_worker *worker);

typedef int (*atch_wait_fn)(pid_t, int *, int);
typedef int (*atch_signal_fn)(pid_t, int);

int atch_reap_child(pid_t pid, atch_wait_fn wait_fn, int *status);
int atch_stop_child(pid_t pid, unsigned grace_ms, atch_signal_fn signal_fn,
		    atch_wait_fn wait_fn);

struct atch_restart_ops {
	int (*reserve)(void *arg);
	int (*stop)(void *arg);
	int (*launch)(void *arg);
	int (*commit)(void *arg);
	void (*release)(void *arg);
};

int atch_restart(void *arg, const struct atch_restart_ops *ops);

#endif
